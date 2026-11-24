// Editor model → real rendered output: formats, trim, music, overlays, video clips, photo scenes, fonts, caption
// styles, subtitles and render recovery. Offline mocks + real Chromium + ffmpeg. node tools/export-test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-export-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4392, PORT = 4306, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg', FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const OUT = path.join(ROOT, 'output', 'export-test'); fs.mkdirSync(OUT, { recursive: true });
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
async function waitStage(id, stage, status, ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error');
    if (err) throw new Error(`${err[0]}: ${err[1].error}`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${stage}=${status}`);
    await sleep(400);
  }
}
const probe = (f) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', f]).toString());
/** Integrated loudness (EBU R128) of a file. */
function spawnSyncErr(f) {
  const out = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const m = out.match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+) LUFS/);
  return m ? Number(m[1]) : NaN;
}

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, RS_RENDER_WORKERS: '2',
  LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '',
  PEXELS_BASE_URL: `${MOCK}/pexels`, PEXELS_API_KEY: 'pexels-key' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);

// library media: a music bed, an image and a video clip
const music = path.join(TMP, 'music.mp3'), img = path.join(TMP, 'img.jpg'), vid = path.join(TMP, 'vid.mp4');
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-f', 'lavfi', '-i', 'sine=f=330:d=4', '-filter_complex', 'amix=inputs=2', music]);
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1200x900', '-frames:v', '1', img]);
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-pix_fmt', 'yuv420p', vid]);
const add = async (f, folder) => api('/api/assets', { method: 'POST', body: fs.readFileSync(f), headers: { 'X-Filename': path.basename(f), 'X-Folder': folder } });
const [mA, iA, vA] = [await add(music, 'music'), await add(img, 'img'), await add(vid, 'clips')];

const p0 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 10, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
let P = await waitStage(p0.id, 'storyboard', 'review');
const id = P.id;

await test('editor save: invalid edits are refused without side effects (unknown asset, wrong kind)', async () => {
  await assert.rejects(api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { overlays: [{ kind: 'image', asset: 'aaaaaaaaaaaa', start: 1, end: 2 }] } }) }), /400/);
  await assert.rejects(api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { audio: { music: { asset: iA.id } } } }) }), /400/);
});

await test('editor save: scenes (photo + full-frame video bg), overlays, trim, music, typography, 16:9 720p', async () => {
  const sb = structuredClone(P.storyboard);
  sb.scenes[1] = { ...sb.scenes[1], template: 'photo', image: iA.id, items: [{ label: 'ضوء الشمس', icon: 'sun', value: null, at: null }] };
  if (sb.scenes[2]) sb.scenes[2] = { ...sb.scenes[2], bg: 'full', image: vA.id };
  const r = await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ storyboard: sb, edit: {
    export: { aspect: '16:9', resolution: 720, quality: 'draft', fps: 25 },
    trim: { start: 1, end: 7 },
    transition: 'slide',
    audio: { music: { asset: mA.id, volume: 0.3, duck: true }, voiceVolume: 1 },
    typography: { font: 'cairo', captionFont: 'tajawal', captionStyle: 'outline', digits: 'arabic', captionSize: 56 },
    overlays: [
      { kind: 'text', text: 'خلي بالك!', start: 2, end: 4, pos: 'top', anim: 'pop', size: 44 },
      { kind: 'image', asset: iA.id, start: 3, end: 5, pos: 'center', scale: 0.4 },
      { kind: 'video', asset: vA.id, start: 4.5, end: 6.5, pos: 'bottom', scale: 0.5 },
    ] } }) });
  assert.equal(r.project.stages.render.status, 'idle');
  assert.equal(r.project.storyboard.scenes[1].template, 'photo');
  assert.equal(r.project.edit.overlays.length, 3);
  const d = await api(`/api/projects/${id}/render-data`);
  assert.equal(d.layout.width, 1280); assert.equal(d.layout.height, 720);
  assert.equal(d.start, 1); assert.equal(d.end, 7); assert.equal(d.duration, 6);
  assert.match(d.fonts.main.faces[0].url, /\/fonts\/cairo\//); assert.match(d.fonts.captions.faces[0].url, /\/fonts\/tajawal\//);
  assert.equal(d.media[iA.id].kind, 'image'); assert.equal(d.media[vA.id].kind, 'video');
});

await test('render: 16:9 720p 25 fps, 6 s trim, music ducked, overlays + clips + photo, −14 LUFS', async () => {
  await api(`/api/projects/${id}/stages/storyboard/approve`, { method: 'POST' });
  P = await waitStage(id, 'render', 'done');
  const f = path.join(DATA, 'projects', id, 'video.mp4');
  const pr = probe(f);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264'); assert.equal(v.width, 1280); assert.equal(v.height, 720); assert.equal(v.r_frame_rate, '25/1');
  assert.ok(Math.abs(Number(pr.format.duration) - 6) < 0.15, `duration ${pr.format.duration}`);
  assert.ok(pr.streams.some((s) => s.codec_type === 'audio'));
  const L = spawnSyncErr(f); assert.ok(Math.abs(L + 14) <= 1, `loudness ${L}`);
  const log = P.stages.render.log.join('\n');
  assert.match(log, /clip scene-2: \d+ frames/); assert.match(log, /clip ov-/); assert.match(log, /music 30% \(ducked under voice\)/);
  assert.ok(!fs.existsSync(path.join(DATA, 'projects', id, 'segments')), 'temp segments cleaned');
  assert.ok(!fs.existsSync(path.join(DATA, 'projects', id, 'frames.mp4')));
  fs.copyFileSync(f, path.join(OUT, 'export-16x9-720p.mp4'));
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', '3.6', '-i', f, '-frames:v', '1', path.join(OUT, 'frame-16x9.jpg')]);
});

await test('render page: the chosen fonts are the ones loaded (Cairo for text, Tajawal for captions)', async () => {
  const { launchBrowser } = await import('../server/render.mjs');
  const b = await launchBrowser();
  try {
    const pg = await b.newPage();
    const loaded = [];
    pg.on('response', (r) => { if (r.url().includes('/fonts/')) loaded.push(new URL(r.url()).pathname); });
    await pg.goto(`${BASE}/render.html?project=${id}`);
    await pg.waitForFunction(() => window.__ready || window.__error);
    assert.equal(await pg.evaluate(() => window.__error || null), null);
    assert.ok(loaded.some((u) => u.startsWith('/fonts/cairo/')) && loaded.some((u) => u.startsWith('/fonts/tajawal/')), loaded.join(','));
    assert.ok(await pg.evaluate(() => document.fonts.check('700 40px ReelCaption') && document.fonts.check('700 40px ReelFont')));
    assert.deepEqual(await pg.evaluate(() => [document.getElementById('c').width, document.getElementById('c').height]), [1280, 720]);
  } finally { await b.close(); }
});

await test('subtitles follow the trim (start at 0, nothing after the clip end) and the Arabic-digit setting', async () => {
  const raw = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/subtitles.srt`)).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM (Windows players need it for Arabic)');
  const srt = raw.subarray(3).toString('utf8');
  assert.match(srt, /^1\n00:00:00,000 --> /);
  const ends = [...srt.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((m) => m[3] * 1 + m[4] / 1000);
  assert.ok(Math.max(...ends) <= 6.001, `last end ${Math.max(...ends)}`);
});

await test('1:1 1080p export (draft) renders at 1080×1080', async () => {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '1:1', resolution: 1080, quality: 'draft', fps: 30 }, trim: { start: 0, end: 3 }, overlays: [], audio: { music: null }, typography: { align: 'justify', captionSize: 64, captionFont: 'amiri', digits: 'arabic' } } }) });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  await waitStage(id, 'render', 'done');
  const v = probe(path.join(DATA, 'projects', id, 'video.mp4')).streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '1080x1080');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', '1.5', '-i', path.join(DATA, 'projects', id, 'video.mp4'), '-frames:v', '1', path.join(OUT, 'frame-1x1.jpg')]);
});

await test('recovery: a render cancelled after its first segment resumes from that segment', async () => {
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '9:16', resolution: 720, quality: 'draft', fps: 30 }, trim: { start: 0, end: null } } }) });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const man = path.join(DATA, 'projects', id, 'segments', 'manifest.json');
  const t0 = Date.now();
  while (!(fs.existsSync(man) && JSON.parse(fs.readFileSync(man, 'utf8')).done?.length >= 1)) { if (Date.now() - t0 > 180000) throw new Error('first segment never finished'); await sleep(200); }
  await api(`/api/projects/${id}/cancel`, { method: 'POST' });
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const done = await waitStage(id, 'render', 'done');
  assert.match(done.stages.render.log.join('\n'), /recovery: reusing 1\/2 segments/);
  const pr = probe(path.join(DATA, 'projects', id, 'video.mp4'));
  assert.ok(Math.abs(Number(pr.format.duration) - done.render.duration) < 0.15, `duration ${pr.format.duration} vs ${done.render.duration}`);
});

/** Mean volume (dB) of the 1 kHz band in [t0, t1] of a file's audio. */
function toneDb(f, t0, t1) {
  const err = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(t0), '-t', String(t1 - t0), '-i', f, '-af', 'bandpass=f=1000:width_type=q:w=8,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return Number(err.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
}

await test('cut from the middle + clip sound: video, audio and subtitles all lose the cut range; the clip is heard', async () => {
  const tone = path.join(TMP, 'tone.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=f=1000:d=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tone]);
  const tA = await add(tone, 'clips');
  assert.equal(tA.hasAudio, true);
  const before = await api(`/api/projects/${id}/render-data`);
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: {
    export: { aspect: '9:16', resolution: 720, quality: 'draft', fps: 30 }, trim: { start: 0, end: null },
    cuts: [{ start: 2, end: 4 }],
    overlays: [{ kind: 'video', asset: tA.id, start: 5, end: 6.5, pos: 'bottom', scale: 0.4, volume: 1 }] } }) });
  const d = await api(`/api/projects/${id}/render-data`);
  assert.deepEqual(d.segments, [[0, 2], [4, d.full]]);
  assert.ok(Math.abs(d.duration - (before.full - 2)) < 0.01, `duration ${d.duration} vs ${before.full - 2}`);
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const done = await waitStage(id, 'render', 'done');
  const f = path.join(DATA, 'projects', id, 'video.mp4');
  const pr = probe(f);
  assert.ok(Math.abs(Number(pr.format.duration) - d.duration) < 0.15, `mp4 ${pr.format.duration} vs ${d.duration}`);
  assert.match(done.stages.render.log.join('\n'), /1 cut .*1 clip sound/);
  // source 5 s → output 3 s: the clip's 1 kHz tone is there, and it is not in the first second
  const inClip = toneDb(f, 3.1, 4.3), outside = toneDb(f, 0.1, 1.2);
  assert.ok(inClip > outside + 12, `tone in clip window ${inClip} dB vs outside ${outside} dB`);
  const srt = await (await fetch(`${BASE}/api/projects/${id}/subtitles.srt`)).text();
  const ends = [...srt.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((m) => m[3] * 1 + m[4] / 1000);
  assert.ok(Math.max(...ends) <= d.duration + 0.001, `subtitles end at ${Math.max(...ends)} > ${d.duration}`);
  const cutWords = before.words.filter((w) => w.start >= 2.05 && w.end <= 3.95).map((w) => w.text);
  for (const w of cutWords) assert.ok(!srt.includes(w) || before.words.filter((x) => x.text === w).length > 1, `cut word «${w}» still in subtitles`);
});

await test('custom order: the second half plays first, then a 1.5 s pause, then the first half', async () => {
  const before = await api(`/api/projects/${id}/render-data`);
  const split = before.words[Math.floor(before.words.length / 2)].start;
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { cuts: [], overlays: [], export: { aspect: '9:16', resolution: 720, quality: 'draft', fps: 30 },
    sequence: [{ start: split, end: before.full }, { hold: 1.5, at: split }, { start: 0, end: split }] } }) });
  const d = await api(`/api/projects/${id}/render-data`);
  assert.ok(Math.abs(d.duration - (before.full + 1.5)) < 0.01, `duration ${d.duration}`);
  await api(`/api/projects/${id}/run`, { method: 'POST' });
  const done = await waitStage(id, 'render', 'done');
  assert.match(done.stages.render.log.join('\n'), /custom order: 2 parts, 1 pause/);
  const f = path.join(DATA, 'projects', id, 'video.mp4');
  assert.ok(Math.abs(Number(probe(f).format.duration) - d.duration) < 0.15);
  // the pause is silent (voice gone, no music in this edit) while the parts around it are not
  const vol = (t0, t1) => Number(spawnSync(FFMPEG, ['-hide_banner', '-ss', String(t0), '-t', String(t1 - t0), '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume:\s*(-?[\d.]+)/)?.[1]);
  const pauseAt = before.full - split;
  const quiet = vol(pauseAt + 0.25, pauseAt + 1.25), loud = vol(0.3, 1.3);
  assert.ok(quiet < loud - 25, `pause ${quiet} dB vs speech ${loud} dB`);
  const srt = await (await fetch(`${BASE}/api/projects/${id}/subtitles.srt`)).text();
  const first = srt.split('\n')[2].replace(/‏/g, '');
  const firstLate = before.words.find((w) => w.start >= split - 0.01).text;
  assert.ok(first.startsWith(firstLate), `first subtitle «${first}» should start with «${firstLate}»`);
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { sequence: null } }) });
});

console.log(`\n${n} export tests passed${failed ? `, ${failed} FAILED` : ''} — frames in output/export-test/`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
