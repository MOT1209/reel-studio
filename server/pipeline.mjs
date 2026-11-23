// Projects + the 5-stage pipeline (script → voice → timing → storyboard → render).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, getSettings, resolveFonts, resolvePalette, writeFileAtomic } from './settings.mjs';
import { chatStream, ttsWithTimestamps, transcribeWords } from './apis.mjs';
import { scriptMessages, parseScript, tokenize, countWords, charsToWords, wordsWithChars, alignWords, WORDS_PER_SECOND, LENGTHS } from './text.mjs';
import { storyboardMessages, reviewMessages, extractJson, repairStoryboard, storyboardNouns, TEMPLATES } from './storyboard.mjs';
import { iconsFor } from './icons.mjs';
import { uploadVideo, videoMetadata, youtubeStatus } from './youtube.mjs';
import { run, probeDuration, renderFrames, writeSfx, mixAudio, muxFinal, contactSheet } from './render.mjs';

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
  catch (e) { console.error(`project ${id}: unreadable project.json (${e.message}) — skipped`); return null; }
  if (!p?.stages || !STAGES.every((s) => p.stages[s])) { console.error(`project ${id}: project.json has no stages — skipped`); return null; }
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
    options: { forceTemplate: TEMPLATES.includes(options.forceTemplate) ? options.forceTemplate : null, publish: options.publish ?? !!getSettings().youtube?.autoPublish },
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: 'idle', error: null, log: [], startedAt: null, endedAt: null }])),
    script: null, voice: null, words: null, timing: null, storyboard: null, storyboardFixes: [], icons: null, render: null,
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
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
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
    log(p, 'script', `LLM ${s.llm.baseUrl} · model ${s.llm.model} · ${auto ? 'length: auto (LLM decides)' : `target ${target} words`}`);
    bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', reset: true } });
    const { text, model } = await chatStream(s, scriptMessages(p.topic, p.seconds), {
      signal, onDelta: (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', delta: d } }),
    });
    const parsed = parseScript(text);
    const n = countWords(parsed.text);
    p.script = { ...parsed, words: n, model: model || s.llm.model };
    log(p, 'script', `"${parsed.title}" — ${n} words ≈ ${(n / WORDS_PER_SECOND).toFixed(0)} s${target ? ` (target ${target})` : ''}${model ? ' · ' + model : ''}`);
    if (target && Math.abs(n - target) > target * 0.25) log(p, 'script', `⚠ word count is ${n > target ? 'above' : 'below'} target by ${Math.abs(n - target)} — the video will be ~${(n / WORDS_PER_SECOND).toFixed(0)} s`);
    if (!/عارف\s+ليه/.test(parsed.text)) log(p, 'script', '⚠ series question «عارف ليه؟» not found');
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
    log(p, 'voice', `ElevenLabs voice ${s.elevenlabs.voiceId || '(none)'} · ${s.elevenlabs.modelId}`);
    const { audio, chars } = await ttsWithTimestamps(s, p.script.text, { signal });
    fs.writeFileSync(out, audio);
    const timed = charsToWords(chars);
    fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'elevenlabs', chars, words: timed.map(({ chars: _c, ...w }) => w) }));
    p.voice = { file: 'voice.mp3', source: 'elevenlabs', duration: await probeDuration(out), chars: chars.length, timedWords: timed.length };
    log(p, 'voice', `voice.mp3 ${p.voice.duration.toFixed(2)} s · ${chars.length} timed characters → ${timed.length} words`);
  },

  async timing(p, signal) {
    const dir = projectDir(p.id);
    let timed;
    if (p.voice?.source === 'upload') {
      const s = getSettings();
      log(p, 'timing', `Deepgram ${s.deepgram.model} (${s.deepgram.language}) on uploaded voice`);
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
    p.timing = { weak: weak.length, matchAvg: +avg.toFixed(3), source: p.voice.source };
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
    p.icons = iconsFor(storyboardNouns(final.storyboard));
    log(p, 'storyboard', `templates: ${final.storyboard.scenes.map((sc) => `${sc.type}/${sc.template}@${sc.at}`).join(' · ')}`);
    log(p, 'storyboard', `icons: ${Object.entries(p.icons).map(([n, v]) => `${n}→${v.key}`).join(', ')}`);
  },

  async render(p, signal) {
    const dir = projectDir(p.id);
    const data = renderData(p);
    const duration = data.duration, FPS = data.fps;
    const audioCfg = getSettings().audio;
    log(p, 'render', `${duration.toFixed(2)} s · ${Math.ceil(duration * FPS)} frames @ ${FPS} fps · 1080×1920`);
    const tmpVideo = path.join(dir, 'frames.mp4');
    let lastEmit = 0;
    await renderFrames({
      url: `http://127.0.0.1:${serverPort}/render.html?project=${p.id}`,
      out: tmpVideo, duration, fps: FPS, signal, log: (l) => log(p, 'render', l),
      onFrame: (i, total, jpg) => {
        const now = Date.now();
        if (now - lastEmit > 200 || i === total - 1) { lastEmit = now; bus(p.id).emit('event', { type: 'progress', data: { stage: 'render', frame: i + 1, total } }); }
        if (jpg) { p.lastPreview = jpg; bus(p.id).emit('event', { type: 'preview', data: { t: i / FPS, jpeg: jpg.toString('base64') } }); }
      },
    });
    log(p, 'render', 'mixing voice + SFX, normalising to −14 LUFS');
    const cuts = data.scenes.slice(1).map((sc) => sc.start);
    const ticks = [];
    data.scenes.forEach((sc) => sc.items.forEach((it) => { if (it.at != null) ticks.push(p.words[it.at].start); }));
    writeSfx(path.join(dir, 'sfx.wav'), duration, audioCfg.whoosh ? cuts : [], audioCfg.tick ? ticks.sort((a, b) => a - b) : [], audioCfg.sfxVolume);
    await mixAudio({ voice: path.join(dir, 'voice.mp3'), sfx: path.join(dir, 'sfx.wav'), out: path.join(dir, 'mix.m4a'), duration, signal, log: (l) => log(p, 'render', l) });
    await muxFinal({ video: tmpVideo, audio: path.join(dir, 'mix.m4a'), out: path.join(dir, 'video.mp4'), signal });
    await contactSheet({ video: path.join(dir, 'video.mp4'), out: path.join(dir, 'contact.jpg'), duration });
    fs.rmSync(tmpVideo, { force: true });
    p.render = { file: 'video.mp4', contact: 'contact.jpg', duration: +duration.toFixed(3), frames: Math.ceil(duration * FPS), fps: FPS, theme: data.theme.name, at: new Date().toISOString() };
    log(p, 'render', `video.mp4 ready (${(fs.statSync(path.join(dir, 'video.mp4')).size / 1e6).toFixed(1)} MB) · contact sheet saved`);
  },
};

// ---- publish (YouTube) ------------------------------------------------------------
const publishing = new Map(); // id → AbortController
function plog(p, line) {
  p.publish = p.publish || { status: 'idle', log: [] };
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
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

/** Everything render.html needs; times are resolved here so the page stays deterministic. */
export function renderData(p) {
  if (!p.words || !p.storyboard) throw httpError(409, 'storyboard is not ready');
  const fonts = resolveFonts();
  const lastEnd = p.words[p.words.length - 1]?.end || 0;
  const duration = Math.max(p.voice?.duration || 0, lastEnd + 0.3) + 0.6;
  const sc = p.storyboard.scenes;
  const scenes = sc.map((s, i) => ({
    ...s,
    start: i === 0 ? 0 : p.words[s.at].start,
    end: i + 1 < sc.length ? p.words[sc[i + 1].at].start : duration,
    items: s.items.map((it) => ({ ...it, t: it.at != null ? p.words[it.at].start : null })),
  }));
  return {
    id: p.id, title: p.script?.title || p.topic, seriesTag: getSettings().seriesTag, duration, fps: getSettings().render.fps || 30,
    theme: { name: getSettings().look.theme, colors: resolvePalette(), grid: getSettings().look.grid !== false },
    words: p.words.map(({ i, text, line, start, end }) => ({ i, text, line, start, end })),
    accents: p.storyboard.accents, scenes, icons: p.icons || {},
    fonts: { regular: `/font/${encodeURIComponent(fonts.regular)}`, bold: `/font/${encodeURIComponent(fonts.bold)}` },
  };
}
