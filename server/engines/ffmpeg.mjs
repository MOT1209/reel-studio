// FFmpeg engine: everything that is media processing, independent of which engine draws the frames —
// segmented H.264/H.265 encoding of a frame stream (with recovery), SFX synthesis, the audio mix + loudness,
// muxing, contact sheets and output validation with ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, FFMPEG, FFPROBE, trackChild } from '../proc.mjs';
import { writeFileAtomic } from '../settings.mjs';
import { isHold, segLen } from '../timeline.mjs';

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


export const QUALITY = { draft: { crf: 26, preset: 'veryfast' }, standard: { crf: 20, preset: 'faster' }, high: { crf: 17, preset: 'medium' } };
export const CODECS = { h264: { lib: 'libx264', tag: 'avc1', name: 'H.264' }, h265: { lib: 'libx265', tag: 'hvc1', name: 'H.265 / HEVC' } };
export const SEG_FRAMES = 300; // 10 s at 30 fps per segment: a crash or a cancel only loses the segment being encoded

/** Encoders this ffmpeg build actually has (libx265 is optional in many builds). */
let encCache = null;
export async function availableCodecs() {
  if (encCache) return encCache;
  try {
    const { out } = await run(FFMPEG, ['-hide_banner', '-encoders']);
    encCache = Object.fromEntries(Object.entries(CODECS).map(([k, c]) => [k, out.includes(c.lib)]));
  } catch { encCache = { h264: false, h265: false }; }
  return encCache;
}

/**
 * Encodes `total` frames into an MP4 (no audio) in independent segments, from any frame producer.
 * engine: { prepare(ctx), produce(i0, i1, emit, ctx), cleanup() } — produce may emit frames in any order
 * (parallel pages, Remotion's own concurrency); they are re-ordered here and fed to ffmpeg strictly in order.
 * Segments whose key (render data + settings hash) already exist on disk are reused: the recovery path after a
 * cancel, a crash or a server restart.
 */
export async function encodeSegmented({ engine, total, fps, width, height, quality = 'standard', codec = 'h264', bitrate = null, segDir, key = '', out, signal, log = () => {}, onFrame = () => {} }) {
  const nSeg = Math.max(1, Math.ceil(total / SEG_FRAMES));
  fs.mkdirSync(segDir, { recursive: true });
  const manifestFile = path.join(segDir, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  const fullKey = `${key}|${engine.id}|${codec}|${bitrate || ''}`;
  if (manifest.key !== fullKey) { for (const f of fs.readdirSync(segDir)) fs.rmSync(path.join(segDir, f), { force: true }); manifest = { key: fullKey, done: [] }; }
  const segFile = (k) => path.join(segDir, `seg_${String(k).padStart(4, '0')}.mp4`);
  const todo = [];
  const segFrames = (k) => Math.min(total, (k + 1) * SEG_FRAMES) - k * SEG_FRAMES;
  for (let k = 0; k < nSeg; k++) {
    let ok = manifest.done.includes(k) && fs.existsSync(segFile(k));
    // a reused segment must hold exactly the frames it should (a truncated file from a crash would otherwise be trusted)
    if (ok && (await countFrames(segFile(k)).catch(() => -1)) !== segFrames(k)) { ok = false; log(`recovery: segment ${k} is damaged — rendering it again`); }
    if (!ok) { todo.push(k); manifest.done = manifest.done.filter((x) => x !== k); }
  }
  if (todo.length < nSeg) log(`recovery: reusing ${nSeg - todo.length}/${nSeg} segments rendered before`);
  const q = QUALITY[quality] || QUALITY.standard;
  const c = CODECS[codec] || CODECS.h264;
  const t0 = Date.now();
  if (todo.length) {
    const ctx = { width, height, fps, total, signal, log };
    // a failing prepare (browser launched, page never became ready…) must not leak the browser it already started
    try { await engine.prepare(ctx); } catch (e) { await Promise.resolve(engine.cleanup(ctx)).catch(() => {}); throw e; }
    try {
      for (const k of todo) {
        if (signal?.aborted) throw new Error('cancelled');
        const i0 = k * SEG_FRAMES, i1 = Math.min(total, i0 + SEG_FRAMES);
        await encodeSegment({ engine, ctx, i0, i1, total, fps, width, height, q, c, bitrate, out: segFile(k), signal, onFrame });
        const got = await countFrames(segFile(k));
        if (got !== i1 - i0) throw new Error(`segment ${k}: expected ${i1 - i0} frames, encoded ${got}`);
        manifest.done.push(k);
        writeFileAtomic(manifestFile, JSON.stringify(manifest));
      }
    } finally { await engine.cleanup(ctx); }
  } else onFrame(total - 1, total, null);
  // concat (stream copy — every segment starts with a keyframe and shares the same encoder settings)
  const list = path.join(segDir, 'list.txt');
  writeFileAtomic(list, Array.from({ length: nSeg }, (_, k) => `file '${segFile(k).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await run(FFMPEG, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(c.tag ? ['-tag:v', c.tag] : []), '-movflags', '+faststart', out], { signal });
  log(`encoded ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s (${nSeg} segment${nSeg > 1 ? 's' : ''}, ${engine.id}, ${c.name})`);
  return total;
}

/** One segment: the engine produces frames [i0, i1); one ffmpeg process receives them strictly in order. */
async function encodeSegment({ engine, ctx, i0, i1, total, fps, width, height, q, c, bitrate, out, signal, onFrame }) {
  const tmp = out + '.part.mp4';
  const rate = bitrate ? ['-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`] : ['-crf', String(q.crf)];
  const ff = spawn(FFMPEG, ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${width}:${height}:in_range=full:out_range=tv,format=yuv420p`,
    '-c:v', c.lib, '-preset', q.preset, ...rate, '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(fps),
    ...(c.lib === 'libx265' ? ['-x265-params', 'log-level=error'] : []), tmp], { windowsHide: true });
  trackChild(ff);
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-4000); });
  // ffmpeg can die at any moment (bad codec, disk full, killed): `failed` stops the producer and the writer.
  let failed = null, ffClosed = false;
  const ffDone = new Promise((res, rej) => {
    ff.on('close', (code) => { ffClosed = true; if (code === 0) res(); else { failed = failed || new Error(`ffmpeg exited ${code}: ${ffErr.slice(-800)}`); rej(failed); } });
    ff.on('error', (e) => { ffClosed = true; failed = failed || new Error(`ffmpeg: ${e.message}`); rej(failed); });
  });
  ffDone.catch(() => {}); // awaited below; avoid an unhandled rejection when the render is cancelled
  ff.stdin.on('error', () => {});
  const ready = new Map();
  let written = i0, waiting = [];
  const wakeAll = () => { const w = waiting; waiting = []; w.forEach((r) => r()); };
  const check = () => { if (signal?.aborted) throw new Error('cancelled'); if (failed) throw failed; };
  // writer: drains `ready` in order; emit() applies back-pressure so at most ~48 frames wait in memory
  const flush = async () => {
    while (ready.has(written)) {
      const jpg = ready.get(written); ready.delete(written);
      if (ffClosed) throw failed || new Error('ffmpeg closed its input early');
      if (!ff.stdin.write(jpg)) {
        // wait for drain — or for ffmpeg to die, otherwise this would wait forever
        await new Promise((r) => { const t = setInterval(() => { if (ffClosed || signal?.aborted) { clearInterval(t); r(); } }, 100); ff.stdin.once('drain', () => { clearInterval(t); r(); }); });
      }
      onFrame(written, total, written % 15 === 0 || written === total - 1 ? jpg : null);
      written++;
      wakeAll();
    }
  };
  let flushing = Promise.resolve();
  const emit = async (i, jpg) => {
    check();
    if (i < i0 || i >= i1 || ready.has(i) || i < written) return; // outside the segment or a duplicate
    while (i - written > 48) { check(); await new Promise((r) => { waiting.push(r); setTimeout(r, 200); }); }
    ready.set(i, jpg);
    flushing = flushing.then(flush);
    await flushing;
  };
  try {
    try { await engine.produce(i0, i1, emit, ctx); }
    catch (e) { failed = failed || e; throw e; }
    await flushing;
    check();
    if (written !== i1) throw new Error(`engine ${engine.id} delivered ${written - i0} of ${i1 - i0} frames`);
    ff.stdin.end();
    await ffDone;
    fs.renameSync(tmp, out);
  } finally {
    if (ff.exitCode === null && (signal?.aborted || failed || !ff.stdin.writableEnded)) ff.kill('SIGKILL');
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Muxes into <out>.part.mp4, verifies it when `expect` is given (validateOutput options) and only then renames: a cancel,
 * a crash or a failed check never leaves a bad file at `out`. There is no `-shortest`: it silently cut 1–2 video frames
 * whenever the audio was a hair shorter (measured: 324 of 326 frames); the caller makes the audio as long as the frames.
 */
export async function muxFinal({ video, audio, out, signal, expect = null }) {
  const tmp = `${out}.part.mp4`;
  try {
    await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', tmp], { signal });
    if (expect) await validateOutput(tmp, expect);
    fs.renameSync(tmp, out);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Number of video frames (packets) in a file — proves a segment has exactly the frames it should. */
export async function countFrames(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return parseInt(out, 10);
}

export async function contactSheet({ video, out, duration, aspect = '9:16' }) {
  const [tw, th, cols] = { '9:16': [270, 480, 6], '1:1': [320, 320, 6], '16:9': [384, 216, 4], '4:5': [288, 360, 5] }[aspect] || [270, 480, 6];
  const count = Math.min(36, Math.max(cols, Math.round(duration * 2)));
  const rows = Math.ceil(count / cols);
  const fps = (count / duration).toFixed(4);
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-vf', `fps=${fps},scale=${tw}:${th},tile=${cols}x${rows}:padding=6:color=0x0C1014`, '-frames:v', '1', '-q:v', '3', out]);
}


/**
 * Checks a finished MP4 with ffprobe — a zero exit code proves nothing: dimensions, frame rate, duration (±0.15 s),
 * video codec and an audio stream must match what was asked for. Returns the probe; throws with the mismatch.
 */
export async function validateOutput(file, { width, height, fps, duration, codec = 'h264', audio = true, frames = 0 } = {}) {
  const { out } = await run(FFPROBE, ['-v', 'error', ...(frames ? ['-count_packets'] : []), '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,duration,nb_read_packets:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out || '{}');
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const d = Number(j.format?.duration);
  const want = { h264: 'h264', h265: 'hevc' }[codec] || codec;
  const problems = [];
  if (!v) problems.push('no video stream');
  else {
    if (width && v.width !== width) problems.push(`width ${v.width} ≠ ${width}`);
    if (height && v.height !== height) problems.push(`height ${v.height} ≠ ${height}`);
    if (fps && v.r_frame_rate !== `${fps}/1`) problems.push(`fps ${v.r_frame_rate} ≠ ${fps}`);
    if (v.codec_name !== want) problems.push(`codec ${v.codec_name} ≠ ${want}`);
    if (frames && Number(v.nb_read_packets) !== frames) problems.push(`${v.nb_read_packets} frames ≠ ${frames}`);
  }
  if (audio && !a) problems.push('no audio stream');
  if (audio && a && duration && Number(a.duration) && Math.abs(Number(a.duration) - duration) > 0.2) problems.push(`audio ${Number(a.duration).toFixed(2)} s ≠ ${duration.toFixed(2)} s`);
  if (duration && !(Math.abs(d - duration) <= 0.15)) problems.push(`duration ${d.toFixed(3)} ≠ ${duration.toFixed(3)}`);
  if (problems.length) throw new Error(`output check failed: ${problems.join(', ')}`);
  return { width: v.width, height: v.height, fps: v.r_frame_rate, duration: d, video: v.codec_name, audio: a?.codec_name || null };
}
