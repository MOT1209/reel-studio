// Subtitle cues from the aligned words, and SRT / WebVTT export.
import { isHold, segLen } from './timeline.mjs';
// Cues follow the same rules as the burned-in captions (≤ 6 words, break on a new script line or a sentence end,
// ≤ 42 characters) so the exported file matches what the video shows.

const RLM = '‏'; // keeps leading/trailing punctuation on the right side in players without full bidi support
const isArabic = (s) => /[؀-ۿ]/.test(s);

/** words: [{text,start,end,line}] → cues [{start,end,text}] (times in seconds, relative to `offset`). */
export function buildCues(words, { maxWords = 6, maxChars = 42, offset = 0, end: clipEnd = Infinity, digits = 'latin', segments = null } = {}) {
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  words.forEach((w, i) => {
    if (cur.length && words[cur[cur.length - 1]].line !== w.line) flush();
    const len = cur.reduce((a, k) => a + words[k].text.length + 1, 0) + w.text.length;
    if (cur.length && len > maxChars) flush();
    cur.push(i);
    if (cur.length >= maxWords || (cur.length >= 3 && /[.!؟?…،,:]$/.test(w.text))) flush();
  });
  flush();
  const cues = chunks.map((idx, k) => {
    const start = words[idx[0]].start;
    const nextStart = k + 1 < chunks.length ? words[chunks[k + 1][0]].start : Infinity;
    const end = Math.min(words[idx[idx.length - 1]].end + 0.4, nextStart);
    let text = idx.map((i) => words[i].text).join(' ');
    if (digits === 'arabic') text = toArabicDigits(text);
    return { start: start - offset, end: Math.min(end, clipEnd) - offset, text, src: [start, end], idx };
  });
  if (segments) return mapCues(cues, segments, words, digits);
  return cues.filter((c) => c.end > 0 && c.start < clipEnd - offset).map(({ src, ...c }) => ({ ...c, start: Math.max(0, c.start) }));
}

/** Cues in source time → output time: a cue split by a cut keeps its parts that survive; fully cut cues are dropped. */
function mapCues(cues, segs, words, digits) {
  const out = [];
  for (const c of cues) {
    const [a, b] = c.src;
    let offset = 0; // output time where the current part starts
    for (const sg of segs) {
      const base = offset;
      offset += segLen(sg);
      if (isHold(sg)) continue;
      const [s0, s1] = sg;
      const x = Math.max(a, s0), y = Math.min(b, s1);
      if (y - x < 0.08) continue;
      // only the words actually spoken inside this kept part (a word counts where most of it is)
      const kept = c.idx.filter((i) => { const m = (words[i].start + Math.min(words[i].end, b)) / 2; return m >= s0 && m < s1; });
      if (!kept.length) continue;
      let text = kept.map((i) => words[i].text).join(' ');
      if (digits === 'arabic') text = toArabicDigits(text);
      out.push({ start: +(base + (x - s0)).toFixed(3), end: +(base + (y - s0)).toFixed(3), text });
    }
  }
  return out.sort((p, q) => p.start - q.start); // reordered parts come out in output order
}

export function toArabicDigits(s) { return String(s).replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d))); }

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
const line = (text) => (isArabic(text) ? RLM + text + RLM : text);

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${line(c.text)}\n`).join('\n');
}
export function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}${isArabic(c.text) ? ' align:center' : ''}\n${line(c.text)}\n`).join('\n');
}
