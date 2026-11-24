// Source time ↔ output time. The narration is the source timeline; the export keeps [trim.start, trim.end] minus the
// cut ranges. Everything drawn uses source time (captions stay in sync by construction); the encoder, the audio mix,
// the subtitles and the progress bar use output time.

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

export const outDuration = (segs) => segs.reduce((s, [a, b]) => s + (b - a), 0);

/** Output time → source time (clamped to the last kept instant). */
export function outToSrc(tau, segs) {
  let acc = 0;
  for (const [a, b] of segs) { const len = b - a; if (tau < acc + len) return a + (tau - acc); acc += len; }
  const last = segs[segs.length - 1];
  return last ? last[1] : 0;
}

/** Source time → output time, or null when that instant was cut out / trimmed away. */
export function srcToOut(t, segs) {
  let acc = 0;
  for (const [a, b] of segs) { if (t >= a && t <= b) return acc + (t - a); acc += b - a; }
  return null;
}
