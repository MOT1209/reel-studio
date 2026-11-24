// End-to-end test against the offline mocks:
//  create a 10 s project → approve the script → wait for the render → check every stage,
//  the video format, loudness, and caption ↔ voice sync. Also exercises the upload/Deepgram path,
//  approvals and cancel. Leaves the finished reel in output/test-reel-10s.mp4.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = Number(process.env.MOCK_PORT || 4399);
const PORT = Number(process.env.E2E_PORT || 4302);
const DATA = path.join(ROOT, 'data', 'e2e');
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TOPIC = process.env.E2E_TOPIC || 'ليه السما لونها أزرق؟';
const OUT_NAME = `test-reel-10s${process.env.E2E_THEME && process.env.E2E_THEME !== 'dark' ? '-' + process.env.E2E_THEME : ''}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function start(cmd, args, env, tag) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  procs.push(p);
  return p;
}
const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });
process.on('exit', cleanup);

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}
async function waitFor(desc, fn, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    // network hiccups are retried; a fatal error (failed stage) stops the wait at once
    const v = await fn().catch((e) => { if (e.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(500);
  }
}
const stageOf = async (id) => (await api(`/api/projects/${id}`)).stages;

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  start('node', ['tools/mock-apis.mjs'], { MOCK_PORT: String(MOCK_PORT) }, 'mock');
  start('node', ['server/index.mjs'], {
    RS_PORT: String(PORT), RS_DATA_DIR: DATA,
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LLM_API_KEY: '', ELEVENLABS_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_VOICE_ID: '', YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '',
    YT_AUTH_URL: `http://127.0.0.1:${MOCK_PORT}/yt/auth`, YT_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/yt/token`, YT_REVOKE_URL: `http://127.0.0.1:${MOCK_PORT}/yt/revoke`,
    YT_API_URL: `http://127.0.0.1:${MOCK_PORT}/yt/api`, YT_UPLOAD_URL: `http://127.0.0.1:${MOCK_PORT}/yt/upload`, YT_CHUNK_BYTES: String(512 * 1024),
  }, 'app');
  await waitFor('server', () => api('/api/health'), 90000);
  await waitFor('mock', () => fetch(`http://127.0.0.1:${MOCK_PORT}/v1/voices`, { headers: { 'xi-api-key': 'x' } }).then((r) => r.ok), 90000);
  const h = await api('/api/health');
  check('server up, ffmpeg found', !!h.ffmpeg, h.ffmpeg?.slice(0, 40));

  // --- settings: keys are masked to the last 4 chars ----------------------------------
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm: { apiKey: 'sk-e2e-SECRET-9876' }, elevenlabs: { apiKey: 'el-e2e-SECRET-5555' }, deepgram: { apiKey: 'dg-e2e-SECRET-4444' } }) });
  const raw = JSON.stringify(await api('/api/settings'));
  check('settings never expose full keys', !raw.includes('SECRET') && raw.includes('••••9876') && raw.includes('••••5555'));
  const { voices } = await api('/api/voices');
  check('load voices (ElevenLabs /v1/voices)', voices.length > 0, voices.map((v) => v.name).join(', '));
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ elevenlabs: { voiceId: voices[0].id } }) });
  const xo = await fetch(BASE + '/api/settings', { method: 'PUT', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  check('cross-origin writes are refused', xo.status === 403);

  // --- connection tests, style, auto length -------------------------------------------
  const tests = {};
  for (const svc of ['llm', 'elevenlabs', 'deepgram']) tests[svc] = await api(`/api/test/${svc}`, { method: 'POST', body: '{}' });
  check('«اختبار الاتصال» works for LLM / ElevenLabs / Deepgram', Object.values(tests).every((r) => r.ok), Object.values(tests).map((r) => r.message).join(' | '));
  // every base URL is pinned by .env here, so the form cannot point the saved key at another host
  const pinned = await api('/api/test/deepgram', { method: 'POST', body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1' }) });
  check('connection test cannot redirect a .env-pinned base URL', pinned.ok === true, pinned.message.slice(0, 60));
  const style = await api('/api/style');
  check('style guide + reference scripts readable from the app', style.style.includes('عارف ليه') && style.examples.length >= 1, `${style.examples.length} example(s)`);
  const pa = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: TOPIC, seconds: 'auto', approvals: { script: 'wait' } }) });
  await waitFor('auto script review', async () => (await stageOf(pa.id)).script.status === 'review', 60000);
  const pav = await api(`/api/projects/${pa.id}`);
  check('length "auto": the LLM picks the length', pav.seconds === 'auto' && pav.script.words > 30 && pav.stages.script.log.some((l) => /length: auto/.test(l)), `${pav.script.words} words ≈ ${(pav.script.words / 2.6).toFixed(0)} s`);
  await api(`/api/projects/${pa.id}`, { method: 'DELETE' });
  // paper theme for the main reel (the renderer must take its palette from settings)
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ look: { theme: process.env.E2E_THEME || 'dark' } }) });

  // --- project 1: TTS, wait for script approval, then full auto ----------------------
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: TOPIC, seconds: 10, approvals: { script: 'wait' } }) });
  // SSE: collect event types while it runs
  const seen = new Set();
  const sseCtl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/projects/${p.id}/events`, { signal: sseCtl.signal });
    const rd = res.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; for (const m of dec.decode(value).matchAll(/^event: (\w+)/gm)) seen.add(m[1]); }
  })().catch(() => {});
  await waitFor('script review', async () => (await stageOf(p.id)).script.status === 'review', 60000);
  let proj = await api(`/api/projects/${p.id}`);
  check('script stage stops for approval', proj.stages.voice.status === 'idle');
  check('script has TITLE/SCRIPT/SOURCES', !!proj.script.title && proj.script.text.length > 10 && proj.script.sources.length > 0, `"${proj.script.title}", ${proj.script.words} words`);
  check('<think> blocks stripped', !/think/i.test(JSON.stringify(proj.script)));
  check('series question present', /عارف ليه؟/.test(proj.script.text));
  await api(`/api/projects/${p.id}/stages/script/approve`, { method: 'POST' });
  const t0 = Date.now();
  await waitFor('render', async () => { const s = await stageOf(p.id); if (Object.values(s).some((x) => x.status === 'error')) throw Object.assign(new Error('stage failed: ' + JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, x]) => [k, x.error || x.status])))), { fatal: true }); return s.render.status === 'done'; }, 10 * 60000);
  proj = await api(`/api/projects/${p.id}`);
  sseCtl.abort();
  check('all 5 stages done', Object.values(proj.stages).every((s) => s.status === 'done'), `render took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check('SSE delivered state/log/llm/progress/preview', ['state', 'log', 'llm', 'progress', 'preview'].every((e) => seen.has(e)), [...seen].join(','));
  check('timing: words aligned, none weak', proj.words.length === proj.script.words && proj.timing.weak === 0, `${proj.words.length} words, match ${proj.timing.matchAvg}`);
  const sb = proj.storyboard;
  check('storyboard: first scene intro@0, sorted, valid', sb.scenes[0].type === 'intro' && sb.scenes[0].at === 0 && sb.scenes.every((s, i) => !i || s.at > sb.scenes[i - 1].at) && sb.scenes.every((s) => s.at < proj.words.length));
  check('storyboard: validator repaired the messy draft', proj.stages.storyboard.log.some((l) => /fix:/.test(l)));
  check('storyboard: no template 3× in a row', sb.scenes.every((s, i) => i < 2 || !(s.template === sb.scenes[i - 1].template && s.template === sb.scenes[i - 2].template)));
  check('storyboard: self-review pass ran', proj.stages.storyboard.log.some((l) => /self-review/.test(l)));

  // --- video file ------------------------------------------------------------------
  const dir = path.join(DATA, 'projects', p.id);
  const video = path.join(dir, 'video.mp4');
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]).toString());
  const vs = probe.streams.find((s) => s.codec_type === 'video'), as = probe.streams.find((s) => s.codec_type === 'audio');
  check('video: H.264 yuv420p 1080×1920 30 fps', vs.codec_name === 'h264' && vs.pix_fmt === 'yuv420p' && vs.width === 1080 && vs.height === 1920 && vs.r_frame_rate === '30/1', `${vs.codec_name} ${vs.pix_fmt} ${vs.width}×${vs.height} ${vs.r_frame_rate}`);
  const dur = Number(probe.format.duration);
  check('video: duration ≈ 10 s reel', dur > 8 && dur < 14 && Math.abs(dur - proj.render.duration) < 0.15, `${dur.toFixed(2)} s`);
  check('audio: AAC present', as?.codec_name === 'aac');
  const lufsOut = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', video, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr;
  let lufs = NaN;
  try { lufs = Number(lufsOut.split('Summary:')[1].match(/I:\s*(-?[\d.]+) LUFS/)[1]); } catch {}
  check('audio: integrated loudness −14 LUFS (±1)', Math.abs(lufs + 14) <= 1, `${lufs} LUFS`);
  check('contact sheet written', fs.existsSync(path.join(dir, 'contact.jpg')));

  // --- caption sync ----------------------------------------------------------------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--disable-gpu'] }).catch(() => chromium.launch({ channel: 'chrome' }));
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto(`${BASE}/render.html?project=${p.id}`);
  await page.waitForFunction(() => window.__ready || window.__error);
  const syncRes = await page.evaluate(() => {
    const W = window.renderData.words, FPS = window.renderData.fps, bad = [];
    let maxLag = 0;
    for (const w of W) {
      const first = Math.ceil(w.start * FPS - 1e-9); // first frame index at/after onset
      const litAt = window.captionState(first / FPS).lit.includes(w.i);
      const before = first > 0 ? window.captionState((first - 1) / FPS).lit.includes(w.i) : false;
      if (!litAt || before) bad.push(w.i);
      maxLag = Math.max(maxLag, first / FPS - w.start);
    }
    return { bad, maxLag, n: W.length };
  });
  check('captions: each word lights on its first frame at/after onset, never before', syncRes.bad.length === 0, `${syncRes.n} words, max quantisation lag ${(syncRes.maxLag * 1000).toFixed(0)} ms`);
  await browser.close();

  // Onsets of the (mock) voice vs word timings: the fake voice starts each word with a sharp attack.
  const env = rmsEnvelope(path.join(dir, 'voice.mp3'));
  const errs = proj.words.map((w) => { const on = onsetNear(env, w.start); return on == null ? 9 : Math.abs(on - w.start); });
  const med = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)], mx = Math.max(...errs);
  check('voice ↔ word timing: audible onsets match caption onsets', med < 0.04 && mx < 0.1, `median ${(med * 1000).toFixed(0)} ms, max ${(mx * 1000).toFixed(0)} ms`);

  fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
  fs.copyFileSync(video, path.join(ROOT, 'output', `${OUT_NAME}.mp4`));
  fs.copyFileSync(path.join(dir, 'contact.jpg'), path.join(ROOT, 'output', `${OUT_NAME}-contact.jpg`));

  // --- YouTube: link (OAuth + PKCE, mocked consent) → publish → unlink -------------------
  const ytBefore = await api('/api/youtube');
  check('youtube: not configured/linked by default', !ytBefore.configured && !ytBefore.linked);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ youtube: { clientId: 'mock-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-mock-SECRET-7777', privacy: 'unlisted' } }) });
  check('youtube: client secret masked like the other keys', !JSON.stringify(await api('/api/settings')).includes('SECRET-7777'));
  let hop = await fetch(`${BASE}/oauth/youtube/start`, { redirect: 'manual' });
  hop = await fetch(hop.headers.get('location'), { redirect: 'manual' }); // Google consent (mock) → redirect back
  const cb = await fetch(hop.headers.get('location'), { redirect: 'manual' });
  const cbHtml = await cb.text();
  const ytNow = await api('/api/youtube');
  check('youtube: channel linked through the OAuth callback', cb.status === 200 && ytNow.linked && ytNow.channel?.title === 'قناة تجريبية', ytNow.channel?.title);
  check('youtube: tokens never sent to the browser', !/mock-refresh|mock-access/.test(JSON.stringify(ytNow) + cbHtml));
  const replay = await fetch(hop.headers.get('location'), { redirect: 'manual' });
  check('youtube: OAuth state is single-use (replay refused)', replay.status === 400);
  await api(`/api/projects/${p.id}/publish`, { method: 'POST', body: '{}' });
  await waitFor('publish', async () => { const x = (await api(`/api/projects/${p.id}`)).publish; if (x.status === 'error') throw Object.assign(new Error(x.error), { fatal: true }); return x.status === 'done'; }, 60000);
  const pub = (await api(`/api/projects/${p.id}`)).publish;
  const last = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/yt/_last`)).json();
  check('youtube: video uploaded (resumable, chunked) with title/#shorts/privacy', pub.url?.startsWith('https://youtu.be/') && last.bytes === fs.statSync(video).size && last.chunks > 1
    && last.meta.snippet.title.includes(proj.script.title) && last.meta.snippet.title.includes('#shorts') && last.meta.status.privacyStatus === 'unlisted' && last.mp4 === 'ftyp',
    `${pub.url} · ${last.chunks} chunks · ${last.meta.status.privacyStatus}`);
  await api('/api/youtube', { method: 'DELETE' });
  check('youtube: unlink removes the stored token', !(await api('/api/youtube')).linked);

  // --- project 2: uploaded voice-over → Deepgram timing, approvals, cancel ---------------
  const p2 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: TOPIC, seconds: 10, voiceMode: 'upload', autostart: false, approvals: { script: 'auto', voice: 'auto', timing: 'wait', storyboard: 'auto', render: 'auto' } }) });
  await fetch(`${BASE}/api/projects/${p2.id}/upload`, { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'audio/mpeg', 'X-Filename': 'my-voice.mp3' }, body: fs.readFileSync(path.join(dir, 'voice.mp3')) });
  await api(`/api/projects/${p2.id}/run`, { method: 'POST' });
  await waitFor('p2 timing review', async () => { const s = await stageOf(p2.id); if (Object.values(s).some((x) => x.status === 'error')) throw Object.assign(new Error('stage failed: ' + JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, x]) => [k, x.error || x.status])))), { fatal: true }); return s.timing.status === 'review'; }, 60000);
  const q = await api(`/api/projects/${p2.id}`);
  const diffs = q.words.map((w, i) => Math.abs(w.start - proj.words[i].start));
  check('upload → Deepgram words aligned onto script spelling', q.words.length === proj.words.length && q.words.every((w, i) => w.text === proj.words[i].text), `${q.timing.weak} weak, match ${q.timing.matchAvg}`);
  check('upload timing agrees with TTS timing', Math.max(...diffs) < 0.08, `max Δ ${(Math.max(...diffs) * 1000).toFixed(0)} ms`);
  await api(`/api/projects/${p2.id}/stages/timing/approve`, { method: 'POST' });
  await waitFor('p2 render start', async () => (await stageOf(p2.id)).render.status === 'running', 60000);
  await api(`/api/projects/${p2.id}/cancel`, { method: 'POST' });
  const s2 = await stageOf(p2.id);
  check('cancel stops a running stage', s2.render.status === 'idle' && s2.storyboard.status === 'done');
  await api(`/api/projects/${p2.id}/stages/storyboard/rerun`, { method: 'POST' });
  await waitFor('p2 storyboard rerun', async () => (await stageOf(p2.id)).render.status === 'running', 60000);
  await api(`/api/projects/${p2.id}/cancel`, { method: 'POST' });
  check('re-run restarts from the chosen stage', (await stageOf(p2.id)).storyboard.status === 'done');
  await api(`/api/projects/${p2.id}`, { method: 'DELETE' });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Reel: output/${OUT_NAME}.mp4`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

function rmsEnvelope(file) {
  const pcm = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  const hop = 80, out = []; // 5 ms
  for (let i = 0; i + hop <= pcm.length / 2; i += hop) { let s = 0; for (let k = 0; k < hop; k++) { const v = pcm.readInt16LE((i + k) * 2) / 32768; s += v * v; } out.push(Math.sqrt(s / hop)); }
  const peak = Math.max(...out);
  return { hop: hop / 16000, v: out.map((x) => x / peak) };
}
function onsetNear(env, t) {
  // first rising edge through 15% of peak within ±150 ms of t
  const a = Math.max(1, Math.floor((t - 0.15) / env.hop)), b = Math.min(env.v.length - 1, Math.ceil((t + 0.15) / env.hop));
  for (let i = a; i <= b; i++) if (env.v[i] >= 0.15 && env.v[i - 1] < 0.15) return i * env.hop;
  return null;
}

main().catch((e) => { console.error('E2E FAILED:', e.message); cleanup(); process.exit(1); });
