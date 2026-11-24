/* Word-level bidirectional ordering for caption layout (Unicode UAX #9, rules W2/W7/N1/N2/L2, at word granularity).
 *
 * Why words: captions are drawn one word at a time (each word lights up on its spoken onset), so the browser's own
 * bidi — which handles a whole string correctly — never sees the line. Glyph shaping inside each word is still done
 * by Chromium (HarfBuzz); only the order of the words on a line is decided here.
 *
 * Loaded by render.html (window.ReelBidi) and by the Node tests (vm).
 */
(function (root) {
  'use strict';
  // strong right-to-left: Hebrew, Arabic, Syriac, Thaana, NKo, Arabic Supplement/Extended, presentation forms
  const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
  const DIGIT = /[0-9٠-٩۰-۹]/;

  /** First strong character decides a word's class: R, L, EN (number) or N (neutral). */
  function classOf(word) {
    for (const ch of String(word)) {
      if (RTL.test(ch)) return 'R';
      if (LTR.test(ch)) return 'L';
    }
    return DIGIT.test(word) ? 'EN' : 'N';
  }

  /** Paragraph direction (rule P2/P3): the first strong word; Arabic-first product, so RTL when there is none. */
  function baseDir(words, fallback = 'rtl') {
    for (const w of words) { const c = classOf(w); if (c === 'R') return 'rtl'; if (c === 'L') return 'ltr'; }
    return fallback;
  }

  /** Resolved level class (R or L) per word. */
  function resolve(words, base) {
    const b = base === 'ltr' ? 'L' : 'R';
    const cls = words.map(classOf);
    // W2/W7: a number takes the direction of the last strong word before it (AN after Arabic, L after Latin)
    let prev = b;
    const res = cls.map((c) => { if (c === 'R' || c === 'L') { prev = c; return c; } return c === 'EN' ? prev : 'N'; });
    // N1/N2: neutrals between two words of the same direction take it; otherwise the paragraph direction
    for (let i = 0; i < res.length; i++) {
      if (res[i] !== 'N') continue;
      let j = i; while (j < res.length && res[j] === 'N') j++;
      const before = i > 0 ? res[i - 1] : b, after = j < res.length ? res[j] : b;
      const v = before === after ? before : b;
      for (let k = i; k < j; k++) res[k] = v;
      i = j - 1;
    }
    return res;
  }

  /**
   * Visual order of a line: indices of `words` in the order they are placed, starting at the paragraph's leading
   * edge (the right edge for RTL). Runs opposite to the paragraph direction are reversed (rule L2).
   */
  function visualOrder(words, base) {
    base = base || baseDir(words);
    const b = base === 'ltr' ? 'L' : 'R';
    const res = resolve(words, base);
    const out = [];
    for (let i = 0; i < res.length;) {
      let j = i; while (j < res.length && res[j] === res[i]) j++;
      const run = [];
      for (let k = i; k < j; k++) run.push(k);
      out.push(...(res[i] === b ? run : run.reverse()));
      i = j;
    }
    return out;
  }

  const api = { classOf, baseDir, resolve, visualOrder };
  root.ReelBidi = api;
})(typeof window !== 'undefined' ? window : globalThis);
