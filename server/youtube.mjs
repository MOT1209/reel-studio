// YouTube publishing: OAuth 2.0 (loopback redirect + PKCE) and resumable uploads (YouTube Data API v3).
// Tokens live only in data/youtube-token.json and never reach the browser.
import { youtubeChapters } from './longform.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getSettings, writeFileAtomic } from './settings.mjs';
import { addSecret } from './logger.mjs';
import { seal, open as unseal } from './vault.mjs';

const URLS = () => ({
  auth: process.env.YT_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.YT_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: process.env.YT_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: process.env.YT_API_URL || 'https://www.googleapis.com/youtube/v3',
  upload: process.env.YT_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3',
});
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const TOKEN_FILE = path.join(DATA_DIR, 'youtube-token.json');
const pending = new Map(); // state → { verifier, redirectUri, at }

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN_KEYS = ['refresh_token', 'access_token'];
function readToken() {
  let t;
  try { t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
  for (const k of TOKEN_KEYS) if (t[k]) t[k] = unseal(DATA_DIR, t[k], `youtube ${k}`) || undefined;
  addSecret(t.refresh_token); addSecret(t.access_token);
  return t;
}
function writeToken(t) {
  addSecret(t.refresh_token); addSecret(t.access_token); // never logged
  const out = { ...t };
  for (const k of TOKEN_KEYS) if (out[k]) out[k] = seal(DATA_DIR, out[k]); // encrypted at rest
  writeFileAtomic(TOKEN_FILE, JSON.stringify(out, null, 1), { mode: 0o600 });
}

function creds() {
  const { clientId, clientSecret } = getSettings().youtube;
  if (!clientId || !clientSecret) throw Object.assign(new Error('حط Client ID و Client secret في الإعدادات ← يوتيوب الأول'), { status: 400 });
  return { clientId, clientSecret };
}

/** Public status for the UI (no tokens). */
export function youtubeStatus() {
  const t = readToken();
  const { clientId, clientSecret } = getSettings().youtube;
  return { configured: !!(clientId && clientSecret), linked: !!t?.refresh_token, channel: t?.channel || null };
}

/** Step 1: URL of Google's consent screen. redirectUri must be this server's /oauth/youtube/callback. */
export function startAuth(redirectUri) {
  const { clientId } = creds();
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60e3) pending.delete(k);
  const state = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(48));
  pending.set(state, { verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  return `${URLS().auth}?${q}`;
}

/** Step 2: exchange the code, store the refresh token, read the channel. */
export async function finishAuth({ code, state, error }) {
  if (error) throw new Error(`Google رفض الربط: ${error}`);
  const p = pending.get(state);
  if (!p) throw new Error('رابط الربط انتهى أو مش صحيح — ابدأ الربط تاني من الإعدادات');
  pending.delete(state);
  const { clientId, clientSecret } = creds();
  const res = await fetch(URLS().token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`token exchange failed: ${j.error_description || j.error || res.status}`);
  const old = readToken();
  const tok = { refresh_token: j.refresh_token || old?.refresh_token, access_token: j.access_token, expiry: Date.now() + (j.expires_in || 3600) * 1000 - 60e3, scope: j.scope };
  if (!tok.refresh_token) throw new Error('Google ما رجّعش refresh token — شيل صلاحية التطبيق من حسابك وجرب تاني');
  writeToken(tok);
  tok.channel = await fetchChannel(tok.access_token);
  writeToken(tok);
  return tok.channel;
}

async function fetchChannel(accessToken) {
  const res = await fetch(`${URLS().api}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube channels: ${j.error?.message || res.status}`);
  const c = j.items?.[0];
  if (!c) throw new Error('الحساب ده مالوش قناة يوتيوب');
  return { id: c.id, title: c.snippet?.title, thumbnail: c.snippet?.thumbnails?.default?.url || '' };
}

/** A valid access token. force=true skips the cached one (after the API answered 401). */
async function accessToken({ force = false } = {}) {
  const t = readToken();
  if (!t?.refresh_token) throw Object.assign(new Error('القناة مش مربوطة — اربطها من الإعدادات ← يوتيوب'), { status: 409 });
  if (!force && t.access_token && Date.now() < t.expiry) return t.access_token;
  const { clientId, clientSecret } = creds();
  const res = await fetch(URLS().token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant') { fs.rmSync(TOKEN_FILE, { force: true }); throw new Error('صلاحية الربط انتهت — اربط القناة تاني'); }
    throw new Error(`token refresh failed: ${j.error_description || j.error || res.status}`);
  }
  t.access_token = j.access_token; t.expiry = Date.now() + (j.expires_in || 3600) * 1000 - 60e3;
  writeToken(t);
  return t.access_token;
}

export async function unlinkYoutube() {
  const t = readToken();
  if (t?.refresh_token) await fetch(`${URLS().revoke}?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
  fs.rmSync(TOKEN_FILE, { force: true });
}

/** Title/description/tags for a project. YouTube limits: title ≤ 100 chars, description ≤ 5000. */
export function videoMetadata(p) {
  const yt = getSettings().youtube;
  const tags = String(yt.tags || '').split(/[,،#\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 15);
  const title = `${p.script?.title || p.topic}`.slice(0, 90) + (p.render?.duration <= 180 ? ' #shorts' : '');
  const sources = (p.script?.sources || []).length ? `\n\nالمصادر:\n${p.script.sources.map((s) => '• ' + s).join('\n')}` : '';
  // long-form: chapter timestamps (YouTube turns "0:00 Title" lines into chapters) instead of the whole narration
  const chapters = p.render?.chapters?.length ? youtubeChapters(p.render.chapters, p.render.duration) : '';
  const body = p.chapters?.length ? `${p.script?.title || p.topic}${chapters ? `\n\n${chapters}` : ''}` : (p.script?.text || '').trim();
  const description = `${body}${sources}\n\n${tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ')}`.slice(0, 4900);
  return { title, description, tags, categoryId: String(yt.categoryId || '27') };
}

/**
 * Resumable upload of a finished video. Returns { videoId, url, privacy }.
 * onProgress(fraction) is called after every chunk.
 */
export async function uploadVideo(file, meta, { privacy = 'private', signal, onProgress = () => {} } = {}) {
  const size = fs.statSync(file).size;
  let token = await accessToken();
  const startSession = () => fetch(`${URLS().upload}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.categoryId, defaultLanguage: 'ar', defaultAudioLanguage: 'ar' },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true },
    }),
  });
  let init = await startSession();
  if (init.status === 401) { token = await accessToken({ force: true }); init = await startSession(); } // revoked before expiry
  if (!init.ok) {
    const j = await init.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') throw new Error('خلصت حصة الرفع اليومية على يوتيوب (حوالي 6 فيديوهات في اليوم لكل مشروع Google) — جرب بكرة');
    throw new Error(`YouTube upload init: ${j.error?.message || init.status}`);
  }
  const session = init.headers.get('location');
  if (!session) throw new Error('YouTube did not return an upload session');
  const KB256 = 256 * 1024; // chunks must be multiples of 256 KiB
  const CHUNK = Math.max(1, Math.round((Number(process.env.YT_CHUNK_BYTES) || 8 * 1024 * 1024) / KB256)) * KB256;
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0, authRetries = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const res = await fetch(session, {
        method: 'PUT', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
        body: buf,
      });
      if (res.status === 308) { // chunk accepted — continue from what the server has
        // Range = what the server has stored; no Range header means it stored nothing yet.
        const r = res.headers.get('range');
        offset = r ? Number(r.split('-')[1]) + 1 : 0;
        authRetries = 0;
        onProgress(offset / size);
        continue;
      }
      if (res.status === 401) {
        // the cached token was revoked early: refresh once; a second 401 in a row is a real failure
        if (++authRetries > 1) throw new Error('YouTube رفض الصلاحية (401) — اربط القناة تاني');
        token = await accessToken({ force: true });
        continue;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.id) throw new Error(`YouTube upload: ${j.error?.message || res.status}`);
      onProgress(1);
      return { videoId: j.id, url: `https://youtu.be/${j.id}`, privacy: j.status?.privacyStatus || privacy };
    }
  } finally { fs.closeSync(fd); }
}
