// Chapter join test (needs ffmpeg): node tools/concat-test.mjs
// Three 2 s chapters, each with a 1 kHz tone starting at 0.5 s. Joining with `-c:a copy` would leave ~26 ms of
// un-trimmed AAC priming/padding at every join (16 → 42 → 70 ms of drift in 3 chapters); concatVideos re-encodes the
// audio once, so the drift must stay within one AAC frame no matter how many chapters are joined.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { concatVideos } from '../server/engines/ffmpeg.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const SR = 48000, FPS = 24, CHAPTER_SECONDS = 2, TONE_AT = 0.5, CHAPTERS = 3;
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-concat-'));
const out = path.join(W, 'joined.mp4');

try {
  execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
} catch {
  console.error('concat-test needs ffmpeg (set FFMPEG_PATH)');
  process.exit(1);
}

const files = [];
for (let i = 1; i <= CHAPTERS; i++) {
  const f = path.join(W, `ch${i}.mp4`);
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=${FPS}:d=${CHAPTER_SECONDS}`,
    '-f', 'lavfi', '-i', `aevalsrc='if(lt(mod(t,${CHAPTER_SECONDS}),${TONE_AT}),0,0.8*sin(2*PI*1000*t))':s=${SR}:d=${CHAPTER_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', f,
  ]);
  files.push(f);
}

const framesPer = CHAPTER_SECONDS * FPS;
const expect = { width: 320, height: 240, fps: FPS, frames: framesPer * CHAPTERS, duration: CHAPTER_SECONDS * CHAPTERS, codec: 'h264' };
await concatVideos({ files, out, expect }); // throws (validateOutput) if frames/duration/audio are wrong

const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_packets', '-of', 'json', out]).toString());
const vs = probe.streams.find((s) => s.codec_type === 'video');
const as = probe.streams.find((s) => s.codec_type === 'audio');
assert.equal(Number(vs.nb_read_packets), expect.frames, 'joined video keeps every chapter frame');
assert.equal(`${vs.width}x${vs.height}`, '320x240');
assert.equal(as.codec_name, 'aac', 'joined audio is AAC');
assert.equal(Number(as.sample_rate), SR);
assert.equal(Number(as.channels), 2);

// measured onsets of the tone in the joined audio
const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
const avg = (t) => {
  const i = Math.round(t * SR);
  let s = 0;
  for (let k = i; k < i + 480; k++) s += Math.abs(pcm.readInt16LE(k * 2)) / 32768;
  return s / 480;
};
const onsets = [];
for (let i = 0; i < CHAPTERS; i++) {
  const base = i * CHAPTER_SECONDS;
  let found = null;
  for (let t = base + TONE_AT - 0.2; t < base + TONE_AT + 0.5; t += 0.002) if (avg(t) > 0.2) { found = t; break; }
  onsets.push(found);
}
const drift = onsets.map((x, i) => (x == null ? NaN : x - (TONE_AT + i * CHAPTER_SECONDS)));
console.log(`onsets ${onsets.map((x) => x?.toFixed(3)).join(', ')} · drift ${drift.map((d) => (d * 1000).toFixed(1)).join(' / ')} ms`);

assert.ok(onsets.every((x) => x !== null), 'every chapter tone is audible in the joined audio');
assert.ok(drift.every((d) => Math.abs(d) <= 0.04), `each chapter starts within 40 ms of its place (${drift.map((d) => (d * 1000).toFixed(0)).join('/')} ms)`);
assert.ok(Math.abs(drift[drift.length - 1] - drift[0]) <= 0.02, `drift does not accumulate across joins (${(drift[0] * 1000).toFixed(0)} → ${(drift[drift.length - 1] * 1000).toFixed(0)} ms)`);
const audioDur = Number(as.duration || 0);
assert.ok(Math.abs(audioDur - expect.duration) < 0.1, `audio duration ${audioDur.toFixed(3)} s ≈ ${expect.duration} s`);

fs.rmSync(W, { recursive: true, force: true });
console.log(`✔ concat: ${CHAPTERS} chapters → ${expect.frames} frames, audio drift ${(Math.abs(drift[drift.length - 1]) * 1000).toFixed(0)} ms (no accumulation)`);
