// Legacy engine: Playwright pages run public/render.html and draw each frame on a canvas (window.drawFrame).
// Kept as the reference and the fallback while the Remotion engine is introduced.
import os from 'node:os';
import { trackBrowser } from '../proc.mjs';

export async function launchBrowser(log = () => {}) {
  const { chromium } = await import('playwright');
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const opt of attempts) {
    try {
      const b = await chromium.launch({ ...opt, args: ['--font-render-hinting=none', '--disable-gpu'] /* software raster parallelises across pages */ });
      if (opt.channel) log(`using system browser channel "${opt.channel}"`);
      return trackBrowser(b, (gone) => b.on('disconnected', gone)); // closed on shutdown
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No Chromium available (run "npm run setup"): ${lastErr?.message?.split('\n')[0]}`);
}


/**
 * Renders frames of render.html into an H.264 MP4 (no audio).
 * onFrame(i, total, jpegBuffer|null) is called for progress/preview.
 */
// Frame capture: "canvas" (default) grabs the canvas pixels as JPEG inside the page;
// "screenshot" uses Playwright page screenshots (slower, identical output).
const CAPTURE = process.env.RS_CAPTURE === 'screenshot' ? 'screenshot' : 'canvas';
// Parallel pages: by CPU cores, but each headless page needs ~400 MB — on a memory-starved machine
// extra pages only cause swapping (everything, the server included, slows to a crawl).
export const MAX_WORKERS = 4;
/**
 * Parallel pages for one render. RS_RENDER_WORKERS must be an integer 1–MAX_WORKERS; anything else (text, 0, negative,
 * fractions, Infinity, out of range) is rejected with a note and the memory-aware automatic value is used instead.
 * An explicit valid value is still capped by free RAM (≈400 MB per page) unless RS_RENDER_WORKERS_FORCE=1.
 */
export function parseWorkers(raw, { cpus = os.cpus().length, freeMem = os.freemem(), force = false, perPageMB = 400 } = {}) {
  const byCpu = Math.max(1, cpus - 1);
  const byMem = Math.max(1, Math.floor((freeMem / 1024 ** 2 - 300) / perPageMB));
  const auto = Math.max(1, Math.min(MAX_WORKERS, byCpu, byMem));
  if (raw === undefined || raw === null || String(raw).trim() === '') return { n: auto, note: null };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > MAX_WORKERS) return { n: auto, note: `RS_RENDER_WORKERS="${raw}" is invalid (use an integer 1–${MAX_WORKERS}) — using ${auto}` };
  if (force) return { n: v, note: null };
  const n = Math.min(v, byMem);
  return { n, note: n < v ? `RS_RENDER_WORKERS=${v} reduced to ${n}: only ${(freeMem / 1024 ** 3).toFixed(1)} GB RAM is free` : null };
}
function workerCount(log = () => {}) {
  const w = parseWorkers(process.env.RS_RENDER_WORKERS, { force: process.env.RS_RENDER_WORKERS_FORCE === '1' });
  if (w.note) log(`⚠ ${w.note}`);
  return w.n;
}

async function openWorker(browser, url, errors, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // A failed favicon request is logged as a console error by Chrome/Edge — it must not abort a render.
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon\.ico/.test(m.location()?.url || '')) errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 60000 });
  const pageErr = await page.evaluate(() => window.__error || null);
  if (pageErr) throw new Error(`render.html: ${pageErr}`);
  return page;
}

async function captureFrame(page, t, width, height, tau) {
  if (CAPTURE === 'screenshot') {
    await page.evaluate(async ([tt, ta]) => { if (window.prepareFrame) await window.prepareFrame(tt); window.drawFrame(tt, ta); }, [t, tau]);
    return page.screenshot({ type: 'jpeg', quality: 94, clip: { x: 0, y: 0, width, height } });
  }
  const b64 = await page.evaluate(async ([tt, ta]) => {
    if (window.prepareFrame) await window.prepareFrame(tt); // video clips: load the frame images this time needs
    window.drawFrame(tt, ta); // source time (what to draw) + output time (progress bar, end fade)
    const blob = await new Promise((r) => document.getElementById('c').toBlob(r, 'image/jpeg', 0.95));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    return btoa(s);
  }, [t, tau]);
  return Buffer.from(b64, 'base64');
}


export const legacyEngine = {
  id: 'legacy',
  name: 'Canvas + Playwright (legacy)',
  /** Engine is usable when Playwright can be imported (the browser itself is checked when a render starts). */
  async validate() {
    try { await import('playwright'); return { ok: true }; } catch (e) { return { ok: false, reason: `playwright: ${e.message}` }; }
  },
  /** ctx.url: the render page; opens the browser and N pages once per render. */
  async prepare(ctx) {
    ctx.errors = [];
    ctx.browser = await launchBrowser(ctx.log);
    const n = Math.min(ctx.workers || workerCount(ctx.log), Math.max(1, Math.floor(ctx.total / 30)));
    ctx.pages = await Promise.all(Array.from({ length: n }, () => openWorker(ctx.browser, ctx.url, ctx.errors, ctx.width, ctx.height)));
    ctx.log(`capture: ${CAPTURE} · ${n} parallel page${n > 1 ? 's' : ''} · ${ctx.width}×${ctx.height} · free RAM ${(os.freemem() / 1024 ** 3).toFixed(1)} GB`);
    if (os.freemem() < 1024 ** 3) ctx.log('⚠ الذاكرة الفاضية أقل من 1 GB — الرندر هيبقى بطيء؛ اقفل برامج تانية لو تقدر');
  },
  /** Pages pull frame indices from a shared counter; frames are emitted as they finish. */
  async produce(i0, i1, emit, ctx) {
    let next = i0, failed = null;
    const worker = async (page) => {
      for (;;) {
        if (failed || ctx.signal?.aborted) return;
        if (ctx.errors.length) throw new Error(`render.html error: ${ctx.errors[0]}`);
        const i = next++;
        if (i >= i1) return;
        let jpg;
        try { jpg = await captureFrame(page, ctx.timeOf(i), ctx.width, ctx.height, i / ctx.fps); }
        catch (e) { throw new Error(`frame ${i}: ${e.message.split('\n')[0]}`); }
        await emit(i, jpg);
      }
    };
    await Promise.all(ctx.pages.map((pg) => worker(pg).catch((e) => { failed = failed || e; throw e; })));
    if (ctx.errors.length) throw new Error(`render.html error: ${ctx.errors[0]}`);
  },
  async cleanup(ctx) {
    if (ctx.browser) await Promise.race([ctx.browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    ctx.browser = null; ctx.pages = null;
  },
};
export { workerCount };
