// Projects + the 5-stage pipeline (script → voice → timing → storyboard → render).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, getSettings, resolveFonts, resolvePalette, writeFileAtomic } from './settings.mjs';
import { chatStream } from './apis.mjs';
import { countWords, LENGTHS } from './text.mjs';
import { sceneMessages, extractJson, repairStoryboard, storyboardNouns, TEMPLATES } from './storyboard.mjs';
import { LONG_FORM_SECONDS, planChapters, newChapter, assembleProject, distributeEdits, splitScriptByWordCounts, chapterProgress, chapterEdit } from './chapters.mjs';
import { makeStages } from './stage-run.mjs';
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
import { notifyProject } from './webhooks.mjs';

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

/** Chapter summary for the UI/SSE — the full records (words, storyboards) stay on disk and out of every state event. */
function publicChapters(chs) {
  return (chs || []).map((ch) => ({
    id: ch.id, index: ch.index, title: ch.title, seconds: ch.seconds, stages: ch.stages, error: ch.error,
    words: ch.words?.length || 0,
    render: ch.render ? { duration: ch.render.duration, frames: ch.render.frames, file: ch.render.file, status: ch.render.status, engine: ch.render.engine || null, fallbackFrom: ch.render.fallbackFrom || null } : null,
  }));
}

export function publicProject(p) {
  const { lastPreview, icons, chapters, ...rest } = p;
  return {
    ...rest, running: running.has(p.id) ? running.get(p.id).stage : null,
    chapters: chapters?.length ? publicChapters(chapters) : null,
    iconKeys: icons ? Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, v.key])) : null,
    chapterProgress: chapters?.length ? chapterProgress(p) : null,
  };
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
  // a chapter interrupted mid-stage goes back to idle: the next run resumes at that chapter
  for (const ch of p.chapters || []) for (const s of Object.keys(ch.stages || {})) if (ch.stages[s] === 'running') ch.stages[s] = 'idle';
  cache.set(id, p);
  return p;
}

export function listProjects() {
  return fs.readdirSync(PROJECTS_DIR).filter(validId).map(getProject).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({ id: p.id, topic: p.topic, title: p.script?.title || '', seconds: p.seconds, createdAt: p.createdAt, statuses: Object.fromEntries(STAGES.map((s) => [s, p.stages[s].status])), running: running.has(p.id), chapters: p.chapters?.length || null }));
}

export function createProject({ topic, seconds = 30, approvals = {}, voiceMode = 'tts', options = {} }) {
  topic = String(topic || '').trim().slice(0, 300);
  if (!topic) throw httpError(400, 'topic is required');
  seconds = seconds === 'auto' ? 'auto' : Number(seconds);
  if (!LENGTHS.includes(seconds)) throw httpError(400, `length must be one of ${LENGTHS.join(', ')}`);
  const chapterSeconds = Number(options.chapterSeconds);
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const p = {
    id, topic, seconds, createdAt: new Date().toISOString(), updatedAt: null,
    voiceMode: voiceMode === 'upload' ? 'upload' : 'tts', upload: null,
    approvals: Object.fromEntries(STAGES.map((s) => [s, (approvals[s] || getSettings().approvals?.[s]) === 'wait' ? 'wait' : 'auto'])),
    options: {
      forceTemplate: TEMPLATES.includes(options.forceTemplate) ? options.forceTemplate : null, publish: options.publish ?? !!getSettings().youtube?.autoPublish,
      dialect: ['msa', 'levantine', 'gulf'].includes(options.dialect) ? options.dialect : 'egyptian', research: options.research !== false,
      chapters: options.chapters === true ? true : options.chapters === false ? false : 'auto',
      chapterSeconds: Number.isFinite(chapterSeconds) && chapterSeconds >= 5 && chapterSeconds <= 600 ? chapterSeconds : null,
    },
    chapters: null,
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
  notifyProject(p, 'project.created', { createdAt: p.createdAt });
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
  // a long project keeps its progress per chapter: the same stage (and everything after it) is reset there too
  if (p.chapters?.length) {
    for (const ch of p.chapters) {
      for (const s of STAGES.slice(STAGES.indexOf(stage))) {
        ch.stages[s] = 'idle';
        if (s === 'script') { ch.script = null; ch.title = ''; }
        if (s === 'voice') ch.voice = null;
        if (s === 'timing') { ch.words = null; ch.timing = null; }
        if (s === 'storyboard') { ch.storyboard = null; ch.storyboardFixes = []; ch.icons = null; }
        if (s === 'render') { ch.render = null; ch.clips = {}; }
      }
      ch.error = null;
    }
    assembleProject(p);
  }
}

/**
 * Chapters are used when asked for explicitly (chapters: true, e.g. a 3× 10 s test or a deliberately short-chapter
 * video) or above the long-form threshold; chapters: false and an uploaded voice-over keep a project single-pass.
 */
function isChaptered(p) {
  if (p.options?.chapters === false || p.voiceMode === 'upload' || typeof p.seconds !== 'number') return false;
  return p.options?.chapters === true || p.seconds >= LONG_FORM_SECONDS;
}

// ---- control -------------------------------------------------------------------
export function runPipeline(id) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'project not found');
  if (running.has(id)) return false;
  if (!p.chapters?.length && isChaptered(p)) {
    p.chapters = planChapters(p.seconds, { chapterSeconds: p.options?.chapterSeconds || undefined }).map(newChapter);
    log(p, 'script', `long-form: ${p.chapters.length} chapters × ~${Math.round(p.seconds / p.chapters.length)} s — progress is saved after every chapter`);
    save(p);
  }
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
          notifyProject(p, 'project.stage.done', {
            stage, status: st.status,
            ...(stage === 'render' && p.render ? { render: { file: p.render.file, duration: p.render.duration, frames: p.render.frames } } : {}),
          });
          if (st.status === 'review') break;
        } catch (e) {
          const cancelled = entry.controller.signal.aborted || e.name === 'AbortError' || e.message === 'cancelled';
          st.status = cancelled ? 'idle' : 'error';
          st.error = cancelled ? null : e.message;
          st.endedAt = new Date().toISOString();
          // a chapter left "running" is not done: the next run resumes at it
          for (const ch of p.chapters || []) if (ch.stages?.[stage] === 'running') ch.stages[stage] = 'idle';
          log(p, stage, cancelled ? '■ cancelled' : `✖ ${e.message}`);
          save(p);
          if (!cancelled) notifyProject(p, 'project.stage.failed', { stage, error: redact(e.message) });
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
    const title = String(body.title ?? p.script?.title ?? '').trim();
    const sources = Array.isArray(body.sources) ? body.sources.map(String) : p.script?.sources || [];
    if (p.chapters?.length) {
      // an edited full script goes back to the chapters at line boundaries, keeping their sizes
      const parts = splitScriptByWordCounts(text, p.chapters.map((ch) => ch.words?.length || ch.script?.words || 1));
      p.chapters.forEach((ch, i) => {
        ch.script = { ...(ch.script || {}), title, text: parts[i], sources, words: countWords(parts[i]), edited: true };
        if (i === 0) ch.title = title || ch.title;
        ch.stages.script = 'done';
      });
      assembleProject(p);
    } else {
      p.script = { ...(p.script || {}), title, text, sources, edited: true, words: countWords(text) };
    }
  } else if (stage === 'timing') {
    body.words.forEach((w, i) => {
      const s = Number(w.start), e = Number(w.end);
      if (Number.isFinite(s)) p.words[i].start = +s.toFixed(3);
      if (Number.isFinite(e)) p.words[i].end = +Math.max(e, p.words[i].start + 0.05).toFixed(3);
      if (typeof w.text === 'string' && w.text.trim()) p.words[i].text = w.text.trim();
    });
    if (p.chapters?.length) distributeEdits(p, p.words, null);
  } else {
    const { storyboard, fixes } = repairStoryboard(body._parsed, p.words, { forceTemplate: p.options.forceTemplate });
    assertStoryboard(storyboard, { words: p.words });
    if (p.chapters?.length) distributeEdits(p, null, storyboard);
    else { p.storyboard = storyboard; p.storyboardFixes = fixes; p.icons = iconsFor(storyboardNouns(storyboard)); }
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
    if (p.chapters?.length) throw httpError(409, 'المشروع ده بالنظام الفصلي — الصوت المرفوع للمشاريع القصيرة فقط');
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
  if (p.chapters?.length && mode === 'upload') throw httpError(409, 'المشروع ده بالنظام الفصلي — الصوت المرفوع للمشاريع القصيرة فقط');
  if ((mode === 'upload' ? 'upload' : 'tts') !== p.voiceMode) await stopForEdit(p, 'voice mode changed');
  p.voiceMode = mode === 'upload' ? 'upload' : 'tts';
  if (p.stages.voice.status !== 'idle') resetFrom(p, 'voice');
  save(p);
}

// ---- stages --------------------------------------------------------------------
// The stage bodies live in stage-run.mjs (the same code runs a whole short project or one chapter of a long one).
const STAGE_FN = makeStages({ log, save, bus, projectDir, renderData, port: () => serverPort });

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
  if (p.chapters?.length) {
    // the editor works on the joined timeline; the edits are mapped back to the chapters that own those words
    fixes = distributeEdits(p, words, sb);
  } else {
    if (words) p.words = words;
    if (sb) { p.storyboard = sb; p.storyboardFixes = fixes; p.icons = iconsFor(storyboardNouns(sb)); }
  }
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
    if (p.chapters?.length) distributeEdits(p, null, rep.storyboard);
    else { p.storyboard = rep.storyboard; p.icons = iconsFor(storyboardNouns(rep.storyboard)); }
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
    notifyProject(p, 'project.published', { videoId: r.videoId, url: r.url, privacy: r.privacy, channel: st.channel?.title || null });
  } catch (e) {
    const cancelled = ctl.signal.aborted;
    Object.assign(p.publish, { status: cancelled ? 'idle' : 'error', error: cancelled ? null : e.message });
    plog(p, cancelled ? '■ النشر اتلغى' : `✖ ${e.message}`);
    if (!cancelled) notifyProject(p, 'project.publish.failed', { error: redact(e.message) });
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
  // a chaptered video is always the joined chapters in order (trim/cuts/custom order are single-pass edits), so the
  // subtitles use one full segment and stay in sync with the rendered video
  const segments = p.chapters?.length ? [[0, Math.max(0.1, p.voice?.duration || 0)]] : renderData(p).segments;
  return { segments, digits: e.typography?.digits || getSettings().look.typography?.digits || 'latin' };
}

/** Everything render.html needs; times are resolved here so the page stays deterministic. */
export function renderData(p, { chapter = null } = {}) {
  const ch = chapter ? (p.chapters || []).find((x) => x.id === chapter) : null;
  if (chapter && !ch) throw httpError(404, `chapter ${chapter} not found`);
  // a chapter render gets the chapter's own words/storyboard/voice on a project-scoped view (asset and clip URLs
  // live under the project) plus the project's export settings
  const S = ch ? { ...ch, id: p.id, topic: p.topic, edit: chapterEdit(p.edit, ch), options: p.options } : p;
  if (!S.words || !S.storyboard) throw httpError(409, ch ? `chapter ${chapter}: storyboard is not ready` : 'storyboard is not ready');
  const E = effectiveEdit(S.edit);
  const L = layoutFor(E.export.aspect, E.export.resolution);
  const typo = typographyFor(S.edit);
  const lastEnd = S.words[S.words.length - 1]?.end || 0;
  // the joined chapters already carry the 0.6 s tail in each chapter video; a single render still gets one
  const joined = Array.isArray(S.chapters) && S.chapters.length > 0;
  const full = Math.max(S.voice?.duration || 0, lastEnd + 0.3) + (joined ? 0 : 0.6);
  const start = Math.min(E.trim.start, full - 1);
  const end = E.trim.end ? Math.min(E.trim.end, full) : full;
  let segments = E.sequence ? sequenceToSegments(E.sequence) : keptSegments(start, end, E.cuts); // custom order wins
  // only the default trim/cut path falls back; a custom sequence is validated (cleanSequence) and kept as is
  if (!E.sequence && outDuration(segments) < 0.5) segments = [[start, end]];
  const sc = S.storyboard.scenes;
  const scenes = sc.map((s, i) => ({
    ...s,
    start: i === 0 ? 0 : S.words[s.at].start,
    end: i + 1 < sc.length ? S.words[sc[i + 1].at].start : full,
    items: s.items.map((it) => ({ ...it, t: it.at != null ? S.words[it.at].start : null })),
    clip: S.clips?.[`scene-${i}`] ? clipRef(S, `scene-${i}`) : null,
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
    id: p.id, title: S.script?.title || p.topic, seriesTag: getSettings().seriesTag, duration: outDuration(segments), start, end, full, segments, fps: E.export.fps,
    music: E.audio.music && getAsset(E.audio.music.asset) ? { src: `/api/assets/${E.audio.music.asset}/file`, volume: E.audio.music.volume, voiceVolume: E.audio.voiceVolume } : null,
    theme: { name: getSettings().look.theme, colors: resolvePalette(), grid: getSettings().look.grid !== false },
    layout: L, typography: typo, transition: E.transition,
    platform: E.export.platform ? { id: E.export.platform, ...PLATFORMS[E.export.platform], check: durationCheck(E.export.platform, outDuration(segments)) } : null,
    words: S.words.map(({ i, text, line, start: st, end: en }) => ({ i, text, line, start: st, end: en })),
    accents: S.storyboard.accents, scenes, icons: S.icons || {}, media,
    overlays: E.overlays.map((o) => ({ ...o, clip: S.clips?.[`ov-${o.id}`] ? clipRef(S, `ov-${o.id}`) : null })),
    fonts: { main: facesFor(typo.font), captions: facesFor(typo.captionFont) },
  };
}
const clipRef = (p, ref) => ({ ...p.clips[ref], url: `/api/projects/${p.id}/clips/${encodeURIComponent(p.clips[ref].key)}/` });
