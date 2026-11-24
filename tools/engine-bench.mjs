// Engine benchmark: the same 1080×1920 project rendered by the legacy and the Remotion engine at 1 and 2 parallel
// pages/tabs. Measures the render job time (frames → encoded MP4, warm: the Remotion bundle is built first and not
// counted) and the peak memory of the whole process tree (server + browsers + ffmpeg), sampled every 200 ms.
// Linux/macOS (uses ps). node tools/engine-bench.mjs [seconds=20]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECONDS = Number(process.argv[2]) || 20;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bench-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4394, PORT = 4309, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 150; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, 'Content-Type': 'application/json' } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
async function waitStage(id, stage, status, ms = 900000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error');
    if (err) throw new Error(`${err[0]}: ${err[1].error}`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${stage}`);
    await sleep(300);
  }
}
/** Resident memory (MB) of a process and all its descendants. */
function treeRss(pid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const rss = new Map(rows.map(([p, , r]) => [p, r]));
  let sum = 0; const stack = [pid];
  while (stack.length) { const p = stack.pop(); sum += rss.get(p) || 0; stack.push(...(kids.get(p) || [])); }
  return sum / 1024;
}

const mock = spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' });
let server = null;
process.on('exit', () => { mock.kill(); server?.kill(); });
async function startServer(workers) {
  server?.kill(); await sleep(500);
  server = spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA,
    RS_RENDER_WORKERS: String(workers), RS_REMOTION_CONCURRENCY: String(workers),
    LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '' } });
  await up(`${BASE}/api/health`);
}

await up(`${MOCK}/media/_stats`);
await startServer(1);
const p0 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: SECONDS, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
const id = (await waitStage(p0.id, 'storyboard', 'review')).id;
// the first render (engine auto → Remotion) is the cold warm-up: it builds the Remotion bundle
{ const t0 = Date.now(); await api(`/api/projects/${id}/stages/storyboard/approve`, { method: 'POST' }); await waitStage(id, 'render', 'done'); console.log(`   cold first render (bundle build + render): ${((Date.now() - t0) / 1000).toFixed(1)} s`); }

const results = [];
async function run(engine, workers, label) {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '9:16', resolution: 1080, quality: 'standard', fps: 30, engine } } }) });
  let peak = 0;
  const timer = setInterval(() => { try { peak = Math.max(peak, treeRss(server.pid)); } catch {} }, 200);
  const t0 = Date.now();
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const p = await waitStage(id, 'render', 'done');
  clearInterval(timer);
  if (p.render.engine !== engine) throw new Error(`${engine} fell back to ${p.render.engine}`);
  const row = { engine, workers, label, frames: p.render.frames, renderSeconds: p.render.renderSeconds, fps: +(p.render.frames / p.render.renderSeconds).toFixed(1), stageSeconds: +((Date.now() - t0) / 1000).toFixed(1), peakMB: Math.round(peak) };
  results.push(row);
  console.log(JSON.stringify(row));
}

const ENGINES = (process.env.RS_BENCH_ENGINES || 'legacy,remotion').split(',');
for (const workers of (process.env.RS_BENCH_WORKERS || '1,2').split(',').map(Number)) {
  await startServer(workers);
  for (const engine of ENGINES) await run(engine, workers, `${workers} page${workers > 1 ? 's' : ''}/tab${workers > 1 ? 's' : ''}`);
}
const machine = { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, totalGB: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version, platform: `${os.platform()} ${os.release()}` };
fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'output', 'engine-bench.json'), JSON.stringify({ seconds: SECONDS, machine, results }, null, 2));
console.log('\nmachine', JSON.stringify(machine));
console.table(results.filter((r) => !r.label.startsWith('warm')).map(({ engine, workers, frames, renderSeconds, fps, peakMB }) => ({ engine, workers, frames, 'render s': renderSeconds, 'frames/s': fps, 'peak RAM MB': peakMB })));
server.kill(); mock.kill();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
