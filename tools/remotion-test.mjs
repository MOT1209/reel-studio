// Remotion engine, end to end: real server, real project (photo scene, video background clip, Arabic captions),
// rendered by the legacy engine and by Remotion, both checked with ffprobe and compared frame by frame (SSIM).
// Also: H.265 + bitrate through Remotion, cancel, engine selection API. node tools/remotion-test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-remotion-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4393, PORT = 4307, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg', FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const OUT = path.join(ROOT, 'output', 'remotion-test'); fs.mkdirSync(OUT, { recursive: true });
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, ...(typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
async function waitStage(id, stage, status, ms = 300000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error');
    if (err) throw new Error(`${err[0]}: ${err[1].error}\n${(err[1].log || []).slice(-6).join('\n')}`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${stage}=${status}`);
    await sleep(400);
  }
}
const probe = (f) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration', '-of', 'json', f]).toString());
const vOf = (f) => probe(f).streams.find((s) => s.codec_type === 'video');
/** Mean SSIM of two videos (all frames) and the worst single frame. */
function ssim(a, b) {
  const log = path.join(TMP, `ssim-${Date.now()}.log`);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', a, '-i', b, '-lavfi', `[0:v][1:v]ssim=stats_file=${log.replace(/\\/g, '/').replace(/:/g, '\\:')}`, '-f', 'null', '-'], { encoding: 'utf8' });
  const all = Number((r.stderr.match(/All:([\d.]+)/) || [])[1]);
  const per = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => Number((l.match(/All:([\d.]+)/) || [])[1]));
  return { all, min: Math.min(...per), frames: per.length };
}

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, RS_RENDER_WORKERS: '2', RS_REMOTION_CONCURRENCY: '2',
  LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);

const img = path.join(TMP, 'img.jpg'), vid = path.join(TMP, 'vid.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1200x900', '-frames:v', '1', img]);
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-pix_fmt', 'yuv420p', vid]);
const add = async (f, folder) => api('/api/assets', { method: 'POST', body: fs.readFileSync(f), headers: { 'X-Filename': path.basename(f), 'X-Folder': folder } });
const [iA, vA] = [await add(img, 'img'), await add(vid, 'clips')];

await test('engines API: legacy and remotion are registered and available', async () => {
  const e = await api('/api/engines?fresh=1');
  const by = Object.fromEntries(e.engines.map((x) => [x.id, x]));
  assert.ok(by.legacy?.available, 'legacy available');
  assert.ok(by.remotion?.available, `remotion available: ${by.remotion?.reason}`);
  assert.deepEqual(e.choices, ['auto', 'remotion', 'legacy']);
  assert.ok(e.codecs.h264);
});

const p0 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 10, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
let P = await waitStage(p0.id, 'storyboard', 'review');
const id = P.id;
const sb = structuredClone(P.storyboard);
sb.scenes[1] = { ...sb.scenes[1], template: 'photo', image: iA.id, items: [{ label: 'ضوء الشمس', icon: 'sun', value: null, at: null }] };
if (sb.scenes[2]) sb.scenes[2] = { ...sb.scenes[2], bg: 'full', image: vA.id };
const baseEdit = { export: { aspect: '9:16', resolution: 720, quality: 'high', fps: 30, engine: 'legacy' }, trim: { start: 0, end: 6 }, typography: { captionStyle: 'boxed', digits: 'arabic' } };
await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ storyboard: sb, edit: baseEdit }) });

const video = path.join(DATA, 'projects', id, 'video.mp4');
const legacyOut = path.join(OUT, 'legacy.mp4'), remotionOut = path.join(OUT, 'remotion.mp4');
const timing = {};

await test('legacy engine renders the reference video (photo scene, video background, Arabic captions)', async () => {
  await api(`/api/projects/${id}/stages/storyboard/approve`, { method: 'POST' });
  P = await waitStage(id, 'render', 'done');
  assert.equal(P.render.engine, 'legacy');
  timing.legacy = P.render.renderSeconds;
  fs.copyFileSync(video, legacyOut);
});

await test('remotion engine renders the same project: same size, fps, frame count, codec, audio (ffprobe)', async () => {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { ...baseEdit, export: { ...baseEdit.export, engine: 'remotion' } } }) });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  P = await waitStage(id, 'render', 'done', 600000);
  const log = P.stages.render.log.join('\n');
  assert.equal(P.render.engine, 'remotion', `engine used: ${P.render.engine} · fallback from ${P.render.fallbackFrom}\n${log.slice(-800)}`);
  assert.equal(P.render.fallbackFrom, null);
  assert.match(log, /engine: Remotion/);
  assert.match(log, /checked: 720×1280 · 30\/1 fps · h264\/aac/);
  timing.remotion = P.render.renderSeconds;
  fs.copyFileSync(video, remotionOut);
  const [a, b] = [probe(legacyOut), probe(remotionOut)];
  const [va, vb] = [a.streams.find((s) => s.codec_type === 'video'), b.streams.find((s) => s.codec_type === 'video')];
  assert.deepEqual([vb.width, vb.height, vb.r_frame_rate, vb.codec_name], [720, 1280, '30/1', 'h264']);
  assert.equal(vb.nb_read_frames, va.nb_read_frames, 'same frame count');
  assert.ok(b.streams.some((s) => s.codec_type === 'audio'), 'audio track');
  assert.ok(Math.abs(Number(a.format.duration) - Number(b.format.duration)) < 0.05);
});

await test('remotion output matches the legacy engine frame by frame (SSIM ≥ 0.97 mean, ≥ 0.93 worst frame)', async () => {
  const s = ssim(legacyOut, remotionOut);
  console.log(`   SSIM mean ${s.all.toFixed(4)} · worst frame ${s.min.toFixed(4)} · ${s.frames} frames · render ${timing.legacy}s legacy vs ${timing.remotion}s remotion`);
  assert.ok(s.all >= 0.97, `mean SSIM ${s.all}`);
  assert.ok(s.min >= 0.93, `worst frame SSIM ${s.min}`);
  for (const t of [0.5, 2.5, 4.5]) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(t), '-i', legacyOut, '-ss', String(t), '-i', remotionOut, '-filter_complex', '[0:v][1:v]hstack', '-frames:v', '1', path.join(OUT, `compare-${t}s.jpg`)]);
  }
});

await test('remotion: 16:9 1080p, H.265 at a fixed bitrate', async () => {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { ...baseEdit, trim: { start: 0, end: 3 }, export: { aspect: '16:9', resolution: 1080, quality: 'draft', fps: 30, engine: 'remotion', codec: 'h265', bitrate: 3000 } } }) });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  P = await waitStage(id, 'render', 'done', 600000);
  assert.equal(P.render.engine, 'remotion');
  const v = vOf(video);
  assert.deepEqual([v.width, v.height], [1920, 1080]);
  const enc = execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString();
  assert.equal(v.codec_name, enc.includes('libx265') ? 'hevc' : 'h264');
  const kbps = (fs.statSync(video).size * 8) / 1000 / Number(probe(video).format.duration);
  assert.ok(kbps < 3000 * 1.6, `bitrate ${kbps.toFixed(0)} kbit/s (asked 3000)`);
  fs.copyFileSync(video, path.join(OUT, 'remotion-16x9-h265.mp4'));
});

await test('remotion: cancel mid-render stops the job (status cancelled), the next render still works', async () => {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { ...baseEdit, trim: { start: 0, end: null }, export: { ...baseEdit.export, quality: 'draft', engine: 'remotion', codec: 'h264', bitrate: null } } }) });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const t0 = Date.now();
  let job = null;
  while (!(job && job.engine === 'remotion' && job.status === 'running' && job.frames > 20)) {
    if (Date.now() - t0 > 180000) throw new Error('render never started');
    job = (await api('/api/render-jobs')).jobs.at(-1);
    await sleep(150);
  }
  await api(`/api/render-jobs/${job.id}/cancel`, { method: 'POST' });
  for (let i = 0; i < 100 && (await api(`/api/render-jobs/${job.id}`)).status === 'running'; i++) await sleep(100);
  assert.equal((await api(`/api/render-jobs/${job.id}`)).status, 'cancelled');
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  P = await waitStage(id, 'render', 'done', 600000);
  assert.equal(P.render.engine, 'remotion');
});

await test('the job history is written to data/logs/render-jobs.jsonl', async () => {
  const rows = fs.readFileSync(path.join(DATA, 'logs', 'render-jobs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.engine === 'remotion' && r.status === 'done'));
  assert.ok(rows.some((r) => r.engine === 'remotion' && r.status === 'cancelled'));
  assert.ok(rows.some((r) => r.engine === 'legacy' && r.status === 'done'));
});

fs.writeFileSync(path.join(OUT, 'timing.json'), JSON.stringify(timing, null, 2));
procs.forEach((p) => p.kill());
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} remotion tests FAILED` : `\n${n} remotion tests passed — outputs in output/remotion-test/`);
process.exit(failed ? 1 : 0);
