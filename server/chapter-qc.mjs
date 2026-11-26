// Post-join quality gate for chaptered (long-form) projects. After the chapter MP4s are joined, prove the joined file
// is coherent BEFORE the project can mark itself done:
//   - the frame count and the duration match the plan exactly;
//   - the audio is not longer than the video (the class of bug that slipped the sound at every join);
//   - every chapter's audio sits where its video says, measured by correlating the chapter's own energy envelope
//     against the joined file (one chapter may be off by at most MAX_LAG, and the lag must not grow across joins);
//   - the chapters do not drift apart in loudness (each is normalised to −14 LUFS, so the spread should be ~0).
// A failure throws with the chapter name and the size of the error: a silently out-of-sync 30-minute video is worse
// than a failed render.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, trackChild, FFMPEG, FFPROBE } from './proc.mjs';

const HOP = 0.005;             // 5 ms energy frames
const SR = 16000;
const HOP_SAMPLES = Math.round(SR * HOP);
const LAG_SEARCH = 0.15;       // search ±150 ms around the expected position
const MAX_LAG = 0.06;          // one chapter may sit at most 60 ms off its own audio (measured on real joins: 3 ms)
const MAX_SPREAD = 0.03;       // and the lag must not grow across joins (measured: 0 ms)
const MAX_LU_SPREAD = 1.5;     // LU between chapters (measured: 0.0 LU)
const DURATION_TOL = 0.1;      // joined duration vs frames / fps
const AUDIO_VIDEO_TOL = 0.05;  // joined audio vs video duration
const WINDOW_START = 0.5;      // skip the fade-in at the chapter start
const WINDOW_LEN = 4;

/** Frames, duration and audio duration of one MP4 (fast: stream metadata, no packet counting). */
async function probe(file, signal, fps) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const declared = Number(v?.nb_frames);
  const byDuration = Number(v?.duration) && fps ? Math.round(Number(v.duration) * fps) : NaN;
  return {
    frames: Number.isFinite(declared) && declared > 0 ? declared : byDuration,
    duration: Number(j.format?.duration),
    videoDuration: Number(v?.duration),
    audioDuration: a ? Number(a.duration) : null,
  };
}

/** Decodes a file's audio to 16 kHz mono and turns it into 5 ms RMS frames (a cheap, robust envelope). */
function envelope(file, signal) {
  return new Promise((resolve, reject) => {
    const p = trackChild(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { windowsHide: true }));
    const chunks = [];
    let bytes = 0;
    let err = '';
    p.stdout.on('data', (d) => { chunks.push(d); bytes += d.length; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('error', reject);
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) return reject(new Error(`chapter QC: ffmpeg exited ${code} decoding ${path.basename(file)}${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
      const pcm = Buffer.concat(chunks, bytes);
      const n = Math.floor(pcm.length / 2 / HOP_SAMPLES);
      const env = new Float32Array(Math.max(0, n));
      let peak = 0;
      for (let i = 0; i < n; i++) {
        let s = 0;
        const base = i * HOP_SAMPLES * 2;
        for (let k = 0; k < HOP_SAMPLES; k++) { const x = pcm.readInt16LE(base + k * 2) / 32768; s += x * x; }
        const rms = Math.sqrt(s / HOP_SAMPLES);
        env[i] = rms;
        if (rms > peak) peak = rms;
      }
      if (peak > 0) for (let i = 0; i < env.length; i++) env[i] /= peak;
      resolve(env);
    });
  });
}

/** Best offset (seconds) of `b` (chapter) inside `a` (joined), starting at the two given frame indexes. */
function bestLag(a, aStart, b, bStart, frames) {
  const maxLag = Math.round(LAG_SEARCH / HOP);
  let best = 0;
  let bestScore = -Infinity;
  let bestSeen = false;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0, ea = 0, eb = 0;
    let seen = 0;
    for (let i = 0; i < frames; i++) {
      const y = b[bStart + i + lag];
      if (y === undefined) continue;
      const x = a[aStart + i];
      if (x === undefined) break;
      dot += x * y; ea += x * x; eb += y * y; seen++;
    }
    if (seen < frames * 0.8) continue;
    const score = dot / Math.sqrt(ea * eb || 1);
    if (score > bestScore) { bestScore = score; best = lag; bestSeen = true; }
  }
  return bestSeen ? { lag: best * HOP, score: bestScore } : null;
}

/** Integrated loudness (LUFS) of one file; −70 for digital silence. */
async function loudness(file, signal) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { signal });
  const all = [...err.matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  if (!Number.isFinite(v)) throw new Error(`chapter QC: could not read loudness of ${path.basename(file)}`);
  return v;
}

const ms = (x) => Math.round(x * 1000);

/**
 * Runs every post-join check. Throws one Error listing every problem (chapter names included) when the joined file
 * is not trustworthy; returns the measured stats otherwise (kept on the project for the UI/API).
 */
export async function checkChapterJoin({ files, joined, fps, frames: expectedFrames, duration: expectedDuration, signal, log = () => {} }) {
  if (!files?.length) throw new Error('chapter QC needs at least one chapter file');
  if (!(fps > 0)) throw new Error('chapter QC needs the project fps');
  const issues = [];
  const ids = files.map((f) => path.basename(path.dirname(f)));

  // 1) the joined file itself
  const j = await probe(joined, signal, fps);
  if (!Number.isFinite(j.frames)) issues.push(`could not read the joined frame count (${path.basename(joined)})`);
  else if (j.frames !== expectedFrames) issues.push(`joined video has ${j.frames} frames, expected ${expectedFrames}`);
  if (Math.abs(j.duration - expectedDuration) > DURATION_TOL)
    issues.push(`joined duration is ${j.duration.toFixed(3)} s, expected ${expectedDuration.toFixed(3)} s`);
  if (j.audioDuration && Math.abs(j.audioDuration - j.duration) > AUDIO_VIDEO_TOL)
    issues.push(`joined audio is ${ms(Math.abs(j.audioDuration - j.duration))} ms ${j.audioDuration > j.duration ? 'longer' : 'shorter'} than the video`);

  // 2) each chapter against the joined file
  const chs = [];
  for (const f of files) chs.push(await probe(f, signal, fps));
  const joinedEnv = await envelope(joined, signal);
  const lags = [];
  const lus = [];
  let at = 0;
  for (let i = 0; i < files.length; i++) {
    const id = ids[i];
    const frames = chs[i].frames;
    if (!Number.isFinite(frames) || frames <= 0) { issues.push(`${id}: no video frames`); lags.push(NaN); }
    else {
      const chEnv = await envelope(files[i], signal);
      const start = at / fps;
      const avail = Math.min(WINDOW_LEN, chs[i].duration - WINDOW_START, (joinedEnv.length * HOP) - start - WINDOW_START);
      const winFrames = Math.floor(avail / HOP);
      if (winFrames < 100) issues.push(`${id}: chapter is too short to verify its audio position`);
      else {
        const r = bestLag(joinedEnv, Math.round((start + WINDOW_START) / HOP), chEnv, Math.round(WINDOW_START / HOP), winFrames);
        if (!r || r.score < 0.5) issues.push(`${id}: could not align its audio with the joined video (correlation ${r ? r.score.toFixed(2) : 'n/a'}) — check the join`);
        else lags.push(r.lag);
      }
    }
    lus.push(await loudness(files[i], signal));
    at += frames;
  }

  const okLags = lags.filter(Number.isFinite);
  const maxLag = okLags.length ? Math.max(...okLags.map(Math.abs)) : NaN;
  const spread = okLags.length ? Math.max(...okLags) - Math.min(...okLags) : NaN;
  if (okLags.length === files.length) {
    if (maxLag > MAX_LAG) {
      const worst = ids[lags.findIndex((x) => Math.abs(x) === Math.max(...okLags.map(Math.abs)))];
      issues.push(`sync error ${ms(maxLag)} ms at ${worst} (limit ${ms(MAX_LAG)} ms) — its audio does not start where its video does`);
    }
    if (spread > MAX_SPREAD) {
      issues.push(`sync drifts across joins by ${ms(spread)} ms (${lags.map((x) => (Number.isFinite(x) ? ms(x) : '?')).join(' → ')} ms; limit ${ms(MAX_SPREAD)} ms)`);
    }
  }
  const luSpread = Math.max(...lus) - Math.min(...lus);
  if (luSpread > MAX_LU_SPREAD) {
    const lo = lus.indexOf(Math.min(...lus));
    const hi = lus.indexOf(Math.max(...lus));
    issues.push(`loudness spread ${luSpread.toFixed(1)} LU between chapters (${ids[hi]} ${lus[hi].toFixed(1)} vs ${ids[lo]} ${lus[lo].toFixed(1)} LUFS; limit ${MAX_LU_SPREAD} LU)`);
  }

  if (issues.length) throw new Error(`chapter QC failed — ${issues.join(' | ')}`);
  const stats = {
    frames: j.frames,
    duration: +j.duration.toFixed(3),
    audioDuration: j.audioDuration ? +j.audioDuration.toFixed(3) : null,
    lagsMs: lags.map((x) => (Number.isFinite(x) ? ms(x) : null)),
    maxLagMs: ms(maxLag),
    lagSpreadMs: ms(spread),
    loudnessLu: lus.map((x) => +x.toFixed(1)),
    loudnessSpreadLu: +luSpread.toFixed(1),
  };
  log(`chapter QC ✓ ${stats.frames} frames · ${stats.duration.toFixed(2)} s · sync ${stats.maxLagMs} ms max (spread ${stats.lagSpreadMs} ms) · loudness ${Math.min(...lus).toFixed(1)}…${Math.max(...lus).toFixed(1)} LUFS (spread ${stats.loudnessSpreadLu} LU)`);
  return stats;
}
