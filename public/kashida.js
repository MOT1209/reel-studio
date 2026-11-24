/* Kashida (tatweel, U+0640) justification for Arabic lines.
 * Arabic is justified by stretching letter connections, not by widening the gaps between words.
 * A tatweel may only go between two letters that actually join: after a dual-joining letter and before another
 * Arabic letter — never after ا د ذ ر ز و ة ى ء (they don't connect forward) and never inside لا (the ligature).
 * Preferred spots follow common typographic practice: the last connection of a word first, longer words first.
 * Loaded by render.html (window.ReelKashida) and by the Node tests (vm).
 */
(function (root) {
  'use strict';
  const TATWEEL = 'ـ';
  const LETTER = /[ؠ-ؿف-يٮ-ۓۺ-ۿ]/;
  const MARK = /[ً-ٰٟۖ-ۭ]/; // diacritics stay on their letter
  const NO_FORWARD = new Set([...'اأإآٱدذرزوؤةىءژڈڑ']); // right-joining only (or non-joining)
  const ALEFS = new Set([...'اأإآٱ']);

  /** Insertion points (index in the string, after the letter + its diacritics), best first. */
  function spots(word) {
    const ch = [...word];
    const out = [];
    for (let i = 0; i < ch.length; i++) {
      if (!LETTER.test(ch[i]) || NO_FORWARD.has(ch[i])) continue;
      let j = i + 1;
      while (j < ch.length && MARK.test(ch[j])) j++;
      if (j >= ch.length || !LETTER.test(ch[j])) continue;
      if (ch[i] === 'ل' && ALEFS.has(ch[j])) continue; // keep the lam-alef ligature
      out.push({ at: j, i });
    }
    // last connection first, then the others from the end
    return out.reverse();
  }

  function insert(word, counts) {
    const ch = [...word];
    let s = '';
    for (let k = 0; k < ch.length; k++) { s += ch[k]; if (counts[k + 1]) s += TATWEEL.repeat(counts[k + 1]); }
    return s;
  }

  /**
   * Stretches words (an array) so the line reaches `target` width without exceeding it.
   * measure(str) → width. Returns the new word strings. maxPerSpot limits the look (default 3).
   */
  function justifyWords(words, target, measure, { space = 0, maxPerSpot = 3 } = {}) {
    const cur = words.map((w) => ({ w, sp: spots(w), counts: {}, k: 0 }));
    const width = () => cur.reduce((a, x) => a + measure(insert(x.w, x.counts)), 0) + space * (words.length - 1);
    let wNow = width();
    if (wNow >= target) return words.slice();
    // round-robin over words (longest first), one tatweel at a time
    const order = cur.map((x, i) => i).filter((i) => cur[i].sp.length).sort((a, b) => cur[b].w.length - cur[a].w.length);
    if (!order.length) return words.slice();
    const totalSpots = order.reduce((a, i) => a + cur[i].sp.length, 0);
    let stuck = 0, r = 0;
    while (stuck < totalSpots) { // stop after every spot failed once in a row
      const x = cur[order[r++ % order.length]];
      const spot = x.sp[x.k++ % x.sp.length];
      if ((x.counts[spot.at] || 0) >= maxPerSpot) { stuck++; continue; }
      x.counts[spot.at] = (x.counts[spot.at] || 0) + 1;
      const w2 = width();
      if (w2 > target) { x.counts[spot.at]--; stuck++; continue; }
      stuck = 0; wNow = w2;
      if (target - wNow < 0.5) break;
    }
    return cur.map((x) => insert(x.w, x.counts));
  }

  root.ReelKashida = { TATWEEL, spots, justifyWords };
})(typeof window !== 'undefined' ? window : globalThis);
