// UI end-to-end in a real browser (offline mocks): every section loads without errors, the library uploads and
// imports, the typography studio saves, Arabic tools propose + apply, skills run, and the editor's operations
// (add text, undo/redo, aspect, trim drag, scene template, autosave) reach the saved project.
// Screenshots: output/ui/*.png. node tools/ui-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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

// A second run must not silently attach to the first run's server: the spawns below ignore their output, so a
// server that loses the port race would die unnoticed and the tests would talk to the other run's server.
async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer()
      .once('error', () => reject(new Error(`port ${port} is already in use — stop the other Reel Studio test run first`)))
      .once('listening', () => s.close(() => resolve()));
    s.listen(port, '127.0.0.1');
  });
}
for (const port of [PORT, MOCK_PORT]) {
  try { await assertFree(port); } catch (e) { console.error(`[ui-test] ${e.message}`); process.exit(1); }
}
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
// Warm the app up before the timed tests: the first page load pays the cold browser/disk cost (JS, CSS, fonts),
// and on a loaded machine that can exceed the first view's timeout. A failed warm-up is not fatal: the tests
// below still report the real problem.
await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForFunction(() => {
  const v = document.querySelector('[data-view="dashboard"]');
  return v && !v.textContent.includes('بيحمّل');
}, null, { timeout: 60000 }).catch(() => {});
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
  // the timeline's scale is the zoom control's px-per-second and its length comes from the project's own voice,
  // so read both instead of assuming the 70 px default or a ~30 s video
  const pps = () => page.$eval('#edZoom', (e) => Number(e.value));
  const fullLen = async () => { const p = await saved(); return Math.max(p.voice?.duration || 0, p.words.at(-1).end + 0.3) + 0.6; };
  const clickAt = async (sec) => { const r = await page.$('.tl-row.ruler'); await r.scrollIntoViewIfNeeded(); const b = await r.boundingBox(); await page.mouse.click(b.x + sec * (await pps()) + 1, b.y + 22); };
  // an empty stretch of the timeline that fits a `len`-second overlay (so a new block is not buried under an old one)
  const freeStart = async (len) => {
    const full = await fullLen(), ovs = (await saved()).edit.overlays;
    for (let sec = 0.2; sec + len <= full - 0.2; sec = +(sec + 0.1).toFixed(2)) {
      if (!ovs.some((o) => sec < o.end + 0.15 && sec + len > o.start - 0.15)) return sec;
    }
    return 0.2;
  };
  await test('editor: opens with timeline + live preview', async () => {
    await page.goto(`${BASE}/?p=${proj.id}#/projects`);
    await page.waitForSelector('.stage[data-stage="editor"]:not(.off)');
    await page.click('.stage[data-stage="editor"]');
    await page.waitForSelector('#tlInner .blk.scene');
    // the iframe may not have started loading yet: look the frame up on every try
    const preview = () => page.frame({ url: /render\.html/ });
    await until('preview ready', async () => preview() && (await preview().evaluate(() => window.__ready === true)));
    const fr = preview();
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
    // the fixture's video is ~13 s, not 30: compare the saved end with the time under the cursor when
    // it was released (the timeline's px-per-second), not with a fixed second count
    const { left, pps } = await page.evaluate(() => ({ left: document.querySelector('#tlInner').getBoundingClientRect().left, pps: Number(document.querySelector('#edZoom').value) }));
    const dropX = b.x - 140;
    await page.mouse.move(b.x + 4, b.y + 10); await page.mouse.down();
    await page.mouse.move(dropX, b.y + 10, { steps: 8 }); await page.mouse.up();
    const end = await until('trim saved', async () => { const e = (await saved()).edit.trim; return Number.isFinite(e?.end) && e.end; });
    const want = (dropX - left) / pps, tol = 8 / pps + 0.05; // the drag snaps within 8 px
    assert.ok(Math.abs(end - want) <= tol, `trim end ${end} vs ${want.toFixed(2)} ±${tol.toFixed(2)} (${pps} px/s)`);
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

  await test('editor: scene 2 animation presets (wipe in, word-by-word title) saved; "project default" clears them', async () => {
    await page.selectOption('[data-s="transition"]', 'wipe');
    await page.selectOption('[data-s="titleAnim"]', 'words');
    await until('animation saved', async () => { const sc = (await saved()).storyboard.scenes[1]; return sc.transition === 'wipe' && sc.titleAnim === 'words'; });
    await page.selectOption('[data-s="transition"]', '');
    await until('default restored', async () => (await saved()).storyboard.scenes[1].transition === null);
  });

  await test('editor: regenerate scene 2 with the AI (hint) → new scene in the inspector, others untouched', async () => {
    const before = (await saved()).storyboard.scenes;
    await page.fill('#scHint', 'chart please');
    await page.click('#scRegen');
    await until('regenerated', async () => (await saved()).storyboard.scenes[1].template === 'chart', 30000);
    await until('inspector shows it', async () => (await page.$eval('[data-s="template"]', (e) => e.value)) === 'chart');
    const after = (await saved()).storyboard.scenes;
    assert.deepEqual(after[0], before[0]);
    await shot('editor-regenerated');
  });

  await test('editor: render engine / codec / bitrate choices are saved with the project', async () => {
    assert.deepEqual(await page.$$eval('#edEngine option', (o) => o.map((x) => x.value)), ['auto', 'remotion', 'legacy']);
    await page.selectOption('#edEngine', 'legacy');
    await page.selectOption('#edBitrate', '8000');
    await until('export saved', async () => { const e = (await saved()).edit.export; return e.engine === 'legacy' && e.bitrate === 8000; });
    await page.selectOption('#edEngine', 'auto');
    await page.selectOption('#edBitrate', '');
    await until('export reset', async () => { const e = (await saved()).edit.export; return e.engine === 'auto' && e.bitrate === null; });
  });

  await test('editor: mark in/out on the ruler and cut the range out (I / O / ✂); undo restores it', async () => {
    // the range sits inside the project at a fifth and a third of its length, whatever that length is
    const full = await fullLen()
      , inSec = +(full * 0.2).toFixed(2), outSec = +(full * 0.32).toFixed(2);
    // the toolbar can re-wrap after a mark, moving the timeline — measure the ruler before every click
    await clickAt(inSec); await page.click('#markIn');
    await clickAt(outSec);
    await page.click('#markOut');
    assert.equal(await page.isDisabled('#cutRange'), false);
    await page.click('#cutRange');
    await until('cut saved', async () => { const c = (await saved()).edit.cuts; return c?.length === 1 && Math.abs(c[0].start - inSec) < 0.05 && Math.abs(c[0].end - outSec) < 0.05; });
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
    await clickAt((await fullLen()) * 0.5); // mid-timeline, not a fixed 5 s
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

  await test('editor: choosing TikTok applies its format and shows the duration advice; safe-zone guides toggle', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#edPlatform option').length > 3);
    await page.selectOption('#edPlatform', 'tiktok');
    await until('platform saved', async () => { const e = (await saved()).edit.export; return e.platform === 'tiktok' && e.aspect === '9:16'; });
    assert.equal(await page.inputValue('#edAspect'), '9:16');
    assert.match(await page.textContent('#edDur'), /TikTok/);
    await page.check('#edGuides');
    await sleep(500);
    await shot('editor-platform');
  });

  await test('editor: shift-click selects several overlays; Delete removes them together', async () => {
    const n0 = (await saved()).edit.overlays.length;
    const at1 = await freeStart(5.4); // two 2.5 s overlays with room between them
    await clickAt(at1); await page.click('#addText');
    await clickAt(at1 + 2.7); await page.click('#addText');
    await until('two more saved', async () => (await saved()).edit.overlays.length === n0 + 2);
    const blocks = await page.$$('#tlInner .blk.ov.text');
    await blocks[blocks.length - 1].click({ position: { x: 20, y: 10 } });
    await blocks[blocks.length - 2].click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
    await page.waitForSelector('#ovDelAll');
    await page.keyboard.press('Delete');
    await until('both removed', async () => (await saved()).edit.overlays.length === n0);
  });

  await test('editor: layer order buttons, keyframe at the playhead, magnet snapping vs none, audio-track button', async () => {
    // the overlays this test drags default to 2.5 s: start in an empty stretch (so the drag hits the new block,
    // not an older one) that still has words after it
    await clickAt(await freeStart(2.6));
    const before = (await saved()).edit.overlays.length;
    await page.click('#addText'); await until('1st text', async () => (await saved()).edit.overlays.length === before + 1);
    await page.click('#addText'); await until('2nd text', async () => (await saved()).edit.overlays.length === before + 2);
    let ov = (await saved()).edit.overlays; const lastId = ov.at(-1).id;
    await page.click('#lyBack');
    await until('sent to back', async () => (await saved()).edit.overlays[0].id === lastId);
    await page.click('#lyFront');
    await until('brought to front', async () => (await saved()).edit.overlays.at(-1).id === lastId);
    await page.click('#kfAdd');
    await until('keyframe saved', async () => { const o = (await saved()).edit.overlays.find((x) => x.id === lastId); return o.keyframes?.length === 1 && o.keyframes[0].ease === 'inOut'; });
    // magnet: drag the selected text so its start lands 0.05 s before a word start; with the magnet on it snaps to the word
    const P = await saved(); const o = P.edit.overlays.find((x) => x.id === lastId);
    // every word edge, overlay edge, cut and mark is a snap target: pick a word whose start is the nearest one,
    // so "snapped to the word" means the magnet worked and not that some other edge happened to be closer
    const thr = 8 / (await pps());
    const edges = [...P.edit.cuts.flatMap((c) => [c.start, c.end]), ...P.edit.overlays.filter((x) => x.id !== lastId).flatMap((x) => [x.start, x.end])];
    const word = P.words.find((w) => w.start > o.start + 1.0 && w.start < Math.min(P.voice?.duration || 99, o.start + 6) && edges.every((e) => Math.abs(e - w.start) > 2 * thr));
    assert.ok(word, 'a word start with no closer overlay/cut edge to snap to');
    const drag = async (target) => {
      const blk = await page.$(`#tlInner .blk.ov[data-ov="${lastId}"]`); await blk.scrollIntoViewIfNeeded(); const b = await blk.boundingBox();
      const cur = (await saved()).edit.overlays.find((x) => x.id === lastId).start;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + (target - cur) * (await pps()), b.y + b.height / 2, { steps: 6 }); await page.mouse.up();
    };
    await drag(word.start - 0.05);
    await until('snapped to the word', async () => Math.abs((await saved()).edit.overlays.find((x) => x.id === lastId).start - word.start) < 0.011);
    await page.uncheck('#snapOn');
    const word2 = P.words.find((w) => w.start > word.start + 1.2);
    const startBefore = (await saved()).edit.overlays.find((x) => x.id === lastId).start;
    await drag(word2.start - 0.05);
    await until('moved without snapping', async () => { const st = (await saved()).edit.overlays.find((x) => x.id === lastId).start; return st !== startBefore && Math.abs(st - word2.start) > 0.02; });
    await page.check('#snapOn');
    assert.ok(await page.isVisible('#addTrack'), 'audio-track button');
    assert.ok(await page.isVisible('#lyFront'));
  });

  await test('editor: duplicate an overlay, crop inputs reach the project, ripple delete closes the gap', async () => {
    const ovs = async () => (await saved()).edit.overlays;
    const n0 = (await ovs()).length;
    await page.click('#addText'); await until('text A', async () => (await ovs()).length === n0 + 1);
    const a = (await ovs()).at(-1);
    await page.click('#ovDup'); await until('duplicate', async () => (await ovs()).length === n0 + 2);
    const all = await ovs(); const dup = all.at(-1);
    assert.notEqual(dup.id, a.id); assert.equal(dup.text, a.text); assert.ok(Math.abs(dup.start - a.end) < 0.02, 'the copy starts where the original ends');
    // ripple: move the copy after the original, then delete the original with ripple on → the copy moves earlier by the original's length
    const mv = +(a.end + 0.6).toFixed(2); await page.fill('[data-o="start"]', String(mv)); await page.fill('[data-o="end"]', String(+(mv + 1.5).toFixed(2))); await page.press('[data-o="end"]', 'Tab');
    await until('copy moved', async () => { const d2 = (await ovs()).find((x) => x.id === dup.id); return d2 && Math.abs(d2.start - mv) < 0.02; });
    await page.check('#rippleOn');
    await (await page.$(`#tlInner .blk.ov[data-ov="${a.id}"]`)).click({ position: { x: 12, y: 10 } });
    await page.click('#ovDel');
    await until('ripple applied', async () => { const o2 = await ovs(); const d2 = o2.find((x) => x.id === dup.id); return !o2.some((x) => x.id === a.id) && d2 && Math.abs(d2.start - (mv - (a.end - a.start))) < 0.02; });
    await page.uncheck('#rippleOn');
  });

  await test('settings: a saved key has a delete button; it removes the key (and not keys that come from .env)', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ pixabay: { apiKey: 'pixabay-test-key-123456' } }) });
    await page.goto(`${BASE}/#/dashboard`); await sleep(400);
    await page.click('#btnSettings'); await page.click('#setTabs [data-tab="libs"]');
    const btn = '[data-del-secret="pixabay.apiKey"]';
    await page.waitForSelector(btn, { state: 'visible' });
    assert.equal(await page.isVisible('[data-del-secret="pexels.apiKey"]'), false, 'a key that comes from .env has no delete button');
    await page.click(btn);
    await until('key deleted', async () => (await api('/api/settings'))._source['pixabay.apiKey'] === 'none');
    await page.waitForSelector(btn, { state: 'hidden' });
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
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
