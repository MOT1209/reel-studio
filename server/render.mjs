// Compatibility facade: the render code now lives in proc.mjs (processes), engines/ffmpeg.mjs (media) and
// engines/*.mjs (frame engines, picked by engines/manager.mjs). Existing imports keep working through this file.
import path from 'node:path';
import { encodeSegmented } from './engines/ffmpeg.mjs';
import { legacyEngine } from './engines/legacy.mjs';
import { outToSrc } from './timeline.mjs';

export { run, probeDuration, checkFfmpeg, FFMPEG, FFPROBE, trackChild, killAllChildren, activeProcessCount } from './proc.mjs';
export { writeSfx, mixAudio, muxFinal, concatAudio, concatVideos, contactSheet, QUALITY, CODECS, validateOutput, verifyVideo, countFrames, encodeSegmented } from './engines/ffmpeg.mjs';
export { launchBrowser, workerCount, parseWorkers, MAX_WORKERS } from './engines/legacy.mjs';

export const FPS = 30;
export const W = 1080, H = 1920;

/** Legacy entry point: render a render.html URL with the legacy engine (used by tools and older callers). */
export async function renderFrames({ url, out, duration, start = 0, segments = null, fps = FPS, width = W, height = H, quality = 'standard', segDir, key = '', signal, log = () => {}, onFrame = () => {} }) {
  const total = Math.ceil(duration * fps - 1e-9);
  const engine = { ...legacyEngine, prepare: (ctx) => legacyEngine.prepare(Object.assign(ctx, { url, timeOf: segments ? (i) => outToSrc(i / fps, segments) : (i) => start + i / fps })) };
  return encodeSegmented({ engine, total, fps, width, height, quality, segDir: segDir || path.join(path.dirname(out), 'segments'), key, out, signal, log, onFrame });
}
