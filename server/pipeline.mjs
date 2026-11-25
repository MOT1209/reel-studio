// Projects + the 5-stage pipeline (script → voice → timing → storyboard → render).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, getSettings, resolveFonts, resolvePalette, writeFileAtomic } from './settings.mjs';
import { chatStream, ttsWithTimestamps, ttsOpenAI, transcribeWords, applyPronunciation } from './apis.mjs';
import { estimateWords } from './estimate.mjs';
import { scriptMessages, researchMessages, parseScript, tokenize, countWords, charsToWords, wordsWithChars, alignWords, WORDS_PER_SECOND, LENGTHS } from './text.mjs';
import { storyboardMessages, reviewMessages, sceneMessages, extractJson, repairStoryboard, storyboardNouns, TEMPLATES } from './storyboard.mjs';
import { assertStoryboard } from './scene-schema.mjs';
import { iconsFor } from './icons.mjs';
import { redact, log as slog } from './logger.mjs';
import { uploadVideo, videoMetadata, youtubeStatus } from './youtube.mjs';
import { run, probeDuration, writeSfx, mixAudio, muxFinal, contactSheet, validateOutput } from './render.mjs';
import { renderVideo } from './engines/manager.mjs';
import { effectiveEdit, cleanEdit, layoutFor, prepareClip, checkRenderInputs } from './edit.mjs';
import { facesFor, typographyFor } from './fonts.mjs';
import { getAsset, assetFile, creditsFor } from './assets.mjs';
import * as PV from './providers.mjs';
import { keptSegments, outDuration, srcToOut, outToSrc, sequenceToSegments, isHold } from './timeline.mjs';
import { PLATFORMS, PLATFORM_IDS, durationCheck } from './platforms.mjs';
import { PROFILES, profileOf, MIN_SECONDS, MAX_SECONDS, durationCategory } from './profiles.mjs';
import * as LF from './longform.mjs';

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
  // the classic reel lengths, or any whole number of seconds up to 30 minutes (long-form: chapters)
  if (!LENGTHS.includes(seconds) && !(Number.isInteger(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS)) {
    throw httpError(400, `length must be one of ${LENGTHS.join(', ')} or a whole number of seconds from ${MIN_SECONDS} to ${MAX_SECONDS}`);
  }
  const profile = PROFILES[options.profile] ? options.profile : 'short';
  // a long video with no platform chosen goes to landscape YouTube, not a 9:16 Short
  if (!options.platform && !options.aspect && typeof seconds === 'number' && seconds > 180) options = { ...options, platform: profileOf(profile).platform === 'youtube-shorts' ? 'youtube' : profileOf(profile).platform };
  else if (!options.platform && !options.aspect && profile !== 'short') options = { ...options, platform: profileOf(profile).platform };
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const p = {
    id, topic, seconds, createdAt: new Date().toISOString(), updatedAt: null,
    voiceMode: voiceMode === 'upload' ? 'upload' : 'tts', upload: null,
    approvals: Object.fromEntries(STAGES.map((s) => [s, (approvals[s] || getSettings().approvals?.[s]) === 'wait' ? 'wait' : 'auto'])),
    options: {
      forceTemplate: TEMPLATES.includes(options.forceTemplate) ? options.forceTemplate : null, publish: options.publish ?? !!getSettings().youtube?.autoPublish,
      dialect: ['msa', 'levantine', 'gulf'].includes(options.dialect) ? options.dialect : 'egyptian', research: options.research !== false,
      profile,
    },
    category: durationCategory(seconds),
    outline: null, chapters: null, storyboardDrafts: null,
    research: null,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'idle', error: null, log: [], startedAt: null, endedAt: null }])),
    script: null, voice: null, words: null, timing: null, storyboard: null, storyboardFixes: [], icons: null, render: null, clips: {},
    edit: PLATFORMS[options.platform] ? { export: { platform: options.platform, aspect: PLATFORMS[options.platform].aspect, resolution: PLATFORMS[options.platform].resolution, fps: PLATFORMS[options.platform].fps } }
      : ['9:16', '1:1', '16:9', '4:5'].includes(options.aspect) ? { export: { aspect: options.aspect } } : {},
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
          // the render stage queues inside the engine manager (render.maxJobs), where the heavy part runs
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

/** Stops every running pipeline and publish and waits for them (used by the graceful shutdown). */
export async function shutdown() {
  // running stages AND uploads (auto-publish starts after the stage loop, manual ones are not in `running` at all)
  const ids = [...new Set([...running.keys(), ...publishing.keys()])];
  for (const id of publishing.keys()) cancelPublish(id);
  await Promise.all([...ids.map((id) => stopRun(id)), ...[...publishDone.values()]]);
  for (const id of ids) { const p = cache.get(id); if (p) { try { save(p); } catch {} } }
  return ids.length;
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
  if (stage === 'script' && p.chapters) p.chapters.forEach((c) => { c.approved = true; });
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
  // re-running the script of a long-form project means a new outline and new chapters (resume is "▶ continue")
  if (stage === 'script' && LF.isLongform(p)) { p.outline = null; p.chapters = null; }
  if (stage === 'script' || stage === 'storyboard') p.storyboardDrafts = null;
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
    assertStoryboard(storyboard, { words: p.words });
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
  // long-form: the narration is the chapters; a free edit of the joined text would silently lose the chapter boundaries
  if (stage === 'script' && p.chapters?.length && String(body.text).trim() !== LF.joinChapters(p.chapters)) throw httpError(409, 'this is a long-form project: edit the chapters one by one (the title and sources can be edited here)');
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
  if (!buf?.length) throw httpError(400, 'empty upload');
  if (!looksLikeMedia(buf)) throw httpError(415, UPLOAD_BAD);
  const tmp = path.join(projectDir(id), `.upload-${crypto.randomBytes(6).toString('hex')}`);
  if (!getProject(id)) throw httpError(404, 'project not found');
  fs.writeFileSync(tmp, buf);
  return saveUploadFile(id, tmp, filename, mime);
}
const UPLOAD_BAD = 'الملف مش ملف صوت معروف (mp3/wav/m4a/aac/ogg/opus/flac/webm/mp4)';

/** Takes ownership of an already-written temp file (streamed from the request — never held in RAM). Always removes it on failure. */
export async function saveUploadFile(id, tmp, filename, mime) {
  try {
    const p = getProject(id);
    if (!p) throw httpError(404, 'project not found');
    const fd = fs.openSync(tmp, 'r'); const head = Buffer.alloc(64); const got = fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
    if (!got) throw httpError(400, 'empty upload');
    if (!looksLikeMedia(head.subarray(0, got))) throw httpError(415, UPLOAD_BAD);
    await stopForEdit(p, 'new voice-over uploaded');
    const ext = (path.extname(filename || '').toLowerCase().match(/^\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mp4)$/) || [, 'mp3'])[1];
    for (const f of fs.readdirSync(projectDir(id))) if (f.startsWith('upload.')) fs.rmSync(path.join(projectDir(id), f));
    const dest = path.join(projectDir(id), `upload.${ext}`);
    try { fs.renameSync(tmp, dest); } catch { fs.copyFileSync(tmp, dest); fs.rmSync(tmp, { force: true }); }
    const size = fs.statSync(dest).size;
    p.upload = { file: `upload.${ext}`, mime: mime || 'audio/mpeg', name: String(filename || '').slice(0, 120), size };
    p.voiceMode = 'upload';
    if (p.stages.voice.status !== 'idle') resetFrom(p, 'voice');
    log(p, 'voice', `uploaded voice-over ${p.upload.name || p.upload.file} (${(size / 1024).toFixed(0)} KB)`);
    save(p);
  } finally { fs.rmSync(tmp, { force: true }); }
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
    // a long-form script interrupted half-way keeps its research and written chapters (resume, not restart)
    const resuming = LF.isLongform(p) && p.chapters?.some((c) => c.status === 'written');
    if (!resuming) p.research = null;
    if (!resuming && p.options?.research !== false) {
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
    if (LF.isLongform(p)) return longScript(p, signal, s);
    const { text, model } = await chatStream(s, scriptMessages(p.topic, p.seconds, { dialect: p.options?.dialect, research: p.research, brief: profileOf(p.options?.profile).writer }), {
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
    const provider = s.tts?.provider === 'openai' ? 'openai' : 'elevenlabs';
    if (spoken.text.length > TTS_MAX_CHARS[provider]) return voiceInParts(p, signal, { s, provider, text: spoken.text, out, fixed: spoken.text !== p.script.text });
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
      // long narration: Deepgram needs longer than the default 5 minutes to answer for a 30-minute file
      const dw = await transcribeWords(s, buf, 'audio/mpeg', { signal, timeout: Math.max(300000, Math.round((p.voice.duration || 0) * 1000)) });
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
    if (p.chapters?.length) return longStoryboard(p, signal, s);
    const duration = p.voice.duration;
    const pr = profileOf(p.options?.profile);
    const ctx = { title: p.script.title, words: p.words, duration, forceTemplate: p.options.forceTemplate, ...(p.options?.profile && p.options.profile !== 'short' ? { visual: pr.visual, templates: pr.templates } : {}) };
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
    assertStoryboard(final.storyboard, { words: p.words });
    log(p, 'storyboard', `scene JSON valid (schema ${final.storyboard.scenes.length} scenes)`);
    p.storyboard = final.storyboard;
    p.storyboardFixes = final.fixes;
    await autoVisuals(p, signal);
    p.icons = iconsFor(storyboardNouns(final.storyboard));
    log(p, 'storyboard', `templates: ${final.storyboard.scenes.map((sc) => `${sc.type}/${sc.template}@${sc.at}`).join(' · ')}`);
    log(p, 'storyboard', `icons: ${Object.entries(p.icons).map(([n, v]) => `${n}→${v.key}`).join(', ')}`);
  },

  async render(p, signal) {
    const dir = projectDir(p.id);
    // every engine receives validated scene JSON — an invalid storyboard stops here with the exact problems
    assertStoryboard(p.storyboard, { words: p.words });
    const E = effectiveEdit(p.edit);
    const L = layoutFor(E.export.aspect, E.export.resolution);
    { // validation gate: never start a long render on input the renderer cannot use
      const rd = renderData(p);
      const problems = checkRenderInputs({ words: p.words, storyboard: p.storyboard, edit: E, voiceExists: fs.existsSync(path.join(dir, 'voice.mp3')), hasAsset: (id) => !!getAsset(id), duration: rd.duration });
      if (problems.length) throw new Error(`render input check failed: ${problems.join('; ')}`);
    }
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
    log(p, 'render', `${duration.toFixed(2)} s${E.sequence ? ` · custom order: ${segments.filter((x) => !isHold(x)).length} parts, ${segments.filter(isHold).length} pause(s)` : `${start || data.end < data.full ? ` (trim ${start.toFixed(2)}→${data.end.toFixed(2)})` : ''}${segments.length > 1 ? ` · ${segments.length - 1} cut(s)` : ''}`} · ${Math.ceil(duration * FPS)} frames @ ${FPS} fps · ${L.width}×${L.height} (${E.export.aspect}) · ${E.export.quality}`);
    if (data.platform?.check.level === 'over') log(p, 'render', `⚠ ${data.platform.check.message}`);
    const tmpVideo = path.join(dir, 'frames.mp4');
    const key = crypto.createHash('sha256').update(JSON.stringify({ data, q: E.export.quality, v: 2 })).digest('hex').slice(0, 16);
    let lastEmit = 0;
    const total = Math.ceil(duration * FPS - 1e-9);
    const job = await renderVideo({
      project: p.id, engine: E.export.engine, fallback: getSettings().render.fallback !== false,
      source: {
        projectId: p.id, port: serverPort, data, url: `http://127.0.0.1:${serverPort}/render.html?project=${p.id}`,
        timeOf: (i) => outToSrc(i / FPS, segments),
      },
      total, out: tmpVideo, fps: FPS, width: L.width, height: L.height, quality: E.export.quality, codec: E.export.codec, bitrate: E.export.bitrate,
      segDir: path.join(dir, 'segments'), key, signal, log: (l) => log(p, 'render', l),
      onJob: (j) => bus(p.id).emit('event', { type: 'job', data: j }),
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
    // audio is made exactly as long as the rendered frames (frames/fps ≥ duration), so the mux never has to cut video
    const vdur = Math.ceil(duration * FPS - 1e-9) / FPS;
    writeSfx(path.join(dir, 'sfx.wav'), vdur, audioCfg.whoosh ? cuts : [], audioCfg.tick ? ticks.sort((a, b) => a - b) : [], E.audio.sfxVolume);
    const musicAsset = E.audio.music && getAsset(E.audio.music.asset);
    if (E.audio.music && !musicAsset) log(p, 'render', '⚠ music file is no longer in the library — rendering without it');
    await mixAudio({
      voice: path.join(dir, 'voice.mp3'), sfx: path.join(dir, 'sfx.wav'), out: path.join(dir, 'mix.m4a'), duration: vdur, segments, voiceVolume: E.audio.voiceVolume,
      clips: await clipSounds(E.overlays, E.audio.tracks || []),
      music: musicAsset ? { ...E.audio.music, file: assetFile(musicAsset) } : null, signal, log: (l) => log(p, 'render', l),
    });
    // mux into a temp file, prove it with ffprobe (size, fps, codec, EXACT frame count, audio, durations), then rename
    const probe = await muxFinal({ video: tmpVideo, audio: path.join(dir, 'mix.m4a'), out: path.join(dir, 'video.mp4'), signal,
      expect: { width: L.width, height: L.height, fps: FPS, frames: total, duration: vdur, codec: job.codec } });
    log(p, 'render', `checked: ${probe.width}×${probe.height} · ${probe.fps} fps · ${probe.frames} frames · ${probe.video}/${probe.audio} · ${probe.duration.toFixed(2)} s`);
    await contactSheet({ video: path.join(dir, 'video.mp4'), out: path.join(dir, 'contact.jpg'), duration, aspect: E.export.aspect });
    // temporary files: segments, the silent video and the SFX track are not needed once the MP4 exists
    for (const f of [tmpVideo, path.join(dir, 'sfx.wav')]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
    const used = [...data.scenes.map((sc) => sc.image), ...E.overlays.map((o) => o.asset), ...(E.audio.tracks || []).map((x) => x.asset), musicAsset?.id].filter(Boolean);
    p.render = {
      file: 'video.mp4', contact: 'contact.jpg', duration: +duration.toFixed(3), frames: Math.ceil(duration * FPS), fps: FPS, theme: data.theme.name,
      width: L.width, height: L.height, aspect: E.export.aspect, quality: E.export.quality, credits: creditsFor(used), at: new Date().toISOString(),
      engine: job.engine, fallbackFrom: job.fallbackFrom, codec: job.codec, bitrate: E.export.bitrate, renderSeconds: job.seconds, job: job.id,
      chapters: renderChapters(p, toOut),
    };
    if (p.render.chapters) log(p, 'render', `chapters: ${p.render.chapters.map((c) => `${c.start.toFixed(1)} s ${c.title}`).join(' · ')}`);
    const outDir = getSettings().render.outputDir;
    if (outDir) {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const name = `${(p.topic || p.id).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 60) || p.id} - ${p.id}.mp4`;
        fs.copyFileSync(path.join(dir, 'video.mp4'), path.join(outDir, name));
        p.render.exported = path.join(outDir, name);
        log(p, 'render', `copied to ${p.render.exported}`);
      } catch (e) { log(p, 'render', `⚠ output folder: ${e.message}`); }
    }
    log(p, 'render', `video.mp4 ready (${(fs.statSync(path.join(dir, 'video.mp4')).size / 1e6).toFixed(1)} MB) · contact sheet saved${p.render.credits.length ? ` · ${p.render.credits.length} credits` : ''}`);
  },
};

// ---- long-form ------------------------------------------------------------------------
/**
 * Long-form storyboard: every chapter is designed in windows of ≈ 2 minutes (one LLM call each, ≤ 16 scenes, so the
 * reply stays inside the token limit). Each window's draft is saved under a hash of its words: a resume, or a new
 * storyboard after editing one chapter, only asks the LLM for windows whose words changed. The merged drafts go
 * through the same repair and scene-schema validation as a short storyboard.
 */
async function longStoryboard(p, signal, s) {
  const pr = profileOf(p.options?.profile);
  const ranges = LF.chapterRanges(p.chapters);
  const windows = LF.storyboardWindows(ranges, p.words, { windowSec: Math.min(120, pr.sceneSeconds * 15) });
  const cache = p.storyboardDrafts || {};
  const drafts = [];
  let asked = 0;
  log(p, 'storyboard', `long-form: ${ranges.length} chapters → ${windows.length} storyboard windows · ~${pr.sceneSeconds} s per scene`);
  bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', reset: true } });
  const emit = (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', delta: d } });
  for (const w of windows) {
    if (signal.aborted) throw new Error('cancelled');
    if (cache[w.key]) { drafts.push(cache[w.key]); continue; }
    emit(`\n\n— ${w.title} (${w.start.toFixed(0)}–${w.end.toFixed(0)} s) —\n`);
    const ctx = {
      title: `${p.script.title} — ${w.title}`, words: p.words.slice(w.w0, w.w1), duration: w.end - w.start, forceTemplate: p.options.forceTemplate,
      sceneSeconds: pr.sceneSeconds, maxScenes: 16, window: { first: w.w0 === 0, chapter: w.title }, visual: pr.visual, templates: pr.templates,
    };
    const r = await chatStream(s, storyboardMessages(ctx), { signal, onDelta: emit, temperature: 0.6, maxTokens: 6000 });
    let raw;
    try { raw = extractJson(r.text); } catch (e) { log(p, 'storyboard', `⚠ window ${w.k + 1} (${w.title}): ${e.message} — one title scene instead`); raw = { scenes: [] }; }
    cache[w.key] = { scenes: Array.isArray(raw.scenes) ? raw.scenes : [], accents: Array.isArray(raw.accents) ? raw.accents : [] };
    drafts.push(cache[w.key]);
    asked++;
    p.storyboardDrafts = cache;
    log(p, 'storyboard', `window ${w.k + 1}/${windows.length} (${w.title}): ${cache[w.key].scenes.length} scenes drafted`);
    save(p); // checkpoint
  }
  // keep only the drafts the current words still use
  p.storyboardDrafts = Object.fromEntries(windows.map((w) => [w.key, cache[w.key]]));
  const merged = LF.mergeWindowDrafts(windows, drafts);
  const r = repairStoryboard(merged, p.words, { forceTemplate: p.options.forceTemplate });
  log(p, 'storyboard', `${r.storyboard.scenes.length} scenes · ${r.fixes.length} repairs · ${asked} windows asked, ${windows.length - asked} reused`);
  r.fixes.slice(0, 40).forEach((f) => log(p, 'storyboard', `  fix: ${f}`));
  if (r.fixes.length > 40) log(p, 'storyboard', `  … ${r.fixes.length - 40} more repairs`);
  assertStoryboard(r.storyboard, { words: p.words });
  log(p, 'storyboard', `scene JSON valid (schema ${r.storyboard.scenes.length} scenes)`);
  p.storyboard = r.storyboard;
  p.storyboardFixes = r.fixes;
  await autoVisuals(p, signal);
  p.icons = iconsFor(storyboardNouns(r.storyboard));
  const count = {};
  r.storyboard.scenes.forEach((sc) => { count[sc.template] = (count[sc.template] || 0) + 1; });
  log(p, 'storyboard', `templates: ${Object.entries(count).map(([t, n]) => `${t}×${n}`).join(' · ')}`);
}

/**
 * Chapter start times in the finished video (output time: trims, cuts and re-ordering applied). A chapter whose first
 * word was cut out starts at its first surviving word; a chapter cut out entirely is dropped. null for short videos.
 */
function renderChapters(p, toOut) {
  if (!p.chapters?.length || !p.words?.length) return null;
  const ranges = LF.chapterRanges(p.chapters);
  if (ranges.at(-1)?.w1 !== p.words.length) return null; // words are not from these chapters (should not happen)
  const out = [];
  for (const r of ranges) {
    let t = null;
    for (let i = r.w0; i < r.w1 && t === null; i++) t = toOut(p.words[i].start);
    if (t !== null && !(out.length && t <= out.at(-1).start)) out.push({ id: r.id, title: r.title, start: out.length ? +t.toFixed(3) : 0 });
  }
  return out;
}

/** Exact length of a PCM WAV from its "data" chunk (ffmpeg may add a LIST chunk before it). */
function wavSeconds(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(4096); const n = fs.readSync(fd, h, 0, h.length, 0);
    const rate = h.readUInt32LE(24), block = h.readUInt16LE(32);
    for (let o = 12; o + 8 <= n;) {
      const id = h.toString('ascii', o, o + 4), size = h.readUInt32LE(o + 4);
      if (id === 'data') return Math.min(size, fs.fstatSync(fd).size - o - 8) / (rate * block);
      o += 8 + size + (size & 1);
    }
  } finally { fs.closeSync(fd); }
  throw new Error(`no audio data in ${path.basename(file)}`);
}

/** Longest text sent in one TTS request (below the providers' per-request limits). */
const TTS_MAX_CHARS = { elevenlabs: 4500, openai: 4000 };
{ // RS_TTS_MAX_CHARS: a lower per-request limit (200–4000), e.g. for a provider plan with a smaller limit, or tests
  const v = Number(process.env.RS_TTS_MAX_CHARS);
  if (Number.isInteger(v) && v >= 200 && v <= 4000) { TTS_MAX_CHARS.elevenlabs = v; TTS_MAX_CHARS.openai = v; }
}

/**
 * Narration longer than one TTS request: split at line breaks, voice each part (cached on disk by its text + voice
 * settings, so a resume or an edit of one chapter only pays for the parts that changed), decode every part to PCM,
 * place the parts back to back with exact sample offsets, and encode one voice.mp3. ElevenLabs character times are
 * shifted by each part's offset, so the timing stage sees one continuous alignment.
 */
async function voiceInParts(p, signal, { s, provider, text, out, fixed }) {
  const dir = projectDir(p.id), pdir = path.join(dir, 'voice-parts');
  fs.mkdirSync(pdir, { recursive: true });
  const parts = LF.splitForTts(text, TTS_MAX_CHARS[provider]);
  const cfg = provider === 'openai'
    ? { baseUrl: s.openaiTts.baseUrl, model: s.openaiTts.model, voice: s.openaiTts.voice, speed: s.openaiTts.speed }
    : { voiceId: s.elevenlabs.voiceId, modelId: s.elevenlabs.modelId, stability: s.elevenlabs.stability, style: s.elevenlabs.style, speed: s.elevenlabs.speed };
  log(p, 'voice', `${provider === 'openai' ? `OpenAI-compatible TTS ${cfg.model} · voice ${cfg.voice}` : `ElevenLabs voice ${cfg.voiceId || '(none)'} · ${cfg.modelId}`} · ${text.length} characters in ${parts.length} parts${fixed ? ' · pronunciation fixes applied' : ''}`);
  const FF = process.env.FFMPEG_PATH || 'ffmpeg';
  const keep = new Set();
  const chars = [];
  const list = [];
  let offset = 0, reused = 0;
  for (const [k, part] of parts.entries()) {
    if (signal.aborted) throw new Error('cancelled');
    const key = crypto.createHash('sha256').update(JSON.stringify({ provider, cfg, text: part.text, v: 1 })).digest('hex').slice(0, 20);
    const mp3 = path.join(pdir, `${key}.mp3`), meta = path.join(pdir, `${key}.json`), wav = path.join(pdir, `${key}.wav`);
    keep.add(`${key}.mp3`); keep.add(`${key}.json`);
    let m = null;
    try { if (fs.existsSync(mp3)) m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { m = null; }
    if (m) reused++;
    else {
      if (provider === 'openai') { writeFileAtomic(mp3, await ttsOpenAI(s, part.text, { signal })); m = { chars: null }; }
      else { const r = await ttsWithTimestamps(s, part.text, { signal }); writeFileAtomic(mp3, r.audio); m = { chars: r.chars }; }
      writeFileAtomic(meta, JSON.stringify(m)); // written last: a part only counts as done once both files exist
      log(p, 'voice', `part ${k + 1}/${parts.length}: ${part.text.length} characters voiced`);
    }
    // decode → PCM: the exact sample count is the part's real length (mp3 frame padding would drift over 30 minutes)
    await run(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', wav], { signal });
    const dur = wavSeconds(wav);
    if (m.chars) {
      for (const c of m.chars) chars.push({ c: c.c, start: +(c.start + offset).toFixed(4), end: +(c.end + offset).toFixed(4) });
      chars.push({ c: part.sep === ' ' ? ' ' : '\n', start: +(offset + dur).toFixed(4), end: +(offset + dur).toFixed(4) });
    }
    list.push(`file '${wav.replace(/'/g, "'\\''")}'`);
    offset += dur;
  }
  const listFile = path.join(pdir, 'concat.txt');
  fs.writeFileSync(listFile, list.join('\n') + '\n');
  await run(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '192k', `${out}.part.mp3`], { signal });
  fs.renameSync(`${out}.part.mp3`, out);
  // the decoded parts are temporary; the mp3 parts stay as the cache (parts no longer in the script are removed)
  for (const f of fs.readdirSync(pdir)) if (!keep.has(f)) fs.rmSync(path.join(pdir, f), { force: true });
  if (provider === 'elevenlabs') {
    const timed = charsToWords(chars);
    writeFileAtomic(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'elevenlabs', parts: parts.length, chars, words: timed.map(({ chars: _c, ...w }) => w) }));
    p.voice = { file: 'voice.mp3', source: 'elevenlabs', duration: await probeDuration(out), chars: chars.length, timedWords: timed.length, parts: parts.length, reusedParts: reused };
  } else {
    fs.rmSync(path.join(dir, 'voice-timing.json'), { force: true });
    p.voice = { file: 'voice.mp3', source: 'openai', duration: await probeDuration(out), parts: parts.length, reusedParts: reused };
  }
  log(p, 'voice', `voice.mp3 ${(p.voice.duration / 60).toFixed(1)} min (${p.voice.duration.toFixed(1)} s) · ${parts.length} parts, ${reused} reused from cache · sum of parts ${offset.toFixed(2)} s`);
}

/** Plans the chapters (once), then writes every chapter that is not written yet; saves after each one. */
async function longScript(p, signal, s) {
  const profile = p.options?.profile || 'short';
  const emit = (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', delta: d } });
  if (!p.chapters?.length) {
    const count = LF.chapterCount(p.seconds, profile);
    log(p, 'script', `long-form ${profileOf(profile).en}: ${Math.round(p.seconds / 60)} min · planning ${count} chapters`);
    const r = await chatStream(s, LF.outlineMessages({ topic: p.topic, seconds: p.seconds, profile, dialect: p.options?.dialect, research: p.research, count }), { signal, onDelta: emit, temperature: 0.5, maxTokens: 3000 });
    const o = LF.parseOutline(extractJson(r.text), { seconds: p.seconds, count, topic: p.topic });
    o.fixes.forEach((f) => log(p, 'script', `  outline fix: ${f}`));
    p.outline = { title: o.title, sources: o.sources, model: r.model || s.llm.model, at: new Date().toISOString() };
    p.chapters = o.chapters;
    log(p, 'script', `outline: "${o.title}" — ${o.chapters.map((c, i) => `${i + 1}. ${c.title} (${c.seconds} s)`).join(' · ')}`);
    save(p);
  } else log(p, 'script', `resuming: ${p.chapters.filter((c) => c.status === 'written').length}/${p.chapters.length} chapters already written`);
  for (let k = 0; k < p.chapters.length; k++) {
    const c = p.chapters[k];
    if (c.status === 'written' && c.text) continue;
    if (signal.aborted) throw new Error('cancelled');
    emit(`\n\n— ${k + 1}. ${c.title} —\n`);
    await writeChapter(p, k, { signal, s, onDelta: emit });
    save(p); // checkpoint: a crash or cancel resumes at the next chapter
  }
  syncScriptFromChapters(p, { model: p.outline?.model });
  const target = Math.round(p.seconds * WORDS_PER_SECOND);
  log(p, 'script', `"${p.script.title}" — ${p.chapters.length} chapters · ${p.script.words} words ≈ ${(p.script.words / WORDS_PER_SECOND / 60).toFixed(1)} min (target ${target})`);
  if (Math.abs(p.script.words - target) > target * 0.25) log(p, 'script', `⚠ word count is ${p.script.words > target ? 'above' : 'below'} target by ${Math.abs(p.script.words - target)}`);
}

async function writeChapter(p, k, { signal, s = getSettings(), onDelta = () => {}, hint = '' }) {
  const c = p.chapters[k];
  const r = await chatStream(s, LF.chapterMessages({ topic: p.topic, title: p.outline?.title || p.topic, chapters: p.chapters, k, profile: p.options?.profile, dialect: p.options?.dialect, research: p.research, hint }), { signal, onDelta, maxTokens: 4096 });
  c.text = LF.parseChapter(r.text);
  LF.touchChapter(c);
  c.status = 'written'; c.approved = false; c.edited = false; c.model = r.model || s.llm.model;
  log(p, 'script', `chapter ${k + 1} "${c.title}": ${c.words} words ≈ ${(c.words / WORDS_PER_SECOND).toFixed(0)} s (planned ${c.seconds} s)`);
}

/** p.script is always the chapters joined: the voice, timing and captions see one continuous narration. */
function syncScriptFromChapters(p, extra = {}) {
  const text = LF.joinChapters(p.chapters);
  p.script = { ...(p.script || {}), title: p.script?.edited && p.script?.title ? p.script.title : (p.outline?.title || p.topic), text, sources: p.script?.sources?.length && p.script?.edited ? p.script.sources : (p.outline?.sources || []), words: countWords(text), chapters: p.chapters.length, ...extra };
}

/**
 * Chapter operations (long-form): rename, edit text, move, delete, add, approve, regenerate.
 * Anything that changes the narration invalidates the voice and later stages — but the voice is generated per part
 * and cached by text, so only the changed chapters are voiced again.
 */
export async function chapterOp(id, k, op, body = {}) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!p.chapters?.length && op !== 'add') throw httpError(409, 'this project has no chapters (long-form projects only)');
  // a long-form project can also be written by hand: the first "add" creates the chapter list (no outline, no LLM)
  if (op === 'add' && !p.chapters && LF.isLongform(p) && !p.script) p.chapters = [];
  const n = p.chapters?.length || 0;
  const idx = op === 'add' ? null : Number(k);
  if (op !== 'add' && !(Number.isInteger(idx) && idx >= 0 && idx < n)) throw httpError(400, `chapter must be 0…${n - 1}`);
  if (op === 'add' && !p.chapters) throw httpError(409, 'this project has no chapters (long-form projects only)');
  const c = idx === null ? null : p.chapters[idx];
  let narration = true;
  if (op === 'rename') {
    const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) throw httpError(400, 'title is required');
    c.title = title; narration = false;
  } else if (op === 'approve') {
    c.approved = body.approved !== false; narration = false;
  } else if (op === 'edit') {
    const text = String(body.text ?? '').trim();
    if (!text) throw httpError(400, 'chapter text is empty — delete the chapter instead');
    if (typeof body.title === 'string' && body.title.trim()) c.title = body.title.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (typeof body.goal === 'string') c.goal = body.goal.trim().slice(0, 400);
    c.text = text; LF.touchChapter(c); c.status = 'written'; c.edited = true; c.approved = false;
  } else if (op === 'move') {
    const to = Number(body.to);
    if (!(Number.isInteger(to) && to >= 0 && to < n)) throw httpError(400, `to must be 0…${n - 1}`);
    if (to === idx) narration = false;
    p.chapters.splice(to, 0, p.chapters.splice(idx, 1)[0]);
  } else if (op === 'delete') {
    if (n <= 1) throw httpError(409, 'a video needs at least one chapter');
    p.chapters.splice(idx, 1);
  } else if (op === 'add') {
    if (n >= LF.MAX_CHAPTERS) throw httpError(409, `at most ${LF.MAX_CHAPTERS} chapters`);
    const at = body.after === undefined ? n : Math.max(0, Math.min(n, Number(body.after) + 1));
    const ch = { id: LF.newChapterId(), title: String(body.title || `الفصل ${at + 1}`).trim().slice(0, 60), goal: String(body.goal || '').trim().slice(0, 400), seconds: Math.max(20, Math.min(600, Number(body.seconds) || 120)), text: String(body.text || '').trim(), words: 0, status: 'pending', approved: false, edited: false };
    if (ch.text) { LF.touchChapter(ch); ch.status = 'written'; ch.edited = true; }
    p.chapters.splice(at, 0, ch);
  } else if (op === 'regenerate') {
    await stopForEdit(p, `chapter ${idx + 1} regenerated`);
    const ctl = new AbortController();
    await writeChapter(p, idx, { signal: ctl.signal, hint: String(body.hint || '').slice(0, 300) });
  } else throw httpError(400, `unknown chapter operation "${op}"`);
  if (narration) {
    if (op !== 'regenerate') await stopForEdit(p, `chapter ${op}`);
    const written = p.chapters.every((x) => x.status === 'written' && x.text);
    if (written) {
      syncScriptFromChapters(p);
      log(p, 'script', `✎ chapter ${op}${c ? ` "${c.title}"` : ''} → ${p.chapters.length} chapters · ${p.script.words} words`);
      if (p.stages.script.status === 'idle' || p.stages.script.status === 'error') p.stages.script.status = p.approvals.script === 'wait' ? 'review' : 'done';
      resetFrom(p, 'voice');
    } else {
      // a new empty chapter: the script stage writes it on the next run
      log(p, 'script', `✎ chapter ${op} — ${p.chapters.filter((x) => x.status !== 'written').length} chapter(s) still to write`);
      resetFrom(p, 'script');
    }
  } else log(p, 'script', `✎ chapter ${idx + 1} ${op === 'approve' ? (c.approved ? 'approved' : 'approval removed') : `renamed to "${c.title}"`}`);
  // approving the last chapter approves the stage
  if (op === 'approve' && p.stages.script.status === 'review' && p.chapters.every((x) => x.approved)) {
    p.stages.script.status = 'done';
    log(p, 'script', '✔ all chapters approved');
    save(p);
    runPipeline(id);
    return publicProject(p);
  }
  save(p);
  return publicProject(p);
}

/**
 * Automatic visual selection: every "photo" scene without an image gets the best stock result for its query from the
 * first configured provider (Pexels → Pixabay → Unsplash), imported with its licence. Without a provider, or when the
 * search fails, the scene falls back to an illustrated template — never a broken frame.
 */
async function autoVisuals(p, signal) {
  const status = PV.providerStatus();
  const provider = ['pexels', 'pixabay', 'unsplash'].find((k) => status[k].configured);
  const orientation = { '9:16': 'portrait', '1:1': 'square', '16:9': 'landscape' }[effectiveEdit(p.edit).export.aspect];
  // after 3 failed searches in a row (rate limit, outage) the remaining photo scenes fall back without more requests
  let failures = 0;
  for (const [k, sc] of p.storyboard.scenes.entries()) {
    if (sc.template !== 'photo' || sc.image) continue;
    if (signal?.aborted) throw new Error('cancelled');
    const q = sc.query || sc.items.map((it) => it.icon).filter(Boolean).join(' ') || sc.title;
    try {
      if (!provider) throw new Error('مفيش مكتبة صور متوصلة (الإعدادات ← المكتبات)');
      if (failures >= 3) throw new Error('المكتبة فشلت 3 مرات ورا بعض — باقي المشاهد بالرسوم');
      const r = await PV.search(provider, q, { kind: 'image', orientation, per: 5 });
      if (!r.items.length) throw new Error(`مفيش نتايج لـ "${r.queryUsed}"`);
      const a = await PV.importResult(provider, r.items[0], { folder: `project-${p.id}` });
      sc.image = a.id;
      failures = 0;
      log(p, 'storyboard', `visual: scene ${k + 1} ← ${status[provider].name} "${r.queryUsed}" (${a.license.name}${a.source.author ? ', ' + a.source.author : ''})`);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (provider) failures++;
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
    assertStoryboard(r.storyboard, { words: words || p.words });
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

/**
 * Regenerates one scene with the LLM (optionally steered by a hint), keeps its start word and media, repairs and
 * validates the whole storyboard, and resets the render. The other scenes are untouched.
 */
const regenerating = new Set();
export async function regenerateScene(id, k, { hint = '' } = {}) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (!p.words || !p.storyboard) throw httpError(409, 'storyboard is not ready');
  const scenes = p.storyboard.scenes;
  k = Number(k);
  if (!Number.isInteger(k) || k < 0 || k >= scenes.length) throw httpError(400, `scene ${k} does not exist`);
  if (regenerating.has(id)) throw httpError(409, 'a scene is already being regenerated');
  regenerating.add(id);
  try {
    const sc = scenes[k];
    const to = k + 1 < scenes.length ? scenes[k + 1].at : p.words.length;
    const msgs = sceneMessages({ title: p.script?.title || p.topic, words: p.words.slice(sc.at, to), scene: sc, prev: scenes[k - 1], next: scenes[k + 1], hint: String(hint || '').slice(0, 300) });
    const r = await chatStream(getSettings(), msgs, { temperature: 0.8, maxTokens: 900 });
    let raw = extractJson(r.text);
    if (Array.isArray(raw?.scenes)) raw = raw.scenes[0];
    if (!raw || typeof raw !== 'object') throw httpError(502, 'the model did not return a scene');
    // the scene keeps its place in time and the media the user picked for it
    const next = { ...raw, at: sc.at, image: raw.template === 'photo' || sc.bg === 'full' ? sc.image : null, bg: sc.bg, imageOffset: sc.imageOffset };
    if (k === 0) next.type = 'intro';
    const rep = repairStoryboard({ ...p.storyboard, scenes: scenes.map((s, i) => (i === k ? next : s)) }, p.words, { forceTemplate: p.options.forceTemplate });
    assertStoryboard(rep.storyboard, { words: p.words });
    if (rep.storyboard.scenes.length !== scenes.length) throw httpError(422, 'the new scene would merge with a neighbour — try again');
    await stopForEdit(p, 'scene regeneration');
    p.storyboard = rep.storyboard;
    p.icons = iconsFor(storyboardNouns(rep.storyboard));
    resetFrom(p, 'render');
    const ns = rep.storyboard.scenes[k];
    log(p, 'storyboard', `↻ scene ${k + 1} regenerated: ${sc.template} → ${ns.template}${hint ? ` (hint: ${String(hint).slice(0, 60)})` : ''}${rep.fixes.length ? ` · ${rep.fixes.length} auto-fixes` : ''}`);
    save(p);
    return { project: publicProject(p), scene: ns, fixes: rep.fixes };
  } finally { regenerating.delete(id); }
}

// ---- publish (YouTube) ------------------------------------------------------------
const publishing = new Map(); // id → AbortController
const publishDone = new Map(); // id → promise of the running upload (the shutdown waits for it)
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
  let finish; publishDone.set(id, new Promise((r) => { finish = r; }));
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
    publishDone.delete(id);
    save(p);
    finish();
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
  let segments = E.sequence ? sequenceToSegments(E.sequence) : keptSegments(start, end, E.cuts); // custom order wins
  // only the default trim/cut path falls back; a custom sequence is validated (cleanSequence) and kept as is
  if (!E.sequence && outDuration(segments) < 0.5) segments = [[start, end]];
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
    platform: E.export.platform ? { id: E.export.platform, ...PLATFORMS[E.export.platform], check: durationCheck(E.export.platform, outDuration(segments)) } : null,
    words: p.words.map(({ i, text, line, start: st, end: en }) => ({ i, text, line, start: st, end: en })),
    accents: p.storyboard.accents, scenes, icons: p.icons || {}, media,
    overlays: E.overlays.map((o) => ({ ...o, clip: p.clips?.[`ov-${o.id}`] ? clipRef(p, `ov-${o.id}`) : null })),
    fonts: { main: facesFor(typo.font), captions: facesFor(typo.captionFont) },
  };
}
/** Video overlays whose sound is turned up → mix inputs (source time). Files without an audio stream are skipped. */
async function clipSounds(overlays, tracks = []) {
  const out = [];
  // independent audio tracks (sound effects, a second voice, extra music): same source-time mix as clip sounds, so cuts apply
  for (const x of tracks) {
    const a = getAsset(x.asset);
    if (!a || a.kind !== 'audio' || !(x.volume > 0)) continue;
    out.push({ file: assetFile(a), at: x.start, offset: x.offset || 0, length: Math.min(x.end - x.start, Math.max(0.1, (a.duration || 1e9) - (x.offset || 0))), volume: x.volume, fadeIn: x.fadeIn || 0, fadeOut: x.fadeOut || 0 });
  }
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
