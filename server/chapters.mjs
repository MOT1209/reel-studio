// Long-form chapters: a 90 s – 30 min project is split into 45–120 s chapters. Each chapter runs the same five
// stages (script → voice → timing → storyboard → render) on its own audio, and the chapter MP4s are concatenated
// into one video. Chapter progress lives in project.json, so a cancelled or crashed run resumes at the first
// unfinished chapter instead of starting over.
//
// This module is pure data + ffmpeg-free: planning, progress, aggregation of the chapters into the project-level
// words/storyboard the editor, subtitles and previews read, and the mapping of an aggregate edit back onto the
// chapters. Rendering lives in stage-run.mjs.
import path from 'node:path';
import { DATA_DIR } from './settings.mjs';
import { MAX_SECONDS } from './text.mjs';
import { repairStoryboard, storyboardNouns } from './storyboard.mjs';
import { iconsFor } from './icons.mjs';
import { effectiveEdit } from './edit.mjs';

export { MAX_SECONDS };
export const CHAPTER_SECONDS = 120;
export const MIN_CHAPTER_SECONDS = 45;
export const MAX_CHAPTERS = 24;
/** Above this many seconds a TTS project is planned as chapters (a single 20-minute storyboard is not usable). */
export const LONG_FORM_SECONDS = 90;
export const CHAPTER_STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];

export const chapterFolder = (projectId, chapterId) => path.join(DATA_DIR, 'projects', projectId, 'chapters', chapterId);

/** Splits a total duration into chapters of ~2 minutes (at least two, each ≥ 45 s, at most 24). */
export function planChapters(seconds, { chapterSeconds = CHAPTER_SECONDS } = {}) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return [];
  const n = Math.max(2, Math.min(MAX_CHAPTERS, Math.round(total / chapterSeconds)));
  const each = total / n;
  return Array.from({ length: n }, (_, i) => {
    const start = +(each * i).toFixed(2);
    const rest = +(total - start).toFixed(2);
    return { index: i, id: `ch-${String(i + 1).padStart(2, '0')}`, start, seconds: i === n - 1 ? rest : +each.toFixed(2) };
  });
}

/** A chapter record as stored in project.json. */
export function newChapter(entry) {
  return {
    id: entry.id, index: entry.index, title: '', seconds: entry.seconds,
    offset: 0, from: 0,
    script: null, voice: null, words: null, timing: null, storyboard: null, storyboardFixes: [], icons: null, clips: {},
    stages: Object.fromEntries(CHAPTER_STAGES.map((s) => [s, 'idle'])),
    render: null, error: null,
  };
}

/** Chapters that still need a stage (the resume check; the caller also verifies the files on disk). */
export function pendingChapters(p, stage) {
  return (p.chapters || []).filter((ch) => ch.stages?.[stage] !== 'done');
}

/** The length of one chapter's rendered video: its voice (plus the 0.6 s tail every render gets) or its frames. */
export function chapterDuration(ch, fps = 30) {
  if (ch?.render?.frames && ch?.render?.fps) return ch.render.frames / ch.render.fps;
  const last = ch?.words?.length ? ch.words[ch.words.length - 1].end : 0;
  return Math.max(0.5, Math.max(ch?.voice?.duration || 0, last + 0.3) + 0.6);
}

/** Recomputes every chapter's start time and first word index in the joined timeline. */
export function layoutChapters(p, fps = 30) {
  let t = 0, w = 0;
  for (const ch of p.chapters || []) {
    ch.offset = +t.toFixed(3);
    ch.from = w;
    t += chapterDuration(ch, fps);
    w += ch.words?.length || 0;
  }
  return { duration: +t.toFixed(3), words: w };
}

/**
 * Rebuilds the project-level script/words/storyboard/voice from the chapters, so everything that already reads a
 * project (editor, subtitles, preview, publish metadata, platform duration checks) keeps working on long videos.
 * Word times become project-global; scene and accent word indices are shifted the same way.
 */
export function assembleProject(p) {
  const chs = p.chapters || [];
  if (!chs.length) return p;
  const fps = effectiveEdit(p.edit).export.fps;
  const { duration } = layoutChapters(p, fps);
  const words = [], scenes = [], accents = [], icons = {};
  for (const ch of chs) {
    for (const w of ch.words || []) {
      words.push({ ...w, i: words.length, start: +(w.start + ch.offset).toFixed(3), end: +(w.end + ch.offset).toFixed(3) });
    }
    if (ch.storyboard && ch.words?.length) {
      for (const s of ch.storyboard.scenes) {
        scenes.push({ ...s, at: s.at + ch.from, items: s.items.map((it) => ({ ...it, at: it.at == null ? null : it.at + ch.from })) });
      }
      for (const [k, tone] of ch.storyboard.accents || []) accents.push([k + ch.from, tone]);
    }
    Object.assign(icons, ch.icons || {});
  }
  p.words = words.length ? words : null;
  p.storyboard = scenes.length ? { scenes, accents: accents.sort((a, b) => a[0] - b[0]) } : null;
  p.icons = Object.keys(icons).length ? icons : null;

  const scripts = chs.map((c) => c.script).filter((s) => s?.text);
  p.script = scripts.length ? {
    title: scripts[0].title || p.script?.title || p.topic,
    text: scripts.map((s) => s.text).join('\n\n'),
    sources: [...new Set(scripts.flatMap((s) => (s.sources || [])))],
    words: scripts.reduce((a, s) => a + (s.words || 0), 0),
    model: scripts[0].model || null,
    chapters: chs.length,
  } : null;

  const voiced = chs.filter((c) => c.voice?.duration);
  p.voice = voiced.length ? { file: 'voice.mp3', duration: +duration.toFixed(3), source: voiced[0].voice.source, chapters: chs.length } : null;

  const timed = chs.filter((c) => c.timing);
  if (timed.length) {
    const weight = timed.reduce((a, c) => a + (c.words?.length || 0), 0) || 1;
    p.timing = {
      weak: timed.reduce((a, c) => a + (c.timing.weak || 0), 0),
      matchAvg: +(timed.reduce((a, c) => a + (c.timing.matchAvg || 0) * (c.words?.length || 0), 0) / weight).toFixed(3),
      source: timed[0].timing.source, estimated: timed.some((c) => c.timing.estimated), chapters: chs.length,
    };
  }
  return p;
}

/** How far a long project is: per-stage chapter counts, finished chapters and rendered seconds. */
export function chapterProgress(p) {
  const chs = p.chapters || [];
  const stages = Object.fromEntries(CHAPTER_STAGES.map((s) => [s, { done: 0, total: chs.length }]));
  let done = 0, failed = 0, seconds = 0;
  for (const ch of chs) {
    let all = true;
    for (const s of CHAPTER_STAGES) {
      if (ch.stages?.[s] === 'done') stages[s].done++;
      else all = false;
    }
    if (all) done++;
    if (ch.error) failed++;
    if (ch.stages?.render === 'done') seconds += chapterDuration(ch);
  }
  return { total: chs.length, done, failed, seconds: +seconds.toFixed(2), stages };
}

/**
 * Maps an edit of the joined timeline (the editor and the stage panels work on p.words / p.storyboard) back onto
 * the chapters. Words map by position (an edit keeps the word count), scenes and accents by their word index.
 * Each chapter's storyboard is repaired against its own local words, exactly as a generation would be.
 */
export function distributeEdits(p, words = null, storyboard = null) {
  const chs = p.chapters || [];
  const fixes = [];
  if (!chs.length) return fixes;
  let from = 0;
  for (const ch of chs) {
    const n = ch.words?.length || 0;
    if (words && n) {
      const local = [];
      for (let i = 0; i < n; i++) {
        const w = words[from + i] || ch.words[i];
        const start = Math.max(0, (Number.isFinite(w.start) ? w.start : ch.words[i].start + ch.offset) - ch.offset);
        const end = Math.max(start + 0.05, (Number.isFinite(w.end) ? w.end : ch.words[i].end + ch.offset) - ch.offset);
        local.push({ ...ch.words[i], text: w.text || ch.words[i].text, start: +start.toFixed(3), end: +end.toFixed(3) });
      }
      for (let i = 1; i < local.length; i++) if (local[i].start < local[i - 1].start) local[i].start = local[i - 1].start;
      ch.words = local;
      ch.timing = { ...(ch.timing || {}), edited: true };
    }
    from += n;
  }
  if (storyboard) {
    let i0 = 0;
    for (const ch of chs) {
      const n = ch.words?.length || 0;
      if (n) {
        const to = i0 + n;
        const scenes = storyboard.scenes
          .filter((s) => s.at >= i0 && s.at < to)
          .map((s) => ({
            ...s, at: s.at - i0,
            items: s.items.map((it) => ({ ...it, at: it.at == null ? null : Math.max(0, Math.min(n - 1, it.at - i0)) })),
          }));
        const accents = (storyboard.accents || []).filter(([k]) => k >= i0 && k < to).map(([k, tone]) => [k - i0, tone]);
        const repaired = repairStoryboard({ scenes, accents }, ch.words, { forceTemplate: p.options?.forceTemplate });
        ch.storyboard = repaired.storyboard;
        ch.storyboardFixes = repaired.fixes;
        ch.icons = iconsFor(storyboardNouns(repaired.storyboard));
        for (const f of repaired.fixes) fixes.push(`${ch.id}: ${f}`);
        i0 = to;
      }
    }
  }
  assembleProject(p);
  return fixes;
}

/** Splits an edited full script back into chapter-sized texts, at line boundaries, by each chapter's word count. */
export function splitScriptByWordCounts(text, counts) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const per = counts.map((c) => (c / total) * lines.length);
  const out = [];
  let at = 0;
  for (let i = 0; i < counts.length; i++) {
    const left = lines.length - at - (counts.length - i - 1); // keep at least one line for every later chapter
    const take = i === counts.length - 1 ? lines.length - at : Math.max(0, Math.min(left, Math.max(1, Math.round(per[i]))));
    out.push(lines.slice(at, at + take).join('\n'));
    at += take;
  }
  if (at < lines.length) out[out.length - 1] += '\n' + lines.slice(at).join('\n');
  return out;
}

/**
 * The edit a chapter render uses: chapter-local overlays and audio tracks (clipped and shifted to the chapter),
 * no trim/cuts/custom order (they describe the joined timeline), and no background music — the music is mixed
 * once over the concatenated video so it runs across the whole video instead of restarting every chapter.
 */
export function chapterEdit(edit, ch) {
  const E = effectiveEdit(edit || {});
  const duration = chapterDuration(ch, E.export.fps);
  const end = ch.offset + duration;
  const inside = (x) => Number(x?.end) > ch.offset && Number(x?.start) < end;
  const shift = (x) => ({
    ...x,
    start: +Math.max(0, Number(x.start) - ch.offset).toFixed(3),
    end: +Math.min(duration, Number(x.end) - ch.offset).toFixed(3),
  });
  return {
    ...E,
    trim: { start: 0, end: null },
    cuts: [],
    sequence: null,
    overlays: (E.overlays || []).filter(inside).map(shift),
    audio: {
      ...E.audio,
      music: null,
      tracks: (E.audio.tracks || []).filter(inside).map(shift),
    },
  };
}
