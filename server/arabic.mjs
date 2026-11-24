// Arabic language engine: local analysis (normalisation, diacritics, digits, dialect detection, segmentation)
// and LLM-backed rewrites (correction, tashkeel, MSA ↔ Egyptian, simplification) that are always returned as a
// proposal with a word diff — nothing is applied to a script without the user's approval.
import { chatStream } from './apis.mjs';
import { getSettings } from './settings.mjs';
import { normWord, tokenize } from './text.mjs';

// ---- local ---------------------------------------------------------------------------------
const TASHKEEL = /[ً-ْٰٓ-ٕ]/g; // fathatan…sukun, superscript alef, maddah/hamza marks
export const stripTashkeel = (s) => String(s).replace(TASHKEEL, '');
export const hasTashkeel = (s) => /[ً-ْ]/.test(s);
export const toArabicDigits = (s) => String(s).replace(/[0-9]/g, (d) => String.fromCharCode(0x660 + Number(d)));
export const toLatinDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

// Distinctive function words per variety (normalised before matching). Words shared by most dialects
// (مش، ليه، عشان، يعني، اللي، بس، كمان) only count as "colloquial", not as evidence for one dialect.
const MARKERS = {
  egyptian: ['ده', 'دي', 'دول', 'إزاي', 'ازاي', 'فين', 'امتى', 'إمتى', 'دلوقتي', 'كده', 'كدا', 'أوي', 'اوي', 'بتاع', 'بتاعة', 'عايز', 'عاوز', 'برضه', 'برضو', 'لسه', 'إيه', 'ايه', 'خالص', 'إمبارح', 'النهارده', 'ازيك'],
  levantine: ['شو', 'هلق', 'هلأ', 'هلا', 'كتير', 'منيح', 'بدي', 'بدك', 'بدو', 'هيك', 'ليش', 'وين', 'لسا', 'هون', 'هونيك', 'هاد', 'هاي', 'هدول', 'كيفك', 'شي', 'مبارح', 'منشان', 'كرمال'],
  gulf: ['شلون', 'وايد', 'زين', 'الحين', 'ابي', 'أبي', 'يبي', 'تبي', 'وش', 'ايش', 'إيش', 'هذي', 'ترى', 'حق', 'يالله', 'چذي', 'جذي', 'شفيك', 'اشلون', 'عيل'],
  maghrebi: ['بزاف', 'واش', 'ديال', 'دابا', 'كيفاش', 'علاش', 'مزيان', 'بغيت', 'كاين', 'ماشي', 'هادشي', 'غادي', 'راه', 'ياك', 'شحال', 'فاش', 'بلي', 'هكا'],
  msa: ['هذا', 'هذه', 'هؤلاء', 'لماذا', 'كيف', 'ليس', 'ليست', 'سوف', 'الذي', 'التي', 'الذين', 'إن', 'إنه', 'إنها', 'لقد', 'قد', 'أيضا', 'أيضًا', 'حيث', 'لكن', 'متى', 'أين', 'ماذا', 'الآن', 'جدا', 'جدًا', 'يجب', 'لأن', 'ذلك', 'تلك'],
};
const SHARED = ['مش', 'ليه', 'عشان', 'علشان', 'يعني', 'اللي', 'بس', 'كمان', 'هو', 'زي', 'بقى', 'مو', 'مب'];
const SETS = Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, new Set(v.map(normWord))]));
const SHARED_N = new Set(SHARED.map(normWord));
export const DIALECT_AR = { egyptian: 'عامية مصرية', levantine: 'شامي', gulf: 'خليجي', maghrebi: 'مغاربي', msa: 'فصحى', mixed: 'مختلط', colloquial: 'عامية (مش محددة)', unknown: 'مش واضح' };

/**
 * Dialect estimate from distinctive marker words, the "b-" present-tense prefix (Egyptian/Levantine: بيعمل، بتروح)
 * and the Maghrebi "ka-/ki-" prefix (كيدير). Returns the best guess plus every score — a heuristic, not a classifier.
 */
export function detectDialect(text) {
  const toks = tokenize(text).map((t) => normWord(t.text)).filter(Boolean);
  const sc = { egyptian: 0, levantine: 0, gulf: 0, maghrebi: 0, msa: 0 };
  let colloquial = 0;
  for (const t of toks) {
    for (const [k, set] of Object.entries(SETS)) if (set.has(t)) sc[k]++;
    if (SHARED_N.has(t)) colloquial++;
    if (/^(ب|هي|هت|هن|رح|ح)(ي|ت|ن)[ء-ي]{2,}/.test(t) && !/^(بين|بيت|بيئ|حين|حيث|حتي)/.test(t)) colloquial += 0.5;
    if (/^ك(ي|ن|ت)[ء-ي]{3,}/.test(t) && !/^(كيف|كيم|كتب|كتاب|كنت|كثير)/.test(t)) sc.maghrebi += 0.5;
  }
  const ranked = Object.entries(sc).sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0], second = ranked[1][1];
  const total = ranked.reduce((a, [, v]) => a + v, 0) + colloquial;
  let dialect;
  if (total < 1) dialect = 'unknown';
  else if (top === 0) dialect = 'colloquial';
  else if (second > 0 && top < second * 1.3) dialect = 'mixed';
  else if (best === 'msa' && colloquial > top) dialect = 'mixed';
  else dialect = best;
  return { dialect, label: DIALECT_AR[dialect], scores: sc, colloquial, egyptian: sc.egyptian, msa: sc.msa, words: toks.length, latinTerms: tokenize(text).filter((t) => /[A-Za-z]/.test(t.text)).length };
}

/** Splits a script into sentences (keeps the script's own lines; long lines are split on sentence punctuation). */
export function sentences(text) {
  return String(text).split('\n').flatMap((l) => l.split(/(?<=[.!؟?…])\s+/)).map((x) => x.trim()).filter(Boolean);
}

/** Word diff (LCS on normalised words, diacritics ignored for equality). */
export function wordDiff(a, b) {
  const A = String(a).split(/\s+/).filter(Boolean), B = String(b).split(/\s+/).filter(Boolean);
  const key = (w) => normWord(stripTashkeel(w)) || w;
  const n = A.length, m = B.length;
  if (n * m > 4e6) return [{ op: 'del', text: A.join(' ') }, { op: 'ins', text: B.join(' ') }];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(A[i]) === key(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (op, text) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += ' ' + text; else out.push({ op, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(A[i]) === key(B[j])) { push(A[i] === B[j] ? 'eq' : 'mod', B[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out;
}

// ---- LLM rewrites ------------------------------------------------------------------------------
const KEEP = `Keep the line breaks exactly (one caption sentence per line). Keep English science terms in English. Do not add facts, do not remove facts, do not add any commentary. Reply with the rewritten text only.`;
export const OPS = {
  correct: { label: 'تصحيح إملائي ونحوي', prompt: `Correct spelling, hamza, taa marbuta / haa, alef maqsura, punctuation and grammar mistakes in this Arabic text. Keep its dialect (if it is colloquial — Egyptian, Levantine, Gulf or Maghrebi — keep it colloquial; do NOT convert it to MSA). Change as little as possible. ${KEEP}` },
  tashkeel: { label: 'تشكيل', prompt: `Add full, correct Arabic diacritics (tashkeel) to every Arabic word, according to its meaning and grammatical role in context. Do not change any letter or word. ${KEEP}` },
  msa: { label: 'تحويل للفصحى', prompt: `Rewrite this text in clear, correct Modern Standard Arabic (فصحى) suitable for an educational video narration. Keep the meaning, the tone and roughly the same length. ${KEEP}` },
  egyptian: { label: 'تحويل للعامية المصرية', prompt: `Rewrite this text in natural Egyptian colloquial Arabic (العامية المصرية) as a friendly narrator would say it. Keep the meaning and roughly the same length. ${KEEP}` },
  levantine: { label: 'تحويل للشامي', prompt: `Rewrite this text in natural Levantine Arabic (الشامي — Syrian/Lebanese/Palestinian/Jordanian everyday speech) as a friendly narrator would say it. Keep the meaning and roughly the same length. ${KEEP}` },
  gulf: { label: 'تحويل للخليجي', prompt: `Rewrite this text in natural Gulf Arabic (الخليجي — Saudi/Emirati/Kuwaiti everyday speech) as a friendly narrator would say it. Keep the meaning and roughly the same length. ${KEEP}` },
  simplify: { label: 'تبسيط', prompt: `Simplify this Arabic text for a general audience: shorter sentences, everyday words, the same facts. Keep the same dialect. ${KEEP}` },
};

/**
 * Runs one rewrite and validates the output. Returns { op, text, diff, warnings[], model }.
 * Validation: non-empty; length within 0.5×–2× of the input; for "tashkeel" the letters must be unchanged.
 */
export async function rewrite(op, text, { signal, settings = getSettings() } = {}) {
  const spec = OPS[op];
  if (!spec) throw Object.assign(new Error(`unknown Arabic operation "${op}"`), { status: 400 });
  const input = String(text || '').trim();
  if (!input) throw Object.assign(new Error('النص فاضي'), { status: 400 });
  if (input.length > 8000) throw Object.assign(new Error('النص أطول من 8000 حرف'), { status: 413 });
  const { text: out, model } = await chatStream(settings, [
    { role: 'system', content: `[[TASK:ARABIC:${op}]]\nYou are an expert Arabic editor and linguist. ${spec.prompt}` },
    { role: 'user', content: input },
  ], { signal, temperature: op === 'tashkeel' || op === 'correct' ? 0.1 : 0.4, maxTokens: 4096 });
  const result = String(out).replace(/^```\w*\n?|```$/g, '').trim();
  const warnings = [];
  if (!result) throw new Error('الـ LLM رجّع نص فاضي');
  const ratio = result.length / input.length;
  if (ratio < 0.5 || ratio > 2.2) warnings.push(`طول النص اتغيّر كتير (${Math.round(ratio * 100)}%) — راجعه كويس`);
  if (op === 'tashkeel' && normWord(stripTashkeel(result)) !== normWord(stripTashkeel(input))) warnings.push('التشكيل غيّر حروف في الكلام — راجع الاختلافات');
  if (result.split('\n').length !== input.split('\n').length) warnings.push('عدد السطور اتغيّر — كل سطر = جملة كابشن');
  return { op, label: spec.label, text: result, diff: wordDiff(input, result), warnings, model };
}
