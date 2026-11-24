// Accessibility + layout checks in a real browser over every screen (dashboard, projects, project page, library,
// fonts, voice, skills, settings dialog, editor) at desktop and phone width. node tools/a11y-test.mjs
//  - every form control has an accessible name (label, aria-label, title or wrapping label)
//  - every button / link has an accessible name; every <img> has alt
//  - <html> has lang + dir; dialogs are labelled
//  - no horizontal page overflow at 390 px width; interactive elements are keyboard-focusable and show a focus style
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-a11y-'));
const MOCK_PORT = 4391, PORT = 4316, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
const api = async (p, opts = {}) => (await fetch(BASE + p, { ...opts, headers: { Origin: BASE, 'Content-Type': 'application/json' } })).json();
procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'), LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'v', DEEPGRAM_API_KEY: 'mock' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);
const proj = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 10, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
for (let i = 0; i < 200; i++) { if ((await api(`/api/projects/${proj.id}`)).stages.storyboard.status === 'review') break; await sleep(300); }

/** runs inside the page: list accessibility problems among visible elements */
const AUDIT = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]'); };
  const text = (e) => (e.textContent || '').trim();
  const name = (e) => {
    if (e.getAttribute('aria-label')?.trim() || e.getAttribute('title')?.trim()) return true;
    const lb = e.getAttribute('aria-labelledby'); if (lb && document.getElementById(lb)) return true;
    if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) return true;
    if (e.closest('label') && text(e.closest('label'))) return true;
    return false;
  };
  const out = [];
  const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}${e.dataset && Object.keys(e.dataset).length ? '[data-' + Object.keys(e.dataset)[0] + ']' : ''}`;
  for (const e of document.querySelectorAll('input:not([type=hidden]), select, textarea')) if (vis(e) && !name(e)) out.push(`control without a name: ${desc(e)}`);
  for (const e of document.querySelectorAll('button, a[href], [role=button]')) if (vis(e) && !text(e) && !name(e)) out.push(`button/link without a name: ${desc(e)}`);
  for (const e of document.querySelectorAll('img')) if (vis(e) && !e.hasAttribute('alt')) out.push(`img without alt: ${desc(e)}`);
  for (const e of document.querySelectorAll('iframe')) if (vis(e) && !name(e)) out.push(`iframe without a title: ${desc(e)}`);
  for (const e of document.querySelectorAll('dialog[open]')) if (!name(e) && !e.querySelector('h1,h2,h3,h4')) out.push('dialog without a heading/label');
  if (!document.documentElement.lang) out.push('html has no lang'); if (!document.documentElement.dir) out.push('html has no dir');
  return out;
};

const { launchBrowser } = await import('../server/render.mjs');
const browser = await launchBrowser();
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
const screens = [['dashboard', '#/dashboard'], ['projects', '#/projects'], ['project', `#/projects/${proj.id}`], ['library', '#/library'], ['fonts', '#/fonts'], ['voice', '#/voice'], ['skills', '#/skills']];
for (const [w, h, label] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('dialog', (d) => d.dismiss());
  for (const [name, hash] of screens) {
    await test(`${label} · ${name}: accessible names, alt text, lang/dir${w < 500 ? ', no horizontal overflow' : ''}`, async () => {
      await page.goto(`${BASE}/${hash}`); await sleep(900);
      const problems = await page.evaluate(AUDIT);
      if (w < 500) { const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 2) problems.push(`page is ${ov}px wider than the ${w}px screen`); }
      assert.deepEqual([...new Set(problems)], []);
    });
  }
  await test(`${label} · video editor (toolbar, timeline, inspector for a scene and an overlay)`, async () => {
    await page.goto(`${BASE}/?p=${proj.id}#/projects`);
    await page.waitForSelector('.stage[data-stage="editor"]:not(.off)'); await page.click('.stage[data-stage="editor"]');
    await page.waitForSelector('#tlInner .blk.scene'); await sleep(900);
    const probs = new Set((await page.evaluate(AUDIT)).map((x) => 'editor: ' + x));
    await page.click('#addText'); await sleep(500); (await page.evaluate(AUDIT)).forEach((x) => probs.add('text inspector: ' + x));
    await (await page.$('#tlInner .blk.scene')).click({ position: { x: 20, y: 10 } }); await sleep(400); (await page.evaluate(AUDIT)).forEach((x) => probs.add('scene inspector: ' + x));
    if (w < 500) { const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 2) probs.add(`editor page is ${ov}px wider than the screen`); }
    assert.deepEqual([...probs], []);
  });
  await test(`${label} · settings dialog and every tab`, async () => {
    await page.goto(`${BASE}/#/dashboard`); await sleep(500);
    const opener = await page.$('#settingsBtn, [data-open-settings], #btnSettings, button[title*="إعدادات"], a[href="#/settings"]');
    if (!opener) throw new Error('could not find the settings button');
    await opener.click(); await sleep(400);
    const probs = new Set();
    for (const t of await page.$$eval('#setTabs [data-tab]', (b) => b.map((x) => x.dataset.tab))) { await page.click(`#setTabs [data-tab="${t}"]`); await sleep(120); (await page.evaluate(AUDIT)).forEach((p) => probs.add(`[${t}] ${p}`)); }
    assert.deepEqual([...probs], []);
  });
  if (w > 500) await test('keyboard: Tab reaches interactive elements and the focused element has a visible focus style', async () => {
    await page.goto(`${BASE}/#/library`); await sleep(600);
    const seen = new Set(); let noRing = 0;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || e.matches(':focus-visible') && cs.outlineStyle !== 'none'; return { tag: e.tagName + (e.id ? '#' + e.id : '') + ':' + (e.getAttribute('href') || (e.textContent || '').trim().slice(0, 20)), ring }; });
      if (r) { seen.add(r.tag); if (!r.ring) noRing++; }
    }
    assert.ok(seen.size >= 8, `only ${seen.size} distinct elements reachable by Tab`);
    assert.equal(noRing, 0, `${noRing} focused elements show no focus style`);
  });
  await page.close();
}
await browser.close();
console.log(`\n${n} a11y tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
