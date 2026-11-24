// Source time ↔ output time. The narration is the source timeline; the export is a list of segments in output order:
//   [a, b]     — a source range (picture + voice from a to b)
//   [t, t, d]  — a pause: frame t held for d seconds, silent voice (music and SFX still play)
// By default the list is [trim.start, trim.end] minus the cut ranges, in order. With edit.sequence the editor can
// reorder ranges and insert pauses. Everything drawn uses source time (captions stay in sync by construction); the
// encoder, the audio mix, the subtitles and the progress bar use output time.

export const isHold = (s) => s.length === 3;
export const segLen = (s) => (isHold(s) ? s[2] : s[1] - s[0]);

/** Normalised cut list: sorted, merged, clipped to [0, full], each ≥ 0.1 s. */
export function cleanCuts(cuts, full) {
  if (!Array.isArray(cuts)) return [];
  const list = cuts.slice(0, 50).map((c) => [Number(c?.start), Number(c?.end)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(full, Math.max(a, b))])
    .filter(([a, b]) => b - a >= 0.1).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of list) { const last = out[out.length - 1]; if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out.map(([a, b]) => ({ start: +a.toFixed(3), end: +b.toFixed(3) }));
}

/**
 * Custom order: [{start,end}] source ranges and [{hold, at}] pauses, in output order. Ranges must not overlap
 * (each source instant appears at most once, so subtitles and the progress bar stay unambiguous). Returns null
 * when the list is empty. Throws (status 400) on an invalid list.
 */
export function cleanSequence(seq, full) {
  if (seq === null || seq === undefined) return null;
  if (!Array.isArray(seq)) throw Object.assign(new Error('sequence must be a list'), { status: 400 });
  if (seq.length > 80) throw Object.assign(new Error('sequence: at most 80 items'), { status: 400 });
  const out = [];
  for (const it of seq) {
    if (it && it.hold !== undefined) {
      const d = Number(it.hold), at = Math.max(0, Math.min(full, Number(it.at) || 0));
      if (!(d >= 0.1 && d <= 10)) throw Object.assign(new Error('a pause lasts 0.1–10 s'), { status: 400 });
      out.push({ hold: +d.toFixed(3), at: +at.toFixed(3) });
    } else {
      const a = Math.max(0, Number(it?.start)), b = Math.min(full, Number(it?.end));
      if (!(Number.isFinite(a) && Number.isFinite(b) && b - a >= 0.1)) continue;
      out.push({ start: +a.toFixed(3), end: +b.toFixed(3) });
    }
  }
  const ranges = out.filter((x) => x.hold === undefined).sort((x, y) => x.start - y.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end - 1e-6) throw Object.assign(new Error('sequence: two parts use the same moment of the voice'), { status: 400 });
  if (!ranges.length) throw Object.assign(new Error('sequence needs at least one part of the voice'), { status: 400 });
  if (out.reduce((a, x) => a + (x.hold !== undefined ? x.hold : x.end - x.start), 0) < 0.5) throw Object.assign(new Error('the video would be shorter than half a second'), { status: 400 });
  return out;
}
export const sequenceToSegments = (seq) => seq.map((x) => (x.hold !== undefined ? [x.at, x.at, x.hold] : [x.start, x.end]));

/** Kept source segments [[a, b], …] for a trim window and cuts. */
export function keptSegments(start, end, cuts = []) {
  const segs = [];
  let cur = start;
  for (const c of cuts) {
    if (c.end <= cur || c.start >= end) continue;
    if (c.start > cur) segs.push([cur, Math.min(c.start, end)]);
    cur = Math.max(cur, c.end);
    if (cur >= end) break;
  }
  if (cur < end) segs.push([cur, end]);
  return segs.filter(([a, b]) => b - a > 1e-6);
}

export const outDuration = (segs) => segs.reduce((s, x) => s + segLen(x), 0);

/** Output time → source time (a pause returns its held frame; clamped to the last instant). */
export function outToSrc(tau, segs) {
  let acc = 0;
  for (const s of segs) { const len = segLen(s); if (tau < acc + len) return isHold(s) ? s[0] : s[0] + (tau - acc); acc += len; }
  const last = segs[segs.length - 1];
  return last ? (isHold(last) ? last[0] : last[1]) : 0;
}

/**
 * Source time → output time for a point event (word onset, scene change, tick), or null when that instant was
 * cut out / trimmed away. Ranges are half-open [a, b): an instant on a boundary belongs to the part that starts
 * there — so after an inserted pause it lands where the narration resumes. Only the very end of a part that no
 * other part continues maps to that part's end.
 */
export function srcToOut(t, segs) {
  let acc = 0, end = null;
  for (const s of segs) {
    if (!isHold(s)) { if (t >= s[0] && t < s[1]) return acc + (t - s[0]); if (t === s[1] && end === null) end = acc + (t - s[0]); }
    acc += segLen(s);
  }
  return end;
}
