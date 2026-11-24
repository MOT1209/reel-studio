// Arabic in the FINAL VIDEO: renders a real MP4 whose captions contain Arabic only, English only, Arabic+English,
// Arabic+numbers/punctuation and a long line, then decodes frames from the MP4 (not the browser preview) and checks
// them: text is present, stays inside the safe margins, and Arabic glyphs are shaped (the same word is narrower
// joined than as isolated letters). Frames are saved to output/arabic-video/ for visual review. node tools/arabic-video-test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-arvid-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4393, PORT = 4315, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const OUT = path.join(ROOT, 'output', 'arabic-video'); fs.mkdirSync(OUT, { recursive: true });
const procs = []; process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, ...(typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
async function waitStage(id, stage, status, ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error'); if (err) throw new Error(`${err[0]}: ${err[1].error}`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${stage}=${status}`); await sleep(400);
  }
}
procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, RS_RENDER_WORKERS: '2',
  LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);

const p0 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 10, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
const P = await waitStage(p0.id, 'storyboard', 'review'); const id = P.id;

// One real render per case. The case text replaces the words of the FIRST script line (timing kept); if the line has more
// words than the text, the text repeats, so the caption chunk is always full of that case's script.
const CASES = {
  arabic: 'السرعة الهائلة للضوء في الفراغ',
  english: 'Light travels very fast indeed',
  mixed: 'الـ DNA polymerase بيعمل نسخة جديدة',
  numbers: 'سنة ٢٠٢٤ كانت 100% أسرع، صح؟',
  long: 'ولذلك فإن الضوء الأزرق يتشتت أكثر بكثير من الأحمر',
};
const keys = Object.keys(CASES);
const line0 = P.words.map((w, i) => (w.line === P.words[0].line ? i : -1)).filter((i) => i >= 0);
console.log(`first script line has ${line0.length} words`);
const mp4 = path.join(DATA, 'projects', id, 'video.mp4');
const edit = { export: { aspect: '9:16', resolution: 720, quality: 'standard', fps: 30 }, trim: { start: 0, end: null }, cuts: [],
  overlays: [{ kind: 'text', text: 'سرعة الضوء ⚡ Light speed', start: 0.5, end: 4, pos: 'top', size: 56, anim: 'pop', box: true }] };
let approved = false;
const renderCase = async (k) => {
  const toks = CASES[k].split(' ');
  const words = P.words.map((w, i) => ({ start: w.start, end: w.end, text: line0.includes(i) ? toks[line0.indexOf(i) % toks.length] : w.text }));
  await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ words, edit }) });
  if (!approved) { approved = true; await api(`/api/projects/${id}/stages/storyboard/approve`, { method: 'POST' }); } else await api(`/api/projects/${id}/run`, { method: 'POST' });
  await waitStage(id, 'render', 'done');
  fs.copyFileSync(mp4, path.join(OUT, `${k}.mp4`));
  return path.join(OUT, `${k}.mp4`);
};
let cur = mp4;
function frame(t) { return spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', cur, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 }).stdout; }
function savePng(t, name) { execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(t), '-i', cur, '-frames:v', '1', path.join(OUT, name + '.png')]); }
const W = 720, H = 1280;
/** bounding box of near-white text pixels in the caption band */
function textBox(buf, y0, y1) {
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, c = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (buf[i] > 225 && buf[i + 1] > 225 && buf[i + 2] > 215) { c++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } }
  return { minx, maxx, miny, maxy, n: c };
}
const D = await api(`/api/projects/${id}/render-data`);
for (const k of keys) {
  await test(`final video · ${k}: caption text is rendered, inside the safe margins, one block`, async () => {
    cur = await renderCase(k);
    const w3 = D.words[line0[Math.min(3, line0.length - 1)]];
    const mid = (w3.start + w3.end) / 2 + 0.05; // after ≥ 4 words are lit
    savePng(mid, k);
    const b = textBox(frame(mid), 900, 1150);
    assert.ok(b.n > 400, `caption pixels found: ${b.n}`);
    assert.ok(b.minx >= 24 && b.maxx <= W - 24, `text spans ${b.minx}–${b.maxx} of ${W} (must stay inside 24 px margins)`);
    assert.ok(b.maxy - b.miny < 220, `caption block is ${b.maxy - b.miny}px tall (≤ 3 lines)`);
  });
}
await test('final video · animated Arabic+English title overlay is visible mid-animation and gone after it ends', async () => {
  savePng(2, 'title');
  const during = textBox(frame(2), 60, 300), after = textBox(frame(5), 60, 300);
  assert.ok(during.n > 300 && during.n > after.n * 2, `title pixels during ${during.n}, after ${after.n}`);
});
await test('final video · Arabic is shaped: a joined word is narrower than the same letters drawn isolated (render browser)', async () => {
  const { launchBrowser } = await import('../server/render.mjs');
  const b = await launchBrowser(); const pg = await b.newPage();
  await pg.goto(`${BASE}/render.html?project=${id}`); await pg.waitForFunction(() => window.__ready === true);
  const r = await pg.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = "700 60px 'RS Arabic', sans-serif"; c.direction = 'rtl';
    const joined = c.measureText('بيتشتت').width; const iso = [...'بيتشتت'].map((ch) => c.measureText(ch + '‌').width - c.measureText('‌').width).reduce((a, x) => a + x, 0); return { joined, iso }; });
  await b.close();
  assert.ok(r.joined < r.iso - 4, `joined ${r.joined.toFixed(1)} vs isolated ${r.iso.toFixed(1)}`);
});
console.log(`\n${n} Arabic video tests passed${failed ? `, ${failed} FAILED` : ''} — frames in output/arabic-video/`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
