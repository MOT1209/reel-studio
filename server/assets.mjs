// Media library: images, videos and audio in data/assets/<id>/ with a meta.json that always carries the source and
// licence. Uploads stream to disk (no full video in RAM), are checked by magic bytes and probed with ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, writeFileAtomic } from './settings.mjs';
import { run } from './render.mjs';

const DIR = path.join(DATA_DIR, 'assets');
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const LIMITS = { image: 25 * 1024 * 1024, audio: 150 * 1024 * 1024, video: 600 * 1024 * 1024 };
const ID = /^[a-f0-9]{12}$/;
export const validAssetId = (id) => ID.test(String(id || ''));
const err = (status, message) => Object.assign(new Error(message), { status });

/** Container sniffing from the first bytes. Returns { kind, ext } or null. */
export function sniff(b) {
  const s = (i, n) => b.subarray(i, i + n).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (s(0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'image', ext: 'png' };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return { kind: 'image', ext: 'webp' };
  if (s(0, 4) === 'GIF8') return { kind: 'image', ext: 'gif' };
  if (s(4, 4) === 'ftyp') return /^(M4A |M4B |mp42?A)/.test(s(8, 4)) ? { kind: 'audio', ext: 'm4a' } : { kind: 'video?', ext: s(8, 2) === 'qt' ? 'mov' : 'mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video?', ext: 'webm' };
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', ext: 'mp3' };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return { kind: 'audio', ext: 'wav' };
  if (s(0, 4) === 'OggS') return { kind: 'audio', ext: 'ogg' };
  if (s(0, 4) === 'fLaC') return { kind: 'audio', ext: 'flac' };
  return null;
}

async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]);
  const j = JSON.parse(out || '{}');
  const v = (j.streams || []).find((x) => x.codec_type === 'video');
  const a = (j.streams || []).find((x) => x.codec_type === 'audio');
  const d = parseFloat(j.format?.duration);
  return { width: v?.width || null, height: v?.height || null, hasVideo: !!v, hasAudio: !!a, duration: Number.isFinite(d) ? +d.toFixed(3) : null };
}

const metaPath = (id) => path.join(DIR, id, 'meta.json');
export function getAsset(id) {
  if (!validAssetId(id)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}
export const assetFile = (a) => path.join(DIR, a.id, a.file);
export const assetDir = (id) => path.join(DIR, id);

/** Licence record. commercial: true | false | 'check' (the user must read the terms). */
export function licenseRecord(l = {}) {
  return {
    name: String(l.name || 'غير محدد').slice(0, 80), url: l.url ? String(l.url).slice(0, 300) : null,
    attribution: l.attribution ? String(l.attribution).slice(0, 300) : null, attributionRequired: !!l.attributionRequired,
    commercial: l.commercial === true || l.commercial === false ? l.commercial : 'check', notes: l.notes ? String(l.notes).slice(0, 500) : null,
  };
}

/**
 * Adds a file that is already on disk (moved into the library). Validates type/size, probes, makes a thumbnail.
 * source: { type:'upload'|'pexels'|'pixabay'|'unsplash', ... } — license: see licenseRecord().
 */
export async function addAssetFromFile(tmpFile, { name, folder = '', tags = [], source = { type: 'upload' }, license = {} }) {
  const fd = fs.openSync(tmpFile, 'r'); const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
  const sn = sniff(head);
  if (!sn) { fs.rmSync(tmpFile, { force: true }); throw err(415, 'نوع الملف مش مدعوم (صور: jpg/png/webp/gif · فيديو: mp4/mov/webm · صوت: mp3/wav/m4a/ogg/flac)'); }
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = `file.${sn.ext}`;
  fs.renameSync(tmpFile, path.join(dir, file));
  try {
    const size = fs.statSync(path.join(dir, file)).size;
    const info = await probe(path.join(dir, file)).catch(() => null);
    if (!info) throw err(415, 'ffprobe مش قادر يقرأ الملف — ممكن يكون بايظ');
    let kind = sn.kind === 'video?' ? (info.hasVideo ? 'video' : 'audio') : sn.kind;
    if (kind === 'audio' && !info.hasAudio) throw err(415, 'الملف مفيهوش صوت');
    if (size > LIMITS[kind]) throw err(413, `أكبر من الحد (${Math.round(LIMITS[kind] / 1048576)}MB)`);
    let thumb = null;
    if (kind !== 'audio') {
      await run(FFMPEG, ['-hide_banner', '-y', ...(kind === 'video' ? ['-ss', String(Math.min(1, (info.duration || 0) / 2))] : []), '-i', path.join(dir, file), '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '4', path.join(dir, 'thumb.jpg')]).then(() => { thumb = 'thumb.jpg'; }).catch(() => {});
    }
    const meta = {
      id, kind, file, thumb, name: String(name || file).slice(0, 120), folder: cleanFolder(folder), tags: cleanTags(tags), size,
      width: info.width, height: info.height, duration: kind === 'image' ? null : info.duration,
      source: { type: source.type || 'upload', provider: source.provider || null, providerId: source.providerId ? String(source.providerId) : null, pageUrl: source.pageUrl || null, author: source.author || null, authorUrl: source.authorUrl || null },
      license: licenseRecord(license), createdAt: new Date().toISOString(),
    };
    writeFileAtomic(metaPath(id), JSON.stringify(meta, null, 1));
    return meta;
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

const cleanFolder = (f) => String(f || '').replace(/[\\/<>:"|?*\u0000-\u001f]/g, '').trim().slice(0, 40);
const cleanTags = (t) => (Array.isArray(t) ? t : String(t || '').split(/[,،]/)).map((x) => String(x).trim().slice(0, 30)).filter(Boolean).slice(0, 20);

/** Streams an HTTP request body to a temp file with a byte limit. */
export function streamToTemp(req, limit) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `.upload-${crypto.randomBytes(6).toString('hex')}`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rmSync(tmp, { force: true }); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(err(413, `الملف أكبر من ${Math.round(limit / 1048576)}MB`)); req.destroy(); } });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) (size ? resolve(tmp) : fail(err(400, 'ملف فاضي'))); });
    req.pipe(out);
  });
}

export function listAssets({ kind, folder, q, page = 1, per = 60 } = {}) {
  if (!fs.existsSync(DIR)) return { items: [], total: 0, folders: [] };
  const all = fs.readdirSync(DIR).filter((d) => ID.test(d)).map(getAsset).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const folders = [...new Set(all.map((a) => a.folder).filter(Boolean))].sort();
  const ql = String(q || '').trim().toLowerCase();
  const items = all.filter((a) => (!kind || a.kind === kind) && (folder == null || folder === '' || a.folder === folder)
    && (!ql || [a.name, ...(a.tags || []), a.source?.author, a.license?.name].filter(Boolean).some((x) => String(x).toLowerCase().includes(ql))));
  const p = Math.max(1, Number(page) || 1), n = Math.max(1, Math.min(200, Number(per) || 60));
  return { items: items.slice((p - 1) * n, p * n), total: items.length, page: p, folders };
}

export function updateAsset(id, patch) {
  const a = getAsset(id);
  if (!a) throw err(404, 'asset not found');
  if (typeof patch.name === 'string') a.name = patch.name.trim().slice(0, 120) || a.name;
  if (patch.folder !== undefined) a.folder = cleanFolder(patch.folder);
  if (patch.tags !== undefined) a.tags = cleanTags(patch.tags);
  if (patch.license && typeof patch.license === 'object') a.license = licenseRecord({ ...a.license, ...patch.license });
  writeFileAtomic(metaPath(id), JSON.stringify(a, null, 1));
  return a;
}

export function deleteAsset(id) {
  if (!getAsset(id)) throw err(404, 'asset not found');
  fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
}

/** Text a video description needs for every asset a project uses (attribution where required or available). */
export function creditsFor(ids) {
  return [...new Set(ids)].map(getAsset).filter(Boolean).filter((a) => a.source?.type !== 'upload' || a.license?.attribution)
    .map((a) => a.license?.attribution || `${a.source.author ? a.source.author + ' — ' : ''}${a.source.provider || a.source.type}${a.source.pageUrl ? ' ' + a.source.pageUrl : ''}`);
}

/** A downscaled JPEG (longest side ≤ max) cached next to the original — the renderer never decodes a 6000-px photo. */
export async function scaledFile(a, max) {
  if (a.kind !== 'image') return assetFile(a);
  const m = [720, 1080, 1280, 1920].includes(Number(max)) ? Number(max) : 1920;
  if (Math.max(a.width || 0, a.height || 0) <= m && a.file.endsWith('.jpg')) return assetFile(a);
  const out = path.join(DIR, a.id, `scaled-${m}.jpg`);
  if (fs.existsSync(out)) return out;
  // several render pages ask for the same image at once: one conversion, everyone awaits it
  if (!scaling.has(out)) {
    const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    scaling.set(out, run(FFMPEG, ['-hide_banner', '-y', '-i', assetFile(a), '-frames:v', '1', '-vf', `scale=${m}:${m}:force_original_aspect_ratio=decrease`, '-q:v', '3', tmp])
      .then(() => fs.renameSync(tmp, out)).finally(() => { fs.rmSync(tmp, { force: true }); scaling.delete(out); }));
  }
  await scaling.get(out);
  return out;
}
const scaling = new Map();
