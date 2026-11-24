// Phase 1/3 regression tests: retry/timeouts, render queue, worker validation, output verification, graceful shutdown.
//   node tools/phase1-test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-p1-'));
Object.assign(process.env, { RS_DATA_DIR: path.join(TMP, 'data'), RS_RETRY_BASE_MS: '20' });
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { fetchRetry } = await import('../server/net.mjs');
const { JobQueue, runQueued, parseLimit } = await import('../server/queue.mjs');
const R = await import('../server/render.mjs');

// ---- fetchRetry ------------------------------------------------------------------------
const hits = {};
const srv = http.createServer((req, res) => {
  const k = req.url; hits[k] = (hits[k] || 0) + 1;
  if (k === '/flaky') return hits[k] < 3 ? (res.writeHead(503), res.end('x')) : res.end('ok');
  if (k === '/limited') return hits[k] < 2 ? (res.writeHead(429, { 'Retry-After': '0' }), res.end()) : res.end('ok');
  if (k === '/auth') { res.writeHead(401); return res.end('bad key'); }
  if (k === '/hang') return; // never answers
  res.end('ok');
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const U = (p) => `http://127.0.0.1:${srv.address().port}${p}`;

await test('fetchRetry: 503 twice then 200 succeeds on the third attempt', async () => {
  const r = await fetchRetry(U('/flaky'), {}, { retries: 2 }); assert.equal(await r.text(), 'ok'); assert.equal(hits['/flaky'], 3);
});
await test('fetchRetry: 429 with Retry-After is retried', async () => {
  const r = await fetchRetry(U('/limited'), {}, { retries: 2 }); assert.equal(r.status, 200);
});
await test('fetchRetry: a 401 is returned at once, never retried', async () => {
  const r = await fetchRetry(U('/auth'), {}, { retries: 3 }); assert.equal(r.status, 401); assert.equal(hits['/auth'], 1);
});
await test('fetchRetry: a hanging server times out (and is retried) instead of hanging forever', async () => {
  const t0 = Date.now();
  await assert.rejects(fetchRetry(U('/hang'), {}, { timeout: 150, retries: 1, label: 'X' }), /X: timeout/);
  assert.equal(hits['/hang'], 2); assert.ok(Date.now() - t0 < 3000);
});
await test('fetchRetry: the user cancel stops it immediately', async () => {
  const c = new AbortController(); setTimeout(() => c.abort(), 80);
  await assert.rejects(fetchRetry(U('/hang'), { signal: c.signal }, { timeout: 10000, retries: 3 }), /cancelled/);
});
srv.closeAllConnections?.(); srv.close();

// ---- queue -------------------------------------------------------------------------------
await test('queue: limit 1 → jobs run one at a time, in priority then FIFO order', async () => {
  const q = new JobQueue({ limit: 1 }); const order = []; let active = 0, maxActive = 0;
  const job = (name, prio) => runQueued(q, name, async () => { active++; maxActive = Math.max(maxActive, active); order.push(name); await sleep(30); active--; }, { priority: prio });
  await Promise.all([job('a', 0), job('b', 0), job('c', 5), job('d', 0)]);
  assert.equal(maxActive, 1); assert.deepEqual(order, ['a', 'c', 'b', 'd']);
});
await test('queue: limit 2 allows two at once, never three', async () => {
  const q = new JobQueue({ limit: 2 }); let active = 0, maxActive = 0;
  await Promise.all([1, 2, 3, 4, 5].map((i) => runQueued(q, 'j' + i, async () => { active++; maxActive = Math.max(maxActive, active); await sleep(30); active--; })));
  assert.equal(maxActive, 2);
});
await test('queue: cancelling a waiting job removes it without ever taking a slot', async () => {
  const q = new JobQueue({ limit: 1 }); const c = new AbortController();
  const first = runQueued(q, 'first', () => sleep(80));
  await sleep(5);
  const waiting = runQueued(q, 'second', async () => assert.fail('must not run'), { signal: c.signal });
  c.abort();
  await assert.rejects(waiting, /cancelled/); await first;
  const st = q.snapshot().map((j) => j.status); assert.deepEqual(st.sort(), ['cancelled', 'done']);
});
await test('queue: a failed job frees its slot; transient errors are retried once, others are not', async () => {
  const q = new JobQueue({ limit: 1 }); let tries = 0;
  const r = await runQueued(q, 'flaky', async () => { if (++tries < 2) throw new Error('Target closed'); return 'ok'; }, { retries: 1, backoffMs: 5, retryable: (e) => /Target closed/.test(e.message) });
  assert.equal(r, 'ok'); assert.equal(tries, 2);
  let t2 = 0;
  await assert.rejects(runQueued(q, 'bad', async () => { t2++; throw new Error('bad input'); }, { retries: 3, backoffMs: 5, retryable: (e) => /Target closed/.test(e.message) }), /bad input/);
  assert.equal(t2, 1);
  assert.equal(await runQueued(q, 'after', async () => 'fine'), 'fine');
});
await test('queue: RS_MAX_RENDERS must be an integer 1–4', () => {
  for (const bad of ['0', '-1', '2.5', 'abc', '99', 'Infinity']) { const r = parseLimit(bad); assert.equal(r.n, 1, bad); assert.ok(r.note, bad); }
  assert.equal(parseLimit('3').n, 3); assert.equal(parseLimit(undefined).n, 1);
});

// ---- worker count ------------------------------------------------------------------------
await test('RS_RENDER_WORKERS: invalid values are rejected with a note, valid ones are capped by free RAM', () => {
  const env = { cpus: 8, freeMem: 16 * 1024 ** 3 };
  for (const bad of ['abc', '0', '-2', '1.5', 'Infinity', '9']) { const r = R.parseWorkers(bad, env); assert.ok(r.note, bad); assert.ok(r.n >= 1 && r.n <= R.MAX_WORKERS, bad); }
  assert.equal(R.parseWorkers('2', env).n, 2);
  const low = R.parseWorkers('4', { cpus: 8, freeMem: 1.2 * 1024 ** 3 }); assert.equal(low.n, 2); assert.match(low.note, /reduced/);
  assert.equal(R.parseWorkers('4', { cpus: 8, freeMem: 1.2 * 1024 ** 3, force: true }).n, 4);
  assert.equal(R.parseWorkers(undefined, { cpus: 1, freeMem: 16 * 1024 ** 3 }).n, 1);
});

// ---- output verification -------------------------------------------------------------------
const mk = (file, { w = 320, h = 240, fps = 30, secs = 2, audio = true, vcodec = 'libx264' } = {}) => {
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${w}x${h}:r=${fps}:d=${secs}`];
  if (audio) a.push('-f', 'lavfi', '-i', `sine=frequency=440:d=${secs}`);
  a.push('-c:v', vcodec, '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), '-shortest', file);
  const r = spawnSync(FFMPEG, a); assert.equal(r.status, 0, String(r.stderr));
};
const good = path.join(TMP, 'good.mp4'); mk(good);
await test('verifyVideo: a correct file passes (codecs, size, fps, frames, durations)', async () => {
  await R.verifyVideo(good, { width: 320, height: 240, fps: 30, duration: 2, frames: 60 });
  assert.equal(await R.countFrames(good), 60);
});
await test('verifyVideo: wrong size / frame count / missing audio / short audio are all reported', async () => {
  await assert.rejects(R.verifyVideo(good, { width: 640, height: 240, fps: 30, duration: 2, frames: 59 }), /width 320 ≠ 640.*59/);
  const silent = path.join(TMP, 'silent.mp4'); mk(silent, { audio: false });
  await assert.rejects(R.verifyVideo(silent, { duration: 2 }), /no audio stream/);
  await assert.rejects(R.verifyVideo(good, { duration: 5 }), /≠ 5\.00 s/);
  await assert.rejects(R.verifyVideo(good, { fps: 25 }), /fps/);
});
await test('muxFinal: a failed output check leaves NO file at the final path (and no .part)', async () => {
  const out = path.join(TMP, 'final.mp4');
  const aud = path.join(TMP, 'a.m4a'); assert.equal(spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'aac', aud]).status, 0);
  await assert.rejects(R.muxFinal({ video: good, audio: aud, out, expect: { width: 999, height: 240 } }), /output check failed/);
  assert.ok(!fs.existsSync(out) && !fs.existsSync(out + '.part.mp4'));
  await R.muxFinal({ video: good, audio: aud, out, expect: { width: 320, height: 240, fps: 30, duration: 2, frames: 60 } });
  assert.ok(fs.statSync(out).size > 0 && !fs.existsSync(out + '.part.mp4'));
});
await test('muxFinal: cancelling mid-way never leaves a partial file at the final path', async () => {
  const out = path.join(TMP, 'cancel.mp4'); const c = new AbortController(); c.abort();
  await assert.rejects(R.muxFinal({ video: good, audio: good, out, signal: c.signal }), /cancelled/);
  assert.ok(!fs.existsSync(out) && !fs.existsSync(out + '.part.mp4'));
});
await test('renderFrames: a damaged reused segment is detected by frame count and re-rendered', async () => {
  // a manifest that claims segment 0 is done, with a file that is not a valid 30-frame segment
  const segDir = path.join(TMP, 'seg'); fs.mkdirSync(segDir, { recursive: true });
  fs.writeFileSync(path.join(segDir, 'manifest.json'), JSON.stringify({ key: 'k', done: [0] }));
  mk(path.join(segDir, 'seg_0000.mp4'), { audio: false, secs: 1, fps: 30, w: 64, h: 64 }); // 30 frames but we ask for 45
  const logs = [];
  await assert.rejects(R.renderFrames({ url: 'http://127.0.0.1:9/none', out: path.join(TMP, 'x.mp4'), duration: 1.5, fps: 30, width: 64, height: 64, segDir, key: 'k', log: (l) => logs.push(l) }));
  assert.ok(logs.some((l) => /segment 0 is damaged/.test(l)), 'the 30-frame file must be rejected for a 45-frame segment');
  assert.ok(!logs.some((l) => /reusing/.test(l)));
});

await test('run(): a child that exceeds its execution limit is killed and reported; normal commands are unaffected', async () => {
  const t0 = Date.now();
  await assert.rejects(R.run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 }), /timed out after 0 s and was killed|timed out after/);
  assert.ok(Date.now() - t0 < 5000);
  const r = await R.run(process.execPath, ['-e', 'console.log("ok")'], { timeoutMs: 5000 }); assert.equal(r.out.trim(), 'ok');
  assert.equal(R.activeProcessCount(), 0, 'no child is left registered');
});

// ---- graceful shutdown -----------------------------------------------------------------------
await test('shutdown: SIGTERM stops the server, kills its children and exits cleanly', async () => {
  const PORT = 4311;
  const child = spawn('node', ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'sd') }, stdio: 'ignore' });
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/health`); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server did not start');
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  child.kill('SIGTERM');
  const r = await Promise.race([exited, sleep(10000).then(() => 'TIMEOUT')]);
  assert.notEqual(r, 'TIMEOUT'); assert.equal(r.code, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${PORT}/api/health`));
});
await test('queue endpoint: GET /api/queue reports the limit and jobs', async () => {
  const PORT = 4312;
  const child = spawn('node', ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'sd2'), RS_MAX_RENDERS: '2' }, stdio: 'ignore' });
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/health`); up = true; } catch { await sleep(100); } }
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/queue`)).json();
    assert.equal(j.limit, 2); assert.deepEqual(j.jobs, []);
  } finally { child.kill('SIGKILL'); }
});

await test('upload: streamed to disk, limit enforced (413), bad bytes refused (415), no temp files left behind', async () => {
  const PORT = 4314, data = path.join(TMP, 'sd3'), BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn('node', ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: data, RS_MAX_UPLOAD_MB: '1' }, stdio: 'ignore' });
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(100); } }
    const H = { Origin: BASE, 'Content-Type': 'application/json' };
    const proj = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: H, body: JSON.stringify({ topic: 'اختبار', autostart: false }) })).json();
    const post = (buf, name = 'v.mp3') => fetch(`${BASE}/api/projects/${proj.id}/upload`, { method: 'POST', headers: { Origin: BASE, 'x-filename': name, 'Content-Type': 'audio/mpeg' }, body: buf });
    const mp3 = (bytes) => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(bytes - 3, 1)]);
    assert.equal((await post(mp3(2 * 1024 * 1024))).status, 413);
    assert.equal((await post(Buffer.alloc(5000, 7))).status, 415);
    const ok = await post(mp3(200 * 1024)); assert.equal(ok.status, 200);
    assert.equal((await ok.json()).upload.size, 200 * 1024);
    const left = [...fs.readdirSync(path.join(data, 'assets')), ...fs.readdirSync(path.join(data, 'projects', proj.id))].filter((f) => f.startsWith('.upload-'));
    assert.deepEqual(left, []);
  } finally { child.kill('SIGKILL'); }
});

console.log(`\n${n} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
