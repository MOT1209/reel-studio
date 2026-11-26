// Long-form end-to-end test against the offline mocks (needs ffmpeg + a Playwright browser):
//   a 30 s project split into 3 chapters of 10 s → render each chapter → join them → check the joined file,
//   the chapter frame counts, the audio join, caption/voice sync across the joins and the subtitle clock.
// Uses the legacy canvas engine at 720×1280/24 fps by default (E2E_ENGINE=remotion runs the same project on
// Remotion); every chapter is a full 5-stage run. Size can be raised for a scale run:
//   E2E_CHAPTERS=5 E2E_CHAPTER_SECONDS=60 E2E_TIMEOUT_MS=2700000 (5 minutes of video, five 60 s chapters).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = Number(process.env.MOCK_PORT || 4397);
const PORT = Number(process.env.E2E_PORT || 4304);
const ENGINE = process.env.E2E_ENGINE || 'legacy';
const DATA = path.join(ROOT, 'data', process.env.E2E_DATA || 'e2e-longform');
const BASE = `http://127.0.0.1:${PORT}`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const CHAPTER_SECONDS = Number(process.env.E2E_CHAPTER_SECONDS || 10);
const CHAPTERS = Number(process.env.E2E_CHAPTERS || 3);
const FPS = Number(process.env.E2E_FPS || 24);
const RENDER_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 10 * 60000);
const OUT_NAME = process.env.E2E_OUT || `test-reel-longform-${CHAPTERS}ch`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });
process.on('exit', cleanup);
function start(cmd, args, env, tag) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  procs.push(p);
  return p;
}
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(opts.headers || {}) } });
  const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
async function waitFor(desc, fn, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch((e) => { if (e.fatal) throw e; return null; });
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(500);
  }
}
const probe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_packets', '-of', 'json', file]).toString());
function rmsEnvelope(file) {
  const pcm = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  const hop = 80, out = []; // 5 ms
  for (let i = 0; i + hop <= pcm.length / 2; i += hop) { let s = 0; for (let k = 0; k < hop; k++) { const v = pcm.readInt16LE((i + k) * 2) / 32768; s += v * v; } out.push(Math.sqrt(s / hop)); }
  const peak = Math.max(...out);
  return { hop: hop / 16000, v: out.map((x) => x / peak) };
}
function onsetNear(env, t) {
  const a = Math.max(1, Math.floor((t - 0.15) / env.hop)), b = Math.min(env.v.length - 1, Math.ceil((t + 0.15) / env.hop));
  for (let i = a; i <= b; i++) if (env.v[i] >= 0.15 && env.v[i - 1] < 0.15) return i * env.hop;
  return null;
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  // small, fast export for the test (the pipeline reads these settings defaults)
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
    render: { resolution: 720, fps: FPS, quality: 'draft', engine: ENGINE, fallback: false, maxJobs: 1 },
    approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' },
  }), { mode: 0o600 });
  start('node', ['tools/mock-apis.mjs'], { MOCK_PORT: String(MOCK_PORT), FFMPEG_PATH: FFMPEG }, 'mock');
  start('node', ['server/index.mjs'], {
    RS_PORT: String(PORT), RS_DATA_DIR: DATA,
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LLM_API_KEY: '', ELEVENLABS_API_KEY: '', DEEPGRAM_API_KEY: '', FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE,
  }, 'app');
  await waitFor('server', () => api('/api/health'), 90000);
  await waitFor('mock', () => fetch(`http://127.0.0.1:${MOCK_PORT}/v1/voices`, { headers: { 'xi-api-key': 'x' } }).then((r) => r.ok), 90000);
  // the mocks accept any key/voice id (they never reach a real provider)
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm: { apiKey: 'mock-llm-key' }, elevenlabs: { apiKey: 'mock-eleven-key', voiceId: 'mock-voice' }, deepgram: { apiKey: 'mock-deepgram-key' } }) });

  const approvals = { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' };
  const p = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: CHAPTER_SECONDS * CHAPTERS, approvals, options: { chapters: true, chapterSeconds: CHAPTER_SECONDS, research: false } }),
  });
  const t0 = Date.now();
  await waitFor('render', async () => {
    const s = (await api(`/api/projects/${p.id}`)).stages;
    const bad = Object.entries(s).find(([, x]) => x.status === 'error');
    if (bad) throw Object.assign(new Error(`stage ${bad[0]} failed: ${bad[1].error}`), { fatal: true });
    return s.render.status === 'done';
  }, RENDER_TIMEOUT_MS);
  const proj = await api(`/api/projects/${p.id}`);
  const dir = path.join(DATA, 'projects', p.id);
  console.log(`render finished in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  check('all 5 stages done', Object.values(proj.stages).every((s) => s.status === 'done'));
  check(`every chapter rendered with ${ENGINE} (no fallback)`, proj.chapters.every((c) => c.render?.engine === ENGINE && !c.render?.fallbackFrom), proj.chapters.map((c) => `${c.id}:${c.render?.engine}${c.render?.fallbackFrom ? '←' + c.render.fallbackFrom : ''}`).join(' '));
  check(`plan: ${CHAPTERS} chapters of ${CHAPTER_SECONDS} s`, proj.chapters.length === CHAPTERS && proj.chapters.every((c) => c.seconds === CHAPTER_SECONDS), proj.chapters.map((c) => `${c.id}:${c.seconds}s`).join(' '));
  check('chapter progress: every chapter finished every stage', proj.chapterProgress.done === CHAPTERS && Object.values(proj.chapterProgress.stages).every((s) => s.done === CHAPTERS));
  check('each chapter has its own voice, words and storyboard', proj.chapters.every((c, i) => c.words > 0 && c.render?.frames > 0 && fs.existsSync(path.join(dir, 'chapters', c.id, 'voice.mp3')) && fs.existsSync(path.join(dir, 'chapters', c.id, 'video.mp4'))));

  const files = proj.chapters.map((c) => path.join(dir, 'chapters', c.id, 'video.mp4'));
  const probes = files.map(probe);
  const vids = probes.map((x) => x.streams.find((s) => s.codec_type === 'video'));
  const auds = probes.map((x) => x.streams.find((s) => s.codec_type === 'audio'));
  check('chapter files: 720×1280 @ 24 fps, H.264 + AAC', vids.every((v) => v.codec_name === 'h264' && v.width === 720 && v.height === 1280 && v.r_frame_rate === '24/1') && auds.every((a) => a?.codec_name === 'aac'));
  const sumFrames = vids.reduce((a, v) => a + Number(v.nb_read_packets), 0);
  check('chapter frame counts add up to the project frame count', Number(proj.render.frames) === sumFrames && vids.every((v, i) => Number(v.nb_read_packets) === proj.chapters[i].render.frames), `${vids.map((v) => v.nb_read_packets).join(' + ')} = ${sumFrames}`);

  const video = path.join(dir, 'video.mp4');
  const jp = probe(video);
  const jv = jp.streams.find((s) => s.codec_type === 'video');
  const ja = jp.streams.find((s) => s.codec_type === 'audio');
  check('joined video: no re-encode, exact frame count', jv.codec_name === 'h264' && Number(jv.nb_read_packets) === sumFrames && jv.width === 720 && jv.height === 1280 && jv.r_frame_rate === '24/1', `${jv.nb_read_packets} frames · ${Number(jp.format.duration).toFixed(2)} s`);
  check('joined audio: AAC 48 kHz stereo, length ≈ video', ja?.codec_name === 'aac' && Number(ja.sample_rate) === 48000 && Math.abs(Number(ja.duration) - Number(jp.format.duration)) < 0.1, `${ja?.codec_name} ${ja?.sample_rate} Hz · ${Number(ja?.duration).toFixed(3)} s vs video ${Number(jp.format.duration).toFixed(3)} s`);

  const chapterDur = probes.reduce((a, x) => a + Number(x.format.duration), 0);
  const joinDelta = Number(jp.format.duration) - chapterDur;
  check('join keeps the total duration (no gap or overlap at the joins)', Math.abs(joinDelta) <= 0.05, `Σ chapters ${chapterDur.toFixed(3)} s · joined ${Number(jp.format.duration).toFixed(3)} s · Δ ${(joinDelta * 1000).toFixed(0)} ms`);
  check('contact sheet written', fs.existsSync(path.join(dir, 'contact.jpg')));
  check('joined voice track for the editor/preview', fs.existsSync(path.join(dir, 'voice.mp3')), `${Number(probe(path.join(dir, 'voice.mp3')).format.duration).toFixed(2)} s`);

  // caption ↔ voice sync on the joined video (all three chapters, including the words right after each join)
  const env = rmsEnvelope(video);
  const words = proj.words;
  const errs = words.map((w) => { const on = onsetNear(env, w.start); return on == null ? 9 : Math.abs(on - w.start); });
  const sorted = [...errs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  // each chapter starts where the previous chapter's rendered frames end
  const boundaries = [];
  let acc = 0;
  for (const c of proj.chapters.slice(0, -1)) { acc += c.render.frames / FPS; boundaries.push(acc); }
  const afterJoin = boundaries.flatMap((t) => words.filter((w) => w.start >= t && w.start < t + 2).map((w) => errs[w.i]));
  const medJoin = afterJoin.length ? [...afterJoin].sort((a, b) => a - b)[Math.floor(afterJoin.length / 2)] : 9;
  check('caption ↔ voice sync on the joined video', med < 0.05 && p90 < 0.15, `${words.length} words · median ${(med * 1000).toFixed(0)} ms · p90 ${(p90 * 1000).toFixed(0)} ms`);
  check('sync right after each chapter join (AAC priming check)', medJoin < 0.05, `${afterJoin.length} words in the 2 s after joins · median ${(medJoin * 1000).toFixed(0)} ms`);

  // subtitles follow the joined timeline
  const srt = await api(`/api/projects/${p.id}/subtitles.srt`);
  const cues = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)];
  const end = (m) => (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
  const lastCue = cues.length ? Math.max(...cues.map(end)) : 0;
  const lastWord = words[words.length - 1].end;
  check('subtitles: cues cover the joined words', cues.length > 10 && Math.abs(lastCue - lastWord) < 0.6, `${cues.length} cues · last ${lastCue.toFixed(2)} s vs last word ${lastWord.toFixed(2)} s`);

  fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
  fs.copyFileSync(video, path.join(ROOT, 'output', `${OUT_NAME}.mp4`));
  fs.copyFileSync(path.join(dir, 'contact.jpg'), path.join(ROOT, 'output', `${OUT_NAME}-contact.jpg`));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Reel: output/${OUT_NAME}.mp4`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('LONGFORM E2E FAILED:', e.message); cleanup(); process.exit(1); });
