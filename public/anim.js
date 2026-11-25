/* Animation + snapping helpers shared by the renderer (render.html) and the editor, and tested in Node.
 *  - sample(o, rel): position / scale / opacity / rotation of an overlay at `rel` seconds after its start,
 *    from its base values and optional keyframes [{t, x, y, scale, opacity, rot, ease}].
 *    Each property is interpolated only between the keyframes that define it; before the first keyframe the first
 *    value holds, after the last the last value holds. Pure and deterministic (no Date/Math.random).
 *  - snapTime(t, points, threshold): the nearest snap point within the threshold, or null.
 */
(function (root) {
  'use strict';
  const EASE = {
    linear: (x) => x,
    in: (x) => x * x,
    out: (x) => 1 - (1 - x) * (1 - x),
    inOut: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
    hold: () => 0, // stays at the earlier value until the next keyframe
  };
  const PROPS = ['x', 'y', 'scale', 'opacity', 'rot'];

  function sample(o, rel) {
    const base = { x: Number(o.x) || 0, y: Number(o.y) || 0, scale: o.scale ?? 1, opacity: o.opacity ?? 1, rot: Number(o.rot) || 0 };
    const kfs = Array.isArray(o.keyframes) ? o.keyframes : [];
    if (!kfs.length) return base;
    const out = { ...base };
    for (const p of PROPS) {
      const pts = kfs.filter((k) => k && Number.isFinite(k[p]) && Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
      if (!pts.length) continue;
      if (rel <= pts[0].t) { out[p] = pts[0][p]; continue; }
      const last = pts[pts.length - 1];
      if (rel >= last.t) { out[p] = last[p]; continue; }
      let i = 0; while (i + 1 < pts.length && pts[i + 1].t <= rel) i++;
      const a = pts[i], b = pts[i + 1];
      const f = (EASE[a.ease] || EASE.linear)((rel - a.t) / Math.max(1e-6, b.t - a.t));
      out[p] = a[p] + (b[p] - a[p]) * f;
    }
    return out;
  }

  /** Nearest point within `threshold` seconds (ties → the earlier point), or null. */
  function snapTime(t, points, threshold) {
    let best = null, bd = threshold;
    for (const p of points) { const d = Math.abs(p - t); if (d < bd || (d === bd && best !== null && p < best)) { bd = d; best = p; } }
    return best;
  }

  /** Snap an interval: tries the start and the end edge, returns the shift that aligns the closest one (0 = no snap). */
  function snapShift(start, end, points, threshold) {
    const a = snapTime(start, points, threshold), b = snapTime(end, points, threshold);
    const da = a === null ? Infinity : Math.abs(a - start), db = b === null ? Infinity : Math.abs(b - end);
    if (da === Infinity && db === Infinity) return null; // no edge in reach (0 would mean "already exactly on one")
    return da <= db ? a - start : b - end;
  }

  root.ReelAnim = { sample, snapTime, snapShift, EASE: Object.keys(EASE) };
})(typeof window !== 'undefined' ? window : globalThis);
