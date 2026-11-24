// Font + asset library + stock providers, through the real HTTP server and the offline mocks.
// node tools/library-test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lib-'));
const MOCK_PORT = 4394, PORT = 4305, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body, headers: res.headers };
}

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'),
  LLM_BASE_URL: `${MOCK}/v1`, PEXELS_BASE_URL: `${MOCK}/pexels`, PIXABAY_BASE_URL: `${MOCK}/pixabay`, UNSPLASH_BASE_URL: `${MOCK}/unsplash`,
  PEXELS_API_KEY: 'pexels-test-key', PIXABAY_API_KEY: 'pixabay-test-key', UNSPLASH_ACCESS_KEY: 'unsplash-test-key' } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);

// sample media made with ffmpeg
const jpg = path.join(TMP, 'a.jpg'), mp4 = path.join(TMP, 'b.mp4'), mp3 = path.join(TMP, 'c.mp3');
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', jpg]);
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2', '-pix_fmt', 'yuv420p', mp4]);
execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', mp3]);
const upload = (file, headers = {}) => api('/api/assets', { method: 'POST', body: fs.readFileSync(file), headers: { 'X-Filename': encodeURIComponent(path.basename(file)), ...headers } });

await test('fonts: 10 bundled Arabic families, each OFL and servable; unknown files are not served', async () => {
  const { body } = await api('/api/fonts');
  const ids = body.fonts.map((f) => f.id);
  for (const id of ['plex', 'cairo', 'tajawal', 'amiri', 'notosansarabic', 'notonaskharabic', 'notokufiarabic', 'scheherazadenew', 'reemkufi', 'arefruqaa']) assert.ok(ids.includes(id), id);
  assert.ok(body.fonts.filter((f) => f.source === 'bundled').every((f) => /Open Font License/.test(f.license.name)));
  const r = await fetch(BASE + body.fonts.find((f) => f.id === 'cairo').faces[0].url);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).readUInt32BE(0), 0x00010000);
  assert.equal((await fetch(`${BASE}/fonts/cairo/..%2F..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/fonts/cairo/OFL.txt`)).status, 404, 'only files in the manifest');
});

await test('fonts: import needs a declared embedding right, rejects non-font bytes, and can be deleted', async () => {
  const font = fs.readFileSync(path.join(ROOT, 'assets/fonts/library/tajawal/Tajawal-Bold.ttf'));
  const no = await api('/api/fonts', { method: 'POST', body: font, headers: { 'X-Filename': 'T.ttf', 'X-Font-Name': 'Mine' } });
  assert.equal(no.status, 400);
  const bad = await api('/api/fonts', { method: 'POST', body: Buffer.from('<html>'), headers: { 'X-Filename': 'x.ttf', 'X-Font-License': 'own' } });
  assert.equal(bad.status, 415);
  const ok = await api('/api/fonts', { method: 'POST', body: font, headers: { 'X-Filename': 'T.ttf', 'X-Font-Name': encodeURIComponent('خطي'), 'X-Font-License': 'own', 'X-Font-Weight': '700' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, 'خطي');
  assert.equal((await fetch(BASE + ok.body.faces[0].url)).status, 200);
  assert.equal((await api(`/api/fonts/${ok.body.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await api('/api/fonts')).body.fonts.some((f) => f.id === ok.body.id));
});

let imgId;
await test('assets: image / video / audio uploads are sniffed, probed, thumbnailed and served', async () => {
  const a = await upload(jpg, { 'X-Folder': encodeURIComponent('علوم'), 'X-Tags': encodeURIComponent('سما, ضوء'), 'X-License-Name': 'CC0', 'X-License-Commercial': 'true' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.kind, 'image'); assert.equal(a.body.width, 640); assert.equal(a.body.folder, 'علوم'); assert.deepEqual(a.body.tags, ['سما', 'ضوء']);
  assert.equal(a.body.license.commercial, true);
  imgId = a.body.id;
  const v = await upload(mp4); assert.equal(v.body.kind, 'video'); assert.ok(Math.abs(v.body.duration - 2) < 0.2); assert.ok(v.body.thumb);
  const s = await upload(mp3); assert.equal(s.body.kind, 'audio'); assert.equal(s.body.thumb, null); assert.equal(s.body.license.commercial, 'check');
  assert.equal((await fetch(`${BASE}/api/assets/${imgId}/thumb`)).status, 200);
  const f = await fetch(`${BASE}/api/assets/${v.body.id}/file`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(f.status, 206);
});
await test('assets: a renamed HTML/text file is refused (415) and nothing is left behind', async () => {
  const before = (await api('/api/assets')).body.total;
  const r = await api('/api/assets', { method: 'POST', body: Buffer.from('<script>alert(1)</script>'), headers: { 'X-Filename': 'evil.jpg' } });
  assert.equal(r.status, 415);
  assert.equal((await api('/api/assets')).body.total, before);
  assert.deepEqual(fs.readdirSync(path.join(TMP, 'data/assets')).filter((x) => x.startsWith('.')), []);
});
await test('assets: search, filter by kind and folder, edit metadata, delete', async () => {
  assert.equal((await api('/api/assets?kind=video')).body.items.length, 1);
  assert.equal((await api(`/api/assets?q=${encodeURIComponent('ضوء')}`)).body.items[0].id, imgId);
  assert.deepEqual((await api('/api/assets')).body.folders, ['علوم']);
  const p = await api(`/api/assets/${imgId}`, { method: 'PATCH', body: JSON.stringify({ folder: 'fav', license: { attribution: 'by me' } }) });
  assert.equal(p.body.folder, 'fav'); assert.equal(p.body.license.attribution, 'by me'); assert.equal(p.body.license.name, 'CC0');
  assert.equal((await api(`/api/assets/${imgId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/assets/${imgId}`)).status, 404);
});

let found;
await test('providers: keys stay on the server; Arabic query is translated; results carry licence terms', async () => {
  const st = (await api('/api/providers')).body;
  assert.ok(st.pexels.configured && st.pixabay.configured && st.unsplash.configured);
  assert.ok(!JSON.stringify(st).includes('test-key'));
  const r = await api(`/api/providers/pexels/search?q=${encodeURIComponent('سما زرقا')}&kind=image`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.queryUsed, 'blue sky');
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.items[0].license.name, 'Pexels License');
  assert.ok(!JSON.stringify(r.body).includes('test-key'));
  found = r.body.items[0];
  const again = await api(`/api/providers/pexels/search?q=${encodeURIComponent('سما زرقا')}&kind=image`);
  assert.equal(again.body.cached, true);
});
await test('providers: import downloads into the library with source, author and attribution', async () => {
  const r = await api('/api/providers/pexels/import', { method: 'POST', body: JSON.stringify({ item: found }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.source.type, 'pexels'); assert.equal(r.body.source.author, 'Mock Photographer 1');
  assert.match(r.body.license.attribution, /Photo by Mock Photographer 1 on Pexels/);
  const v = await api('/api/providers/pixabay/search?q=sky&kind=video');
  const iv = await api('/api/providers/pixabay/import', { method: 'POST', body: JSON.stringify({ item: v.body.items[0] }) });
  assert.equal(iv.body.kind, 'video'); assert.equal(iv.body.license.name, 'Pixabay Content License');
});
await test('providers: Unsplash import registers the download (API guideline) and requires attribution', async () => {
  const s = await api('/api/providers/unsplash/search?q=sky');
  const r = await api('/api/providers/unsplash/import', { method: 'POST', body: JSON.stringify({ item: s.body.items[0] }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.license.attributionRequired, true);
  assert.equal((await (await fetch(`${MOCK}/media/_stats`)).json()).unsplashDownloads, 1);
});
await test('providers: download URLs outside the provider hosts are refused (no SSRF)', async () => {
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'https://evil.example.com/x.jpg', `http://127.0.0.1:${PORT}/api/settings`]) {
    const r = await api('/api/providers/pexels/import', { method: 'POST', body: JSON.stringify({ item: { ...found, download: u } }) });
    assert.equal(r.status, 400, u);
  }
});
await test('providers: a 429 becomes a clear retry message', async () => {
  await fetch(`${MOCK}/media/_ratelimit`);
  const r = await api('/api/providers/pixabay/search?q=rate-limit-test');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /42/);
});

console.log(`\n${n} library tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
