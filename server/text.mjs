// Script prompt/parsing, Arabic normalisation, and character-level LCS word alignment.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './settings.mjs';

export const WORDS_PER_SECOND = 2.6;
export const LENGTHS = [10, 20, 30, 45, 60];

export function scriptMessages(topic, seconds) {
  const style = fs.readFileSync(path.join(ROOT, 'references', 'script-style.md'), 'utf8');
  const target = Math.round(seconds * WORDS_PER_SECOND);
  return [
    { role: 'system', content: `[[TASK:SCRIPT]]\nYou are the head writer of a faceless Arabic science-explainer reel series. Follow this style guide exactly.\n\n${style}` },
    { role: 'user', content: `TOPIC: ${topic}\nLENGTH_SECONDS: ${seconds}\nTARGET_WORDS: ${target} (stay within ±10%; count only the SCRIPT words)\nReply in the exact TITLE / SCRIPT / SOURCES format. No other text.` },
  ];
}

/** Parses the LLM reply into { title, text, sources }. */
export function parseScript(reply) {
  const clean = String(reply).replace(/\r/g, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
  const sec = (name, nextNames) => {
    const re = new RegExp(`(?:^|\\n)\\s*${name}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${nextNames.join('|')})\\s*[:：]|$)`, 'i');
    return (clean.match(re) || [])[1]?.trim() || '';
  };
  const title = sec('TITLE', ['SCRIPT', 'SOURCES']).split('\n')[0].trim();
  let text = sec('SCRIPT', ['SOURCES', 'TITLE']);
  if (!text) {
    // Fallback: no markers — use the whole reply minus obvious headings.
    text = clean.split('\n').filter((l) => !/^\s*(TITLE|SOURCES)\s*[:：]/i.test(l)).join('\n');
  }
  text = text.split('\n')
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').replace(/\[[^\]]*\]|\((?:pause|music|sfx)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('\n');
  const sources = sec('SOURCES', ['TITLE', 'SCRIPT']).split('\n').map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, '').trim()).filter(Boolean);
  if (!text) throw new Error('Could not find a SCRIPT section in the LLM reply');
  return { title: title || text.split('\n')[0].slice(0, 60), text, sources };
}

const PUNCT_ONLY = /^[\p{P}\p{S}«»]+$/u;
/** Splits the script into display tokens: [{text, line}]. Lone punctuation sticks to the previous word. */
export function tokenize(text) {
  const out = [];
  String(text).split('\n').forEach((line, li) => {
    for (const tok of line.split(/\s+/).filter(Boolean)) {
      if (PUNCT_ONLY.test(tok) && out.length && out[out.length - 1].line === li) out[out.length - 1].text += tok;
      else out.push({ text: tok, line: li });
    }
  });
  return out;
}
export const countWords = (text) => tokenize(text).filter((t) => normWord(t.text)).length;

/** Normalises Arabic/Latin text for matching (keeps letters & digits only). */
export function normWord(s) {
  return String(s)
    .replace(/[ً-ٰٟـۖ-ۭ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** ElevenLabs characters → timed words [{text,start,end,chars:[{c,start,end}]}]. */
export function charsToWords(chars) {
  const words = [];
  let cur = null;
  for (const ch of chars) {
    if (/\s/.test(ch.c)) { cur = null; continue; }
    if (!cur) { cur = { text: '', start: ch.start, end: ch.end, chars: [] }; words.push(cur); }
    cur.text += ch.c; cur.end = ch.end; cur.chars.push(ch);
  }
  return words;
}

/** Deepgram-style words → same shape, with character times interpolated inside each word. */
export function wordsWithChars(words) {
  return words.map((w) => {
    const cs = [...String(w.text)];
    const d = Math.max(0.01, w.end - w.start) / Math.max(1, cs.length);
    return { ...w, chars: cs.map((c, i) => ({ c, start: w.start + i * d, end: w.start + (i + 1) * d })) };
  });
}

/**
 * Aligns timed words onto the script tokens with a character-level LCS over normalised text,
 * so captions keep the script's own spelling. Returns [{i,text,line,start,end,weak,match}].
 */
export function alignWords(tokens, timedWords) {
  // Flatten script chars
  const S = []; // {ch, w, k(index in word)}
  tokens.forEach((t, w) => { [...normWord(t.text)].forEach((ch, k) => S.push({ ch, w, k })); });
  const T = []; // {ch, start, end, tw}
  timedWords.forEach((tw, j) => {
    for (const c of tw.chars || wordsWithChars([tw])[0].chars) {
      const n = normWord(c.c);
      for (const ch of n) T.push({ ch, start: c.start, end: c.end, tw: j });
    }
  });
  const n = S.length, m = T.length;
  const match = new Int32Array(n).fill(-1);
  if (n && m) {
    if (n * m > 4e7) throw new Error(`Alignment too large (${n}×${m} chars)`);
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = S[i].ch === T[j].ch ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (S[i].ch === T[j].ch) { match[i] = j; i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
      else j++;
    }
  }
  // Per-word timing from matched chars
  const out = tokens.map((t, w) => ({ i: w, text: t.text, line: t.line, start: null, end: null, weak: false, match: 0 }));
  const perWord = tokens.map(() => []);
  S.forEach((s, idx) => { if (match[idx] >= 0) perWord[s.w].push({ k: s.k, t: T[match[idx]] }); });
  const avgChar = m ? Math.max(0.03, (T[m - 1].end - T[0].start) / m) : 0.08;
  tokens.forEach((t, w) => {
    const len = normWord(t.text).length;
    const pm = perWord[w];
    out[w].match = len ? pm.length / len : 0;
    if (!pm.length) return;
    const first = pm[0], last = pm[pm.length - 1];
    // Onset: if the word's first letters were not matched, step back by their estimated duration,
    // but never earlier than the start of the timed word that holds the first matched char.
    const twStart = timedWords[first.t.tw].start;
    out[w].start = Math.max(twStart, first.t.start - first.k * avgChar);
    out[w].end = Math.max(last.t.end, out[w].start + 0.05);
  });
  // Weak words + interpolation of unmatched ones
  const total = timedWords.length ? timedWords[timedWords.length - 1].end : tokens.length / WORDS_PER_SECOND;
  for (let w = 0; w < out.length; w++) {
    const len = normWord(out[w].text).length;
    out[w].weak = len > 0 && out[w].match < 0.6;
    if (out[w].start != null) continue;
    let a = w - 1; while (a >= 0 && out[a].start == null) a--;
    let b = w + 1; while (b < out.length && out[b].start == null) b++;
    const t0 = a >= 0 ? out[a].end : 0;
    const t1 = b < out.length ? out[b].start : total;
    const span = b - a - 1;
    const pos = w - a - 1;
    out[w].start = t0 + ((t1 - t0) * pos) / Math.max(1, span);
    out[w].end = t0 + ((t1 - t0) * (pos + 1)) / Math.max(1, span);
    out[w].weak = len > 0; // no evidence at all
  }
  // Monotonic onsets
  for (let w = 1; w < out.length; w++) {
    if (out[w].start < out[w - 1].start) out[w].start = out[w - 1].start;
    if (out[w].end < out[w].start + 0.05) out[w].end = out[w].start + 0.05;
  }
  for (const o of out) { o.start = +o.start.toFixed(3); o.end = +o.end.toFixed(3); o.match = +o.match.toFixed(2); }
  return out;
}
