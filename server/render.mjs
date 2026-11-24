// Render stage: Playwright draws each frame via window.drawFrame(t), ffmpeg encodes H.264,
// voice + synthesized SFX are mixed and normalised to −14 LUFS (two-pass loudnorm).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { outToSrc, isHold, segLen } from './timeline.mjs';

export const FPS = 30;
export const W = 1080, H = 1920;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(cmd, args, { signal, input, collect = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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

/**
 * Final mix → loudness-normalised (−14 LUFS, −1.5 dBTP) AAC, exactly `duration` long.
 * 1. Source timeline: the voice + the sound of video clips (each placed at its start, from its offset).
 * 2. Only the kept segments of that timeline survive (trim + cuts), joined with 15 ms fades so cuts never click.
 * 3. Output timeline: + SFX (already in output time) + background music, looped, faded and side-chain ducked
 *    under the voice so narration always stays intelligible.
 * segments: [[a,b],…] in source seconds (default: [start, start+duration]).
 * clips: [{ file, at, offset, length, volume }] in source seconds.
 */
export async function mixAudio({ voice, sfx, out, duration, start = 0, segments = null, voiceVolume = 1, clips = [], music = null, signal, log = () => {} }) {
  const D = duration.toFixed(3);
  const segs = segments?.length ? segments : [[start, start + duration]];
  const f3 = (x) => Math.max(0, x).toFixed(3);
  const inputs = ['-i', voice, '-i', sfx];
  let g = `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(+voiceVolume).toFixed(3)},apad[v0];`;
  const srcLabels = ['[v0]'];
  clips.forEach((c, k) => {
    const idx = 2 + k;
    inputs.push('-i', c.file);
    const ms = Math.round(c.at * 1000);
    g += `[${idx}:a]atrim=start=${f3(c.offset)}:end=${f3(c.offset + c.length)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${(+c.volume).toFixed(3)},adelay=${ms}|${ms}[c${k}];`;
    srcLabels.push(`[c${k}]`);
  });
  if (clips.length) g += `${srcLabels.join('')}amix=inputs=${srcLabels.length}:normalize=0:duration=first[src];`;
  else g += '[v0]anull[src];';
  // keep only the segments that survive (trim + cuts, or the custom order); pauses are generated silence
  const ranges = segs.filter((sg) => !isHold(sg));
  g += `[src]asplit=${ranges.length}${ranges.map((_, k) => `[s${k}]`).join('')};`;
  let r = 0;
  segs.forEach((sg, k) => {
    if (isHold(sg)) { g += `anullsrc=r=48000:cl=stereo,atrim=0:${f3(sg[2])}[k${k}];`; return; }
    const [x, y] = sg, len = y - x, fd = Math.min(0.015, len / 4).toFixed(3);
    g += `[s${r++}]atrim=start=${f3(x)}:end=${f3(y)},asetpts=PTS-STARTPTS,afade=t=in:d=${fd},afade=t=out:st=${f3(len - fd)}:d=${fd}[k${k}];`;
  });
  g += `${segs.map((_, k) => `[k${k}]`).join('')}concat=n=${segs.length}:v=0:a=1,apad[vp];`;
  g += `[1:a]aresample=48000,aformat=channel_layouts=stereo[s];`;
  let mixIn = '[v][s]', n = 2;
  if (music) {
    const mi = inputs.length / 2;
    inputs.push('-stream_loop', '-1', '-i', music.file);
    const fi = Math.max(0, Math.min(5, music.fadeIn ?? 1)), fo = Math.max(0, Math.min(5, music.fadeOut ?? 1.5));
    g += `[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(+music.volume).toFixed(3)},atrim=0:${D},afade=t=in:d=${fi},afade=t=out:st=${Math.max(0, duration - fo).toFixed(3)}:d=${fo}[mraw];`;
    if (music.duck) g += `[vp]asplit=2[v][vsc];[mraw][vsc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350:makeup=1[m];`;
    else g += `[vp]anull[v];[mraw]anull[m];`;
    mixIn += '[m]'; n = 3;
  } else g += `[vp]anull[v];`;
  g += `${mixIn}amix=inputs=${n}:normalize=0:duration=longest,atrim=0:${D}`;
  const pass1 = await run(FFMPEG, ['-hide_banner', '-nostats', ...inputs, '-filter_complex', `${g},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], { signal });
  const m = pass1.err.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) throw new Error('loudnorm pass 1 produced no measurement');
  const j = JSON.parse(m[0]);
  log(`loudness measured: ${j.input_i} LUFS, TP ${j.input_tp} dB → target −14 LUFS${segs.length > 1 ? ` · ${segs.length - 1} cut${segs.length > 2 ? 's' : ''}` : ''}${segs.some(isHold) ? ` · ${segs.filter(isHold).length} pause(s)` : ''}${clips.length ? ` · ${clips.length} clip sound${clips.length > 1 ? 's' : ''}` : ''}${music ? ` · music ${Math.round(music.volume * 100)}%${music.duck ? ' (ducked under voice)' : ''}` : ''}`);
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  await run(FFMPEG, ['-hide_banner', '-y', ...inputs, '-filter_complex', `${g},${ln},aresample=48000`, '-c:a', 'aac', '-b:a', '192k', out], { signal });
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
// Parallel pages: by CPU cores, but each headless page needs ~400 MB — on a memory-starved machine
// extra pages only cause swapping (everything, the server included, slows to a crawl).
function workerCount() {
  if (Number(process.env.RS_RENDER_WORKERS)) return Math.max(1, Math.min(4, Number(process.env.RS_RENDER_WORKERS)));
  const byCpu = Math.max(1, os.cpus().length - 1);
  const byMem = Math.max(1, Math.floor((os.freemem() / 1024 ** 2 - 300) / 400));
  return Math.max(1, Math.min(4, byCpu, byMem));
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

export const QUALITY = { draft: { crf: 26, preset: 'veryfast' }, standard: { crf: 20, preset: 'faster' }, high: { crf: 17, preset: 'medium' } };
const SEG_FRAMES = 300; // 10 s at 30 fps per segment: a crash or a cancel only loses the segment being encoded

/**
 * Renders [start, start+duration) of render.html into an H.264 MP4 (no audio), in independent segments.
 * Segments whose key (render data + settings hash) already exist on disk are reused — that is the recovery path
 * after a cancel, a crash or a server restart. width/height: output size; quality: draft | standard | high.
 */
export async function renderFrames({ url, out, duration, start = 0, segments = null, fps: FPS_ = FPS, width = W, height = H, quality = 'standard', segDir, key = '', signal, log = () => {}, onFrame = () => {} }) {
  const total = Math.ceil(duration * FPS_ - 1e-9);
  const nSeg = Math.max(1, Math.ceil(total / SEG_FRAMES));
  segDir = segDir || path.join(path.dirname(out), 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  const manifestFile = path.join(segDir, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  if (manifest.key !== key) { for (const f of fs.readdirSync(segDir)) fs.rmSync(path.join(segDir, f), { force: true }); manifest = { key, done: [] }; }
  const segFile = (k) => path.join(segDir, `seg_${String(k).padStart(4, '0')}.mp4`);
  const todo = [];
  for (let k = 0; k < nSeg; k++) if (!(manifest.done.includes(k) && fs.existsSync(segFile(k)))) todo.push(k);
  if (todo.length < nSeg) log(`recovery: reusing ${nSeg - todo.length}/${nSeg} segments rendered before`);
  const q = QUALITY[quality] || QUALITY.standard;
  const t0 = Date.now();
  if (todo.length) {
    const browser = await launchBrowser(log);
    try {
      const errors = [];
      const nWorkers = Math.min(workerCount(), Math.max(1, Math.floor(total / 30)));
      const pages = await Promise.all(Array.from({ length: nWorkers }, () => openWorker(browser, url, errors, width, height)));
      log(`capture: ${CAPTURE} · ${nWorkers} parallel page${nWorkers > 1 ? 's' : ''} · ${width}×${height} · ${quality} (crf ${q.crf}) · free RAM ${(os.freemem() / 1024 ** 3).toFixed(1)} GB`);
      if (os.freemem() < 1024 ** 3) log('⚠ الذاكرة الفاضية أقل من 1 GB — الرندر هيبقى بطيء؛ اقفل برامج تانية لو تقدر');
      for (const k of todo) {
        if (signal?.aborted) throw new Error('cancelled');
        const i0 = k * SEG_FRAMES, i1 = Math.min(total, i0 + SEG_FRAMES);
        const timeOf = segments ? (i) => outToSrc(i / FPS_, segments) : (i) => start + i / FPS_; // output frame → source time
        await renderSegment({ pages, errors, i0, i1, total, timeOf, fps: FPS_, width, height, q, out: segFile(k), signal, onFrame });
        manifest.done.push(k);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      }
    } finally {
      await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
  } else onFrame(total - 1, total, null);
  // concat (stream copy — every segment starts with a keyframe and shares the same encoder settings)
  const list = path.join(segDir, 'list.txt');
  fs.writeFileSync(list, Array.from({ length: nSeg }, (_, k) => `file '${segFile(k).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await run(FFMPEG, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { signal });
  log(`encoded ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s (${nSeg} segment${nSeg > 1 ? 's' : ''})`);
  return total;
}

/** Captures frames [i0, i1) with all pages in parallel and feeds one ffmpeg process strictly in order. */
async function renderSegment({ pages, errors, i0, i1, total, timeOf, fps: FPS_, width, height, q, out, signal, onFrame }) {
  const tmp = out + '.part.mp4';
  const ff = spawn(FFMPEG, ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(FPS_), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${width}:${height}:in_range=full:out_range=tv,format=yuv420p`,
    '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(FPS_), tmp], { windowsHide: true });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-4000); });
  // ffmpeg can die at any moment (bad codec, disk full, killed): `failed` stops every loop below.
  let failed = null, ffClosed = false;
  const ffDone = new Promise((res, rej) => {
    ff.on('close', (c) => { ffClosed = true; if (c === 0) res(); else { failed = failed || new Error(`ffmpeg exited ${c}: ${ffErr.slice(-800)}`); rej(failed); } });
    ff.on('error', (e) => { ffClosed = true; failed = failed || new Error(`ffmpeg: ${e.message}`); rej(failed); });
  });
  ffDone.catch(() => {}); // awaited below; avoid an unhandled rejection when the render is cancelled
  ff.stdin.on('error', () => {});
  const stop = () => signal?.aborted || failed || errors.length;
  const nWorkers = pages.length;
  try {
    // Workers pull frame indices; the writer feeds ffmpeg strictly in order.
    const ready = new Map();
    let next = i0, written = i0, wake = null;
    const worker = async (page) => {
      for (;;) {
        if (stop()) return;
        const i = next++;
        if (i >= i1) return;
        while (i - written > nWorkers * 4) { if (stop()) return; await new Promise((r) => setTimeout(r, 5)); } // bounded look-ahead
        try { ready.set(i, await captureFrame(page, timeOf(i), width, height, i / FPS_)); }
        catch (e) { failed = failed || new Error(`frame ${i}: ${e.message.split('\n')[0]}`); wake?.(); return; }
        wake?.();
      }
    };
    const writer = (async () => {
      while (written < i1) {
        if (signal?.aborted) throw new Error('cancelled');
        if (errors.length) throw new Error(`render.html error: ${errors[0]}`);
        if (failed) throw failed;
        if (!ready.has(written)) { await new Promise((r) => { wake = r; setTimeout(r, 50); }); continue; }
        const jpg = ready.get(written); ready.delete(written);
        if (ffClosed) throw failed || new Error('ffmpeg closed its input early');
        if (!ff.stdin.write(jpg)) {
          // wait for drain — or for ffmpeg to die, otherwise this would wait forever
          await new Promise((r) => { const t = setInterval(() => { if (ffClosed || signal?.aborted) { clearInterval(t); r(); } }, 100); ff.stdin.once('drain', () => { clearInterval(t); r(); }); });
        }
        onFrame(written, total, written % 15 === 0 || written === total - 1 ? jpg : null);
        written++;
      }
    })();
    try { await Promise.all([...pages.map(worker), writer]); }
    catch (e) { failed = failed || e; throw e; } // `failed` makes the remaining workers return
    ff.stdin.end();
    await ffDone;
    fs.renameSync(tmp, out);
  } finally {
    if (ff.exitCode === null && (signal?.aborted || failed || !ff.stdin.writableEnded)) ff.kill('SIGKILL');
    fs.rmSync(tmp, { force: true });
  }
}

export async function muxFinal({ video, audio, out, signal }) {
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out], { signal });
}

export async function contactSheet({ video, out, duration, aspect = '9:16' }) {
  const [tw, th, cols] = { '9:16': [270, 480, 6], '1:1': [320, 320, 6], '16:9': [384, 216, 4], '4:5': [288, 360, 5] }[aspect] || [270, 480, 6];
  const count = Math.min(36, Math.max(cols, Math.round(duration * 2)));
  const rows = Math.ceil(count / cols);
  const fps = (count / duration).toFixed(4);
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-vf', `fps=${fps},scale=${tw}:${th},tile=${cols}x${rows}:padding=6:color=0x0C1014`, '-frames:v', '1', '-q:v', '3', out]);
}
