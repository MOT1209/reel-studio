// Render stage: Playwright draws each frame via window.drawFrame(t), ffmpeg encodes H.264,
// voice + synthesized SFX are mixed and normalised to −14 LUFS (two-pass loudnorm).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

export const FPS = 30;
export const W = 1080, H = 1920;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(cmd, args, { signal, input, collect = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { if (collect) out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-800)}`));
    });
    if (input) p.stdin.end(input);
  });
}

export async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${path.basename(file)}`);
  return d;
}

export async function checkFfmpeg() {
  try { const { out } = await run(FFMPEG, ['-version']); return out.split('\n')[0]; } catch { return null; }
}

// ---- SFX synthesis ------------------------------------------------------------
const SR = 48000;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }

function whoosh(seed = 1) {
  const len = Math.round(0.5 * SR), out = new Float32Array(len), r = rng(seed);
  let low = 0, band = 0;
  for (let i = 0; i < len; i++) {
    const x = i / len;
    const f = 300 + 2600 * Math.pow(x, 1.4); // sweep up
    const F = 2 * Math.sin((Math.PI * f) / SR), Q = 0.35; // state-variable band-pass
    const high = r() - low - Q * band;
    band += F * high; low += F * band;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, x / 0.75)), 2) * (x < 0.75 ? 1 : Math.max(0, 1 - (x - 0.75) / 0.25));
    out[i] = band * env * 0.5;
  }
  return out;
}
function tick() {
  const len = Math.round(0.05 * SR), out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = (Math.sin(2 * Math.PI * 2200 * t) * 0.7 + Math.sin(2 * Math.PI * 4400 * t) * 0.2) * Math.exp(-t / 0.01) * 0.35;
  }
  return out;
}

/** Writes a mono 48 kHz 16-bit WAV with whooshes on scene cuts and soft ticks on pops. */
export function writeSfx(file, duration, cuts, ticks, volume = 0.6) {
  const vol = Math.max(0, Math.min(1, Number(volume))) / 0.6; // 0.6 = the reference mix level
  const n = Math.ceil(duration * SR), buf = new Float32Array(n);
  const add = (sig, at, gain) => { const o = Math.round(at * SR); for (let i = 0; i < sig.length; i++) { const k = o + i; if (k >= 0 && k < n) buf[k] += sig[i] * gain; } };
  cuts.forEach((t, i) => add(whoosh(i + 7), t - 0.36, 0.55 * vol)); // envelope peaks ~0.36 s in → lands on the cut
  const tk = tick();
  let lastTick = -1;
  for (const t of ticks) { if (t - lastTick < 0.25) continue; add(tk, t, 0.35 * vol); lastTick = t; }
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24);
  wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, wav);
}

/** voice + sfx → loudness-normalised (−14 LUFS, −1.5 dBTP) AAC, padded/trimmed to duration. */
export async function mixAudio({ voice, sfx, out, duration, signal, log = () => {} }) {
  const graph = `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[v];[1:a]aresample=48000,aformat=channel_layouts=stereo[s];[v][s]amix=inputs=2:normalize=0:duration=longest,atrim=0:${duration.toFixed(3)}`;
  const pass1 = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', voice, '-i', sfx, '-filter_complex', `${graph},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], { signal });
  const m = pass1.err.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) throw new Error('loudnorm pass 1 produced no measurement');
  const j = JSON.parse(m[0]);
  log(`loudness measured: ${j.input_i} LUFS, TP ${j.input_tp} dB → target −14 LUFS`);
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  await run(FFMPEG, ['-hide_banner', '-y', '-i', voice, '-i', sfx, '-filter_complex', `${graph},${ln},aresample=48000`, '-c:a', 'aac', '-b:a', '192k', out], { signal });
}

// ---- browser -------------------------------------------------------------------
export async function launchBrowser(log = () => {}) {
  const { chromium } = await import('playwright');
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const opt of attempts) {
    try {
      const b = await chromium.launch({ ...opt, args: ['--font-render-hinting=none', '--disable-gpu'] /* software raster parallelises across pages */ });
      if (opt.channel) log(`using system browser channel "${opt.channel}"`);
      return b;
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
const WORKERS = Math.max(1, Math.min(4, Number(process.env.RS_RENDER_WORKERS) || Math.max(1, os.cpus().length - 1)));

async function openWorker(browser, url, errors) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 30000 });
  const pageErr = await page.evaluate(() => window.__error || null);
  if (pageErr) throw new Error(`render.html: ${pageErr}`);
  return page;
}

async function captureFrame(page, t) {
  if (CAPTURE === 'screenshot') {
    await page.evaluate((tt) => window.drawFrame(tt), t);
    return page.screenshot({ type: 'jpeg', quality: 94, clip: { x: 0, y: 0, width: W, height: H } });
  }
  const b64 = await page.evaluate(async (tt) => {
    window.drawFrame(tt);
    const blob = await new Promise((r) => document.getElementById('c').toBlob(r, 'image/jpeg', 0.95));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    return btoa(s);
  }, t);
  return Buffer.from(b64, 'base64');
}

export async function renderFrames({ url, out, duration, fps: FPS_ = FPS, signal, log = () => {}, onFrame = () => {} }) {
  const browser = await launchBrowser(log);
  let ff;
  try {
    const errors = [];
    const total = Math.ceil(duration * FPS_);
    const nWorkers = Math.min(WORKERS, Math.max(1, Math.floor(total / 30)));
    const pages = await Promise.all(Array.from({ length: nWorkers }, () => openWorker(browser, url, errors)));
    log(`capture: ${CAPTURE} · ${nWorkers} parallel page${nWorkers > 1 ? 's' : ''}`);
    ff = spawn(FFMPEG, ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(FPS_), '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'faster', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(FPS_), '-movflags', '+faststart', out], { windowsHide: true });
    let ffErr = '';
    ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-4000); });
    const ffDone = new Promise((res, rej) => { ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${ffErr}`)))); ff.on('error', rej); });
    ffDone.catch(() => {}); // awaited below; avoid an unhandled rejection when the render is cancelled
    ff.stdin.on('error', () => {});
    const t0 = Date.now();
    // Workers pull frame indices; the writer feeds ffmpeg strictly in order.
    const ready = new Map();
    let next = 0, written = 0, wake = null;
    const worker = async (page) => {
      for (;;) {
        if (signal?.aborted || errors.length) return;
        const i = next++;
        if (i >= total) return;
        while (i - written > nWorkers * 4) await new Promise((r) => setTimeout(r, 5)); // bounded look-ahead
        ready.set(i, await captureFrame(page, i / FPS_));
        wake?.();
      }
    };
    const writer = (async () => {
      while (written < total) {
        if (signal?.aborted) throw new Error('cancelled');
        if (errors.length) throw new Error(`render.html error: ${errors[0]}`);
        if (!ready.has(written)) { await new Promise((r) => { wake = r; setTimeout(r, 50); }); continue; }
        const jpg = ready.get(written); ready.delete(written);
        if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
        onFrame(written, total, written % 15 === 0 || written === total - 1 ? jpg : null);
        written++;
      }
    })();
    await Promise.all([...pages.map(worker), writer]);
    ff.stdin.end();
    await ffDone;
    log(`encoded ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return total;
  } finally {
    if (ff && ff.exitCode === null && (signal?.aborted || !ff.stdin.writableEnded)) ff.kill('SIGKILL');
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

export async function muxFinal({ video, audio, out, signal }) {
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out], { signal });
}

export async function contactSheet({ video, out, duration, cols = 6 }) {
  const count = Math.min(36, Math.max(6, Math.round(duration * 2)));
  const rows = Math.ceil(count / cols);
  const fps = (count / duration).toFixed(4);
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-vf', `fps=${fps},scale=270:480,tile=${cols}x${rows}:padding=6:color=0x0C1014`, '-frames:v', '1', '-q:v', '3', out]);
}
