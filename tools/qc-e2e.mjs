// Post-join QC end-to-end test (needs ffmpeg + a Playwright browser):
//   a real 3-chapter project renders → the render stage is re-run with a known 150 ms shift injected at the join
//   (RS_TEST_JOIN_SHIFT_MS, the chapters are marked done so only the join runs) → the pipeline must fail the project
//   with a clear QC message instead of marking the video done.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = Number(process.env.QC_MOCK_PORT || 4394);
const PORT = Number(process.env.QC_E2E_PORT || 4344);
const DATA = path.join(ROOT, 'data', 'qc-e2e');
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CHAPTERS = 3;
const CHAPTER_SECONDS = 10; // 30 s total is a valid duration preset

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });
process.on('exit', cleanup);
function start(env, tag) {
  const p = spawn('node', ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
  p.stdout.on('data', (d) => process.env.QC_VERBOSE && process.stdout.write(`[${tag}] ${d}`));
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
async function waitFor(desc, fn, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch((e) => { if (e.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(500);
  }
}
const appEnv = () => ({
  RS_PORT: String(PORT), RS_DATA_DIR: DATA,
  LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  FFMPEG_PATH: FFMPEG, FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
});

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  render: { resolution: 720, fps: 24, quality: 'draft', engine: 'legacy', fallback: false, maxJobs: 1 },
  approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' },
}), { mode: 0o600 });

const mock = spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT), FFMPEG_PATH: FFMPEG }, windowsHide: true, stdio: 'ignore' });
procs.push(mock);

let app = start(appEnv(), 'app');
await waitFor('server', () => api('/api/health'));
await waitFor('mock', () => fetch(`http://127.0.0.1:${MOCK_PORT}/v1/voices`, { headers: { 'xi-api-key': 'x' } }).then((r) => r.ok));
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm: { apiKey: 'k' }, elevenlabs: { apiKey: 'k', voiceId: 'mock-voice' }, deepgram: { apiKey: 'k' } }) });

// 1) a normal run renders three chapters and joins them
const p = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: CHAPTER_SECONDS * CHAPTERS, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' }, options: { chapters: true, chapterSeconds: CHAPTER_SECONDS, research: false } }),
});
await waitFor('render', async () => {
  const s = (await api(`/api/projects/${p.id}`)).stages;
  const bad = Object.entries(s).find(([, x]) => x.status === 'error');
  if (bad) throw Object.assign(new Error(`baseline ${bad[0]} failed: ${bad[1].error}`), { fatal: true });
  return s.render.status === 'done';
});
const okProject = await api(`/api/projects/${p.id}`);
check('baseline project renders and joins', okProject.stages.render.status === 'done' && okProject.chapters.length === CHAPTERS, `${okProject.chapters.length} chapters · ${okProject.render.frames} frames`);

// 2) stop the app, rewind only the render stage, and restart with a 150 ms shift injected at the join
const dir = path.join(DATA, 'projects', p.id);
app.kill('SIGTERM');
await new Promise((r) => app.once('exit', r));
const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
pj.stages.render = { status: 'idle', error: null, log: pj.stages.render.log || [], startedAt: null, endedAt: null };
fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
fs.rmSync(path.join(dir, 'chapters.mp4'), { force: true });
check('render stage rewound, chapters kept done', pj.chapters.every((ch) => ch.stages.render === 'done'), `${pj.chapters.length} chapters`);

// 3) restart with the bad join and re-run: the chapters are done, so only the join + QC run
app = start({ ...appEnv(), RS_TEST_JOIN_SHIFT_MS: '150' }, 'app2');
await waitFor('server after restart', () => api('/api/health'));
await api(`/api/projects/${p.id}/run`, { method: 'POST', body: '{}' });
const failed = await waitFor('render to fail', async () => {
  const s = (await api(`/api/projects/${p.id}`)).stages.render;
  if (s.status === 'error') return s;
  if (s.status === 'done') throw Object.assign(new Error('the bad join was accepted and the project marked done'), { fatal: true });
  return null;
}, 120000);
const after = await api(`/api/projects/${p.id}`);
const msg = String(failed.error || '');
check('the project fails at the render stage instead of finishing', after.stages.render.status === 'error', `"${msg.slice(0, 90)}"`);
check('the error names the QC gate', /chapter QC failed/i.test(msg));
check('the error reports the sync problem', /sync error (1[0-9]{2}) ms at ch-\d+/i.test(msg), msg.slice(0, 160));
check('no video was published as done', after.stages.render.status !== 'done' && !/^✔/m.test(String(after.stages.render.log?.at(-1) || '')));

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
cleanup();
process.exit(bad.length ? 1 : 0);
