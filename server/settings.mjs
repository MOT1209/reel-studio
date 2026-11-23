// Settings: data/settings.json + .env. Keys reach the browser only masked to the last 4 chars.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.RS_DATA_DIR || path.join(ROOT, 'data'));
const FILE = path.join(DATA_DIR, 'settings.json');

// Minimal .env loader (does not override variables already in the environment).
(function loadDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

export const DEFAULTS = {
  llm: { baseUrl: 'http://127.0.0.1:31415/v1', apiKey: '', model: 'auto', temperature: 0.8 },
  elevenlabs: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', voiceId: '', modelId: 'eleven_multilingual_v2' },
  deepgram: { baseUrl: 'https://api.deepgram.com', apiKey: '', model: 'nova-3', language: 'ar' },
  youtube: { clientId: '', clientSecret: '', privacy: 'private', autoPublish: false, tags: 'علوم, shorts, science', categoryId: '27' },
  fontFolder: '',
  seriesTag: 'علوم في دقيقة',
  look: { theme: 'dark', colors: {}, grid: true },
  audio: { sfxVolume: 0.6, whoosh: true, tick: true },
  render: { fps: 30 },
  approvals: { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' },
};

// ---- look: theme presets (render.js draws with whatever palette it receives) ----------------
export const THEMES = {
  dark: { // dark technical illustration (default series look)
    bg: '#0C1014', card: '#161C22', elev: '#202830', text: '#F4F3EE', sec: '#9AA5AE',
    accent: '#27B8C7', blue: '#5978FF', success: '#36C98F', warning: '#F28A30',
  },
  paper: { // flat illustration on cream paper (red/orange for what matters, blue for imaging)
    bg: '#F2E9D8', card: '#FBF6EC', elev: '#EDE3D1', text: '#1F1B16', sec: '#7A7062',
    accent: '#E4572E', blue: '#2F6DB5', success: '#2E9E6B', warning: '#D9822B',
  },
};
export const COLOR_KEYS = Object.keys(THEMES.dark);
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Effective palette: preset + user overrides. */
export function resolvePalette(look = getSettings().look) {
  const base = THEMES[look.theme] || THEMES.dark;
  const out = { ...base };
  for (const k of COLOR_KEYS) if (HEX.test(look.colors?.[k] || '')) out[k] = look.colors[k];
  return out;
}
export const STAGE_NAMES = ['script', 'voice', 'timing', 'storyboard', 'render'];

// Secret fields: [section, field, envVar]
const SECRETS = [['llm', 'apiKey', 'LLM_API_KEY'], ['elevenlabs', 'apiKey', 'ELEVENLABS_API_KEY'], ['deepgram', 'apiKey', 'DEEPGRAM_API_KEY'], ['youtube', 'clientSecret', 'YOUTUBE_CLIENT_SECRET']];
// Base URLs: env always wins (lets tools/mock-apis.mjs and tests redirect everything).
const URL_ENV = [['llm', 'baseUrl', 'LLM_BASE_URL'], ['elevenlabs', 'baseUrl', 'ELEVENLABS_BASE_URL'], ['deepgram', 'baseUrl', 'DEEPGRAM_BASE_URL']];
// Other plain fields with env fallbacks (settings.json wins when set).
const PLAIN_ENV = [['llm', 'model', 'LLM_MODEL'], ['elevenlabs', 'voiceId', 'ELEVENLABS_VOICE_ID'], ['elevenlabs', 'modelId', 'ELEVENLABS_MODEL_ID'], ['deepgram', 'model', 'DEEPGRAM_MODEL'], ['youtube', 'clientId', 'YOUTUBE_CLIENT_ID']];

function readStored() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') out[k] = merge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Effective settings used by the pipeline (contains real keys — server-side only). */
export function getSettings() {
  const stored = readStored();
  const s = merge(DEFAULTS, stored);
  for (const [sec, f, env] of SECRETS) if (!stored?.[sec]?.[f] && process.env[env]) s[sec][f] = process.env[env];
  for (const [sec, f, env] of PLAIN_ENV) if (!stored?.[sec]?.[f] && process.env[env]) s[sec][f] = process.env[env];
  for (const [sec, f, env] of URL_ENV) if (process.env[env]) s[sec][f] = process.env[env];
  if (!stored.fontFolder && process.env.FONT_FOLDER) s.fontFolder = process.env.FONT_FOLDER;
  return s;
}

export const mask = (k) => (k ? '••••' + String(k).slice(-4) : '');

/** Settings safe for the browser: keys masked, plus where each value came from. */
export function getPublicSettings() {
  const stored = readStored();
  const s = getSettings();
  const source = {};
  for (const [sec, f, env] of SECRETS) {
    source[`${sec}.${f}`] = stored?.[sec]?.[f] ? 'settings' : process.env[env] ? '.env' : 'none';
    s[sec][f] = mask(s[sec][f]);
  }
  for (const [sec, f, env] of URL_ENV) if (process.env[env]) source[`${sec}.${f}`] = 'env (locked)';
  return { ...s, _source: source, _themes: THEMES, _palette: resolvePalette(s.look) };
}

/** Partial update from the Settings screen. Masked/empty secrets mean "keep". */
export function updateSettings(patch) {
  const stored = readStored();
  const next = structuredClone(stored);
  for (const sec of ['llm', 'elevenlabs', 'deepgram', 'youtube']) {
    if (!patch?.[sec] || typeof patch[sec] !== 'object') continue;
    next[sec] = next[sec] || {};
    for (const [f, v] of Object.entries(patch[sec])) {
      if (!(f in DEFAULTS[sec])) continue;
      const isSecret = SECRETS.some(([s2, f2]) => s2 === sec && f2 === f);
      if (isSecret) {
        if (typeof v !== 'string' || v.startsWith('••••')) continue; // unchanged
        if (v.trim() === '') { delete next[sec][f]; continue; } // cleared
        next[sec][f] = v.trim();
      } else if (f === 'autoPublish') {
        next[sec][f] = v === true || v === 'true';
      } else if (f === 'privacy') {
        if (['private', 'unlisted', 'public'].includes(v)) next[sec][f] = v;
      } else if (f === 'temperature') {
        const t = Number(v); if (Number.isFinite(t)) next[sec][f] = Math.max(0, Math.min(2, t));
      } else if (typeof v === 'string') next[sec][f] = v.trim();
    }
  }
  if (typeof patch?.fontFolder === 'string') next.fontFolder = patch.fontFolder.trim();
  if (typeof patch?.seriesTag === 'string') next.seriesTag = patch.seriesTag.trim().slice(0, 40);
  if (patch?.look && typeof patch.look === 'object') {
    const L = (next.look = { ...(next.look || {}) });
    if (THEMES[patch.look.theme]) L.theme = patch.look.theme;
    if (typeof patch.look.grid === 'boolean') L.grid = patch.look.grid;
    if (patch.look.colors && typeof patch.look.colors === 'object') {
      L.colors = {};
      for (const k of COLOR_KEYS) if (HEX.test(patch.look.colors[k] || '')) L.colors[k] = patch.look.colors[k].toUpperCase();
    }
  }
  if (patch?.audio && typeof patch.audio === 'object') {
    const A = (next.audio = { ...(next.audio || {}) });
    const v = Number(patch.audio.sfxVolume);
    if (Number.isFinite(v)) A.sfxVolume = Math.max(0, Math.min(1, v));
    for (const k of ['whoosh', 'tick']) if (typeof patch.audio[k] === 'boolean') A[k] = patch.audio[k];
  }
  if (patch?.render && [24, 30, 60].includes(Number(patch.render.fps))) next.render = { ...(next.render || {}), fps: Number(patch.render.fps) };
  if (patch?.approvals && typeof patch.approvals === 'object') {
    next.approvals = { ...DEFAULTS.approvals, ...(next.approvals || {}) };
    for (const s of STAGE_NAMES) if (patch.approvals[s]) next.approvals[s] = patch.approvals[s] === 'wait' ? 'wait' : 'auto';
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return getPublicSettings();
}

// ---- fonts -----------------------------------------------------------------
const FONT_RE = /\.(ttf|otf|woff2?)$/i;
/** Picks a regular and a bold face from the font folder (or the bundled IBM Plex Sans Arabic). */
export function resolveFonts() {
  const bundled = path.join(ROOT, 'assets', 'fonts');
  const custom = getSettings().fontFolder;
  let dir = bundled;
  if (custom && fs.existsSync(custom) && fs.statSync(custom).isDirectory()
      && fs.readdirSync(custom).some((f) => FONT_RE.test(f))) dir = path.resolve(custom);
  const files = fs.readdirSync(dir).filter((f) => FONT_RE.test(f));
  const score = (f, want) => {
    const l = f.toLowerCase();
    if (want === 'bold') return l.includes('semibold') ? 3 : /bold/.test(l) && !/extra|black/.test(l) ? 4 : l.includes('medium') ? 2 : 0;
    return /regular|book|normal/.test(l) ? 4 : !/bold|light|thin|black|medium|italic/.test(l) ? 3 : l.includes('medium') ? 2 : 0;
  };
  const pick = (want) => [...files].sort((a, b) => score(b, want) - score(a, want))[0];
  return { dir, regular: pick('regular'), bold: pick('bold'), custom: dir !== bundled };
}
