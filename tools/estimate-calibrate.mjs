// Render-rate calibration for the pre-render estimate (needs ffmpeg + the Playwright browser):
//   node tools/estimate-calibrate.mjs [--seconds=30] [--chapter-seconds=10] [--legacy-seconds=10]
// Renders a short chaptered project at the DEFAULT render settings (1080×1920, standard, 30 fps, engine auto),
// measures every chapter's job time, then re-runs only the join to time it — and renders one short project on the
// legacy engine at the same settings. The numbers it prints are what server/render-estimate.mjs is built on.
// Data goes to data/estimate-calib (deleted first); the result is also written to output/estimate-calib.json.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, Number(v)]));
const SECONDS = args.seconds || 30;
const CHAPTER_SECONDS = args['chapter-seconds'] || 10;
const LEGACY_SECONDS = args['legacy-seconds'] || 10;
const MOCK_PORT = Number(process.env.CALIB_MOCK_PORT || 4397);
const PORT = Number(process.env.CALIB_PORT || 4356);
const DATA = path.join(ROOT, 'data', 'estimate-calib');
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a server left on the port would answer for the wrong data directory, so refuse to start next to one
async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer()
      .once('error', () => reject(new Error(`port ${port} is already in use — stop the other Reel Studio instance first`)))
      .once('listening', () => s.close(() => resolve()));
    s.listen(port, '127.0.0.1');
  });
}
await assertFree(PORT);
await assertFree(MOCK_PORT);
const procs = [];
const cleanup = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });
process.on('exit', cleanup);

function startServer(tag) {
  const p = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK },
  });
  p.stdout.on('data', (d) => process.env.CALIB_VERBOSE && process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  procs.push(p);
  return p;
}
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
async function waitFor(desc, fn, timeoutMs = 1800000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch((e) => { if (e.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(300);
  }
}
async function up(url) {
  for (let i = 0; i < 300; i++) { try { await fetch(url); return; } catch { await sleep(200); } }
  throw new Error('not up ' + url);
}
const renderDone = (id) => async () => {
  const p = await api(`/api/projects/${id}`);
  const bad = Object.entries(p.stages).find(([, s]) => s.status === 'error');
  if (bad) throw Object.assign(new Error(`${bad[0]} failed: ${bad[1].error}`), { fatal: true });
  return p.stages.render.status === 'done' ? p : null;
};

// ---- setup: mock APIs, a pre-built Remotion bundle (so chapter 1 does not pay for it), and the server -------------
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const prewarm = spawnSync(process.execPath, ['-e', "import('./server/engines/remotion.mjs').then((m) => m.ensureBundle((l) => console.log(l)))"], {
  cwd: ROOT, env: { ...process.env, RS_DATA_DIR: DATA }, stdio: 'inherit',
});
if (prewarm.status !== 0) console.warn('⚠ could not pre-build the Remotion bundle — the first chapter will include the build');
const mock = spawn(process.execPath, ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore', windowsHide: true });
procs.push(mock);
let app = startServer('app');
await up(`${BASE}/api/health`);
await up(`${MOCK}/v1/voices`);
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm: { apiKey: 'k' }, elevenlabs: { apiKey: 'k', voiceId: 'mock-voice' }, deepgram: { apiKey: 'k' } }) });

const approvals = { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' };
const created = (body) => api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', approvals, options: { chapters: true, chapterSeconds: CHAPTER_SECONDS, research: false }, ...body }) });

// ---- 1) the default-settings render: 3 × 10 s chapters, 1080×1920 · standard · 30 fps · engine auto -------------
const p = await created({ seconds: SECONDS });
const tA = Date.now();
const done = await waitFor('default render', renderDone(p.id));
const wallA = (Date.now() - tA) / 1000;
// the public chapter view drops renderSeconds: the job time is in project.json
const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', p.id, 'project.json'), 'utf8'));
const chapters = stored.chapters.map((ch) => ({
  index: ch.index + 1,
  seconds: ch.render.duration,
  frames: ch.render.frames,
  jobSeconds: ch.render.renderSeconds,
  rate: ch.render.renderSeconds / ch.render.duration,
  engine: ch.render.engine,
}));
const engineSum = chapters.reduce((a, c) => a + c.jobSeconds, 0);
const videoSum = chapters.reduce((a, c) => a + c.seconds, 0);

// ---- 2) join only: the chapters are done, so the render stage is just join + QC + contact sheet ------------------
app.kill('SIGTERM');
await new Promise((r) => app.once('exit', r));
const dir = path.join(DATA, 'projects', p.id);
const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
pj.stages.render = { status: 'idle', error: null, log: pj.stages.render.log || [], startedAt: null, endedAt: null };
fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
for (const f of ['chapters.mp4', 'video.mp4', 'contact.jpg', 'join-audio.m4a', 'join-silent.wav', 'join-mix.m4a']) fs.rmSync(path.join(dir, f), { force: true });
app = startServer('app-join');
await up(`${BASE}/api/health`);
const tB = Date.now();
await api(`/api/projects/${p.id}/run`, { method: 'POST', body: '{}' });
const joined = await waitFor('join', renderDone(p.id));
const wallB = (Date.now() - tB) / 1000;

// ---- 3) the legacy engine at the same output settings (a short single-pass project) ------------------------------
const lp = await created({ seconds: LEGACY_SECONDS, options: { chapters: false, research: false } });
// the project may already be rendering on auto — force legacy and render it again from scratch
await waitFor('legacy project first pass', renderDone(lp.id));
await api(`/api/projects/${lp.id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { engine: 'legacy' } } }) });
async function renderCfg(patch) {
  await api(`/api/projects/${lp.id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '9:16', resolution: 1080, quality: 'standard', fps: 30, engine: 'auto', ...patch } } }) });
  const t0 = Date.now();
  await api(`/api/projects/${lp.id}/run`, { method: 'POST', body: '{}' });
  const q = await waitFor(`render ${JSON.stringify(patch)}`, renderDone(lp.id));
  const r = q.render;
  return { seconds: r.duration, frames: r.frames, jobSeconds: r.renderSeconds, rate: +(r.renderSeconds / r.duration).toFixed(3), engine: r.engine, width: r.width, fps: r.fps, quality: r.quality, wallSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
}
const legacy = await renderCfg({ engine: 'legacy' });
// the same settings at 720p, one render per engine → the resolution scaling is measured, not assumed
const probes = { 'legacy-720': await renderCfg({ engine: 'legacy', resolution: 720 }), 'remotion-720': await renderCfg({ engine: 'remotion', resolution: 720 }) };

// ---- summary ---------------------------------------------------------------------------------------------------
const rateMid = engineSum / videoSum;
const rates = chapters.map((c) => c.rate);
const rateMin = Math.min(...rates);
const rateMax = Math.max(...rates);
// the re-run draws no frames: wallB is the join + post-join QC + mux + contact sheet
const joinSeconds = +wallB.toFixed(2);
const joinedQc = joined.render.qc || null;
const perChapter = +((wallA - engineSum - wallB) / chapters.length).toFixed(2);
const machine = { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, totalGB: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version, platform: `${os.platform()} ${os.release()}` };
// render seconds per video second at 30 fps / standard — what server/render-estimate.mjs stores as PER_SECOND
const table = { legacy: { 720: probes['legacy-720'].rate, 1080: legacy.rate }, remotion: { 720: probes['remotion-720'].rate, 1080: +rateMid.toFixed(3) } };
const out = {
  at: new Date().toISOString(), machine, defaults: { resolution: 1080, quality: 'standard', fps: 30, engine: 'auto', chapters: chapters.length, seconds: SECONDS, chapterSeconds: CHAPTER_SECONDS },
  chapters, engineSum: +engineSum.toFixed(2), videoSum: +videoSum.toFixed(2),
  rateMid: +rateMid.toFixed(3), rateMin: +rateMin.toFixed(3), rateMax: +rateMax.toFixed(3),
  perChapterOverheadSeconds: perChapter, joinSeconds, joinedQc, wallA: +wallA.toFixed(1), wallB: +wallB.toFixed(1),
  legacy1080: legacy, probes, table,
  legacyFactor: +(legacy.rate / rateMid).toFixed(3),
};
fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'output', 'estimate-calib.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
cleanup();
process.exit(0);
