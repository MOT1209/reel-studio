// The project's edit model (what the editor changes and the renderer reads), its validation, the layout of each
// output format, and the preparation of video clips (frames extracted once, at the output frame rate and size).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, ASPECTS, QUALITIES } from './settings.mjs';
import { cleanTypography } from './fonts.mjs';
import { getAsset, assetFile, validAssetId } from './assets.mjs';
import { run } from './render.mjs';
import { cleanCuts } from './timeline.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const TRANSITIONS = ['push', 'fade', 'zoom', 'slide', 'none'];
export const OVERLAY_KINDS = ['text', 'image', 'video'];
export const POSITIONS = ['top', 'center', 'bottom', 'full'];
export const ANIMS = ['fade', 'pop', 'slide', 'none'];
export const EASES = ['linear', 'in', 'out', 'inOut', 'hold'];
export const MAX_TRACKS = 12, MAX_KEYFRAMES = 24;

/** Crop rectangle as fractions of the source {x,y,w,h}; null when absent, malformed or the whole frame. */
export function cleanCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const v = (k) => Number(c[k]);
  if (![v('x'), v('y'), v('w'), v('h')].every(Number.isFinite)) return null;
  const x = Math.max(0, Math.min(0.95, v('x'))), y = Math.max(0, Math.min(0.95, v('y')));
  const w = Math.max(0.05, Math.min(1 - x, v('w'))), h = Math.max(0.05, Math.min(1 - y, v('h')));
  if (x === 0 && y === 0 && w >= 0.999 && h >= 0.999) return null;
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
}

/** Keyframes [{t, x?, y?, scale?, opacity?, rot?, ease?}]: t is seconds after the overlay's start; sorted, clamped, capped. */
export function cleanKeyframes(list, length) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const k of list.slice(0, MAX_KEYFRAMES)) {
    if (!k || !Number.isFinite(Number(k.t))) continue;
    const c = { t: +Math.max(0, Math.min(length, Number(k.t))).toFixed(3) };
    for (const [p, lo, hi] of [['x', -1, 1], ['y', -1, 1], ['scale', 0.05, 2], ['opacity', 0, 1], ['rot', -360, 360]]) {
      if (k[p] !== undefined && k[p] !== null && k[p] !== '' && Number.isFinite(Number(k[p]))) c[p] = +Math.max(lo, Math.min(hi, Number(k[p]))).toFixed(4);
    }
    if (EASES.includes(k.ease)) c.ease = k.ease;
    if (Object.keys(c).some((p) => ['x', 'y', 'scale', 'opacity', 'rot'].includes(p))) out.push(c);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Edit with every default filled in (Settings supply the project-independent defaults). */
export function effectiveEdit(e = {}) {
  const s = getSettings();
  return {
    export: {
      aspect: ASPECTS.includes(e.export?.aspect) ? e.export.aspect : s.render.aspect || '9:16',
      resolution: [720, 1080].includes(e.export?.resolution) ? e.export.resolution : s.render.resolution || 1080,
      fps: [24, 25, 30, 60].includes(e.export?.fps) ? e.export.fps : s.render.fps || 30,
      quality: QUALITIES.includes(e.export?.quality) ? e.export.quality : s.render.quality || 'standard',
    },
    trim: { start: Math.max(0, Number(e.trim?.start) || 0), end: Number(e.trim?.end) > 0 ? Number(e.trim.end) : null },
    cuts: Array.isArray(e.cuts) ? e.cuts : [],
    audio: {
      voiceVolume: num(e.audio?.voiceVolume, 0, 2, s.audio.voiceVolume ?? 1),
      sfxVolume: num(e.audio?.sfxVolume, 0, 1, s.audio.sfxVolume ?? 0.6),
      tracks: Array.isArray(e.audio?.tracks) ? e.audio.tracks : [],
      music: e.audio?.music && validAssetId(e.audio.music.asset) ? {
        asset: e.audio.music.asset, volume: num(e.audio.music.volume, 0, 1, s.audio.musicVolume ?? 0.25),
        duck: e.audio.music.duck ?? s.audio.duck ?? true, fadeIn: num(e.audio.music.fadeIn, 0, 5, 1), fadeOut: num(e.audio.music.fadeOut, 0, 5, 1.5),
      } : null,
    },
    transition: TRANSITIONS.includes(e.transition) ? e.transition : 'push',
    typography: e.typography || {},
    overlays: Array.isArray(e.overlays) ? e.overlays : [],
  };
}
function num(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, n)) : d; }

/** Validates an edit coming from the browser. Unknown keys are dropped; asset references must exist. */
export function cleanEdit(e, { duration = Infinity } = {}) {
  if (!e || typeof e !== 'object') return {};
  const out = {};
  if (e.export && typeof e.export === 'object') {
    out.export = {};
    if (ASPECTS.includes(e.export.aspect)) out.export.aspect = e.export.aspect;
    if ([720, 1080].includes(Number(e.export.resolution))) out.export.resolution = Number(e.export.resolution);
    if ([24, 25, 30, 60].includes(Number(e.export.fps))) out.export.fps = Number(e.export.fps);
    if (QUALITIES.includes(e.export.quality)) out.export.quality = e.export.quality;
  }
  if (e.trim && typeof e.trim === 'object') {
    const st = Math.max(0, Math.min(duration - 1, Number(e.trim.start) || 0));
    const en = Number(e.trim.end) > 0 ? Math.min(duration, Number(e.trim.end)) : null;
    out.trim = { start: +st.toFixed(3), end: en && en > st + 1 ? +en.toFixed(3) : null };
  }
  if (e.audio && typeof e.audio === 'object') {
    out.audio = {};
    for (const [k, hi] of [['voiceVolume', 2], ['sfxVolume', 1]]) if (Number.isFinite(Number(e.audio[k]))) out.audio[k] = num(e.audio[k], 0, hi, 1);
    if (e.audio.music === null) out.audio.music = null;
    else if (e.audio.music && typeof e.audio.music === 'object') {
      const a = getAsset(e.audio.music.asset);
      if (!a || a.kind !== 'audio') throw Object.assign(new Error('الموسيقى لازم تكون ملف صوت من المكتبة'), { status: 400 });
      out.audio.music = { asset: a.id, name: a.name, volume: num(e.audio.music.volume, 0, 1, 0.25), duck: e.audio.music.duck !== false, fadeIn: num(e.audio.music.fadeIn, 0, 5, 1), fadeOut: num(e.audio.music.fadeOut, 0, 5, 1.5) };
    }
  }
  if (Array.isArray(e.audio?.tracks)) {
    // independent sound tracks: any audio file from the library, placed anywhere on the (source) timeline
    out.audio = out.audio || {};
    out.audio.tracks = e.audio.tracks.slice(0, MAX_TRACKS).filter((x) => x && typeof x === 'object').map((x) => {
      const a = getAsset(x.asset);
      if (!a || a.kind !== 'audio') throw Object.assign(new Error('مسار الصوت لازم يشاور على ملف صوت من المكتبة'), { status: 400 });
      const start = Math.max(0, Math.min(duration, Number(x.start) || 0));
      const end = Math.max(start + 0.1, Math.min(duration + 30, Number(x.end) || start + (a.duration || 3)));
      return { id: /^[a-z0-9]{4,16}$/.test(x.id) ? x.id : crypto.randomBytes(4).toString('hex'), asset: a.id, name: a.name, start: +start.toFixed(3), end: +end.toFixed(3),
        offset: Math.max(0, Number(x.offset) || 0), volume: num(x.volume, 0, 2, 1), fadeIn: num(x.fadeIn, 0, 5, 0), fadeOut: num(x.fadeOut, 0, 5, 0) };
    });
  }
  if (Array.isArray(e.cuts)) out.cuts = cleanCuts(e.cuts, duration);
  if (TRANSITIONS.includes(e.transition)) out.transition = e.transition;
  if (e.typography && typeof e.typography === 'object') out.typography = cleanTypography(e.typography);
  if (Array.isArray(e.overlays)) {
    out.overlays = e.overlays.slice(0, 50).filter((o) => o && OVERLAY_KINDS.includes(o.kind)).map((o) => {
      const start = Math.max(0, Math.min(duration, Number(o.start) || 0));
      const end = Math.max(start + 0.2, Math.min(duration + 5, Number(o.end) || start + 3));
      const c = {
        id: /^[a-z0-9]{4,16}$/.test(o.id) ? o.id : crypto.randomBytes(4).toString('hex'), kind: o.kind,
        start: +start.toFixed(3), end: +end.toFixed(3),
        pos: POSITIONS.includes(o.pos) ? o.pos : o.kind === 'text' ? 'top' : 'center', anim: ANIMS.includes(o.anim) ? o.anim : 'fade',
        scale: num(o.scale, 0.15, 1, o.kind === 'text' ? 1 : 0.6), opacity: num(o.opacity, 0.1, 1, 1),
        x: num(o.x, -1, 1, 0), y: num(o.y, -1, 1, 0), rot: num(o.rot, -360, 360, 0),
      };
      const kfs = cleanKeyframes(o.keyframes, end - start);
      if (kfs.length) c.keyframes = kfs;
      if (o.kind === 'text') { c.text = String(o.text || '').slice(0, 200); c.size = num(o.size, 18, 120, 44); c.box = o.box !== false; c.color = /^#[0-9a-fA-F]{6}$/.test(o.color || '') ? o.color : null; }
      else {
        const a = getAsset(o.asset);
        if (!a || a.kind !== o.kind) throw Object.assign(new Error(`عنصر ${o.kind} بيشاور على ملف مش موجود في المكتبة`), { status: 400 });
        c.asset = a.id; c.name = a.name; c.offset = Math.max(0, Number(o.offset) || 0); // where inside the clip to start (video)
        const cr = cleanCrop(o.crop); if (cr) c.crop = cr;
        if (o.kind === 'video') c.volume = num(o.volume, 0, 2, 0); // clip sound: muted unless the user turns it up
      }
      return c;
    });
  }
  return out;
}

// ---- layouts ---------------------------------------------------------------------------------------
// Design units: 9:16 → 720×1280, 1:1 → 720×720, 16:9 → 1280×720; ×1.5 for 1080p, ×1 for 720p.
// The illustration card is always drawn in its own 648×684 coordinates and placed with (x, y, k).
export function layoutFor(aspect = '9:16', resolution = 1080) {
  const S = resolution === 720 ? 1 : 1.5;
  const L = {
    '9:16': { DW: 720, DH: 1280, place: { x: 36, y: 232, k: 1 }, title: { right: 684, width: 648, y: 150, size: 40 }, tag: true, caption: { cx: 360, cy: 1036, maxW: 620, lines: 2 } },
    '1:1': { DW: 720, DH: 720, place: { x: 165, y: 158, k: 0.6 }, title: { right: 684, width: 470, y: 120, size: 30 }, tag: true, caption: { cx: 360, cy: 640, maxW: 640, lines: 2, scale: 0.78 } },
    '16:9': { DW: 1280, DH: 720, place: { x: 40, y: 82, k: 0.9 }, title: { right: 1244, width: 600, y: 170, size: 42 }, tag: true, caption: { cx: 960, cy: 470, maxW: 540, lines: 3, scale: 0.95 } },
  }[aspect] || null;
  if (!L) throw new Error(`unknown aspect ${aspect}`);
  return { aspect, S, width: Math.round(L.DW * S), height: Math.round(L.DH * S), ...L };
}

// ---- video clips -----------------------------------------------------------------------------------
/**
 * Extracts the frames a video asset needs (from `offset`, for `seconds`) at the output fps, scaled to fit the output
 * frame — once per (asset, offset, fps, size). Returns { dir, count, fps }. Frames are small JPEGs on disk, so a long
 * 4K clip never sits in memory.
 */
export async function prepareClip(projectDir, assetId, { offset = 0, seconds, fps, maxW, maxH, signal }) {
  const a = getAsset(assetId);
  if (!a || a.kind !== 'video') throw new Error(`video ${assetId} missing from the library`);
  const len = Math.max(0.1, Math.min(seconds, (a.duration || seconds) - offset));
  const key = `${assetId}-${offset.toFixed(2)}-${len.toFixed(2)}-${fps}-${maxW}x${maxH}`;
  const dir = path.join(projectDir, 'clips', key);
  const done = path.join(dir, 'done.json');
  if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await run(FFMPEG, ['-hide_banner', '-y', '-ss', String(offset), '-t', len.toFixed(3), '-i', assetFile(a), '-an',
    '-vf', `fps=${fps},scale=${maxW}:${maxH}:force_original_aspect_ratio=increase`, '-q:v', '4', path.join(dir, 'f_%05d.jpg')], { signal });
  const count = fs.readdirSync(dir).filter((f) => f.startsWith('f_')).length;
  if (!count) throw new Error(`no frames extracted from ${a.name}`);
  const info = { key, count, fps };
  fs.writeFileSync(done, JSON.stringify(info));
  return info;
}

// ---- pre-render validation -------------------------------------------------------------------------
/**
 * The gate between "AI / editor produced something" and "spend minutes rendering it". Returns a list of problems
 * (empty = ok). Pure: the caller supplies what exists on disk.
 */
export function checkRenderInputs({ words, storyboard, edit, voiceExists, hasAsset = () => true, duration }) {
  const bad = [];
  if (!voiceExists) bad.push('voice.mp3 is missing');
  if (!Array.isArray(words) || !words.length) { bad.push('no timed words'); return bad; }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!(Number.isFinite(w.start) && Number.isFinite(w.end))) bad.push(`word ${i + 1} has no valid time`);
    else if (w.end < w.start) bad.push(`word ${i + 1} ends before it starts`);
    else if (i && w.start < words[i - 1].start - 1e-6) bad.push(`word ${i + 1} starts before word ${i}`);
    if (bad.length > 8) { bad.push('…'); return bad; }
  }
  const sc = storyboard?.scenes;
  if (!Array.isArray(sc) || !sc.length) bad.push('storyboard has no scenes');
  else {
    if (sc[0].at !== 0) bad.push('the first scene must start at word 1');
    sc.forEach((s, i) => {
      if (!Number.isInteger(s.at) || s.at < 0 || s.at >= words.length) bad.push(`scene ${i + 1}: start word ${s.at} is outside the script`);
      else if (i && s.at <= sc[i - 1].at) bad.push(`scene ${i + 1} does not start after scene ${i}`);
      if (!s.template) bad.push(`scene ${i + 1} has no template`);
      if (s.image && !hasAsset(s.image)) bad.push(`scene ${i + 1}: image ${s.image} is not in the library`);
    });
  }
  for (const o of edit?.overlays || []) if (o.asset && !hasAsset(o.asset)) bad.push(`overlay ${o.id}: asset ${o.asset} is not in the library`);
  if (duration !== undefined && !(duration >= 1)) bad.push(`the video would be ${Number(duration).toFixed(2)} s (minimum 1 s)`);
  return bad;
}
