// Word timing without speech-to-text: ffmpeg finds the pauses, the script's words share the speaking time in
// proportion to their letters (+1 for the gap), and each script line starts after a pause when the pause count
// allows it. Good enough for captions that light up near their word; the editor shows the result for checking.
import { run } from './render.mjs';
import { tokenize, normWord } from './text.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Speech intervals [[a,b],…] from ffmpeg silencedetect. */
export async function speechIntervals(file, { signal, noise = -32, minSilence = 0.16 } = {}) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noise}dB:d=${minSilence}`, '-f', 'null', '-'], { signal });
  const dur = Number((err.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0)) || 0;
  const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const speech = [];
  let cur = 0;
  starts.forEach((s, i) => { if (s - cur > 0.05) speech.push([cur, s]); cur = ends[i] ?? dur; });
  const total = dur || cur;
  if (total - cur > 0.05) speech.push([cur, total]);
  return { speech: speech.length ? speech : [[0, total]], duration: total };
}

/** Script words → [{text,start,end,confidence:0}] estimated on the audio. */
export async function estimateWords(script, file, opts = {}) {
  const tokens = tokenize(script).filter((t) => normWord(t.text));
  const { speech } = await speechIntervals(file, opts);
  const weight = tokens.map((t) => normWord(t.text).length + 1);
  const totalW = weight.reduce((a, b) => a + b, 0) || 1;
  const speechLen = speech.reduce((a, [x, y]) => a + (y - x), 0);
  // speech clock → real time (skips the pauses)
  const real = (c) => { let acc = 0; for (const [x, y] of speech) { if (c <= acc + (y - x)) return x + (c - acc); acc += y - x; } return speech[speech.length - 1][1]; };
  // snap each new script line to the start of the nearest speech interval when that keeps the order
  let clock = 0;
  const out = tokens.map((t, i) => {
    let start = clock;
    if (i > 0 && t.line !== tokens[i - 1].line) {
      let acc = 0, best = null;
      for (const [x, y] of speech) { if (Math.abs(acc - clock) < 0.6 && acc >= clock - 0.6) { best = acc; break; } acc += y - x; }
      if (best !== null && best > clock) start = best;
    }
    const len = (weight[i] / totalW) * speechLen;
    clock = start + len;
    return { text: t.text, start: +real(start).toFixed(3), end: +real(Math.min(speechLen, clock) - 0.02).toFixed(3), confidence: 0 };
  });
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
  return out;
}
