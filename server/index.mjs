// Reel Studio v1 — local HTTP server (127.0.0.1 only). No framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getSettings, getPublicSettings, updateSettings, resolveFonts } from './settings.mjs';
import { listVoices } from './apis.mjs';
import { iconLicenses } from './icons.mjs';
import { checkFfmpeg } from './render.mjs';
import * as P from './pipeline.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.RS_PORT || process.env.PORT || 4301);
P.setServerPort(PORT);
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(P.httpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 4 * 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw P.httpError(400, 'invalid JSON'); }
}

function sendFile(req, res, file, { cache = 'no-cache' } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': cache });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function sse(req, res, id) {
  const p = P.getProject(id);
  if (!p) return json(res, 404, { error: 'project not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  send({ type: 'state', data: P.publicProject(p) });
  if (p.lastPreview) send({ type: 'preview', data: { jpeg: p.lastPreview.toString('base64') } });
  const onEvent = (ev) => send(ev);
  P.bus(id).on('event', onEvent);
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); P.bus(id).off('event', onEvent); });
}

const FILE_RE = /^(voice\.mp3|video\.mp4|contact\.jpg|mix\.m4a|upload\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mp4))$/;

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method;

  if (parts[0] === 'api') {
    // CSRF guard: state-changing calls must come from this origin.
    if (m !== 'GET' && m !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'cross-origin request refused' });
    }
    const [, a, id, b, stage, action] = parts;
    if (a === 'health' && m === 'GET') {
      const fonts = resolveFonts();
      return json(res, 200, { ok: true, ffmpeg: await checkFfmpeg(), fonts: { dir: fonts.custom ? fonts.dir : 'bundled', regular: fonts.regular, bold: fonts.bold } });
    }
    if (a === 'settings') {
      if (m === 'GET') return json(res, 200, getPublicSettings());
      if (m === 'PUT') return json(res, 200, updateSettings(await readJson(req)));
    }
    if (a === 'voices' && m === 'GET') return json(res, 200, { voices: await listVoices(getSettings()) });
    if (a === 'icons' && id === 'licenses') return json(res, 200, iconLicenses());
    if (a === 'projects') {
      if (!id) {
        if (m === 'GET') return json(res, 200, { projects: P.listProjects() });
        if (m === 'POST') {
          const body = await readJson(req);
          const p = P.createProject(body);
          if (body.autostart !== false) P.runPipeline(p.id);
          return json(res, 201, P.publicProject(p));
        }
      }
      const p = P.getProject(id);
      if (!p) return json(res, 404, { error: 'project not found' });
      if (!b) {
        if (m === 'GET') return json(res, 200, P.publicProject(p));
        if (m === 'DELETE') { await P.deleteProject(id); return json(res, 200, { ok: true }); }
      }
      if (b === 'events' && m === 'GET') return sse(req, res, id);
      if (b === 'run' && m === 'POST') return json(res, 200, { started: P.runPipeline(id) });
      if (b === 'cancel' && m === 'POST') return json(res, 200, { cancelled: await P.cancel(id) });
      if (b === 'approvals' && m === 'PUT') { P.setApprovals(id, await readJson(req)); return json(res, 200, P.publicProject(p)); }
      if (b === 'voice-mode' && m === 'PUT') { P.setVoiceMode(id, (await readJson(req)).mode); return json(res, 200, P.publicProject(p)); }
      if (b === 'upload' && m === 'POST') {
        const buf = await readBody(req, 200 * 1024 * 1024);
        P.saveUpload(id, buf, decodeURIComponent(req.headers['x-filename'] || ''), req.headers['content-type']);
        return json(res, 200, P.publicProject(p));
      }
      if (b === 'render-data' && m === 'GET') return json(res, 200, P.renderData(p));
      if (b === 'files' && stage && FILE_RE.test(stage)) return sendFile(req, res, path.join(P.projectDir(id), stage));
      if (b === 'stages' && P.STAGES.includes(stage)) {
        if (action === 'approve' && m === 'POST') { await P.approve(id, stage); return json(res, 200, { ok: true }); }
        if (action === 'rerun' && m === 'POST') { await P.rerun(id, stage); return json(res, 200, { ok: true }); }
        if (!action && m === 'PUT') { await P.editStage(id, stage, await readJson(req)); return json(res, 200, P.publicProject(p)); }
      }
    }
    return json(res, 404, { error: 'unknown endpoint' });
  }

  if (parts[0] === 'font' && parts[1]) {
    const fonts = resolveFonts();
    const name = path.basename(parts[1]);
    let f = path.join(fonts.dir, name);
    if (!fs.existsSync(f)) f = path.join(ROOT, 'assets', 'fonts', name); // UI always has the bundled font
    return sendFile(req, res, f, { cache: 'max-age=3600' });
  }
  if (m !== 'GET' && m !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  return sendFile(req, res, file);
}

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message || e));

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: only answer to our own host names.
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) { res.writeHead(421); return res.end('misdirected request'); }
  try { await route(req, res); }
  catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, HOST, async () => {
  const ff = await checkFfmpeg();
  console.log(`Reel Studio v1 → http://${HOST}:${PORT}`);
  if (!ff) console.warn('⚠ ffmpeg not found in PATH (set FFMPEG_PATH) — rendering will fail.');
});
