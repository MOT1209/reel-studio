// Long-form production (2–30 minutes): pure functions for chapter planning, chapter writing, splitting narration for
// TTS, mapping chapters onto timed words, storyboard windows and YouTube chapter timestamps.
// Everything here is deterministic and offline; the pipeline calls the LLM / TTS with what these functions build.
import crypto from 'node:crypto';
import { researchBlock, parseScript, tokenize, countWords, WORDS_PER_SECOND } from './text.mjs';
import { profileOf, LONGFORM_MIN_SEC, MAX_SECONDS } from './profiles.mjs';

export const MAX_CHAPTERS = 15;
export const isLongform = (p) => typeof p?.seconds === 'number' && p.seconds >= LONGFORM_MIN_SEC;

const DIALECT_NAME = {
  egyptian: 'natural Egyptian colloquial Arabic (عامية مصرية)', msa: 'clear Modern Standard Arabic (الفصحى المبسطة)',
  levantine: 'natural Levantine Arabic (الشامي)', gulf: 'natural Gulf Arabic (الخليجي)',
};

/** How many chapters a video of `seconds` gets for a profile (≈ one per chapterSeconds, 2…15). */
export function chapterCount(seconds, profileId) {
  return Math.max(2, Math.min(MAX_CHAPTERS, Math.round(seconds / profileOf(profileId).chapterSeconds)));
}

const RULES = (dialect) => `Language: write the narration in ${DIALECT_NAME[dialect] || DIALECT_NAME.egyptian}.
- Keep scientific/technical loanwords in English letters (DNA, oxygen, neurons), never transliterated.
- Numbers as digits. Round honestly («حوالي»). Never invent numbers, studies, quotes or sources.
- Short lines (4–12 words), one idea per line, one line per caption. No emojis, hashtags, stage directions, brackets or speaker labels.`;

export function outlineMessages({ topic, seconds, profile, dialect, research, count }) {
  const pr = profileOf(profile);
  return [
    { role: 'system', content: `[[TASK:OUTLINE]]
You are the head writer planning a ${Math.round(seconds / 60)}-minute ${pr.en} video in Arabic.
${pr.writer}
Plan EXACTLY ${count} chapters that together tell one coherent piece from opening to conclusion. Chapter 1 opens with a strong hook; the last chapter concludes.
Return ONLY JSON, no prose, no code fences:
{"title":"<Arabic video title ≤ 9 words>","chapters":[{"title":"<Arabic chapter title ≤ 6 words>","goal":"<English: what this chapter covers, 1–2 sentences>","seconds":<planned seconds>}],"sources":["<real, checkable reference you are confident exists>"]}
Rules: the chapter seconds add up to about ${seconds}. 0–5 sources; an empty list is better than an invented one.` },
    { role: 'user', content: `TOPIC: ${topic}\nTOTAL_SECONDS: ${seconds}\nCHAPTERS: ${count}${researchBlock(research)}` },
  ];
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const newChapterId = () => 'ch-' + crypto.randomBytes(4).toString('hex');

/**
 * LLM outline JSON → { title, sources, chapters:[{id,title,goal,seconds,text:'',status:'pending',approved:false}] }.
 * Repairs: missing/extra chapters (padded / trimmed to `count`), planned seconds rescaled so they add up to `seconds`.
 */
export function parseOutline(raw, { seconds, count, topic = '' }) {
  const fixes = [];
  let chapters = (Array.isArray(raw?.chapters) ? raw.chapters : []).filter((c) => c && typeof c === 'object')
    .map((c, k) => ({ title: clean(c.title, 60) || `الفصل ${k + 1}`, goal: clean(c.goal, 400), seconds: Number(c.seconds) > 0 ? Number(c.seconds) : 0 }));
  if (chapters.length > count) { fixes.push(`${chapters.length} chapters → ${count}`); chapters = chapters.slice(0, count); }
  while (chapters.length < count) { fixes.push(`chapter ${chapters.length + 1} missing → added`); chapters.push({ title: `الفصل ${chapters.length + 1}`, goal: `Continue the topic "${topic}".`, seconds: 0 }); }
  const planned = chapters.reduce((a, c) => a + c.seconds, 0);
  if (!chapters.every((c) => c.seconds > 0) || Math.abs(planned - seconds) > seconds * 0.1) {
    if (planned > 0 && chapters.every((c) => c.seconds > 0)) chapters.forEach((c) => { c.seconds = (c.seconds * seconds) / planned; });
    else chapters.forEach((c) => { c.seconds = seconds / chapters.length; });
    fixes.push('chapter durations rescaled to the video length');
  }
  // every chapter at least 20 s; rounding keeps the total
  chapters.forEach((c) => { c.seconds = Math.max(20, Math.round(c.seconds)); });
  return {
    title: clean(raw?.title, 90) || clean(topic, 90),
    sources: (Array.isArray(raw?.sources) ? raw.sources : []).map((s) => clean(String(s ?? ''), 200)).filter(Boolean).slice(0, 8),
    chapters: chapters.map((c) => ({ id: newChapterId(), ...c, text: '', words: 0, status: 'pending', approved: false, edited: false })),
    fixes,
  };
}

/** Writes ONE chapter: the outline for context, the end of the previous chapter for continuity, an optional hint. */
export function chapterMessages({ topic, title, chapters, k, profile, dialect, research, hint = '' }) {
  const pr = profileOf(profile);
  const ch = chapters[k];
  const target = Math.round(ch.seconds * WORDS_PER_SECOND);
  const prev = chapters[k - 1]?.text ? chapters[k - 1].text.split('\n').slice(-3).join('\n') : '';
  const outline = chapters.map((c, i) => `${i + 1}. ${c.title} — ${c.goal || ''}${i === k ? '   ← WRITE THIS ONE' : ''}`).join('\n');
  return [
    { role: 'system', content: `[[TASK:CHAPTER]]
You are the head writer of a ${pr.en} video in Arabic. You write ONE chapter of the narration at a time.
${pr.writer}
${RULES(dialect)}
${k === 0 ? 'This is the FIRST chapter: open with a hook that makes the viewer stay.' : 'Continue seamlessly from the previous chapter — do not greet the viewer again or repeat the title.'}
${k === chapters.length - 1 ? 'This is the LAST chapter: bring everything together and conclude.' : 'Do not conclude the whole video; end on a line that leads into the next chapter.'}
Reply in exactly this format, nothing else:
SCRIPT:
<narration lines>` },
    { role: 'user', content: `VIDEO: ${title}\nTOPIC: ${topic}\nOUTLINE:\n${outline}\n\nCHAPTER ${k + 1}: ${ch.title}\nGOAL: ${ch.goal || ''}\nTARGET_WORDS: ${target} (stay within ±15%)${prev ? `\nPREVIOUS CHAPTER ENDED WITH:\n${prev}` : ''}${hint ? `\nEDITOR NOTE: ${hint}` : ''}${researchBlock(research)}` },
  ];
}

/** Chapter reply → cleaned narration text (same cleaning as a full script). */
export function parseChapter(reply) {
  const { text } = parseScript(/SCRIPT\s*[:：]/i.test(reply) ? reply : `SCRIPT:\n${reply}`);
  return text;
}

/** The full narration: chapters in order, separated by line breaks (so every chapter starts on its own caption line). */
export const joinChapters = (chapters) => chapters.map((c) => c.text.trim()).filter(Boolean).join('\n');

/** Word-index range of each chapter in tokenize(joinChapters(chapters)). Lines never span chapters, so counts add up. */
export function chapterRanges(chapters) {
  let w = 0;
  return chapters.filter((c) => c.text.trim()).map((c) => { const n = tokenize(c.text.trim()).length; const r = { id: c.id, title: c.title, w0: w, w1: w + n }; w += n; return r; });
}

/** Refreshes derived fields after a chapter changed. */
export function touchChapter(c) { c.text = String(c.text || '').trim(); c.words = countWords(c.text); return c; }

/**
 * Splits narration into TTS requests of at most maxChars, at line boundaries (a line longer than that is split at
 * sentence ends, then spaces). Joining the parts with '\n' gives back the input exactly when it was cut at line breaks.
 * Returns [{ text, sep }] where sep is the separator that followed the part in the original ('\n' or ' ').
 */
export function splitForTts(text, maxChars = 4500) {
  const out = [];
  let cur = '';
  const push = (s, sep) => { out.push({ text: s, sep }); };
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + 1 + line.length > maxChars) { push(cur, '\n'); cur = ''; }
    if (line.length <= maxChars) { cur = cur ? `${cur}\n${line}` : line; continue; }
    // one very long line: sentence ends, then words
    const pieces = line.match(/[^.!؟?…]+[.!؟?…]*\s*/g) || [line];
    for (let piece of pieces) {
      piece = piece.trimEnd();
      while (piece.length > maxChars) { const cut = piece.lastIndexOf(' ', maxChars) > 0 ? piece.lastIndexOf(' ', maxChars) : maxChars; if (cur) { push(cur, ' '); cur = ''; } push(piece.slice(0, cut), ' '); piece = piece.slice(cut).trimStart(); }
      if (cur && cur.length + 1 + piece.length > maxChars) { push(cur, ' '); cur = ''; }
      cur = cur ? `${cur} ${piece}` : piece;
    }
    // the line ended: whatever is pending continues on the next line
  }
  if (cur) push(cur, '');
  if (out.length) out[out.length - 1].sep = '';
  return out.filter((x) => x.text.trim());
}

/**
 * Storyboard windows for long-form: each chapter is cut into windows of ≈ windowSec at word boundaries, so one LLM call
 * never designs more than ~16 scenes (keeps the reply inside the token limit). Returns [{chapter, k, w0, w1, start, end, key}].
 */
export function storyboardWindows(ranges, words, { windowSec = 120 } = {}) {
  const out = [];
  for (const r of ranges) {
    if (r.w1 <= r.w0) continue;
    const t0 = words[r.w0].start, t1 = words[r.w1 - 1].end;
    const n = Math.max(1, Math.round((t1 - t0) / windowSec));
    let a = r.w0;
    for (let k = 0; k < n; k++) {
      const limit = t0 + ((t1 - t0) * (k + 1)) / n;
      let b = k === n - 1 ? r.w1 : a + 1;
      while (k < n - 1 && b < r.w1 - 1 && words[b].start < limit) b++;
      if (b <= a) continue;
      const key = crypto.createHash('sha256').update(JSON.stringify(words.slice(a, b).map((w) => [w.text, w.start]))).digest('hex').slice(0, 16);
      out.push({ chapter: r.id, title: r.title, k: out.length, w0: a, w1: b, start: words[a].start, end: words[b - 1].end, key });
      a = b;
    }
  }
  return out;
}

/**
 * Merges per-window storyboard drafts into one raw storyboard: scenes outside their window are dropped, and every
 * chapter starts with a scene on its first word (so chapter boundaries are scene boundaries). The result still goes
 * through repairStoryboard + the scene schema like any storyboard.
 */
export function mergeWindowDrafts(windows, drafts) {
  const scenes = [], accents = [];
  const chapterStart = new Set();
  windows.forEach((w, k) => {
    const d = drafts[k] || {};
    const own = (Array.isArray(d.scenes) ? d.scenes : []).filter((s) => s && typeof s === 'object' && Number.isFinite(Number(s.at)))
      .map((s) => ({ ...s, at: Math.round(Number(s.at)) })).filter((s) => s.at >= w.w0 && s.at < w.w1).sort((a, b) => a.at - b.at);
    const first = !chapterStart.has(w.chapter);
    if (first) {
      chapterStart.add(w.chapter);
      if (own.length) own[0].at = w.w0;
      else own.push({ type: 'concept', template: 'type', at: w.w0, title: w.title, items: [] });
      if (!own[0].title) own[0].title = w.title;
    } else if (!own.length) own.push({ type: 'concept', template: 'cards', at: w.w0, title: w.title, items: [] });
    scenes.push(...own);
    for (const a of Array.isArray(d.accents) ? d.accents : []) {
      const i = Array.isArray(a) ? Number(a[0]) : Number(a?.at);
      if (i >= w.w0 && i < w.w1) accents.push(a);
    }
  });
  return { scenes, accents };
}

/** Chapter start times on the finished narration (source seconds). */
export function chapterMarks(ranges, words) {
  return ranges.filter((r) => r.w1 > r.w0 && words[r.w0]).map((r) => ({ id: r.id, title: r.title, start: r.w0 === 0 ? 0 : words[r.w0].start }));
}

const ts = (t) => { t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`; };
/**
 * YouTube chapter list ("0:00 Title" lines). YouTube only shows chapters when the first is at 0:00, there are at least 3,
 * and each lasts at least 10 s — otherwise this returns '' rather than a list YouTube would ignore.
 */
export function youtubeChapters(marks, duration) {
  if (marks.length < 3 || marks[0].start !== 0) return '';
  for (let i = 0; i < marks.length; i++) if ((marks[i + 1]?.start ?? duration) - marks[i].start < 10) return '';
  return marks.map((m) => `${ts(m.start)} ${m.title}`).join('\n');
}

export { MAX_SECONDS };
