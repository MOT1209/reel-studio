// Font library: bundled OFL Arabic families (assets/fonts), the optional font folder from Settings, and fonts the
// user imports (data/fonts). Every face is served from /fonts/<family>/<file> and embedded in the render page via
// FontFace, so the exact same glyphs end up in the MP4.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, getSettings, resolveFonts, writeFileAtomic } from './settings.mjs';

const BUNDLED = path.join(ROOT, 'assets', 'fonts');
const LIB = path.join(BUNDLED, 'library');
const USER_DIR = path.join(DATA_DIR, 'fonts');
const OFL = { name: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org', embed: true };

// category: sans | naskh | kufi | display — "use" is the recommendation shown in the library.
export const FAMILIES = [
  { id: 'plex', name: 'IBM Plex Sans Arabic', category: 'sans', use: 'الافتراضي — واجهة وكابشن واضح', dir: BUNDLED, faces: [['IBMPlexSansArabic-Regular.ttf', '400'], ['IBMPlexSansArabic-Medium.ttf', '500'], ['IBMPlexSansArabic-SemiBold.ttf', '600'], ['IBMPlexSansArabic-Bold.ttf', '700']] },
  { id: 'cairo', name: 'Cairo', category: 'sans', use: 'العناوين', dir: path.join(LIB, 'cairo'), faces: [['Cairo-VF.ttf', '200 1000']] },
  { id: 'tajawal', name: 'Tajawal', category: 'sans', use: 'واجهة حديثة وكابشن', dir: path.join(LIB, 'tajawal'), faces: [['Tajawal-Regular.ttf', '400'], ['Tajawal-Bold.ttf', '700']] },
  { id: 'notosansarabic', name: 'Noto Sans Arabic', category: 'sans', use: 'محتوى عام', dir: path.join(LIB, 'notosansarabic'), faces: [['NotoSansArabic-VF.ttf', '100 900']] },
  { id: 'amiri', name: 'Amiri', category: 'naskh', use: 'كلاسيكي وتحريري', dir: path.join(LIB, 'amiri'), faces: [['Amiri-Regular.ttf', '400'], ['Amiri-Bold.ttf', '700']] },
  { id: 'notonaskharabic', name: 'Noto Naskh Arabic', category: 'naskh', use: 'نصوص طويلة', dir: path.join(LIB, 'notonaskharabic'), faces: [['NotoNaskhArabic-VF.ttf', '400 700']] },
  { id: 'scheherazadenew', name: 'Scheherazade New', category: 'naskh', use: 'نص مشكول وقرآني', dir: path.join(LIB, 'scheherazadenew'), faces: [['ScheherazadeNew-Regular.ttf', '400'], ['ScheherazadeNew-Bold.ttf', '700']] },
  { id: 'notokufiarabic', name: 'Noto Kufi Arabic', category: 'kufi', use: 'عناوين هندسية', dir: path.join(LIB, 'notokufiarabic'), faces: [['NotoKufiArabic-VF.ttf', '100 900']] },
  { id: 'reemkufi', name: 'Reem Kufi', category: 'kufi', use: 'عناوين وشعارات', dir: path.join(LIB, 'reemkufi'), faces: [['ReemKufi-VF.ttf', '400 700']] },
  { id: 'arefruqaa', name: 'Aref Ruqaa', category: 'display', use: 'رقعة — اقتباسات وعناوين قصيرة', dir: path.join(LIB, 'arefruqaa'), faces: [['ArefRuqaa-Regular.ttf', '400'], ['ArefRuqaa-Bold.ttf', '700']] },
].map((f) => ({ ...f, license: OFL, source: 'bundled' }));

const FONT_RE = /\.(ttf|otf|woff2?)$/i;
const ID_RE = /^[a-z0-9-]{2,40}$/;

function userFamilies() {
  if (!fs.existsSync(USER_DIR)) return [];
  return fs.readdirSync(USER_DIR).filter((d) => ID_RE.test(d)).flatMap((d) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(USER_DIR, d, 'meta.json'), 'utf8'));
      return [{ ...m, id: d, dir: path.join(USER_DIR, d), source: 'imported' }];
    } catch { return []; }
  });
}

function folderFamily() {
  const f = resolveFonts();
  if (!f.custom) return [];
  const faces = [[f.regular, '400']]; if (f.bold && f.bold !== f.regular) faces.push([f.bold, '700']);
  return [{ id: 'folder', name: `فولدر الخط (${path.basename(f.dir)})`, category: 'sans', use: 'من الإعدادات', dir: f.dir, faces, license: { name: 'حسب رخصة الخط اللي في الفولدر', embed: true }, source: 'folder' }];
}

export function allFamilies() { return [...FAMILIES, ...folderFamily(), ...userFamilies()]; }

const pub = (f) => ({ id: f.id, name: f.name, category: f.category, use: f.use, source: f.source, license: f.license, faces: f.faces.map(([file, weight]) => ({ url: `/fonts/${f.id}/${encodeURIComponent(file)}`, weight })) });
export function listFonts() { return allFamilies().map(pub); }

/** Faces of a family for the render page; unknown ids fall back to the default (Plex, or the Settings folder). */
export function facesFor(id) {
  const all = allFamilies();
  const fam = all.find((f) => f.id === id) || all.find((f) => f.id === 'folder') || all[0];
  return pub(fam);
}

/** Absolute path of a served font file, or null (only files listed in a family manifest are served). */
export function fontFile(id, file) {
  const fam = allFamilies().find((f) => f.id === id);
  if (!fam || !fam.faces.some(([n]) => n === file)) return null;
  return path.join(fam.dir, path.basename(file));
}

const MAGIC = (b) => (b.readUInt32BE(0) === 0x00010000 || ['OTTO', 'true', 'wOFF', 'wOF2'].includes(b.subarray(0, 4).toString('latin1')));

/**
 * Imports a user font. `license` must state the right to embed it in videos ("ofl", "own", "licensed");
 * the user confirms it in the UI — we can't verify a commercial licence, so we record what they declared.
 */
export function importFont({ name, file, buf, weight = '400', license }) {
  if (!['ofl', 'own', 'licensed'].includes(license)) throw Object.assign(new Error('أكّد إن عندك حق تضمين الخط ده في الفيديوهات'), { status: 400 });
  if (!buf?.length || buf.length > 20 * 1024 * 1024) throw Object.assign(new Error('ملف الخط فاضي أو أكبر من 20MB'), { status: 413 });
  if (!MAGIC(buf) || !FONT_RE.test(file || '')) throw Object.assign(new Error('الملف مش خط (ttf/otf/woff/woff2)'), { status: 415 });
  const id = 'u-' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(USER_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const fname = path.basename(file).replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(dir, fname), buf);
  const w = /^\d{3}( \d{3,4})?$/.test(String(weight)) ? String(weight) : '400';
  const meta = { name: String(name || fname).slice(0, 60), category: 'sans', use: 'خط مستورد', faces: [[fname, w]], license: { name: { ofl: 'SIL OFL (حسب المستخدم)', own: 'ملك المستخدم', licensed: 'مرخّص للمستخدم' }[license], embed: true, declaredBy: 'user' } };
  writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  return pub({ ...meta, id, dir, source: 'imported' });
}

export function deleteFont(id) {
  if (!/^u-[a-f0-9]{8}$/.test(id)) throw Object.assign(new Error('بس الخطوط المستوردة تتحذف'), { status: 400 });
  fs.rmSync(path.join(USER_DIR, id), { recursive: true, force: true });
}

/** Typography with defaults (Settings → look.typography, then the project's edit.typography on top). */
export const TYPO_DEFAULTS = { font: 'plex', captionFont: 'plex', captionSize: 52, captionWeight: 700, titleWeight: 700, letterSpacing: 0, captionStyle: 'boxed', align: 'center', direction: 'auto', digits: 'latin', captions: true };
export const CAPTION_STYLES = ['boxed', 'karaoke', 'minimal', 'outline'];
export function cleanTypography(t = {}, ids = allFamilies().map((f) => f.id)) {
  const o = {};
  if (ids.includes(t.font)) o.font = t.font;
  if (ids.includes(t.captionFont)) o.captionFont = t.captionFont;
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : undefined);
  if (num(t.captionSize, 28, 90) !== undefined) o.captionSize = num(t.captionSize, 28, 90);
  for (const k of ['captionWeight', 'titleWeight']) if (num(t[k], 100, 1000) !== undefined) o[k] = Math.round(num(t[k], 100, 1000) / 100) * 100;
  if (num(t.letterSpacing, -2, 12) !== undefined) o.letterSpacing = num(t.letterSpacing, -2, 12);
  if (CAPTION_STYLES.includes(t.captionStyle)) o.captionStyle = t.captionStyle;
  if (['center', 'right', 'left', 'justify'].includes(t.align)) o.align = t.align;
  if (['auto', 'rtl', 'ltr'].includes(t.direction)) o.direction = t.direction;
  if (['latin', 'arabic'].includes(t.digits)) o.digits = t.digits;
  if (typeof t.captions === 'boolean') o.captions = t.captions;
  return o;
}
export function typographyFor(projectEdit) {
  return { ...TYPO_DEFAULTS, ...cleanTypography(getSettings().look?.typography || {}), ...cleanTypography(projectEdit?.typography || {}) };
}
