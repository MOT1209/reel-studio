// Rendering Engine Manager: one interface for every frame engine (legacy canvas, Remotion, …).
//   engine = { id, name, validate() → {ok, reason}, prepare(ctx), produce(i0, i1, emit, ctx), cleanup(ctx) }
// The manager picks the engine (settings: auto | legacy | remotion), queues heavy jobs (an 8 GB machine renders one
// video at a time by default), records each job (status, progress, timings, fallback, error) in memory and in
// data/logs/render-jobs.jsonl, cancels through an AbortController and falls back to the legacy engine when the
// chosen one fails for any reason other than a cancel. Encoding always goes through engines/ffmpeg.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeSegmented, availableCodecs } from './ffmpeg.mjs';
import { legacyEngine } from './legacy.mjs';
import { remotionEngine } from './remotion.mjs';

const engines = new Map();
export function registerEngine(engine) {
  for (const k of ['id', 'name', 'validate', 'prepare', 'produce', 'cleanup']) if (!engine?.[k]) throw new Error(`engine is missing "${k}"`);
  engines.set(engine.id, engine);
}
export function unregisterEngine(id) { if (id !== 'legacy') engines.delete(id); }
registerEngine(legacyEngine);
registerEngine(remotionEngine);

/** Preference order for "auto": the first available wins; legacy is always last. */
const AUTO_ORDER = ['remotion', 'legacy'];
export const ENGINE_CHOICES = ['auto', ...AUTO_ORDER];

const valCache = new Map(); // id → { at, result } — validate() can be slow (imports, bundle checks)
async function validated(e, fresh = false) {
  const c = valCache.get(e.id);
  if (!fresh && c && Date.now() - c.at < 60_000) return c.result;
  let result;
  try { result = await e.validate(); } catch (err) { result = { ok: false, reason: err.message }; }
  valCache.set(e.id, { at: Date.now(), result });
  return result;
}

/** Every registered engine with its availability, for the settings page and GET /api/engines. */
export async function engineStatus({ fresh = false } = {}) {
  const list = [];
  for (const id of AUTO_ORDER.filter((x) => engines.has(x)).concat([...engines.keys()].filter((x) => !AUTO_ORDER.includes(x)))) {
    const e = engines.get(id);
    const v = await validated(e, fresh);
    list.push({ id, name: e.name, available: !!v.ok, reason: v.ok ? null : v.reason || 'unavailable', ...(v.info ? { info: v.info } : {}) });
  }
  return { engines: list, codecs: await availableCodecs(), choices: ENGINE_CHOICES };
}

/** Resolves a preference to an engine object; throws only when nothing at all is usable. */
export async function chooseEngine(pref = 'auto') {
  if (pref && pref !== 'auto') {
    const e = engines.get(pref);
    if (e && (await validated(e)).ok) return { engine: e, note: null };
    const why = e ? (await validated(e)).reason : 'not installed';
    const fb = await chooseEngine('auto');
    return { engine: fb.engine, note: `engine "${pref}" unavailable (${why}) — using ${fb.engine.id}` };
  }
  for (const id of AUTO_ORDER) { const e = engines.get(id); if (e && (await validated(e)).ok) return { engine: e, note: null }; }
  throw new Error('no render engine is available (run "npm run setup")');
}

// ---- jobs + queue ----------------------------------------------------------------------------------------
const jobs = new Map(); // id → job (kept for the session; the jsonl file is the history)
let logFile = null;
export function setJobLog(file) { logFile = file; }
function persist(job) {
  if (!logFile) return;
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(publicJob(job)) + '\n'); } catch {}
}
export function publicJob(j) {
  const { controller, ...rest } = j;
  return rest;
}
export function getJob(id) { const j = jobs.get(id); return j && publicJob(j); }
export function listJobs() { return [...jobs.values()].map(publicJob).slice(-50); }

let maxJobs = 1, running = 0;
const waiting = [];
export function setMaxJobs(n) { maxJobs = Math.max(1, Math.min(4, Number(n) || 1)); pump(); }
export const getMaxJobs = () => maxJobs;
/** RS_MAX_RENDERS: an integer 1–4 overrides the setting; anything else is ignored with a note. */
export function parseLimit(raw, { max = 4 } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { n: null, note: null };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > max) return { n: null, note: `RS_MAX_RENDERS="${raw}" is invalid (use an integer 1–${max}) — using the setting` };
  return { n: v, note: null };
}
/** Queue view for GET /api/queue: waiting jobs get their position. */
export function queueSnapshot() {
  let pos = 0;
  const all = [...jobs.values()].map((j) => ({ ...publicJob(j), position: j.status === 'queued' ? ++pos : 0 })); // positions over the whole queue
  return { limit: maxJobs, running, waiting: waiting.length, jobs: all.slice(-50) };
}
function pump() { while (running < maxJobs && waiting.length) { running++; waiting.shift()(); } }
async function slot(signal) {
  if (running < maxJobs) { running++; return; }
  await new Promise((res, rej) => {
    const go = () => { signal?.removeEventListener('abort', onAbort); res(); };
    const onAbort = () => { const k = waiting.indexOf(go); if (k >= 0) waiting.splice(k, 1); rej(new Error('cancelled')); };
    waiting.push(go);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function release() { running--; pump(); }

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j || ['done', 'error', 'cancelled'].includes(j.status)) return false;
  j.controller.abort();
  return true;
}

/**
 * Renders the silent video for one project. source: what engines need to know about the project
 * ({ projectId, url (legacy page), data (render data snapshot), timeOf(i) → source time, port }).
 * Returns the finished job record. Throws on failure or cancel (job.status says which).
 */
export async function renderVideo({ project, engine: pref = 'auto', fallback = true, source, total, fps, width, height, quality, codec = 'h264', bitrate = null, segDir, key, out, signal, log = () => {}, onFrame = () => {}, onJob = () => {} }) {
  const controller = new AbortController();
  const onOuter = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', onOuter, { once: true });
  const job = {
    id: crypto.randomBytes(6).toString('hex'), project, requested: pref, engine: null, status: 'queued', frames: 0, total, fps, width, height, codec, quality,
    queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, seconds: null, fallbackFrom: null, error: null, controller,
  };
  jobs.set(job.id, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  const emitJob = () => { try { onJob(publicJob(job)); } catch {} };
  emitJob();
  if (running >= maxJobs) log(`render queue: waiting for ${running} running job${running > 1 ? 's' : ''}`);
  try {
    await slot(controller.signal);
  } catch (e) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); persist(job); emitJob(); signal?.removeEventListener('abort', onOuter); throw e; }
  const t0 = Date.now();
  job.startedAt = new Date().toISOString();
  const codecs = await availableCodecs();
  if (!codecs[codec]) { log(`⚠ codec ${codec} is not in this ffmpeg build — using h264`); codec = job.codec = 'h264'; }
  const attempt = async (engine) => {
    job.engine = engine.id; job.status = 'running'; job.frames = 0; emitJob();
    log(`engine: ${engine.name}`);
    const wrapped = { ...engine, prepare: (ctx) => engine.prepare(Object.assign(ctx, source, { job: publicJob(job) })) };
    return encodeSegmented({
      engine: wrapped, total, fps, width, height, quality, codec, bitrate, segDir, key, out, signal: controller.signal, log,
      onFrame: (i, n, jpg) => { job.frames = i + 1; onFrame(i, n, jpg); },
    });
  };
  try {
    const { engine, note } = await chooseEngine(pref);
    if (note) log(`⚠ ${note}`);
    try {
      await attempt(engine);
    } catch (e) {
      if (controller.signal.aborted || e.message === 'cancelled' || !fallback || engine.id === 'legacy') throw e;
      log(`⚠ ${engine.id} failed: ${e.message.split('\n')[0]} — falling back to the legacy engine`);
      job.fallbackFrom = engine.id; job.fallbackReason = e.message.split('\n')[0].slice(0, 300);
      valCache.delete(engine.id);
      await attempt(engines.get('legacy'));
    }
    job.status = 'done';
  } catch (e) {
    const cancelled = controller.signal.aborted || e.message === 'cancelled';
    job.status = cancelled ? 'cancelled' : 'error';
    job.error = cancelled ? null : e.message.slice(0, 1000);
    throw cancelled ? Object.assign(new Error('cancelled'), { cause: e }) : e;
  } finally {
    job.finishedAt = new Date().toISOString();
    job.seconds = +((Date.now() - t0) / 1000).toFixed(2);
    signal?.removeEventListener('abort', onOuter);
    release();
    persist(job);
    emitJob();
  }
  return publicJob(job); // after finally: finishedAt / seconds are filled in
}
