// Long-form benchmark: a full 30-minute documentary through the whole pipeline on the offline mocks
// (outline → 9 chapters → voice in parts → timing → windowed storyboard → segmented render → mix → mux → ffprobe),
// sampling the memory of the server AND every child process (Chromium, ffmpeg) every second.
//   node tools/longform-bench.mjs [seconds=1800] [resolution=720] [fps=24] [engine=legacy]
// Linux only (reads /proc). Writes the result to output/longform-bench.json.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [SECONDS = 1800, RES = 720, FPS = 24] = process.argv.slice(2, 5).map(Number);
const ENGINE = process.argv[5] || 'legacy';
const MOCK_PORT = 4395, PORT = 4307, BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bench-'));
const procs = [];
const start = (args, env) => { const p = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] }); procs.push(p); return p; };
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: BASE } }); const b = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(b)}`); return b; };

/** RSS (MB) of a process tree. */
function treeRss(pid) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch {}
  }
  let total = 0, self = 0;
  const walk = (p) => {
    try { const kb = Number(fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] || 0); total += kb; if (p === pid) self = kb; } catch {}
    for (const c of kids.get(p) || []) walk(c);
  };
  walk(pid);
  return { total: total / 1024, server: self / 1024 };
}

start(['tools/mock-apis.mjs'], { MOCK_PORT: String(MOCK_PORT) });
const app = start(['server/index.mjs'], {
  RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'),
  LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'mock-voice-eg', DEEPGRAM_API_KEY: '',
});
for (let i = 0; i < 180; i++) { try { await api('/api/health'); break; } catch { await sleep(500); } }
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ elevenlabs: { apiKey: 'el', voiceId: 'mock-voice-eg' } }) });

const peak = { total: 0, server: 0 }, byStage = {};
let stage = 'start';
const t0 = Date.now(), stageT = {};
const sampler = setInterval(() => {
  const r = treeRss(app.pid);
  peak.total = Math.max(peak.total, r.total); peak.server = Math.max(peak.server, r.server);
  byStage[stage] = Math.max(byStage[stage] || 0, r.total);
}, 1000);

const p0 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'تاريخ الضوء', seconds: SECONDS, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' }, options: { profile: 'documentary', research: false } }) });
const id = p0.id;
let p;
for (;;) {
  p = await api(`/api/projects/${id}`);
  const s = ['script', 'voice', 'timing', 'storyboard', 'render'].find((x) => p.stages[x].status !== 'done');
  if (s && s !== stage) { stageT[stage] = (Date.now() - t0) / 1000; stage = s; process.stdout.write(`\n[${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`); }
  const err = Object.entries(p.stages).find(([, v]) => v.status === 'error');
  if (err) { console.error(`\n✖ ${err[0]}: ${err[1].error}\n${err[1].log.slice(-10).join('\n')}`); process.exit(1); }
  if (p.stages.storyboard.status === 'review' && !p.running) {
    await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '16:9', resolution: RES, fps: FPS, quality: 'draft', engine: ENGINE } } }) });
    await api(`/api/projects/${id}/stages/storyboard/approve`, { method: 'POST' });
  }
  if (p.stages.render.status === 'done') break;
  if (stage === 'render' && p.stages.render.status === 'running') {
    const pr = p.stages.render.log.at(-1) || '';
    process.stdout.write(`\r[${((Date.now() - t0) / 1000).toFixed(0)} s] render · ${pr.slice(11, 90).padEnd(80)}`);
  }
  await sleep(2000);
}
stageT[stage] = (Date.now() - t0) / 1000;
clearInterval(sampler);
const dir = path.join(TMP, 'data', 'projects', id);
const leftovers = fs.readdirSync(dir).filter((f) => /^(segments|frames\.mp4|sfx\.wav)$/.test(f) || f.endsWith('.part'));
const out = {
  at: new Date().toISOString(), host: { cpus: os.cpus().length, ramGB: +(os.totalmem() / 1e9).toFixed(1), node: process.version },
  target: { seconds: SECONDS, resolution: RES, fps: FPS, engine: ENGINE, profile: 'documentary' },
  result: {
    videoSeconds: p.render.duration, frames: p.render.frames, size: `${p.render.width}×${p.render.height}`, engine: p.render.engine, renderSeconds: p.render.renderSeconds,
    fileMB: +(fs.statSync(path.join(dir, 'video.mp4')).size / 1e6).toFixed(1), chapters: p.chapters.length, words: p.words.length, scenes: p.storyboard.scenes.length,
    voiceParts: p.voice.parts, chapterMarks: p.render.chapters?.map((c) => `${(c.start / 60).toFixed(2)} min ${c.title}`),
    checked: p.stages.render.log.find((l) => l.includes('checked:'))?.slice(11),
  },
  wallSecondsAtEndOf: stageT,
  peakRssMB: { serverAndChildren: Math.round(peak.total), serverOnly: Math.round(peak.server), byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, Math.round(v)])) },
  tempFilesLeft: leftovers,
};
console.log('\n' + JSON.stringify(out, null, 2));
fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'output', 'longform-bench.json'), JSON.stringify(out, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
