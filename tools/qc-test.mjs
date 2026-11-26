// Post-join QC test (needs ffmpeg): node tools/qc-test.mjs
// Builds real chapter files, joins them with concatVideos, and proves checkChapterJoin (a) passes a good join,
// (b) fails when the audio is delayed (the accumulating-sync class of bug), (c) fails when chapters differ in
// loudness, and (d) fails when the frame count does not match the plan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { concatVideos } from '../server/engines/ffmpeg.mjs';
import { checkChapterJoin } from '../server/chapter-qc.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-qc-'));
const FPS = 24;
const SECONDS = 2;
let passed = 0;
const ok = (name, detail = '') => { passed++; console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`); };

try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); }
catch { console.error('qc-test needs ffmpeg (set FFMPEG_PATH)'); process.exit(1); }

/** One chapter: black video + bursts of a tone (an envelope the correlation can lock onto). */
function chapter(file, amp = 0.6, freq = 800) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const expr = `${amp}*sin(2*PI*${freq}*t)*if(lt(mod(t,0.5),0.15),1,0)`;
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=${FPS}:d=${SECONDS}`,
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', file,
  ]);
  return file;
}

const files = [1, 2, 3].map((i) => chapter(path.join(W, `ch-0${i}`, 'video.mp4')));
const frames = SECONDS * FPS;
const totalFrames = frames * files.length;
const duration = SECONDS * files.length;
const joined = path.join(W, 'joined.mp4');
await concatVideos({ files, out: joined, expect: { width: 320, height: 240, fps: FPS, frames: totalFrames, duration, codec: 'h264' } });

// (a) a good join passes and reports its measurements
const stats = await checkChapterJoin({ files, joined, fps: FPS, frames: totalFrames, duration });
assert.equal(stats.frames, totalFrames);
assert.ok(stats.maxLagMs <= 60, `max lag ${stats.maxLagMs} ms`);
assert.ok(stats.loudnessSpreadLu <= 1.5, `loudness spread ${stats.loudnessSpreadLu} LU`);
ok('a clean join passes', `${stats.frames} frames · sync ${stats.maxLagMs} ms · loudness spread ${stats.loudnessSpreadLu} LU`);

// (b) audio delayed by 120 ms must fail with a sync message
const late = path.join(W, 'late.mp4');
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', joined, '-c:v', 'copy', '-af', 'adelay=120|120', '-c:a', 'aac', late]);
await assert.rejects(
  () => checkChapterJoin({ files, joined: late, fps: FPS, frames: totalFrames, duration }),
  /chapter QC failed.*(sync|audio is)/s,
  'a delayed join is rejected',
);
ok('a 120 ms audio delay is rejected with a sync error');

// (c) a chapter that is ~20 LU quieter must fail with a loudness message
const quiet = [chapter(path.join(W, 'q1', 'video.mp4'), 0.6), chapter(path.join(W, 'q2', 'video.mp4'), 0.06)];
const qJoined = path.join(W, 'quiet.mp4');
await concatVideos({ files: quiet, out: qJoined, expect: { width: 320, height: 240, fps: FPS, frames: frames * 2, duration: SECONDS * 2, codec: 'h264' } });
await assert.rejects(
  () => checkChapterJoin({ files: quiet, joined: qJoined, fps: FPS, frames: frames * 2, duration: SECONDS * 2 }),
  /chapter QC failed.*loudness spread/s,
  'a loudness jump between chapters is rejected',
);
ok('a loudness spread between chapters is rejected');

// (d) a frame-count mismatch must fail before anything else
await assert.rejects(
  () => checkChapterJoin({ files, joined, fps: FPS, frames: totalFrames + 1, duration }),
  /chapter QC failed.*frames/s,
  'a wrong frame count is rejected',
);
ok('a wrong frame count is rejected');

fs.rmSync(W, { recursive: true, force: true });
console.log(`\n${passed}/${passed} checks passed`);
