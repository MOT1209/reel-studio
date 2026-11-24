// Remotion engine: the project is a React composition (remotion/), Remotion drives the browser and captures each
// frame, and the frames go to OUR FFmpeg encoder (engines/ffmpeg.mjs) through onFrameBuffer — Remotion's own encoder
// and its bundled ffmpeg are not used. The bundle is built once per source change into data/remotion-bundle and
// served by the Reel Studio server at /remotion/, so render data, fonts, media and render.js are same-origin.
import fs from 'node:fs';
import os from 'node:os';
import { parseWorkers } from '../memory.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA_DIR, ROOT } from '../settings.mjs';

const require = createRequire(import.meta.url);
const SRC_DIR = path.join(ROOT, 'remotion');
const ENTRY = path.join(SRC_DIR, 'index.jsx');
export const BUNDLE_DIR = path.join(DATA_DIR, 'remotion-bundle');
export const PUBLIC_PATH = '/remotion/';

/** Hash of everything that goes into the bundle: a changed source rebuilds it, an unchanged one reuses it. */
function sourceHash() {
  const h = crypto.createHash('sha256');
  const files = [...fs.readdirSync(SRC_DIR, { recursive: true })].filter((f) => /\.(jsx?|tsx?|css)$/.test(f)).sort();
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(SRC_DIR, f)));
  h.update(fs.readFileSync(path.join(ROOT, 'server', 'timeline.mjs')));
  try { h.update(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'remotion', 'package.json'), 'utf8')).version); } catch {}
  return h.digest('hex').slice(0, 16);
}

let building = null;
/** Builds the bundle if needed (≈15 s the first time, cached by webpack after that). Returns the bundle dir. */
export async function ensureBundle(log = () => {}) {
  const hash = sourceHash();
  const stamp = path.join(BUNDLE_DIR, '.source-hash');
  try { if (fs.readFileSync(stamp, 'utf8') === hash && fs.existsSync(path.join(BUNDLE_DIR, 'index.html'))) return BUNDLE_DIR; } catch {}
  if (building) return building;
  building = (async () => {
    const tmp = `${BUNDLE_DIR}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const t0 = Date.now();
    log('remotion: building the composition bundle (first time after an update, ~15 s)');
    await new Promise((res, rej) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'server', 'engines', 'remotion-bundle.mjs'), ENTRY, tmp, PUBLIC_PATH], { cwd: ROOT, windowsHide: true });
      let err = '';
      child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) { const m = /^progress (\d+)/.exec(l); if (m) log(`remotion: bundling ${m[1]}%`); } });
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('error', rej);
      child.on('close', (code) => (code === 0 ? res() : rej(new Error(`remotion bundle failed (${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`))));
    });
    fs.writeFileSync(path.join(tmp, '.source-hash'), hash);
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    fs.renameSync(tmp, BUNDLE_DIR);
    log(`remotion: bundle ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return BUNDLE_DIR;
  })().finally(() => { building = null; });
  return building;
}

/**
 * A Chrome Headless Shell for Remotion: RS_REMOTION_BROWSER, else the one Playwright installed (npm run setup),
 * else null → Remotion downloads its own on first use (needs internet once).
 */
export function findBrowser() {
  const env = process.env.RS_REMOTION_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const home = os.homedir();
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright')].filter(Boolean);
  const names = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell', 'headless_shell.exe']);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      for (const sub of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(root, d, sub.name))) if (names.has(f)) return path.join(root, d, sub.name, f);
      }
    }
  }
  return null;
}

/** Parallel browser tabs: same memory rule as the legacy engine (cgroup-aware, ≈ 450 MB per tab + 600 MB base), at most 4. RS_REMOTION_CONCURRENCY must be an integer 1–4. */
function concurrency() {
  const r = parseWorkers(process.env.RS_REMOTION_CONCURRENCY, { name: 'RS_REMOTION_CONCURRENCY' });
  if (r.note) console.warn(r.note);
  return r.n;
}

/** Chrome options; RS_REMOTION_GL picks Remotion's GL backend (benchmarked in docs/RENDERING.md). */
function chromiumOptions() {
  const gl = process.env.RS_REMOTION_GL;
  return gl ? { gl } : {};
}

export const remotionEngine = {
  id: 'remotion',
  name: 'Remotion (React composition) + FFmpeg',
  async validate() {
    // resolve only (no import): loading webpack into the server process just to check it exists would stall requests
    try { require.resolve('@remotion/renderer'); require.resolve('@remotion/bundler'); }
    catch (e) { return { ok: false, reason: `Remotion packages not installed (npm install): ${e.message.split('\n')[0]}` }; }
    if (!fs.existsSync(ENTRY)) return { ok: false, reason: 'remotion/index.jsx is missing' };
    const browser = findBrowser();
    return { ok: true, info: { browser: browser || 'downloaded by Remotion on first use', bundle: fs.existsSync(path.join(BUNDLE_DIR, 'index.html')) ? 'built' : 'built on first render' } };
  },
  /** ctx: { projectId, port, width, height, fps, total, signal, log } (+ workers). */
  async prepare(ctx) {
    const R = await import('@remotion/renderer');
    await ensureBundle(ctx.log);
    if (!ctx.port) throw new Error('remotion engine needs the server port');
    ctx.serveUrl = `http://127.0.0.1:${ctx.port}${PUBLIC_PATH}`;
    ctx.inputProps = { projectId: ctx.projectId, total: ctx.total, fps: ctx.fps, width: ctx.width, height: ctx.height };
    ctx.browserExecutable = findBrowser();
    ctx.browserErrors = [];
    ctx.chromiumOptions = chromiumOptions();
    ctx.rBrowser = await R.openBrowser('chrome', { browserExecutable: ctx.browserExecutable, chromiumOptions: ctx.chromiumOptions, logLevel: 'error' });
    ctx.composition = await R.selectComposition({
      serveUrl: ctx.serveUrl, id: 'Reel', inputProps: ctx.inputProps, puppeteerInstance: ctx.rBrowser, browserExecutable: ctx.browserExecutable, logLevel: 'error',
    });
    const c = ctx.composition;
    if (c.width !== ctx.width || c.height !== ctx.height || c.fps !== ctx.fps || c.durationInFrames !== ctx.total) {
      throw new Error(`composition is ${c.width}×${c.height}@${c.fps} × ${c.durationInFrames}, expected ${ctx.width}×${ctx.height}@${ctx.fps} × ${ctx.total}`);
    }
    ctx.concurrency = ctx.workers || concurrency();
    ctx.log(`remotion: ${ctx.concurrency} tab${ctx.concurrency > 1 ? 's' : ''} · ${c.width}×${c.height} · ${c.durationInFrames} frames · browser ${ctx.browserExecutable ? path.basename(path.dirname(ctx.browserExecutable)) : 'Remotion download'} · free RAM ${(os.freemem() / 1024 ** 3).toFixed(1)} GB`);
  },
  async produce(i0, i1, emit, ctx) {
    const R = await import('@remotion/renderer');
    const { cancelSignal, cancel } = R.makeCancelSignal();
    const onAbort = () => cancel();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let emitErr = null;
    try {
      await R.renderFrames({
        composition: ctx.composition, serveUrl: ctx.serveUrl, inputProps: ctx.inputProps, puppeteerInstance: ctx.rBrowser,
        browserExecutable: ctx.browserExecutable, chromiumOptions: ctx.chromiumOptions, outputDir: null, imageFormat: 'jpeg', jpegQuality: 92,
        concurrency: ctx.concurrency, frameRange: [i0, i1 - 1], cancelSignal, timeoutInMilliseconds: 60000, logLevel: 'error',
        onStart: () => {}, onFrameUpdate: () => {},
        onBrowserLog: (l) => { if (l.type === 'error' && !/favicon/.test(l.text)) ctx.browserErrors.push(l.text); },
        // the frame index is absolute (frameRange keeps composition numbering)
        onFrameBuffer: async (buf, frame) => {
          if (emitErr) return;
          try { await emit(frame, buf); } catch (e) { emitErr = e; cancel(); }
        },
      });
    } catch (e) {
      if (emitErr) throw emitErr;
      if (ctx.signal?.aborted) throw new Error('cancelled');
      const extra = ctx.browserErrors.length ? ` (page: ${ctx.browserErrors[0]})` : '';
      throw new Error(`remotion: ${e.message.split('\n')[0]}${extra}`);
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
    if (emitErr) throw emitErr;
  },
  async cleanup(ctx) {
    if (ctx.rBrowser) await Promise.race([ctx.rBrowser.close({ silent: true }).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    ctx.rBrowser = null;
  },
};
