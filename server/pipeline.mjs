// Projects + the 5-stage pipeline (script → voice → timing → storyboard → render).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, getSettings, resolveFonts, resolvePalette, writeFileAtomic } from './settings.mjs';
import { chatStream, ttsWithTimestamps, ttsOpenAI, transcribeWords, applyPronunciation } from './apis.mjs';
import { estimateWords } from './estimate.mjs';
import { scriptMessages, researchMessages, parseScript, tokenize, countWords, charsToWords, wordsWithChars, alignWords, WORDS_PER_SECOND, LENGTHS } from './text.mjs';
import { storyboardMessages, reviewMessages, extractJson, repairStoryboard, storyboardNouns, TEMPLATES } from './storyboard.mjs';
import { iconsFor } from './icons.mjs';
import { redact, log as slog } from './logger.mjs';
import { uploadVideo, videoMetadata, youtubeStatus } from './youtube.mjs';
import { run, probeDuration, renderFrames, writeSfx, mixAudio, muxFinal, contactSheet } from './render.mjs';
import { effectiveEdit, cleanEdit, layoutFor, prepareClip } from './edit.mjs';
import { facesFor, typographyFor } from './fonts.mjs';
import { getAsset, assetFile, creditsFor } from './assets.mjs';
import * as PV from './providers.mjs';
import { keptSegments, outDuration, srcToOut } from './timeline.mjs';

export const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const cache = new Map(); // id → project
const buses = new Map(); // id → EventEmitter
const running = new Map(); // id → { stage, controller, promise }
export let serverPort = 4301;
export const setServerPort = (p) => { serverPort = p; };

export const projectDir = (id) => path.join(PROJECTS_DIR, id);
const validId = (id) => /^[a-z0-9-]{6,40}$/.test(id);

export function bus(id) {
  if (!buses.has(id)) { const e = new EventEmitter(); e.setMaxListeners(50); buses.set(id, e); }
  return buses.get(id);
}

function save(p) {
  p.updatedAt = new Date().toISOString();
  const { lastPreview, ...persist } = p;
  writeFileAtomic(path.join(projectDir(p.id), 'project.json'), JSON.stringify(persist, null, 1));
  bus(p.id).emit('event', { type: 'state', data: publicProject(p) });
}

export function publicProject(p) {
  const { lastPreview, icons, ...rest } = p;
  return { ...rest, running: running.has(p.id) ? running.get(p.id).stage : null, iconKeys: icons ? Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, v.key])) : null };
}

export function getProject(id) {
  if (!validId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  const f = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(f)) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { slog('error', 'unreadable project.json — skipped', { project: id, err: e }); return null; }
  if (!p?.stages || !STAGES.every((s) => p.stages[s])) { slog('error', 'project.json has no stages — skipped', { project: id }); return null; }
  for (const s of STAGES) if (p.stages[s].status === 'running') { p.stages[s].status = 'error'; p.stages[s].error = 'interrupted (server restarted)'; }
  cache.set(id, p);
  return p;
}

export function listProjects() {
  return fs.readdirSync(PROJECTS_DIR).filter(validId).map(getProject).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({ id: p.id, topic: p.topic, title: p.script?.title || '', seconds: p.seconds, createdAt: p.createdAt, statuses: Object.fromEntries(STAGES.map((s) => [s, p.stages[s].status])), running: running.has(p.id) }));
}

export function createProject({ topic, seconds = 30, approvals = {}, voiceMode = 'tts', options = {} }) {
  topic = String(topic || '').trim().slice(0, 300);
  if (!topic) throw httpError(400, 'topic is required');
  seconds = seconds === 'auto' ? 'auto' : Number(seconds);
  if (!LENGTHS.includes(seconds)) throw httpError(400, `length must be one of ${LENGTHS.join(', ')}`);
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const p = {
    id, topic, seconds, createdAt: new Date().toISOString(), updatedAt: null,
    voiceMode: voiceMode === 'upload' ? 'upload' : 'tts', upload: null,
    approvals: Object.fromEntries(STAGES.map((s) => [s, (approvals[s] || getSettings().approvals?.[s]) === 'wait' ? 'wait' : 'auto'])),
    options: {
      forceTemplate: TEMPLATES.includes(options.forceTemplate) ? options.forceTemplate : null, publish: options.publish ?? !!getSettings().youtube?.autoPublish,
      dialect: ['msa', 'levantine', 'gulf'].includes(options.dialect) ? options.dialect : 'egyptian', research: options.research !== false,
    },
    research: null,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'idle', error: null, log: [], startedAt: null, endedAt: null }])),
    script: null, voice: null, words: null, timing: null, storyboard: null, storyboardFixes: [], icons: null, render: null, clips: {},
    edit: ['9:16', '1:1', '16:9'].includes(options.aspect) ? { export: { aspect: options.aspect } } : {},
    publish: { status: 'idle', log: [] },
  };
  fs.mkdirSync(projectDir(id), { recursive: true });
  cache.set(id, p);
  save(p);
  return p;
}

export async function deleteProject(id) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  await cancel(id);
  cache.delete(id);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function log(p, stage, line) {
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${redact(line)}`;
  if (/^[✖⚠]/.test(line)) slog(line.startsWith('✖') ? 'error' : 'warn', line, { project: p.id, stage });
  const L = p.stages[stage].log; L.push(entry); if (L.length > 400) L.splice(0, L.length - 400);
  bus(p.id).emit('event', { type: 'log', data: { stage, line: entry } });
}

function resetFrom(p, stage) {
  for (const s of STAGES.slice(STAGES.indexOf(stage))) {
    p.stages[s] = { status: 'idle', error: null, log: s === stage ? p.stages[s].log : [], startedAt: null, endedAt: null };
  }
}

// ---- control -------------------------------------------------------------------
export function runPipeline(id) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (running.has(id)) return false;
  const entry = { stage: null, controller: null };
  running.set(id, entry);
  entry.promise = (async () => {
    try {
      for (const stage of STAGES) {
        const st = p.stages[stage];
        if (st.status === 'done') continue;
        if (st.status === 'review') break; // waiting for approval
        entry.stage = stage;
        entry.controller = new AbortController();
        st.status = 'running'; st.error = null; st.startedAt = new Date().toISOString(); st.endedAt = null;
        log(p, stage, `▶ ${stage} started`);
        save(p);
        try {
          await STAGE_FN[stage](p, entry.controller.signal);
          if (entry.controller.signal.aborted) throw new Error('cancelled');
          st.endedAt = new Date().toISOString();
          st.status = p.approvals[stage] === 'wait' ? 'review' : 'done';
          log(p, stage, st.status === 'review' ? '⏸ waiting for your approval' : '✔ done');
          save(p);
          if (st.status === 'review') break;
        } catch (e) {
          const cancelled = entry.controller.signal.aborted || e.name === 'AbortError' || e.message === 'cancelled';
          st.status = cancelled ? 'idle' : 'error';
          st.error = cancelled ? null : e.message;
          st.endedAt = new Date().toISOString();
          log(p, stage, cancelled ? '■ cancelled' : `✖ ${e.message}`);
          save(p);
          break;
        }
      }
    } finally {
      running.delete(id);
      save(p);
    }
    if (p.stages.render.status === 'done' && p.options?.publish && !p.publish?.videoId && p.publish?.status !== 'running' && youtubeStatus().linked) {
      publishProject(id).catch(() => {});
    }
  })();
  return true;
}

export async function cancel(id) {
  cancelPublish(id);
  return stopRun(id);
}

/** Aborts the running pipeline (not a publish) and waits until it has settled. */
async function stopRun(id) {
  const r = running.get(id);
  if (!r) return false;
  r.controller?.abort();
  await r.promise.catch(() => {});
  return true;
}

/**
 * An edit changes the input of every later stage. A stage still running on the old input would
 * otherwise finish on stale data (e.g. timing aligned to the new script but the old voice).
 */
async function stopForEdit(p, why) {
  const stage = running.get(p.id)?.stage;
  if (await stopRun(p.id)) log(p, stage || 'script', `■ stopped: ${why}`);
}

export async function approve(id, stage) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (p.stages[stage]?.status !== 'review') throw httpError(409, `${stage} is not waiting for approval`);
  p.stages[stage].status = 'done';
  log(p, stage, '✔ approved');
  save(p);
  runPipeline(id);
}

export async function rerun(id, stage) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!STAGES.includes(stage)) throw httpError(400, 'unknown stage');
  await cancel(id);
  const firstMissing = STAGES.find((s) => p.stages[s].status !== 'done');
  if (STAGES.indexOf(stage) > STAGES.indexOf(firstMissing ?? 'render') && firstMissing) throw httpError(409, `finish ${firstMissing} first`);
  resetFrom(p, stage);
  log(p, stage, '↻ re-run requested');
  save(p);
  runPipeline(id);
}

export function setApprovals(id, approvals) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  for (const s of STAGES) if (approvals?.[s]) p.approvals[s] = approvals[s] === 'wait' ? 'wait' : 'auto';
  save(p);
}

/** Manual edits. Editing a stage's output invalidates every later stage. */
export async function editStage(id, stage, body) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!['script', 'timing', 'storyboard'].includes(stage)) throw httpError(400, `${stage} cannot be edited (re-run it instead)`);
  validateEdit(p, stage, body);
  await stopForEdit(p, `${stage} edited`);
  const st = p.stages[stage];
  if (stage === 'script') {
    const text = String(body?.text ?? '').trim();
    p.script = { ...(p.script || {}), title: String(body.title ?? p.script?.title ?? '').trim(), text, sources: Array.isArray(body.sources) ? body.sources.map(String) : p.script?.sources || [], edited: true, words: countWords(text) };
  } else if (stage === 'timing') {
    body.words.forEach((w, i) => {
      const s = Number(w.start), e = Number(w.end);
      if (Number.isFinite(s)) p.words[i].start = +s.toFixed(3);
      if (Number.isFinite(e)) p.words[i].end = +Math.max(e, p.words[i].start + 0.05).toFixed(3);
      if (typeof w.text === 'string' && w.text.trim()) p.words[i].text = w.text.trim();
    });
  } else {
    const { storyboard, fixes } = repairStoryboard(body._parsed, p.words, { forceTemplate: p.options.forceTemplate });
    p.storyboard = storyboard; p.storyboardFixes = fixes;
    p.icons = iconsFor(storyboardNouns(storyboard));
  }
  log(p, stage, '✎ edited by user');
  if (st.status === 'idle' || st.status === 'error') st.status = 'done';
  const next = STAGES[STAGES.indexOf(stage) + 1];
  if (next) resetFrom(p, next);
  save(p);
}

function validateEdit(p, stage, body) {
  if (stage === 'script' && !String(body?.text ?? '').trim()) throw httpError(400, 'script text is empty');
  if (stage === 'timing' && (!Array.isArray(body?.words) || !p.words || body.words.length !== p.words.length)) throw httpError(400, 'words must be an array with the same length');
  if (stage === 'storyboard') {
    if (!p.words?.length) throw httpError(409, 'timing is not done yet');
    let raw;
    try { raw = typeof body?.storyboard === 'string' ? extractJson(body.storyboard) : body?.storyboard; }
    catch (e) { throw httpError(400, `storyboard JSON: ${e.message}`); }
    if (!raw || typeof raw !== 'object') throw httpError(400, 'storyboard must be a JSON object');
    body._parsed = raw;
  }
}

export async function saveUpload(id, buf, filename, mime) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!buf?.length) throw httpError(400, 'empty upload');
  if (!looksLikeMedia(buf)) throw httpError(415, 'الملف مش ملف صوت معروف (mp3/wav/m4a/aac/ogg/opus/flac/webm/mp4)');
  await stopForEdit(p, 'new voice-over uploaded');
  const ext = (path.extname(filename || '').toLowerCase().match(/^\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mp4)$/) || [, 'mp3'])[1];
  for (const f of fs.readdirSync(projectDir(id))) if (f.startsWith('upload.')) fs.rmSync(path.join(projectDir(id), f));
  fs.writeFileSync(path.join(projectDir(id), `upload.${ext}`), buf);
  p.upload = { file: `upload.${ext}`, mime: mime || 'audio/mpeg', name: String(filename || '').slice(0, 120), size: buf.length };
  p.voiceMode = 'upload';
  if (p.stages.voice.status !== 'idle') resetFrom(p, 'voice');
  log(p, 'voice', `uploaded voice-over ${p.upload.name || p.upload.file} (${(buf.length / 1024).toFixed(0)} KB)`);
  save(p);
}

/** Magic-byte check: the bytes must be a container ffmpeg can read as audio, whatever the file name says. */
export function looksLikeMedia(buf) {
  const a = (i, s) => buf.subarray(i, i + s.length).toString('latin1') === s;
  return a(0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) // mp3 / aac (ADTS)
    || (a(0, 'RIFF') && a(8, 'WAVE')) || a(4, 'ftyp') || a(0, 'OggS') || a(0, 'fLaC')
    || (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3); // webm / matroska
}

export async function setVoiceMode(id, mode) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if ((mode === 'upload' ? 'upload' : 'tts') !== p.voiceMode) await stopForEdit(p, 'voice mode changed');
  p.voiceMode = mode === 'upload' ? 'upload' : 'tts';
  if (p.stages.voice.status !== 'idle') resetFrom(p, 'voice');
  save(p);
}

// ---- stages --------------------------------------------------------------------
const STAGE_FN = {
  async script(p, signal) {
    const s = getSettings();
    const auto = p.seconds === 'auto';
    const target = auto ? null : Math.round(p.seconds * WORDS_PER_SECOND);
    log(p, 'script', `LLM ${s.llm.baseUrl} · model ${s.llm.model} · ${auto ? 'length: auto (LLM decides)' : `target ${target} words`} · ${{ msa: 'فصحى', levantine: 'شامي', gulf: 'خليجي' }[p.options?.dialect] || 'عامية مصرية'}`);
    bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', reset: true } });
    p.research = null;
    if (p.options?.research !== false) {
      // research pass: notes for the writer, shown to the user as UNVERIFIED (a failure only skips it)
      try {
        const r = await chatStream(s, researchMessages(p.topic), { signal, temperature: 0.2, maxTokens: 1500 });
        const j = extractJson(r.text);
        const facts = (Array.isArray(j.facts) ? j.facts : []).slice(0, 10).map((f) => ({
          claim: String(f?.claim || '').slice(0, 300), confidence: ['high', 'medium', 'low'].includes(f?.confidence) ? f.confidence : 'low',
          source: typeof f?.source === 'string' && f.source.trim() ? f.source.slice(0, 200) : null,
        })).filter((f) => f.claim);
        p.research = { angle: String(j.angle || '').slice(0, 200), facts, misconceptions: (Array.isArray(j.misconceptions) ? j.misconceptions : []).map(String).slice(0, 5), verified: false };
        log(p, 'script', `research: ${facts.length} notes (unverified) · ${facts.filter((f) => f.confidence === 'high').length} high-confidence`);
      } catch (e) {
        if (signal.aborted) throw e;
        log(p, 'script', `⚠ research pass skipped (${e.message})`);
      }
    }
    const { text, model } = await chatStream(s, scriptMessages(p.topic, p.seconds, { dialect: p.options?.dialect, research: p.research }), {
      signal, onDelta: (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', delta: d } }),
    });
    const parsed = parseScript(text);
    const n = countWords(parsed.text);
    p.script = { ...parsed, words: n, model: model || s.llm.model };
    log(p, 'script', `"${parsed.title}" — ${n} words ≈ ${(n / WORDS_PER_SECOND).toFixed(0)} s${target ? ` (target ${target})` : ''}${model ? ' · ' + model : ''}`);
    if (target && Math.abs(n - target) > target * 0.25) log(p, 'script', `⚠ word count is ${n > target ? 'above' : 'below'} target by ${Math.abs(n - target)} — the video will be ~${(n / WORDS_PER_SECOND).toFixed(0)} s`);
    if ((p.options?.dialect || 'egyptian') === 'egyptian' && !/عارف\s+ليه/.test(parsed.text)) log(p, 'script', '⚠ series question «عارف ليه؟» not found');
  },

  async voice(p, signal) {
    if (!p.script?.text) throw new Error('no script');
    const dir = projectDir(p.id);
    const out = path.join(dir, 'voice.mp3');
    if (p.voiceMode === 'upload') {
      if (!p.upload) throw new Error('voice mode is "upload" but no file was uploaded');
      log(p, 'voice', `converting ${p.upload.file} → voice.mp3`);
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-y', '-i', path.join(dir, p.upload.file), '-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', out], { signal });
      p.voice = { file: 'voice.mp3', source: 'upload', duration: await probeDuration(out) };
      log(p, 'voice', `voice-over ${p.voice.duration.toFixed(2)} s`);
      return;
    }
    const s = getSettings();
    const spoken = applyPronunciation(p.script.text, s.pronunciation);
    if (s.tts?.provider === 'openai') {
      log(p, 'voice', `OpenAI-compatible TTS ${s.openaiTts.baseUrl} · ${s.openaiTts.model} · voice ${s.openaiTts.voice} · speed ${s.openaiTts.speed}${spoken.text !== p.script.text ? ' · pronunciation fixes applied' : ''}`);
      fs.writeFileSync(out, await ttsOpenAI(s, spoken.text, { signal }));
      p.voice = { file: 'voice.mp3', source: 'openai', duration: await probeDuration(out) };
      log(p, 'voice', `voice.mp3 ${p.voice.duration.toFixed(2)} s (no timestamps — timing comes next)`);
      return;
    }
    log(p, 'voice', `ElevenLabs voice ${s.elevenlabs.voiceId || '(none)'} · ${s.elevenlabs.modelId} · speed ${s.elevenlabs.speed ?? 1}${spoken.text !== p.script.text ? ' · pronunciation fixes applied' : ''}`);
    const { audio, chars } = await ttsWithTimestamps(s, spoken.text, { signal });
    fs.writeFileSync(out, audio);
    const timed = charsToWords(chars);
    fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'elevenlabs', chars, words: timed.map(({ chars: _c, ...w }) => w) }));
    p.voice = { file: 'voice.mp3', source: 'elevenlabs', duration: await probeDuration(out), chars: chars.length, timedWords: timed.length };
    log(p, 'voice', `voice.mp3 ${p.voice.duration.toFixed(2)} s · ${chars.length} timed characters → ${timed.length} words`);
  },

  async timing(p, signal) {
    const dir = projectDir(p.id);
    let timed, estimated = false;
    const s0 = getSettings();
    if (['upload', 'openai'].includes(p.voice?.source) && !s0.deepgram.apiKey) {
      // no speech-to-text configured: estimate from the audio's own pauses (speech clock, words ∝ letters)
      log(p, 'timing', '⚠ no Deepgram key — estimating word timing from the pauses in the audio; check it in the editor');
      const dw = await estimateWords(p.script.text, path.join(dir, 'voice.mp3'), { signal });
      fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'estimate', words: dw }));
      timed = wordsWithChars(dw);
      estimated = true;
    } else if (['upload', 'openai'].includes(p.voice?.source)) {
      const s = s0;
      log(p, 'timing', `Deepgram ${s.deepgram.model} (${s.deepgram.language}) on the ${p.voice.source === 'upload' ? 'uploaded' : 'generated'} voice`);
      const buf = fs.readFileSync(path.join(dir, 'voice.mp3'));
      const dw = await transcribeWords(s, buf, 'audio/mpeg', { signal });
      if (!dw.length) throw new Error('Deepgram returned no words');
      fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'deepgram', words: dw }));
      timed = wordsWithChars(dw);
      log(p, 'timing', `Deepgram heard ${dw.length} words`);
    } else {
      const vt = JSON.parse(fs.readFileSync(path.join(dir, 'voice-timing.json'), 'utf8'));
      timed = charsToWords(vt.chars);
    }
    const tokens = tokenize(p.script.text);
    const words = alignWords(tokens, timed);
    p.words = words;
    const weak = words.filter((w) => w.weak);
    const avg = words.reduce((a, w) => a + w.match, 0) / Math.max(1, words.length);
    p.timing = { weak: weak.length, matchAvg: +avg.toFixed(3), source: estimated ? 'estimate' : p.voice.source, estimated };
    log(p, 'timing', `aligned ${words.length} script words · mean char match ${(avg * 100).toFixed(0)}% · ${weak.length} weak`);
    if (weak.length) log(p, 'timing', `weak: ${weak.slice(0, 12).map((w) => `#${w.i} ${w.text}`).join(', ')}${weak.length > 12 ? '…' : ''}`);
  },

  async storyboard(p, signal) {
    const s = getSettings();
    const duration = p.voice.duration;
    const ctx = { title: p.script.title, words: p.words, duration, forceTemplate: p.options.forceTemplate };
    const emit = (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', delta: d } });
    bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', reset: true } });
    const first = await chatStream(s, storyboardMessages(ctx), { signal, onDelta: emit, temperature: 0.6 });
    const r1 = repairStoryboard(extractJson(first.text), p.words, { forceTemplate: p.options.forceTemplate });
    log(p, 'storyboard', `draft: ${r1.storyboard.scenes.length} scenes · ${r1.fixes.length} repairs`);
    r1.fixes.forEach((f) => log(p, 'storyboard', `  fix: ${f}`));
    let final = r1;
    try {
      emit('\n\n— self-review —\n');
      const second = await chatStream(s, reviewMessages({ ...ctx, storyboard: r1.storyboard, notes: r1.notes }), { signal, onDelta: emit, temperature: 0.3 });
      const r2 = repairStoryboard(extractJson(second.text), p.words, { forceTemplate: p.options.forceTemplate });
      if (r2.storyboard.scenes.length >= 1) {
        final = r2;
        log(p, 'storyboard', `self-review: ${r2.storyboard.scenes.length} scenes · ${r2.fixes.length} repairs`);
        r2.fixes.forEach((f) => log(p, 'storyboard', `  fix: ${f}`));
      }
    } catch (e) {
      if (signal.aborted) throw e;
      log(p, 'storyboard', `⚠ self-review failed (${e.message}) — keeping the draft`);
    }
    p.storyboard = final.storyboard;
    p.storyboardFixes = final.fixes;
    await autoVisuals(p, signal);
    p.icons = iconsFor(storyboardNouns(final.storyboard));
    log(p, 'storyboard', `templates: ${final.storyboard.scenes.map((sc) => `${sc.type}/${sc.template}@${sc.at}`).join(' · ')}`);
    log(p, 'storyboard', `icons: ${Object.entries(p.icons).map(([n, v]) => `${n}→${v.key}`).join(', ')}`);
  },

  async render(p, signal) {
    const dir = projectDir(p.id);
    const E = effectiveEdit(p.edit);
    const L = layoutFor(E.export.aspect, E.export.resolution);
    const FPS = E.export.fps;
    // video clips (scene media and overlays) → frames on disk at the output fps and size
    p.clips = {};
    const clipJobs = [];
    const full = renderData(p);
    full.scenes.forEach((sc, k) => { if (sc.image && getAsset(sc.image)?.kind === 'video') clipJobs.push([`scene-${k}`, sc.image, sc.imageOffset || 0, sc.end - sc.start + 1]); });
    for (const o of E.overlays) if (o.kind === 'video') clipJobs.push([`ov-${o.id}`, o.asset, o.offset || 0, o.end - o.start]);
    for (const [ref, asset, offset, seconds] of clipJobs) {
      const info = await prepareClip(dir, asset, { offset, seconds, fps: FPS, maxW: L.width, maxH: L.height, signal });
      p.clips[ref] = info;
      log(p, 'render', `clip ${ref}: ${info.count} frames from ${getAsset(asset).name}`);
    }
    save(p);
    const data = renderData(p);
    const { duration, start, segments } = data;
    const audioCfg = getSettings().audio;
    log(p, 'render', `${duration.toFixed(2)} s${start || data.end < data.full ? ` (trim ${start.toFixed(2)}→${data.end.toFixed(2)})` : ''}${segments.length > 1 ? ` · ${segments.length - 1} cut(s)` : ''} · ${Math.ceil(duration * FPS)} frames @ ${FPS} fps · ${L.width}×${L.height} (${E.export.aspect}) · ${E.export.quality}`);
    const tmpVideo = path.join(dir, 'frames.mp4');
    const key = crypto.createHash('sha256').update(JSON.stringify({ data, q: E.export.quality, v: 2 })).digest('hex').slice(0, 16);
    let lastEmit = 0;
    await renderFrames({
      url: `http://127.0.0.1:${serverPort}/render.html?project=${p.id}`,
      out: tmpVideo, duration, start, segments, fps: FPS, width: L.width, height: L.height, quality: E.export.quality,
      segDir: path.join(dir, 'segments'), key, signal, log: (l) => log(p, 'render', l),
      onFrame: (i, total, jpg) => {
        const now = Date.now();
        if (now - lastEmit > 200 || i === total - 1) { lastEmit = now; bus(p.id).emit('event', { type: 'progress', data: { stage: 'render', frame: i + 1, total } }); }
        if (jpg) { p.lastPreview = jpg; bus(p.id).emit('event', { type: 'preview', data: { t: i / FPS, jpeg: jpg.toString('base64') } }); }
      },
    });
    log(p, 'render', 'mixing voice + SFX' + (E.audio.music ? ' + music' : '') + ', normalising to −14 LUFS');
    // SFX live in output time: a scene change or a pop that was cut out makes no sound
    const toOut = (t) => srcToOut(t, segments);
    const cuts = data.scenes.slice(1).map((sc) => toOut(sc.start)).filter((t) => t !== null);
    const ticks = [];
    data.scenes.forEach((sc) => sc.items.forEach((it) => { if (it.at != null) { const o = toOut(p.words[it.at].start); if (o !== null) ticks.push(o); } }));
    writeSfx(path.join(dir, 'sfx.wav'), duration, audioCfg.whoosh ? cuts : [], audioCfg.tick ? ticks.sort((a, b) => a - b) : [], E.audio.sfxVolume);
    const musicAsset = E.audio.music && getAsset(E.audio.music.asset);
    if (E.audio.music && !musicAsset) log(p, 'render', '⚠ music file is no longer in the library — rendering without it');
    await mixAudio({
      voice: path.join(dir, 'voice.mp3'), sfx: path.join(dir, 'sfx.wav'), out: path.join(dir, 'mix.m4a'), duration, segments, voiceVolume: E.audio.voiceVolume,
      clips: await clipSounds(E.overlays),
      music: musicAsset ? { ...E.audio.music, file: assetFile(musicAsset) } : null, signal, log: (l) => log(p, 'render', l),
    });
    await muxFinal({ video: tmpVideo, audio: path.join(dir, 'mix.m4a'), out: path.join(dir, 'video.mp4'), signal });
    await contactSheet({ video: path.join(dir, 'video.mp4'), out: path.join(dir, 'contact.jpg'), duration, aspect: E.export.aspect });
    // temporary files: segments, the silent video and the SFX track are not needed once the MP4 exists
    for (const f of [tmpVideo, path.join(dir, 'sfx.wav')]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
    const used = [...data.scenes.map((sc) => sc.image), ...E.overlays.map((o) => o.asset), musicAsset?.id].filter(Boolean);
    p.render = {
      file: 'video.mp4', contact: 'contact.jpg', duration: +duration.toFixed(3), frames: Math.ceil(duration * FPS), fps: FPS, theme: data.theme.name,
      width: L.width, height: L.height, aspect: E.export.aspect, quality: E.export.quality, credits: creditsFor(used), at: new Date().toISOString(),
    };
    log(p, 'render', `video.mp4 ready (${(fs.statSync(path.join(dir, 'video.mp4')).size / 1e6).toFixed(1)} MB) · contact sheet saved${p.render.credits.length ? ` · ${p.render.credits.length} credits` : ''}`);
  },
};

/**
 * Automatic visual selection: every "photo" scene without an image gets the best stock result for its query from the
 * first configured provider (Pexels → Pixabay → Unsplash), imported with its licence. Without a provider, or when the
 * search fails, the scene falls back to an illustrated template — never a broken frame.
 */
async function autoVisuals(p, signal) {
  const status = PV.providerStatus();
  const provider = ['pexels', 'pixabay', 'unsplash'].find((k) => status[k].configured);
  const orientation = { '9:16': 'portrait', '1:1': 'square', '16:9': 'landscape' }[effectiveEdit(p.edit).export.aspect];
  for (const [k, sc] of p.storyboard.scenes.entries()) {
    if (sc.template !== 'photo' || sc.image) continue;
    if (signal?.aborted) throw new Error('cancelled');
    const q = sc.query || sc.items.map((it) => it.icon).filter(Boolean).join(' ') || sc.title;
    try {
      if (!provider) throw new Error('مفيش مكتبة صور متوصلة (الإعدادات ← المكتبات)');
      const r = await PV.search(provider, q, { kind: 'image', orientation, per: 5 });
      if (!r.items.length) throw new Error(`مفيش نتايج لـ "${r.queryUsed}"`);
      const a = await PV.importResult(provider, r.items[0], { folder: `project-${p.id}` });
      sc.image = a.id;
      log(p, 'storyboard', `visual: scene ${k + 1} ← ${status[provider].name} "${r.queryUsed}" (${a.license.name}${a.source.author ? ', ' + a.source.author : ''})`);
    } catch (e) {
      if (signal?.aborted) throw e;
      sc.template = 'cards';
      if (!sc.items.length) sc.items.push({ label: sc.title || '…', icon: sc.query?.split(' ')[0] || 'cell', value: null, at: null });
      log(p, 'storyboard', `⚠ scene ${k + 1}: photo → cards (${e.message})`);
    }
  }
}

/**
 * Editor save: storyboard and/or word timings and/or the edit model in one call. Anything that changes the picture
 * or the sound resets the render stage, so the next render shows exactly what the editor shows.
 */
export async function saveEdit(id, body) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!p.words?.length || !p.storyboard) throw httpError(409, 'المحرر بيشتغل بعد ما الستوري بورد يخلص');
  const duration = Math.max(p.voice?.duration || 0, p.words[p.words.length - 1].end + 0.3) + 0.6;
  // validate everything first — an invalid edit must not stop a running render
  let words = null, sb = null, fixes = [];
  if (Array.isArray(body?.words)) {
    if (body.words.length !== p.words.length) throw httpError(400, 'words must keep the same length');
    words = p.words.map((w, i) => {
      const n = body.words[i] || {};
      const st = Number.isFinite(Number(n.start)) ? Math.max(0, Math.min(duration, Number(n.start))) : w.start;
      return { ...w, start: +st.toFixed(3), end: +Math.max(st + 0.05, Number.isFinite(Number(n.end)) ? Number(n.end) : w.end).toFixed(3), text: typeof n.text === 'string' && n.text.trim() ? n.text.trim().slice(0, 40) : w.text };
    });
    for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
  }
  if (body?.storyboard) {
    if (typeof body.storyboard !== 'object') throw httpError(400, 'storyboard must be an object');
    const r = repairStoryboard(body.storyboard, words || p.words, { forceTemplate: p.options.forceTemplate });
    for (const sc of r.storyboard.scenes) if (sc.image && !getAsset(sc.image)) throw httpError(400, `scene image ${sc.image} is not in the library`);
    sb = r.storyboard; fixes = r.fixes;
  }
  const edit = body?.edit ? cleanEdit(body.edit, { duration }) : null;
  await stopForEdit(p, 'editor change');
  if (words) p.words = words;
  if (sb) { p.storyboard = sb; p.storyboardFixes = fixes; p.icons = iconsFor(storyboardNouns(sb)); }
  if (edit) p.edit = { ...(p.edit || {}), ...edit };
  if (words || sb) { if (['idle', 'error'].includes(p.stages.storyboard.status)) p.stages.storyboard.status = 'done'; if (p.stages.timing.status !== 'done') p.stages.timing.status = 'done'; }
  if (words || sb || edit) resetFrom(p, 'render');
  log(p, 'render', `✎ editor: ${[words && 'timing', sb && 'scenes', edit && Object.keys(edit).join('/')].filter(Boolean).join(' + ')} changed${fixes.length ? ` (${fixes.length} auto-fixes)` : ''}`);
  save(p);
  return { project: publicProject(p), fixes };
}

// ---- publish (YouTube) ------------------------------------------------------------
const publishing = new Map(); // id → AbortController
function plog(p, line) {
  p.publish = p.publish || { status: 'idle', log: [] };
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${redact(line)}`;
  p.publish.log.push(entry); if (p.publish.log.length > 100) p.publish.log.splice(0, p.publish.log.length - 100);
  bus(p.id).emit('event', { type: 'log', data: { stage: 'publish', line: entry } });
}
/** Uploads the rendered video. Resolves when done; errors are stored on p.publish. */
export async function publishProject(id, { privacy } = {}) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (p.stages.render.status !== 'done' || !p.render) throw httpError(409, 'الرندر لسه ما خلصش');
  if (publishing.has(id)) throw httpError(409, 'النشر شغال بالفعل');
  const st = youtubeStatus();
  if (!st.linked) throw httpError(409, 'القناة مش مربوطة — اربطها من الإعدادات ← يوتيوب');
  const priv = ['private', 'unlisted', 'public'].includes(privacy) ? privacy : getSettings().youtube.privacy || 'private';
  const ctl = new AbortController();
  publishing.set(id, ctl);
  p.publish = { ...(p.publish || {}), status: 'running', error: null, progress: 0, log: p.publish?.log || [] };
  const meta = videoMetadata(p);
  plog(p, `▶ رفع على قناة «${st.channel?.title || '?'}» (${priv}) — "${meta.title}"`);
  save(p);
  let last = 0;
  try {
    const r = await uploadVideo(path.join(projectDir(id), 'video.mp4'), meta, {
      privacy: priv, signal: ctl.signal,
      onProgress: (f) => {
        p.publish.progress = f;
        if (f - last >= 0.1 || f === 1) { last = f; bus(id).emit('event', { type: 'progress', data: { stage: 'publish', frame: Math.round(f * 100), total: 100 } }); }
      },
    });
    Object.assign(p.publish, { status: 'done', videoId: r.videoId, url: r.url, privacy: r.privacy, channel: st.channel, at: new Date().toISOString() });
    plog(p, `✔ اتنشر: ${r.url} (${r.privacy})`);
  } catch (e) {
    const cancelled = ctl.signal.aborted;
    Object.assign(p.publish, { status: cancelled ? 'idle' : 'error', error: cancelled ? null : e.message });
    plog(p, cancelled ? '■ النشر اتلغى' : `✖ ${e.message}`);
  } finally {
    publishing.delete(id);
    save(p);
  }
  return p.publish;
}
export function setPublishOption(id, on) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  p.options = { ...(p.options || {}), publish: !!on };
  save(p);
  return p;
}
export function cancelPublish(id) { publishing.get(id)?.abort(); }

/** Subtitle export follows the project's trim and digit style. */
export function subtitleOptions(p) {
  const e = p.edit || {};
  return { segments: renderData(p).segments, digits: e.typography?.digits || getSettings().look.typography?.digits || 'latin' };
}

/** Everything render.html needs; times are resolved here so the page stays deterministic. */
export function renderData(p) {
  if (!p.words || !p.storyboard) throw httpError(409, 'storyboard is not ready');
  const E = effectiveEdit(p.edit);
  const L = layoutFor(E.export.aspect, E.export.resolution);
  const typo = typographyFor(p.edit);
  const lastEnd = p.words[p.words.length - 1]?.end || 0;
  const full = Math.max(p.voice?.duration || 0, lastEnd + 0.3) + 0.6;
  const start = Math.min(E.trim.start, full - 1);
  const end = E.trim.end ? Math.min(E.trim.end, full) : full;
  let segments = keptSegments(start, end, E.cuts);
  if (outDuration(segments) < 0.5) segments = [[start, end]]; // a cut list that removes everything is ignored
  const sc = p.storyboard.scenes;
  const scenes = sc.map((s, i) => ({
    ...s,
    start: i === 0 ? 0 : p.words[s.at].start,
    end: i + 1 < sc.length ? p.words[sc[i + 1].at].start : full,
    items: s.items.map((it) => ({ ...it, t: it.at != null ? p.words[it.at].start : null })),
    clip: p.clips?.[`scene-${i}`] ? clipRef(p, `scene-${i}`) : null,
  }));
  const media = {};
  const addMedia = (id) => {
    const a = id && getAsset(id);
    if (!a || media[id]) return;
    media[id] = { kind: a.kind, name: a.name, src: a.kind === 'image' ? `/api/assets/${id}/scaled?max=${Math.max(L.width, L.height)}` : `/api/assets/${id}/file`, width: a.width, height: a.height, duration: a.duration };
  };
  scenes.forEach((s) => addMedia(s.image));
  E.overlays.forEach((o) => addMedia(o.asset));
  return {
    id: p.id, title: p.script?.title || p.topic, seriesTag: getSettings().seriesTag, duration: outDuration(segments), start, end, full, segments, fps: E.export.fps,
    music: E.audio.music && getAsset(E.audio.music.asset) ? { src: `/api/assets/${E.audio.music.asset}/file`, volume: E.audio.music.volume, voiceVolume: E.audio.voiceVolume } : null,
    theme: { name: getSettings().look.theme, colors: resolvePalette(), grid: getSettings().look.grid !== false },
    layout: L, typography: typo, transition: E.transition,
    words: p.words.map(({ i, text, line, start: st, end: en }) => ({ i, text, line, start: st, end: en })),
    accents: p.storyboard.accents, scenes, icons: p.icons || {}, media,
    overlays: E.overlays.map((o) => ({ ...o, clip: p.clips?.[`ov-${o.id}`] ? clipRef(p, `ov-${o.id}`) : null })),
    fonts: { main: facesFor(typo.font), captions: facesFor(typo.captionFont) },
  };
}
/** Video overlays whose sound is turned up → mix inputs (source time). Files without an audio stream are skipped. */
async function clipSounds(overlays) {
  const out = [];
  for (const o of overlays) {
    if (o.kind !== 'video' || !(o.volume > 0)) continue;
    const a = getAsset(o.asset);
    if (!a || !(await hasAudio(a))) continue;
    out.push({ file: assetFile(a), at: o.start, offset: o.offset || 0, length: Math.min(o.end - o.start, Math.max(0.1, (a.duration || 1e9) - (o.offset || 0))), volume: o.volume });
  }
  return out;
}
async function hasAudio(a) {
  if (typeof a.hasAudio === 'boolean') return a.hasAudio;
  const { out } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', assetFile(a)]).catch(() => ({ out: '' }));
  return out.includes('audio');
}
const clipRef = (p, ref) => ({ ...p.clips[ref], url: `/api/projects/${p.id}/clips/${encodeURIComponent(p.clips[ref].key)}/` });
