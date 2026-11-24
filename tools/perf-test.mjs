// Performance + scale test on the REAL pipeline (offline mocks, real Chromium + ffmpeg). Records measurements, asserts limits.
//   small  = 10 s reel · medium = 30 s · large = 60 s with 6000×4000 photos in 3 scenes + a 1080p video overlay
//   queue  = 3 projects started together with RS_MAX_RENDERS=1 → never more than one render running, all finish
// Peak RSS = whole process tree (server + Chromium + ffmpeg), sampled every 100 ms. node tools/perf-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-perf-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4394, PORT = 4320, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg', FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const procs = []; process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0; const report = [];
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, ...(typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
async function waitStage(id, stage, status, ms = 600000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error'); if (err) throw new Error(`${err[0]}: ${err[1].error}`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${stage}=${status}`); await sleep(400);
  }
}
const treeRss = (root) => {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp] of rows) (kids.get(pp) || kids.set(pp, []).get(pp)).push(p);
  const own = new Map(rows.map(([p, , r]) => [p, r])); let sum = 0; const st = [root];
  while (st.length) { const p = st.pop(); sum += own.get(p) || 0; for (const k of kids.get(p) || []) st.push(k); }
  return sum / 1024;
};

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
// PERF_CGROUP=/sys/fs/cgroup/memory/<name> (cgroup v1, pre-created with memory.limit_in_bytes) runs the server inside that memory limit
const serverEnv = { ...process.env };
const server = spawn(...(process.env.PERF_CGROUP ? ['sh', ['-c', `echo $$ > ${process.env.PERF_CGROUP}/cgroup.procs && exec node server/index.mjs`]] : ['node', ['server/index.mjs']]), { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, RS_MAX_RENDERS: '1',
  LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '' } });
procs.push(server);
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);
let peak = 0; const sampler = setInterval(() => { try { peak = Math.max(peak, treeRss(server.pid)); } catch {} }, 100);
const approvals = { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' };
const probe = (f) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets,duration:format=duration', '-of', 'json', f]).toString());
const check = (id, w, h, minDur) => {
  const j = probe(path.join(DATA, 'projects', id, 'video.mp4')), v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264'); assert.equal(a.codec_name, 'aac'); assert.equal(v.width, w); assert.equal(v.height, h);
  assert.ok(Number(j.format.duration) >= minDur, `duration ${j.format.duration} < ${minDur}`);
  assert.ok(Math.abs(Number(v.nb_read_packets) / 30 - Number(j.format.duration)) < 0.2, 'frame count matches the duration');
  return Number(j.format.duration);
};
async function projectRun(label, seconds, { edit, res = 1080, prep } = {}) {
  peak = 0; const t0 = Date.now();
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: `ليه السما لونها أزرق؟ (${label})`, seconds, approvals: { ...approvals, storyboard: edit ? 'wait' : 'auto' } }) });
  let tRender = 0;
  if (edit) { await waitStage(p.id, 'storyboard', 'review'); const P = await api(`/api/projects/${p.id}`); await edit(p.id, P); await api(`/api/projects/${p.id}/stages/storyboard/approve`, { method: 'POST' }); }
  const t1 = Date.now(); const done = await waitStage(p.id, 'render', 'done');
  const total = (Date.now() - t0) / 1000, render = (Date.now() - t1) / 1000;
  const dur = check(p.id, 1080, 1920, seconds * 0.6);
  const row = { label, seconds, videoSec: +dur.toFixed(1), totalSec: +total.toFixed(1), renderStageSec: +render.toFixed(1), peakRssMB: Math.round(peak), logWorkers: (done.stages.render.log.find((l) => /parallel page/.test(l)) || '').replace(/^\[[\d:]+\] /, '') };
  report.push(row); console.log('  ', JSON.stringify(row)); return { id: p.id, row };
}

const only = (k) => !process.env.PERF_ONLY || process.env.PERF_ONLY.split(',').includes(k);
if (only('small')) await test('small project (10 s): renders, verified, RAM under 3 GB', async () => { const { row } = await projectRun('small', 10); assert.ok(row.peakRssMB < 3072, `${row.peakRssMB} MB`); });
if (only('medium')) await test('medium project (30 s): renders, verified, RAM under 3 GB', async () => { const { row } = await projectRun('medium', 30); assert.ok(row.peakRssMB < 3072, `${row.peakRssMB} MB`); });
if (only('large')) await test('large project (60 s) with 6000×4000 photos in 3 scenes + a 1080p video overlay: RAM under 4 GB', async () => {
  const photo = path.join(TMP, 'big.jpg'), clip = path.join(TMP, 'clip.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=6000x4000', '-vf', 'noise=alls=40:allf=t', '-frames:v', '1', '-q:v', '3', photo]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6', '-pix_fmt', 'yuv420p', clip]);
  const add = (f) => api('/api/assets', { method: 'POST', body: fs.readFileSync(f), headers: { 'X-Filename': path.basename(f), 'X-Folder': 'perf' } });
  const [pA, cA] = [await add(photo), await add(clip)];
  report.push({ label: 'fixture', photoMB: +(fs.statSync(photo).size / 1048576).toFixed(1), photoPx: '6000x4000' });
  const { row } = await projectRun('large', 60, { edit: async (id, P) => {
    const sb = structuredClone(P.storyboard); let k = 0;
    sb.scenes.forEach((s, i) => { if (i % 2 === 1 && k < 3) { s.template = 'photo'; s.image = pA.id; s.items = []; k++; } });
    await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ storyboard: sb, edit: { export: { aspect: '9:16', resolution: 1080, fps: 30, quality: 'standard' }, overlays: [{ kind: 'video', asset: cA.id, start: 4, end: 9, pos: 'bottom', scale: 0.5 }] } }) });
  } });
  assert.ok(row.peakRssMB < 4096, `${row.peakRssMB} MB`);
});
if (only('queue')) await test('queue: 3 projects started together with RS_MAX_RENDERS=1 → at most one render runs at a time and all three finish', async () => {
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: `طابور ${i}`, seconds: 10, approvals }) })).id);
  let maxRunning = 0, sawWaiting = false; const t0 = Date.now();
  for (;;) {
    const q = await api('/api/queue'); const running = q.jobs.filter((j) => j.status === 'running').length;
    maxRunning = Math.max(maxRunning, running); if (q.jobs.some((j) => j.status === 'pending')) sawWaiting = true;
    const sts = await Promise.all(ids.map(async (id) => (await api(`/api/projects/${id}`)).stages));
    if (sts.some((s) => Object.values(s).some((x) => x.status === 'error'))) throw new Error('a project failed: ' + JSON.stringify(sts.map((s) => s.render.error)));
    if (sts.every((s) => s.render.status === 'done')) break;
    if (Date.now() - t0 > 600000) throw new Error('timeout');
    await sleep(150);
  }
  assert.equal(maxRunning, 1, `max concurrent renders ${maxRunning}`); assert.ok(sawWaiting, 'a job was seen waiting in the queue');
  for (const id of ids) check(id, 1080, 1920, 6);
  report.push({ label: 'queue×3', maxRunning, totalSec: +((Date.now() - t0) / 1000).toFixed(1) });
});
clearInterval(sampler);
console.log('\nMEASUREMENTS ' + JSON.stringify(report, null, 1));
console.log(`\n${n} perf tests passed${failed ? `, ${failed} FAILED` : ''}`);
if (!process.env.PERF_ONLY) fs.writeFileSync(path.join(ROOT, 'output', 'perf-report.json'), JSON.stringify({ at: new Date().toISOString(), cpus: os.cpus().length, memGB: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version, report }, null, 1));
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
