// Regression tests for failure paths (Phase 1 audit fixes): node tools/robustness.mjs
// Uses the offline mocks and the real browser/ffmpeg; every case has a hard timeout so a
// regression shows up as a failure instead of a hung test run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-robust-'));
const MOCK_PORT = 4396, PORT = 4304, STALL_PORT = 4395;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
Object.assign(process.env, {
  RS_DATA_DIR: path.join(TMP, 'data'),
  YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'csecret',
  YT_TOKEN_URL: `${MOCK}/yt/token`, YT_API_URL: `${MOCK}/yt/api`, YT_UPLOAD_URL: `${MOCK}/yt/upload`, YT_CHUNK_BYTES: String(256 * 1024),
  LLM_BASE_URL: `http://127.0.0.1:${STALL_PORT}/v1`, LLM_IDLE_TIMEOUT_MS: '60000',
});

const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, what, pr) => Promise.race([pr, sleep(ms).then(() => { throw new Error(`HANG: ${what} still pending after ${ms} ms`); })]);
let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); }
}
async function waitHttp(url) { for (let i = 0; i < 100; i++) { try { await fetch(url); return; } catch { await sleep(100); } } throw new Error('not up: ' + url); }

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
await waitHttp(`${MOCK}/yt/_last`);
const control = (o) => fetch(`${MOCK}/yt/_control`, { method: 'POST', body: JSON.stringify(o) });

const { writeFileAtomic, DATA_DIR } = await import('../server/settings.mjs');
const { uploadVideo } = await import('../server/youtube.mjs');
const { renderFrames } = await import('../server/render.mjs');
const P = await import('../server/pipeline.mjs');
const { extractJson } = await import('../server/storyboard.mjs');

// ---- YouTube -------------------------------------------------------------------------
const video = path.join(TMP, 'v.mp4');
fs.writeFileSync(video, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(1200 * 1024, 7)]));
const tokenFile = path.join(DATA_DIR, 'youtube-token.json');
const staleToken = () => writeFileAtomic(tokenFile, JSON.stringify({ refresh_token: 'mock-refresh', access_token: 'revoked-early', expiry: Date.now() + 3600e3 }));

await test('YouTube: a 401 on a cached, unexpired token forces one refresh and the upload finishes', async () => {
  staleToken(); await control({ denyAll: false, revokeAfterChunks: 2 });
  const r = await within(20000, 'uploadVideo', uploadVideo(video, { title: 't', description: '', tags: [], categoryId: '27' }));
  assert.match(r.videoId, /^mockVid/);
  const last = await (await fetch(`${MOCK}/yt/_last`)).json();
  assert.equal(last.bytes, fs.statSync(video).size, 'every byte arrived exactly once');
});

await test('YouTube: a persistent 401 fails with a message instead of looping forever', async () => {
  staleToken(); await control({ denyAll: true, revokeAfterChunks: 0 });
  await assert.rejects(within(20000, 'uploadVideo', uploadVideo(video, { title: 't', description: '', tags: [], categoryId: '27' })), /401|upload init|unauthorized/);
  await control({ denyAll: false });
});

// ---- rendering -----------------------------------------------------------------------
const page = (body) => 'data:text/html,' + encodeURIComponent(`<canvas id=c width=1080 height=1920></canvas><script>window.drawFrame=t=>{${body};const x=c.getContext('2d');x.fillStyle='#'+((t*997)%16777215|0).toString(16).padStart(6,'0');x.fillRect(0,0,1080,1920)};window.__ready=true</script>`);
const fakeFf = path.join(TMP, 'ff-dies.mjs');
fs.writeFileSync(fakeFf, "process.stdin.once('data',()=>process.exit(3));");
const fakeFfCmd = path.join(TMP, process.platform === 'win32' ? 'ff-dies.cmd' : 'ff-dies.sh');
fs.writeFileSync(fakeFfCmd, process.platform === 'win32' ? `@node "${fakeFf}"\r\n` : `#!/bin/sh\nexec node "${fakeFf}"\n`, { mode: 0o755 });

await test('render: ffmpeg dying mid-render rejects instead of hanging', async () => {
  const r = spawn(process.execPath, ['-e', `
    import('${path.join(ROOT, 'server/render.mjs').replace(/\\/g, '/')}').then(({renderFrames}) =>
      renderFrames({ url: ${JSON.stringify(page(''))}, out: ${JSON.stringify(path.join(TMP, 'x.mp4'))}, duration: 8, fps: 30 }))
      .then(() => { console.log('RESOLVED'); process.exit(0); }, (e) => { console.log('REJECTED ' + e.message); process.exit(0); });`],
  { env: { ...process.env, FFMPEG_PATH: fakeFfCmd, RS_RENDER_WORKERS: '2' } });
  let out = ''; r.stdout.on('data', (d) => { out += d; });
  await within(45000, 'renderFrames with a dying ffmpeg', new Promise((res) => r.on('close', res))).finally(() => r.kill());
  assert.match(out, /REJECTED ffmpeg exited 3/);
});

await test('render: a frame that throws rejects and leaves no loop running', async () => {
  await assert.rejects(within(45000, 'renderFrames', renderFrames({ url: page("if(t>1)throw new Error('boom')"), out: path.join(TMP, 'y.mp4'), duration: 4, fps: 30 })), /boom/);
  // the old writer re-armed a 50 ms timer forever after a failed frame; count timers created now
  await sleep(200);
  const real = globalThis.setTimeout; let armed = 0;
  globalThis.setTimeout = (...a) => { armed++; return real(...a); };
  try { await new Promise((r) => real(r, 600)); } finally { globalThis.setTimeout = real; }
  assert.ok(armed < 3, `no loop keeps polling after the failure (${armed} timers armed in 600 ms)`);
});

// ---- pipeline: edits while a stage runs ----------------------------------------------
// An LLM that never answers keeps the script stage "running" until it is aborted.
const stall = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hi\n\n'); req.on('close', () => res.end()); });
await new Promise((r) => stall.listen(STALL_PORT, '127.0.0.1', r));

await test('pipeline: editing the script while it is being written stops the run and keeps the edit', async () => {
  const p = P.createProject({ topic: 'اختبار', seconds: 10, approvals: { script: 'auto' } });
  P.runPipeline(p.id);
  for (let i = 0; i < 50 && P.publicProject(p).running !== 'script'; i++) await sleep(20);
  assert.equal(P.publicProject(p).running, 'script');
  await within(5000, 'editStage', P.editStage(p.id, 'script', { title: 'عنوان', text: 'نص المستخدم هنا' }));
  assert.equal(P.publicProject(p).running, null, 'nothing is running after the edit');
  assert.equal(p.script.text, 'نص المستخدم هنا');
  assert.equal(p.stages.script.status, 'done');
  assert.ok(STAGES_IDLE(p), 'later stages are reset');
});

await test('pipeline: an invalid edit is refused without cancelling the run', async () => {
  const p = P.createProject({ topic: 'اختبار ٢', seconds: 10 });
  P.runPipeline(p.id);
  for (let i = 0; i < 50 && P.publicProject(p).running !== 'script'; i++) await sleep(20);
  await assert.rejects(P.editStage(p.id, 'script', { text: '   ' }), /empty/);
  assert.equal(P.publicProject(p).running, 'script');
  await P.cancel(p.id);
});

await test('upload: bytes that are not audio are refused (415), real containers accepted', async () => {
  const p = P.createProject({ topic: 'رفع', seconds: 10, approvals: { script: 'wait' } });
  await assert.rejects(P.saveUpload(p.id, Buffer.from('<html>not audio</html>'), 'x.mp3', 'audio/mpeg'), (e) => e.status === 415);
  assert.ok(P.looksLikeMedia(Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1')));
  assert.ok(P.looksLikeMedia(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')])));
  assert.ok(P.looksLikeMedia(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')])));
});

await test('projects: a corrupt project.json is skipped instead of breaking the list', async () => {
  const dir = path.join(DATA_DIR, 'projects', '20990101-bad000');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{"id": "20990101-bad000", "stag');
  const list = P.listProjects();
  assert.ok(Array.isArray(list) && !list.some((x) => x.id === '20990101-bad000'));
});

await test('storage: secrets are written atomically and owner-only (POSIX)', async () => {
  const f = path.join(TMP, 'secret.json');
  writeFileAtomic(f, '{"a":1}', { mode: 0o600 });
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(TMP).filter((x) => x.endsWith('.tmp')), []);
});

await test('storyboard JSON repair keeps URLs inside strings', async () => {
  const j = extractJson('{"a": "https://example.com/x", // note\n "b": [1,2,],}');
  assert.deepEqual(j, { a: 'https://example.com/x', b: [1, 2] });
});

// ---- HTTP layer ----------------------------------------------------------------------
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'srv') }, stdio: 'ignore' }));
const BASE = `http://127.0.0.1:${PORT}`;
await waitHttp(`${BASE}/api/health`);

await test('http: malformed URL escapes answer 400, not 500', async () => {
  assert.equal((await fetch(`${BASE}/api/projects/%E0%A4%A`)).status, 400);
});
await test('http: suffix ranges larger than the file are clamped', async () => {
  const r = await fetch(`${BASE}/app.css`, { headers: { Range: 'bytes=-999999999' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, fs.statSync(path.join(ROOT, 'public/app.css')).size);
});
await test('http: favicon request does not produce a 404 console error in render.html', async () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'public/render.html'), 'utf8'), /rel="icon"/);
});

await test('connection test: a dead endpoint is reported, not thrown', async () => {
  const { testLlm } = await import('../server/apis.mjs');
  const r = await within(15000, 'testLlm', testLlm({ llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'auto' } }));
  assert.equal(r.ok, false);
});

function STAGES_IDLE(p) { return ['voice', 'timing', 'storyboard', 'render'].every((s) => p.stages[s].status === 'idle'); }

stall.close();
console.log(`\n${n} robustness tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
