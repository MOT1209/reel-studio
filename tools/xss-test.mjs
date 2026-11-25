// Stored-XSS check: hostile strings are planted in every place the UI shows user/provider/AI-supplied text
// (project topic, asset name + tags + author, skill name/description, MCP server name, example name, settings values),
// then every view is opened in a real browser. Nothing may execute. node tools/xss-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-xss-'));
const PORT = 4313, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P1 = '<img src=x onerror="window.__xss=(window.__xss||[]).concat(\'a\')">';
const P2 = '"><svg onload="window.__xss=(window.__xss||[]).concat(\'b\')">';
const P3 = "'><script>window.__xss=(window.__xss||[]).concat('c')</script>";
const PAY = P1 + P2 + P3;
const api = async (p, opts = {}) => { const r = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, 'Content-Type': 'application/json', ...(opts.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

// RS_EXAMPLES_DIR: the planted example script goes to a temp folder, never into references/examples (those files are
// sent to the LLM as style examples with every script)
const EXAMPLES = path.join(TMP, 'examples'); fs.mkdirSync(EXAMPLES, { recursive: true });
const repoExamples = () => fs.readdirSync(path.join(ROOT, 'references', 'examples')).sort().join('|');
const repoBefore = repoExamples();
// another server already on the port would receive the hostile payloads (and could write them into a real data folder)
if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) { console.error(`port ${PORT} is already in use — stop that server first`); process.exit(1); }
const child = spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'), RS_EXAMPLES_DIR: EXAMPLES } });
procs.push(child);
// ready = OUR child printed its listening line (not merely "something answers on the port")
const listening = await new Promise((resolve) => {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; if (buf.includes(`:${PORT}`)) resolve(true); });
  child.once('exit', () => resolve(false));
  setTimeout(() => resolve(false), 15000);
});
if (!listening) { console.error('the test server did not start — nothing was planted'); process.exit(1); }
child.stdout.resume();

const planted = [];
const proj = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: PAY, autostart: false }) }); planted.push(['project', proj.status]);
// long-form: a hand-written chapter whose title and text are hostile (chapter list, editors, approval state)
const lf = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'long', seconds: 300, autostart: false, options: { profile: 'documentary' } }) });
const ch = await api(`/api/projects/${lf.body.id}/chapters`, { method: 'POST', body: JSON.stringify({ title: P1 + P2, goal: PAY, text: `${PAY}\nسطر عادي` }) }); planted.push(['chapter', ch.status]);
const img = path.join(TMP, 'p.jpg'); execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=200x200', '-frames:v', '1', img]);
const up = await fetch(`${BASE}/api/assets`, { method: 'POST', body: fs.readFileSync(img), headers: { Origin: BASE, 'x-filename': encodeURIComponent(PAY + '.jpg'), 'x-folder': encodeURIComponent(PAY), 'x-tags': encodeURIComponent(PAY), 'x-license-name': encodeURIComponent(PAY), 'x-license-attribution': encodeURIComponent(PAY), 'x-license-notes': encodeURIComponent(PAY) } });
planted.push(['asset', up.status]);
const sk = await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'evil-skill', name: '<img src=x onerror=window.__xss=[1]>', description: PAY, kind: 'prompt', prompt: 'x {{input}}', input: { type: 'script' }, output: { type: 'text' }, permissions: ['llm'], category: '<svg onload=__xss=[1]>' }) }); planted.push(['skill', sk.status]);
const mcp = await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: PAY, url: 'http://127.0.0.1:9/mcp', allowPrivate: true, headers: { 'X-Test': 'a' } }) }); planted.push(['mcp', mcp.status]);
const ex = await api('/api/style/examples', { method: 'POST', body: JSON.stringify({ name: PAY, text: PAY }) }); planted.push(['example', ex.status]);
const st = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm: { model: PAY }, elevenlabs: { voiceId: PAY }, pronunciation: PAY }) }); planted.push(['settings', st.status]);
console.log('planted:', JSON.stringify(planted));
for (const k of ['project', 'asset', 'skill', 'mcp']) assert.ok(planted.some(([x, s]) => x === k && s === 201), `${k} payload was not accepted — test would prove nothing`);
for (const k of ['example', 'settings', 'chapter']) assert.ok(planted.some(([x, s]) => x === k && s >= 200 && s < 300), `${k} payload was not accepted — test would prove nothing`);
assert.equal(fs.readdirSync(EXAMPLES).length, 1, 'the example was written to the temp examples folder');
assert.equal(repoExamples(), repoBefore, 'nothing was written into references/examples');

const { launchBrowser } = await import('../server/render.mjs');
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message.split('\n')[0]); } }
const xss = () => page.evaluate(() => window.__xss || []);
try {
  await test('hostile strings never execute in any section', async () => {
    for (const v of ['dashboard', 'projects', 'library', 'fonts', 'voice', 'skills']) {
      await page.goto(`${BASE}/#/${v}`); await page.waitForSelector(`[data-view="${v}"]:not([hidden])`); await sleep(700);
    }
    assert.deepEqual(await xss(), []); assert.deepEqual(dialogs, []);
  });
  await test('the hostile project opens (title + stages) and every settings tab renders without executing anything', async () => {
    // ?p= is how the app opens a project (the hash alone only selects the view)
    await page.goto(`${BASE}/?p=${encodeURIComponent(proj.body.id)}#/projects`);
    await page.waitForSelector('.stage[data-stage="script"]');
    assert.ok((await page.evaluate(() => document.body.innerText)).includes('onerror'), 'the project with the hostile topic is really open');
    await page.click('#btnSettings');
    await page.waitForSelector('dialog#settings[open]');
    const tabs = await page.$$eval('#setTabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
    assert.ok(tabs.length >= 5);
    for (const t of tabs) {
      await page.click(`#setTabs [data-tab="${t}"]`);
      await page.waitForSelector(`dialog#settings .tab[data-tab="${t}"]:not([hidden])`);
      await sleep(150);
    }
    assert.deepEqual(await xss(), []); assert.deepEqual(dialogs, []);
  });
  await test('a long-form project with a hostile chapter title/goal/text renders its chapters without executing anything', async () => {
    await page.goto(`${BASE}/?p=${encodeURIComponent(lf.body.id)}#/projects`);
    await page.waitForSelector('.chapter');
    await page.click('.chapter > summary');
    const ta = await page.$eval('[data-chtext="0"]', (x) => x.value);
    assert.ok(ta.includes('<script>'), 'the hostile text is in the chapter editor as text');
    assert.deepEqual(await xss(), []); assert.deepEqual(dialogs, []);
  });
  await test('the payload is stored and shown as text (the planted strings are really on the page)', async () => {
    await page.goto(`${BASE}/#/skills`); await sleep(800);
    const txt = await page.evaluate(() => document.body.innerText);
    assert.ok(txt.includes('onerror'), 'the hostile text should be visible as plain text, proving it reached the page escaped');
  });
} finally { await browser.close(); }
console.log(`\n${n} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
