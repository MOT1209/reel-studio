// Reel Studio — local HTTP server (127.0.0.1 only). No framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getSettings, getPublicSettings, updateSettings, resolveFonts } from './settings.mjs';
import { listVoices, testLlm, testElevenLabs, testDeepgram, testOpenAITts } from './apis.mjs';
import { STYLE_FILE, EXAMPLES_DIR, readExamples } from './text.mjs';
import { youtubeStatus, startAuth, finishAuth, unlinkYoutube } from './youtube.mjs';

const TESTS = { llm: testLlm, elevenlabs: testElevenLabs, deepgram: testDeepgram, openaiTts: testOpenAITts };
import { iconLicenses } from './icons.mjs';
import { checkFfmpeg, killAllChildren } from './render.mjs';
import * as EM from './engines/manager.mjs';
import { SCHEMA } from './scene-schema.mjs';
import { BUNDLE_DIR as REMOTION_DIR } from './engines/remotion.mjs';
import * as P from './pipeline.mjs';
import { log as slog, redact, logFile } from './logger.mjs';
import * as AR from './arabic.mjs';
import { buildCues, toSrt, toVtt } from './subtitles.mjs';
import * as F from './fonts.mjs';
import * as A from './assets.mjs';
import * as PV from './providers.mjs';
import * as SK from './skills.mjs';
import * as MCP from './mcp.mjs';
import { PLATFORMS } from './platforms.mjs';

const HOST = '127.0.0.1';
// Upload limit for a voice-over (MB). RS_MAX_UPLOAD_MB must be an integer 1–2000.
const UPLOAD_LIMIT = (() => { const v = Number(process.env.RS_MAX_UPLOAD_MB); return Number.isInteger(v) && v >= 1 && v <= 2000 ? v * 1024 * 1024 : 200 * 1024 * 1024; })();
const PORT = Number(process.env.RS_PORT || process.env.PORT || 4301);
P.setServerPort(PORT);
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.vtt': 'text/vtt; charset=utf-8', '.srt': 'application/x-subrip; charset=utf-8' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { if (size - c.length <= limit) { reject(P.httpError(413, 'body too large')); req.pause(); } } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 4 * 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw P.httpError(400, 'invalid JSON'); }
}

/** decodeURIComponent that answers 400 instead of crashing on malformed escapes ("%E0%A4%A"). */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { throw P.httpError(400, 'malformed URL encoding'); }
}

function sendFile(req, res, file, { cache = 'no-cache' } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
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
  const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
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
      if (m === 'PUT') { const out = updateSettings(await readJson(req)); applyMaxJobs(); return json(res, 200, out); }
    }
    // rendering engines: availability (?fresh=1 re-checks), the selected default, and the render jobs of this session
    if (a === 'scene-schema' && m === 'GET') return json(res, 200, SCHEMA);
    if (a === 'projects' && id && b === 'scenes' && stage !== undefined && action === 'regenerate' && m === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await P.regenerateScene(id, stage, { hint: body?.hint }));
    }
    if (a === 'engines' && !id && m === 'GET') {
      const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
      return json(res, 200, { ...(await EM.engineStatus({ fresh })), selected: getSettings().render.engine || 'auto', jobs: EM.listJobs() });
    }
    if (a === 'render-jobs') {
      if (!id && m === 'GET') return json(res, 200, { jobs: EM.listJobs() });
      if (id && !b && m === 'GET') { const j = EM.getJob(id); return j ? json(res, 200, j) : json(res, 404, { error: 'no such job' }); }
      if (id && b === 'cancel' && m === 'POST') return json(res, 200, { ok: EM.cancelJob(id) });
    }
    if (a === 'queue' && m === 'GET') return json(res, 200, EM.queueSnapshot());
    if (a === 'voices' && m === 'GET') return json(res, 200, { voices: await listVoices(getSettings()) });
    if (a === 'test' && m === 'POST' && TESTS[id]) {
      // optional unsaved values from the Settings form (masked keys are ignored → saved key is used)
      const body = await readJson(req);
      const s = getSettings();
      const sec = id === 'llm' ? 'llm' : id;
      const locked = getPublicSettings()._source;
      for (const [k, v] of Object.entries(body || {})) {
        if (locked[`${sec}.${k}`] === 'env (locked)') continue; // a base URL pinned in .env cannot be redirected from the browser
        if (typeof v === 'string' && v.trim() && !v.startsWith('••••') && Object.hasOwn(s[sec], k)) s[sec][k] = v.trim();
      }
      try { return json(res, 200, await TESTS[id](s)); }
      catch (e) { return json(res, 200, { ok: false, message: e.message }); }
    }
    if (a === 'style') {
      if (!id && m === 'GET') return json(res, 200, { style: fs.readFileSync(STYLE_FILE, 'utf8'), examples: readExamples(1e9).map((e) => ({ file: e.file, text: e.text })) });
      if (!id && m === 'PUT') {
        const { style } = await readJson(req);
        if (typeof style !== 'string' || style.trim().length < 20) throw P.httpError(400, 'style guide is empty');
        fs.writeFileSync(STYLE_FILE, style.replace(/\r\n/g, '\n'));
        return json(res, 200, { ok: true });
      }
      if (id === 'examples' && m === 'POST') {
        const { name, text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) throw P.httpError(400, 'example text is empty');
        const safe = (String(name || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || `example-${Date.now()}`) + '.md';
        fs.mkdirSync(EXAMPLES_DIR, { recursive: true });
        fs.writeFileSync(path.join(EXAMPLES_DIR, safe), text.replace(/\r\n/g, '\n'));
        return json(res, 201, { file: safe });
      }
      if (id === 'examples' && b && m === 'DELETE') {
        const f = path.join(EXAMPLES_DIR, path.basename(b));
        if (!/\.(md|txt)$/i.test(f) || !fs.existsSync(f)) throw P.httpError(404, 'example not found');
        fs.rmSync(f);
        return json(res, 200, { ok: true });
      }
    }
    if (a === 'youtube') {
      if (m === 'GET') return json(res, 200, youtubeStatus());
      if (m === 'DELETE') { await unlinkYoutube(); return json(res, 200, youtubeStatus()); }
    }
    if (a === 'icons' && id === 'licenses') return json(res, 200, iconLicenses());
    // ---- fonts -------------------------------------------------------------------------
    if (a === 'fonts') {
      if (!id && m === 'GET') return json(res, 200, { fonts: F.listFonts(), defaults: F.TYPO_DEFAULTS, styles: F.CAPTION_STYLES, typography: F.typographyFor(null) });
      if (!id && m === 'POST') {
        const buf = await readBody(req, 20 * 1024 * 1024);
        return json(res, 201, F.importFont({ name: safeDecode(String(req.headers['x-font-name'] || '')), file: safeDecode(String(req.headers['x-filename'] || '')), buf, weight: String(req.headers['x-font-weight'] || '400'), license: String(req.headers['x-font-license'] || '') }));
      }
      if (id && m === 'DELETE') { F.deleteFont(id); return json(res, 200, { ok: true }); }
    }
    // ---- asset library -------------------------------------------------------------------
    if (a === 'assets') {
      if (!id && m === 'GET') return json(res, 200, A.listAssets(Object.fromEntries(url.searchParams)));
      if (!id && m === 'POST') {
        const tmp = await A.streamToTemp(req, A.LIMITS.video);
        const h = (k) => safeDecode(String(req.headers[k] || ''));
        const meta = await A.addAssetFromFile(tmp, {
          name: h('x-filename'), folder: h('x-folder'), tags: h('x-tags'), source: { type: 'upload' },
          license: { name: h('x-license-name') || 'ملك المستخدم', commercial: h('x-license-commercial') === 'false' ? false : h('x-license-commercial') === 'true' ? true : 'check', attribution: h('x-license-attribution') || null, notes: h('x-license-notes') || null },
        });
        return json(res, 201, meta);
      }
      const asset = A.getAsset(id);
      if (!asset) return json(res, 404, { error: 'asset not found' });
      if (!b && m === 'GET') return json(res, 200, asset);
      if (!b && m === 'PATCH') return json(res, 200, A.updateAsset(id, await readJson(req)));
      if (!b && m === 'DELETE') { A.deleteAsset(id); return json(res, 200, { ok: true }); }
      if (b === 'file') return sendFile(req, res, A.assetFile(asset), { cache: 'max-age=86400' });
      if (b === 'thumb' && asset.thumb) return sendFile(req, res, path.join(A.assetDir(id), 'thumb.jpg'), { cache: 'max-age=86400' });
      if (b === 'scaled') return sendFile(req, res, await A.scaledFile(asset, url.searchParams.get('max')), { cache: 'max-age=86400' });
    }
    if (a === 'providers') {
      if (!id && m === 'GET') return json(res, 200, PV.providerStatus());
      if (b === 'search' && m === 'GET') return json(res, 200, await PV.search(id, url.searchParams.get('q'), Object.fromEntries(url.searchParams)));
      if (b === 'import' && m === 'POST') { const body = await readJson(req); return json(res, 201, await PV.importResult(id, body.item, { folder: body.folder || 'stock' })); }
    }
    // ---- skills + MCP --------------------------------------------------------------------
    if (a === 'skills') {
      if (!id && m === 'GET') return json(res, 200, { skills: SK.listSkills(), runs: SK.runLog(50) });
      if (!id && m === 'POST') return json(res, 201, SK.saveSkill(await readJson(req)));
      if (id === 'import' && m === 'POST') return json(res, 201, { imported: SK.importSkills(await readJson(req)) });
      if (id && !b && m === 'PUT') return json(res, 200, SK.saveSkill({ ...(await readJson(req)), id }, { replace: true }));
      if (id && !b && m === 'PATCH') return json(res, 200, SK.setEnabled(id, (await readJson(req)).enabled));
      if (id && !b && m === 'DELETE') { SK.deleteSkill(id); return json(res, 200, { ok: true }); }
      if (id && b === 'export' && m === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="skill-${id}.json"` });
        return res.end(JSON.stringify(SK.exportSkill(id), null, 2));
      }
      if (id && b === 'run' && m === 'POST') {
        const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); }); // client went away
        return json(res, 200, await SK.runSkill(id, await readJson(req), { signal: ctl.signal }));
      }
    }
    if (a === 'mcp') {
      if (!id && m === 'GET') return json(res, 200, { servers: MCP.listServers(), calls: MCP.callLog(50) });
      if (!id && m === 'POST') return json(res, 201, MCP.upsertServer(await readJson(req)));
      if (id && !b && m === 'PUT') return json(res, 200, MCP.upsertServer({ ...(await readJson(req)), id }));
      if (id && !b && m === 'DELETE') { MCP.removeServer(id); return json(res, 200, { ok: true }); }
      if (id && b === 'sync' && m === 'POST') return json(res, 200, await MCP.syncServer(id));
      if (id && b === 'permissions' && m === 'PUT') return json(res, 200, MCP.setPermissions(id, await readJson(req)));
      if (id && b === 'call' && m === 'POST') { const body = await readJson(req); return json(res, 200, await MCP.callTool(id, body.tool, body.arguments || {})); }
    }
    if (a === 'platforms' && m === 'GET') return json(res, 200, { platforms: PLATFORMS });
    if (a === 'logs' && m === 'GET') {
      let lines = [];
      try { lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-Math.min(1000, Number(url.searchParams.get('tail')) || 200)); } catch {}
      return json(res, 200, { lines: lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { msg: l }; } }) });
    }
    if (a === 'arabic' && m === 'POST') {
      const { text } = await readJson(req);
      if (typeof text !== 'string') throw P.httpError(400, 'text is required');
      if (id === 'analyze') return json(res, 200, { ...AR.detectDialect(text), sentences: AR.sentences(text), tashkeel: AR.hasTashkeel(text) });
      const local = { 'strip-tashkeel': AR.stripTashkeel, 'arabic-digits': AR.toArabicDigits, 'latin-digits': AR.toLatinDigits };
      if (local[id]) { const out = local[id](text); return json(res, 200, { op: id, text: out, diff: AR.wordDiff(text, out), warnings: [] }); }
      if (AR.OPS[id]) {
        const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); }); // client went away
        return json(res, 200, await AR.rewrite(id, text, { signal: ctl.signal }));
      }
      throw P.httpError(404, 'unknown Arabic operation');
    }
    if (a === 'arabic' && id === 'ops' && m === 'GET') return json(res, 200, { ops: Object.fromEntries(Object.entries(AR.OPS).map(([k, v]) => [k, v.label])) });
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
      if (b === 'voice-mode' && m === 'PUT') { await P.setVoiceMode(id, (await readJson(req)).mode); return json(res, 200, P.publicProject(p)); }
      if (b === 'upload' && m === 'POST') {
        const name = safeDecode(String(req.headers['x-filename'] || '')); // before anything reaches disk: a bad name leaves no temp file
        const tmp = await A.streamToTemp(req, UPLOAD_LIMIT); // streamed to disk, never buffered whole in RAM
        await P.saveUploadFile(id, tmp, name, req.headers['content-type']);
        return json(res, 200, P.publicProject(p));
      }
      if (b === 'publish' && m === 'POST') {
        if (stage === 'cancel') { P.cancelPublish(id); return json(res, 200, { ok: true }); }
        const body = await readJson(req);
        let early = null;
        P.publishProject(id, body).catch((e) => { early = e; });
        await new Promise((r) => setImmediate(r)); // validation errors reject synchronously
        if (early) throw early;
        return json(res, 202, { started: true });
      }
      if (b === 'options' && m === 'PUT') {
        const body = await readJson(req);
        if (typeof body.publish === 'boolean') P.setPublishOption(id, body.publish);
        return json(res, 200, P.publicProject(p));
      }
      if (b === 'render-data' && m === 'GET') return json(res, 200, P.renderData(p, { chapter: url.searchParams.get('chapter') || null }));
      if (b === 'edit' && m === 'PUT') return json(res, 200, await P.saveEdit(id, await readJson(req)));
      if (b === 'clips' && stage && action && m === 'GET') {
        // extracted video-clip frames: /api/projects/<id>/clips/<key>/f_00001.jpg
        if (!/^[a-f0-9]{12}-[\d.]+-[\d.]+-\d+-\d+x\d+$/.test(stage) || !/^f_\d{5}\.jpg$/.test(action)) return json(res, 404, { error: 'not found' });
        return sendFile(req, res, path.join(P.projectDir(id), 'clips', stage, action), { cache: 'max-age=3600' });
      }
      if ((b === 'subtitles.srt' || b === 'subtitles.vtt') && m === 'GET') {
        if (!p.words?.length) throw P.httpError(409, 'timing is not done yet');
        const cues = buildCues(p.words, P.subtitleOptions(p));
        const vtt = b.endsWith('.vtt');
        res.writeHead(200, { 'Content-Type': `${vtt ? 'text/vtt' : 'application/x-subrip'}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${p.id}.${vtt ? 'vtt' : 'srt'}"`, 'Cache-Control': 'no-store' });
        return res.end('\uFEFF' + (vtt ? toVtt(cues) : toSrt(cues)));
      }
      if (b === 'files' && stage && FILE_RE.test(stage)) return sendFile(req, res, path.join(P.projectDir(id), stage));
      if (b === 'stages' && P.STAGES.includes(stage)) {
        if (action === 'approve' && m === 'POST') { await P.approve(id, stage); return json(res, 200, { ok: true }); }
        if (action === 'rerun' && m === 'POST') { await P.rerun(id, stage); return json(res, 200, { ok: true }); }
        if (!action && m === 'PUT') { await P.editStage(id, stage, await readJson(req)); return json(res, 200, P.publicProject(p)); }
      }
    }
    return json(res, 404, { error: 'unknown endpoint' });
  }

  if (parts[0] === 'oauth' && parts[1] === 'youtube') {
    const redirectUri = `http://127.0.0.1:${PORT}/oauth/youtube/callback`;
    if (parts[2] === 'start') { res.writeHead(302, { Location: startAuth(redirectUri), 'Cache-Control': 'no-store' }); return res.end(); }
    if (parts[2] === 'callback') {
      let ok = true, msg;
      try { const ch = await finishAuth(Object.fromEntries(url.searchParams)); msg = `اتربطت قناة «${ch.title}» ✔`; }
      catch (e) { ok = false; msg = e.message; }
      const safe = String(msg).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>YouTube</title>
<body style="background:#0C1014;color:#F4F3EE;font:18px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><p style="color:${ok ? '#36C98F' : '#F28A30'}">${safe}</p><p style="color:#9AA5AE;font-size:14px">تقدر تقفل الصفحة دي وترجع لـ Reel Studio.</p></div>
<script>try{window.opener&&window.opener.postMessage({youtube:${ok}},location.origin)}catch(e){};${ok ? 'setTimeout(()=>window.close(),1500)' : ''}</script></body></html>`);
    }
  }
  if (parts[0] === 'fonts' && parts[1] && parts[2]) {
    const f = F.fontFile(parts[1], parts[2]);
    if (!f) return json(res, 404, { error: 'font not found' });
    return sendFile(req, res, f, { cache: 'max-age=86400' });
  }
  if (parts[0] === 'font' && parts[1]) {
    const fonts = resolveFonts();
    const name = path.basename(parts[1]);
    let f = path.join(fonts.dir, name);
    if (!fs.existsSync(f)) f = path.join(ROOT, 'assets', 'fonts', name); // UI always has the bundled font
    return sendFile(req, res, f, { cache: 'max-age=3600' });
  }
  if (m !== 'GET' && m !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  // the Remotion composition bundle (built by engines/remotion.mjs), same origin as render data and fonts
  if (parts[0] === 'remotion') {
    const file = path.resolve(REMOTION_DIR, parts.length > 1 ? parts.slice(1).join('/') : 'index.html');
    if (!file.startsWith(REMOTION_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
    return sendFile(req, res, file);
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  return sendFile(req, res, file);
}

process.on('unhandledRejection', (e) => slog('error', 'unhandled rejection', { err: e?.message || String(e) }));

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: only answer to our own host names.
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) { res.writeHead(421); return res.end('misdirected request'); }
  try { await route(req, res); }
  catch (e) {
    if (!res.headersSent) {
      if (e.status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); } // answer first, then drop the oversized upload
      json(res, e.status || 500, { error: redact(e.message) });
    }
    else res.end();
    if (!e.status) slog('error', 'request failed', { method: req.method, path: req.url.split('?')[0], err: e, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
  }
});
let closing = false;
/** SIGINT/SIGTERM: stop accepting requests, cancel running stages, kill ffmpeg + Chromium, flush projects, exit. */
async function gracefulShutdown(sig) {
  if (closing) return; closing = true;
  slog('info', `${sig} received — shutting down`);
  const force = setTimeout(() => { killAllChildren().finally(() => process.exit(1)); }, 8000); force.unref();
  server.close();
  server.closeAllConnections?.();
  try { const n = await P.shutdown(); if (n) slog('info', `stopped ${n} running job(s)`); } catch (e) { slog('error', 'shutdown error', { err: e }); }
  await killAllChildren();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gracefulShutdown(sig));

EM.setJobLog(path.join(path.dirname(logFile), 'render-jobs.jsonl'));
const MAX_ENV = EM.parseLimit(process.env.RS_MAX_RENDERS);
if (MAX_ENV.note) slog('warn', MAX_ENV.note);
function applyMaxJobs() { EM.setMaxJobs(MAX_ENV.n ?? getSettings().render.maxJobs); }
applyMaxJobs();
server.listen(PORT, HOST, async () => {
  const ff = await checkFfmpeg();
  console.log(`Reel Studio v3 → http://${HOST}:${PORT}`);
  if (!ff) console.warn('⚠ ffmpeg not found in PATH (set FFMPEG_PATH) — rendering will fail.');
});
