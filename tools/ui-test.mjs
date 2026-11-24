// UI end-to-end in a real browser (offline mocks): every section loads without errors, the library uploads and
// imports, the typography studio saves, Arabic tools propose + apply, skills run, and the editor's operations
// (add text, undo/redo, aspect, trim drag, scene template, autosave) reach the saved project.
// Screenshots: output/ui/*.png. node tools/ui-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ui-'));
const MOCK_PORT = 4390, PORT = 4308, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'output', 'ui'); fs.mkdirSync(SHOTS, { recursive: true });
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message.split('\n')[0]); } }
const api = async (p, opts = {}) => (await fetch(BASE + p, { ...opts, headers: { Origin: BASE, 'Content-Type': 'application/json', ...(opts.headers || {}) } })).json();
async function until(desc, fn, ms = 20000) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + desc); await sleep(250); } }

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'),
  LLM_BASE_URL: `${MOCK}/v1`, ELEVENLABS_BASE_URL: MOCK, DEEPGRAM_BASE_URL: MOCK, ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: 'mock', LLM_API_KEY: '',
  PEXELS_BASE_URL: `${MOCK}/pexels`, PEXELS_API_KEY: 'pexels-key' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);

// a project that stops at the storyboard (ready for the editor)
const proj = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 10, approvals: { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
await until('script review', async () => (await api(`/api/projects/${proj.id}`)).stages.script.status === 'review', 60000);

const { launchBrowser } = await import('../server/render.mjs');
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const img = path.join(TMP, 'pic.jpg');
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', img]);

try {
  await test('every section renders without script errors', async () => {
    for (const v of ['dashboard', 'projects', 'library', 'fonts', 'voice', 'skills']) {
      await page.goto(`${BASE}/#/${v}`);
      await page.waitForSelector(`[data-view="${v}"]:not([hidden])`);
      await page.waitForFunction((vv) => !document.querySelector(`[data-view="${vv}"]`).textContent.includes('بيحمّل…'), v, { timeout: 10000 });
      await sleep(400);
      await shot(v);
    }
    assert.deepEqual(errors, []);
  });

  await test('library: upload through the file input, then import a stock photo (licence recorded)', async () => {
    await page.goto(`${BASE}/#/library`);
    await page.waitForSelector('#libFile', { state: 'attached' });
    await page.click('.uplmeta summary');
    await page.fill('#upLic', 'CC0');
    await page.setInputFiles('#libFile', img);
    await page.waitForSelector('#libGrid .tile');
    await page.click('[data-ltab="stock"]');
    await page.fill('#stQ', 'سما زرقا');
    await page.click('#stGo');
    await page.waitForSelector('[data-imp="0"]');
    assert.match(await page.textContent('#stInfo'), /blue sky/);
    await page.click('[data-imp="0"]');
    await until('import', async () => (await api('/api/assets')).total === 2);
    const a = (await api('/api/assets')).items.find((x) => x.source.type === 'pexels');
    assert.equal(a.license.name, 'Pexels License');
    await shot('library-stock');
  });

  await test('typography studio: choose Tajawal for captions + outline style, saved as default', async () => {
    await page.goto(`${BASE}/#/fonts`);
    await page.waitForSelector('.fontcard[data-f="tajawal"]');
    await page.click('.fontcard[data-f="tajawal"] [data-use="captionFont"]');
    await page.click('.cap.outline');
    await page.click('#tSave');
    await until('saved', async () => (await api('/api/settings')).look.typography?.captionFont === 'tajawal');
    assert.equal((await api('/api/settings')).look.typography.captionStyle, 'outline');
    await shot('fonts-chosen');
  });

  await test('script stage: Arabic correction proposal shows a diff and applies into the editor box', async () => {
    await page.goto(`${BASE}/?p=${proj.id}#/projects`);
    await page.waitForSelector('#edText');
    await page.fill('#edText', 'انا عايز اعرف ازاي السما زرقا.');
    await page.click('[data-arop="correct"]');
    await page.waitForSelector('#arApply');
    assert.ok(await page.$('.diff mark, .diff ins, .diff del'));
    await shot('arabic-proposal');
    await page.click('#arApply');
    assert.match(await page.inputValue('#edText'), /أنا عايز اعرف إزاي/);
    await page.click('[data-approve="script"]');
    await until('storyboard review', async () => (await api(`/api/projects/${proj.id}`)).stages.storyboard.status === 'review', 90000);
  });

  const saved = () => api(`/api/projects/${proj.id}`);
  await test('editor: opens with timeline + live preview', async () => {
    await page.goto(`${BASE}/?p=${proj.id}#/projects`);
    await page.waitForSelector('.stage[data-stage="editor"]:not(.off)');
    await page.click('.stage[data-stage="editor"]');
    await page.waitForSelector('#tlInner .blk.scene');
    const fr = page.frame({ url: /render\.html/ });
    await until('preview ready', async () => fr && (await fr.evaluate(() => window.__ready === true)));
    assert.ok((await page.$$('#tlInner .blk.word')).length > 10);
    await shot('editor');
  });

  await test('editor: add text → autosaved; undo → removed; redo → back', async () => {
    await page.click('#addText');
    await until('text overlay saved', async () => (await saved()).edit?.overlays?.length === 1);
    await page.fill('[data-o="text"]', 'خلي بالك!');
    await page.press('[data-o="text"]', 'Tab');
    await until('text saved', async () => (await saved()).edit.overlays[0].text === 'خلي بالك!');
    await page.click('#edUndo');
    await until('undo saved', async () => (await saved()).edit.overlays[0].text === 'نص جديد');
    await page.click('#edUndo');
    await until('undo add', async () => (await saved()).edit.overlays.length === 0);
    await page.click('#edRedo');
    await until('redo', async () => (await saved()).edit.overlays.length === 1);
  });

  await test('editor: aspect 16:9 → saved and the preview canvas becomes 1920×1080', async () => {
    await page.selectOption('#edAspect', '16:9');
    await until('aspect saved', async () => (await saved()).edit.export.aspect === '16:9');
    const fr = page.frame({ url: /render\.html/ });
    await until('preview reloaded', async () => (await fr.evaluate(() => document.getElementById('c').width)) === 1920);
  });

  await test('editor: dragging the trim-end handle sets the export end', async () => {
    const h = await page.$('.trimh.end'); await h.scrollIntoViewIfNeeded(); const b = await h.boundingBox();
    await page.mouse.move(b.x + 4, b.y + 10); await page.mouse.down();
    await page.mouse.move(b.x - 140, b.y + 10, { steps: 8 }); await page.mouse.up();
    await until('trim saved', async () => { const e = (await saved()).edit.trim; return e?.end && e.end < 10.5; });
  });

  await test('editor: select scene 2 → template "type" → saved; render stage reset', async () => {
    const blocks = await page.$$('#tlInner .blk.scene');
    await blocks[1].click({ position: { x: 30, y: 10 } });
    await page.waitForSelector('[data-s="template"]');
    await page.selectOption('[data-s="template"]', 'type');
    await until('template saved', async () => (await saved()).storyboard.scenes[1].template === 'type');
    const p = await saved();
    assert.equal(p.stages.render.status, 'idle');
    await shot('editor-edited');
  });

  await test('editor: mark in/out on the ruler and cut the range out (I / O / ✂); undo restores it', async () => {
    const ruler = await page.$('.tl-row.ruler'); await ruler.scrollIntoViewIfNeeded();
    const rb = await ruler.boundingBox();
    // the toolbar can re-wrap after a mark, moving the timeline — measure the ruler before every click
    const at = async (sec) => { const r = await page.$('.tl-row.ruler'); await r.scrollIntoViewIfNeeded(); const b = await r.boundingBox(); await page.mouse.click(b.x + sec * 70 + 1, b.y + 22); };
    await at(2); await page.click('#markIn');
    await at(3.5);
    await page.click('#markOut');
    assert.equal(await page.isDisabled('#cutRange'), false);
    await page.click('#cutRange');
    await until('cut saved', async () => { const c = (await saved()).edit.cuts; return c?.length === 1 && Math.abs(c[0].start - 2) < 0.05 && Math.abs(c[0].end - 3.5) < 0.05; });
    assert.match(await page.textContent('#edDur'), /مقطع محذوف/);
    const d = await api(`/api/projects/${proj.id}/render-data`);
    assert.equal(d.segments.length, 2);
    await page.click('#edUndo');
    await until('cut undone', async () => (await saved()).edit.cuts.length === 0);
    await page.click('#edRedo');
    await until('cut redone', async () => (await saved()).edit.cuts.length === 1);
    await shot('editor-cut');
  });

  await test('editor: insert a pause, drag a part to the end, restore the original order', async () => {
    const r = await page.$('.tl-row.ruler'); await r.scrollIntoViewIfNeeded();
    const b = await r.boundingBox();
    await page.mouse.click(b.x + 5 * 70 + 1, b.y + 22);
    await page.click('#addPause');
    await until('pause saved', async () => (await saved()).edit.sequence?.some((x) => x.hold === 1));
    const seq0 = (await saved()).edit.sequence;
    const segs = await page.$$('#tlInner .blk.seg');
    assert.equal(segs.length, seq0.length);
    const row = await (await page.$('.tl-row.seqrow')).boundingBox();
    await page.dragAndDrop('#tlInner .blk.seg[data-seg="0"]', '.tl-row.seqrow', { targetPosition: { x: row.width - 5, y: 10 } });
    await until('order changed', async () => { const q = (await saved()).edit.sequence; return q && JSON.stringify(q[q.length - 1]) === JSON.stringify(seq0[0]); });
    const d = await api(`/api/projects/${proj.id}/render-data`);
    assert.equal(d.segments.length, seq0.length);
    await shot('editor-sequence');
    await page.click('#seqReset');
    await until('order reset', async () => (await saved()).edit.sequence === null);
  });

  await test('editor: shift-click selects several overlays; Delete removes them together', async () => {
    const n0 = (await saved()).edit.overlays.length;
    const ruler = await page.$('.tl-row.ruler'); await ruler.scrollIntoViewIfNeeded();
    const rb = await ruler.boundingBox();
    await page.mouse.click(rb.x + 0.5 * 70, rb.y + 22); await page.click('#addText');
    await page.mouse.click(rb.x + 5 * 70, rb.y + 22); await page.click('#addText');
    await until('two more saved', async () => (await saved()).edit.overlays.length === n0 + 2);
    const blocks = await page.$$('#tlInner .blk.ov.text');
    await blocks[blocks.length - 1].click({ position: { x: 20, y: 10 } });
    await blocks[blocks.length - 2].click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
    await page.waitForSelector('#ovDelAll');
    await page.keyboard.press('Delete');
    await until('both removed', async () => (await saved()).edit.overlays.length === n0);
  });

  await test('skills page: run a built-in skill from its dialog', async () => {
    await page.goto(`${BASE}/#/skills`);
    await page.waitForSelector('tr[data-sk="titles"] [data-run]');
    await page.click('tr[data-sk="titles"] [data-run]');
    await page.fill('#rIn', 'السما لونها أزرق عشان الضوء بيتشتت');
    await page.click('#rGo');
    await page.waitForSelector('pre.out');
    assert.match(await page.textContent('pre.out'), /titles/);
  });

  await test('no script errors anywhere during the run', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
}
console.log(`\n${n} UI tests passed${failed ? `, ${failed} FAILED` : ''} — screenshots in output/ui/`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
