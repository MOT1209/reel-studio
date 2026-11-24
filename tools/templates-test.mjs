// One test project per storyboard template (offline mocks), then a contact sheet of frames for each:
//   node tools/templates-test.mjs [template …] [--render] [--theme=paper]
// Sheets land in output/templates/<template>.jpg. With --render each project is also rendered to MP4.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = ['body', 'zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter'];
const args = process.argv.slice(2);
const wanted = args.filter((a) => TEMPLATES.includes(a));
const list = wanted.length ? wanted : TEMPLATES;
const fullRender = args.includes('--render');
const MOCK_PORT = Number(process.env.MOCK_PORT || 4398), PORT = Number(process.env.T_PORT || 4303);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'templates-test');
const OUT = path.join(ROOT, 'output', 'templates');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const procs = [];
const start = (a, env) => { const p = spawn('node', a, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true }); p.stderr.on('data', (d) => process.stderr.write(d)); procs.push(p); };
process.on('exit', () => procs.forEach((p) => p.kill()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', Origin: BASE } });
  const b = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(b));
  return b;
}
async function waitStage(id, stage, status, ms = 600000) {
  const t0 = Date.now();
  for (;;) {
    const p = await api(`/api/projects/${id}`);
    const err = Object.entries(p.stages).find(([, s]) => s.status === 'error');
    if (err) throw new Error(`${err[0]}: ${err[1].error}`);
    const waiting = Object.entries(p.stages).find(([k, s]) => s.status === 'review' && k !== stage);
    if (waiting) throw new Error(`${waiting[0]} is waiting for approval — the test would wait forever`);
    if (p.stages[stage].status === status) return p;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(500);
  }
}

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
start(['tools/mock-apis.mjs'], { MOCK_PORT: String(MOCK_PORT) });
start(['server/index.mjs'], { RS_PORT: String(PORT), RS_DATA_DIR: DATA, LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '' });
for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(300); } }
const theme = (args.find((a) => a.startsWith('--theme=')) || '').slice(8);
if (theme) await api('/api/settings', { method: 'PUT', body: JSON.stringify({ look: { theme } }) });
const suffix = theme ? `-${theme}` : '';

const { launchBrowser } = await import('../server/render.mjs'); // same fallback as rendering (bundled → Chrome → Edge)
const browser = await launchBrowser(console.log);
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
const issues = [];
for (const template of list) {
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: `template test: ${template}`, seconds: 20, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: fullRender ? 'auto' : 'wait', render: 'auto' }, options: { forceTemplate: template } }) });
  const proj = await waitStage(p.id, fullRender ? 'render' : 'storyboard', fullRender ? 'done' : 'review');
  const used = [...new Set(proj.storyboard.scenes.map((s) => s.template))];
  if (used.length !== 1 || used[0] !== template) issues.push(`${template}: storyboard used ${used.join(',')}`);
  await page.goto(`${BASE}/render.html?project=${p.id}`);
  await page.waitForFunction(() => window.__ready || window.__error);
  const err = await page.evaluate(() => window.__error);
  if (err) { issues.push(`${template}: ${err}`); continue; }
  const dur = await page.evaluate(() => window.renderData.duration);
  const N = 12, frames = [];
  const dir = path.join(DATA, 'sheets', template);
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 0; k < N; k++) {
    const t = (dur * (k + 0.5)) / N;
    await page.evaluate((tt) => window.drawFrame(tt), t);
    const f = path.join(dir, `f${String(k).padStart(2, '0')}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 85 });
    frames.push(f);
  }
  const sheet = path.join(OUT, `${template}${suffix}.jpg`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'f%02d.jpg'), '-vf', 'scale=270:480,tile=6x2:padding=6:color=0x0C1014', '-frames:v', '1', sheet]);
  if (fullRender) fs.copyFileSync(path.join(DATA, 'projects', p.id, 'video.mp4'), path.join(OUT, `${template}.mp4`));
  console.log(`✔ ${template.padEnd(9)} ${proj.storyboard.scenes.length} scenes · ${dur.toFixed(1)} s → ${path.relative(ROOT, sheet)}`);
}
await browser.close();
if (issues.length) { console.log('\nIssues:\n' + issues.map((i) => ' - ' + i).join('\n')); process.exit(1); }
console.log(`\n${list.length} template sheets in ${path.relative(ROOT, OUT)}`);
process.exit(0);
