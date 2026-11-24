// Stock media providers behind one adapter interface: search(q, {kind, page, per, orientation}) → normalized results,
// and importResult() which downloads into the asset library with the provider's licence terms attached.
// Keys stay on the server; downloads are allowed only from each provider's own media hosts (no SSRF).
import { fetchRetry } from './net.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, DATA_DIR } from './settings.mjs';
import { chatStream } from './apis.mjs';
import { addAssetFromFile, LIMITS } from './assets.mjs';

const err = (status, message) => Object.assign(new Error(message), { status });
const trim = (u) => String(u || '').replace(/\/+$/, '');

// Licence summaries. These are summaries, not legal advice — the UI links the full terms and asks the user to check.
const LIC = {
  pexels: { name: 'Pexels License', url: 'https://www.pexels.com/license/', commercial: true, attributionRequired: false, notes: 'مجاني للاستخدام والتعديل. ممنوع بيع نسخ من غير تعديل، أو الإيحاء بإن الأشخاص في الصورة بيدعموا منتجك.' },
  pixabay: { name: 'Pixabay Content License', url: 'https://pixabay.com/service/license-summary/', commercial: true, attributionRequired: false, notes: 'مجاني للاستخدام. ممنوع بيعه كما هو أو استخدامه بشكل مضلل؛ الأشخاص والعلامات التجارية الظاهرة ممكن يكون ليها حقوق.' },
  unsplash: { name: 'Unsplash License', url: 'https://unsplash.com/license', commercial: true, attributionRequired: true, notes: 'مجاني للاستخدام. شروط الـ API: لازم ذكر المصوّر و Unsplash، وتسجيل التحميل.' },
};

export const PROVIDERS = {
  pexels: {
    name: 'Pexels', kinds: ['image', 'video'], hosts: ['images.pexels.com', 'videos.pexels.com', 'player.vimeo.com'],
    base: () => process.env.PEXELS_BASE_URL || 'https://api.pexels.com', key: (s) => s.pexels?.apiKey,
    async search(q, { kind, page, per, orientation }, key) {
      const video = kind === 'video';
      const u = `${trim(this.base())}${video ? '/videos/search' : '/v1/search'}?${new URLSearchParams({ query: q, page, per_page: per, orientation })}`;
      const j = await getJson(u, { Authorization: key }, 'Pexels');
      return { total: j.total_results || 0, items: (video ? j.videos : j.photos || []).map((x) => video ? ({
        id: String(x.id), kind: 'video', thumb: x.image, width: x.width, height: x.height, duration: x.duration,
        download: bestVideo(x.video_files || []), pageUrl: x.url, author: x.user?.name, authorUrl: x.user?.url,
      }) : ({
        id: String(x.id), kind: 'image', thumb: x.src?.medium, width: x.width, height: x.height,
        download: x.src?.large2x || x.src?.original, pageUrl: x.url, author: x.photographer, authorUrl: x.photographer_url, alt: x.alt,
      })) };
    },
  },
  pixabay: {
    name: 'Pixabay', kinds: ['image', 'video'], hosts: ['pixabay.com', 'cdn.pixabay.com'],
    base: () => process.env.PIXABAY_BASE_URL || 'https://pixabay.com', key: (s) => s.pixabay?.apiKey,
    async search(q, { kind, page, per, orientation }, key) {
      const video = kind === 'video';
      const qs = new URLSearchParams({ key, q, page, per_page: Math.max(3, per), safesearch: 'true', ...(video ? {} : { image_type: 'photo', orientation: orientation === 'portrait' ? 'vertical' : orientation === 'landscape' ? 'horizontal' : 'all' }) });
      const j = await getJson(`${trim(this.base())}/api/${video ? 'videos/' : ''}?${qs}`, {}, 'Pixabay');
      return { total: j.totalHits || 0, items: (j.hits || []).map((x) => video ? ({
        id: String(x.id), kind: 'video', thumb: x.videos?.tiny?.thumbnail || x.videos?.small?.thumbnail, width: x.videos?.medium?.width, height: x.videos?.medium?.height, duration: x.duration,
        download: x.videos?.medium?.url || x.videos?.small?.url, pageUrl: x.pageURL, author: x.user, authorUrl: x.user_id ? `https://pixabay.com/users/${x.user}-${x.user_id}/` : null,
      }) : ({
        id: String(x.id), kind: 'image', thumb: x.webformatURL, width: x.imageWidth, height: x.imageHeight,
        download: x.largeImageURL, pageUrl: x.pageURL, author: x.user, authorUrl: x.user_id ? `https://pixabay.com/users/${x.user}-${x.user_id}/` : null, alt: x.tags,
      })) };
    },
  },
  unsplash: {
    name: 'Unsplash', kinds: ['image'], hosts: ['images.unsplash.com'],
    base: () => process.env.UNSPLASH_BASE_URL || 'https://api.unsplash.com', key: (s) => s.unsplash?.accessKey,
    async search(q, { page, per, orientation }, key) {
      const j = await getJson(`${trim(this.base())}/search/photos?${new URLSearchParams({ query: q, page, per_page: per, orientation: orientation === 'square' ? 'squarish' : orientation, content_filter: 'high' })}`, { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }, 'Unsplash');
      return { total: j.total || 0, items: (j.results || []).map((x) => ({
        id: String(x.id), kind: 'image', thumb: x.urls?.small, width: x.width, height: x.height,
        download: x.urls?.raw ? `${x.urls.raw}&w=1600&fm=jpg&q=85` : x.urls?.regular, downloadLocation: x.links?.download_location,
        pageUrl: x.links?.html, author: x.user?.name, authorUrl: x.user?.links?.html, alt: x.alt_description,
      })) };
    },
  },
};

function bestVideo(files) {
  // the smallest file that is still ≥ 1080 on its short side, else the largest — keeps downloads (and RAM) small
  const mp4 = files.filter((f) => /mp4/.test(f.file_type || 'mp4') && f.link);
  const short = (f) => Math.min(f.width || 0, f.height || 0);
  const ok = mp4.filter((f) => short(f) >= 1080).sort((a, b) => short(a) - short(b));
  return (ok[0] || mp4.sort((a, b) => short(b) - short(a))[0])?.link || null;
}

async function getJson(url, headers, name) {
  let res;
  try { res = await fetchRetry(url, { headers }, { timeout: 15000, retries: 1, label: name, retryStatus: new Set([500, 502, 503, 504]) }); } catch (e) { throw err(502, `${name} مش بيرد (${e.message})`); } // one retry on network errors / 5xx; 429 is reported to the user, not hammered
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || Number(res.headers.get('x-ratelimit-reset')) || 60;
    throw err(429, `${name}: الحد المسموح من الطلبات خلص — جرّب بعد ${Math.min(3600, wait)} ثانية`);
  }
  if (res.status === 401 || res.status === 403) throw err(401, `${name}: المفتاح مرفوض (${res.status}) — راجعه في الإعدادات ← المكتبات`);
  if (!res.ok) throw err(502, `${name} HTTP ${res.status}`);
  return res.json();
}

// ---- search with cache + Arabic query translation ----------------------------------------------
const cache = new Map(); const TTL = 10 * 60e3;
const qcache = new Map();
/** Stock libraries index English tags; an Arabic query is translated by the LLM (cached), falling back to the raw text. */
export async function queryFor(q) {
  if (!/[؀-ۿ]/.test(q)) return q;
  if (qcache.has(q)) return qcache.get(q);
  try {
    const { text } = await chatStream(getSettings(), [
      { role: 'system', content: '[[TASK:TRANSLATE_QUERY]]\nTranslate this Arabic stock-photo search into 1–4 English keywords. Reply with the keywords only.' },
      { role: 'user', content: q }], { temperature: 0, maxTokens: 30, idleMs: 20000 });
    const en = text.replace(/["'\n]/g, ' ').trim().slice(0, 60) || q;
    qcache.set(q, en);
    return en;
  } catch { return q; }
}

export function providerStatus() {
  const s = getSettings();
  return Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, kinds: p.kinds, configured: !!p.key(s), license: LIC[id] }]));
}

export async function search(providerId, q, { kind = 'image', page = 1, per = 20, orientation = 'portrait' } = {}) {
  const p = PROVIDERS[providerId];
  if (!p) throw err(404, 'unknown provider');
  if (!p.kinds.includes(kind)) throw err(400, `${p.name} مفيهوش ${kind === 'video' ? 'فيديو' : 'صور'}`);
  const key = p.key(getSettings());
  if (!key) throw err(400, `حط مفتاح ${p.name} في الإعدادات ← المكتبات`);
  const query = String(q || '').trim().slice(0, 100);
  if (!query) throw err(400, 'اكتب كلمة بحث');
  const used = await queryFor(query);
  const opts = { kind, page: Math.max(1, Number(page) || 1), per: Math.max(1, Math.min(40, Number(per) || 20)), orientation: ['portrait', 'landscape', 'square'].includes(orientation) ? orientation : 'portrait' };
  const ck = JSON.stringify([providerId, used, opts]);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  const r = await p.search(used, opts, key);
  const data = { provider: providerId, query: query, queryUsed: used, page: opts.page, total: r.total, items: r.items.filter((x) => x.download).map((x) => ({ ...x, provider: providerId, license: LIC[providerId] })) };
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

function allowedHost(p, url) {
  let u; try { u = new URL(url); } catch { return false; }
  const base = new URL(p.base());
  const local = u.hostname === '127.0.0.1' && base.hostname === '127.0.0.1'; // offline mocks
  return (u.protocol === 'https:' && p.hosts.includes(u.hostname)) || (local && u.port === base.port);
}

/** Downloads a search result into the library with source + licence. */
export async function importResult(providerId, item, { folder = 'stock', tags = [] } = {}) {
  const p = PROVIDERS[providerId];
  if (!p) throw err(404, 'unknown provider');
  if (!item?.download || !allowedHost(p, item.download)) throw err(400, 'رابط التحميل مش من مصدر المكتبة المسموح');
  const key = p.key(getSettings());
  if (providerId === 'unsplash' && item.downloadLocation && allowedHost({ ...p, hosts: ['api.unsplash.com'] }, item.downloadLocation)) {
    // required by the Unsplash API guidelines whenever a photo is used
    await fetch(item.downloadLocation, { headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
  const limit = LIMITS[item.kind === 'video' ? 'video' : 'image'];
  const res = await fetch(item.download, { signal: AbortSignal.timeout(120000), redirect: 'follow' }).catch((e) => { throw err(502, `التحميل فشل: ${e.message}`); });
  if (!res.ok || !res.body) throw err(502, `التحميل فشل: HTTP ${res.status}`);
  if (!allowedHost(p, res.url)) throw err(400, 'التحميل اتحوّل لمصدر مش مسموح');
  const dir = path.join(DATA_DIR, 'assets'); fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.dl-${crypto.randomBytes(6).toString('hex')}`);
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > limit) throw err(413, 'الملف أكبر من الحد المسموح');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  const lic = LIC[providerId];
  const attribution = item.author ? `${item.kind === 'video' ? 'Video' : 'Photo'} by ${item.author} on ${p.name}${item.pageUrl ? ` (${item.pageUrl})` : ''}` : `${p.name}${item.pageUrl ? ` (${item.pageUrl})` : ''}`;
  return addAssetFromFile(tmp, {
    name: item.alt ? String(item.alt).slice(0, 80) : `${p.name} ${item.id}`, folder, tags: [...tags, providerId],
    source: { type: providerId, provider: p.name, providerId: item.id, pageUrl: item.pageUrl, author: item.author, authorUrl: item.authorUrl },
    license: { ...lic, attribution },
  });
}
