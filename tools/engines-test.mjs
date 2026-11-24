// Engine manager tests: registration, selection, out-of-order frames, segment recovery, fallback, cancel, queue,
// codecs and ffprobe output validation. Uses fake engines that emit real JPEG frames (no browser needed), so it
// tests the manager + the FFmpeg encoder exactly as the real engines use them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { run, FFMPEG, FFPROBE } from '../server/proc.mjs';
import * as EM from '../server/engines/manager.mjs';
import { validateOutput, availableCodecs } from '../server/engines/ffmpeg.mjs';
import { legacyEngine } from '../server/engines/legacy.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-engines-'));
const W = 320, H = 568, FPS = 30;
// a few distinct JPEG frames (colour per index) so a frame-order bug would show up in the decoded output
const COLORS = ['red', 'green', 'blue', 'yellow'];
const JPG = [];
for (const c of COLORS) {
  const f = path.join(TMP, `${c}.jpg`);
  await run(FFMPEG, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=${W}x${H}`, '-frames:v', '1', '-q:v', '3', f]);
  JPG.push(fs.readFileSync(f));
}
const colorOf = (i) => Math.floor(i / 30) % COLORS.length; // one colour per second

/** Fake engine: emits each segment's frames in a shuffled order (as parallel pages / Remotion do). */
function fake(id, { ok = true, failAt = null, delay = 0, short = 0, calls = { produce: 0, prepare: 0, cleanup: 0 } } = {}) {
  return {
    id, name: `fake ${id}`, calls,
    async validate() { return ok ? { ok: true } : { ok: false, reason: 'not installed (test)' }; },
    async prepare() { calls.prepare++; },
    async produce(i0, i1, emit, ctx) {
      calls.produce++;
      const idx = []; for (let i = i0; i < i1 - short; i++) idx.push(i);
      for (let k = 0; k < idx.length; k += 4) { const a = idx.slice(k, k + 4).reverse(); idx.splice(k, a.length, ...a); }
      await Promise.all([0, 1].map(async (w) => {
        for (let k = w; k < idx.length; k += 2) {
          if (ctx.signal?.aborted) throw new Error('cancelled');
          if (failAt !== null && idx[k] >= failAt) throw new Error(`boom at frame ${idx[k]}`);
          if (delay) await new Promise((r) => setTimeout(r, delay));
          await emit(idx[k], JPG[colorOf(idx[k])]);
        }
      }));
    },
    async cleanup() { calls.cleanup++; },
  };
}
const frameCount = async (f) => Number((await run(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f])).out.trim());
/** Average colour of frame i → index into COLORS (checks the frames came out in order). */
async function colorAt(file, i) {
  const out = path.join(TMP, `probe-${i}.rgb`);
  await run(FFMPEG, ['-hide_banner', '-y', '-i', file, '-vf', `select=eq(n\\,${i}),scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out]);
  const [r, g, b] = fs.readFileSync(out);
  const ref = [[255, 0, 0], [0, 128, 0], [0, 0, 255], [255, 255, 0]];
  let best = 0, bd = 1e9;
  ref.forEach((c, k) => { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = k; } });
  return best;
}
const job = (over = {}) => ({
  project: 'test', total: 400, fps: FPS, width: W, height: H, quality: 'draft', segDir: path.join(TMP, `seg-${Math.random().toString(36).slice(2)}`), key: 'k1',
  out: path.join(TMP, `out-${Math.random().toString(36).slice(2)}.mp4`), source: {}, ...over,
});
/** Adds a silent audio track so validateOutput's audio check can run as in the real pipeline. */
async function withAudio(video, dur) {
  const out = video.replace('.mp4', '-a.mp4');
  await run(FFMPEG, ['-hide_banner', '-y', '-i', video, '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out]);
  return out;
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['✔', name]); console.log('✔', name); }
  catch (e) { results.push(['✖', name]); console.log('✖', name, '\n  ', e.stack?.split('\n').slice(0, 3).join('\n   ')); }
}
EM.unregisterEngine('remotion');

await t('an engine without the full interface is refused', () => {
  assert.throws(() => EM.registerEngine({ id: 'x', name: 'x', validate() {} }), /missing "prepare"/);
});

await t('auto picks remotion when it is available, legacy when it is not; an unavailable choice falls back with a note', async () => {
  EM.registerEngine(fake('legacy'));
  EM.registerEngine(fake('remotion', { ok: false }));
  assert.equal((await EM.chooseEngine('auto')).engine.id, 'legacy');
  const r = await EM.chooseEngine('remotion');
  assert.equal(r.engine.id, 'legacy');
  assert.match(r.note, /remotion.*unavailable.*not installed/);
  EM.registerEngine(fake('remotion'));
  await EM.engineStatus({ fresh: true });
  assert.equal((await EM.chooseEngine('auto')).engine.id, 'remotion');
  const st = await EM.engineStatus();
  assert.deepEqual(st.engines.map((e) => [e.id, e.available]), [['remotion', true], ['legacy', true]]);
  assert.ok(st.codecs.h264, 'h264 encoder');
});

const shared = job();
await t('out-of-order frames → an MP4 with every frame, in order, across 2 segments (ffprobe)', async () => {
  const eng = fake('remotion');
  EM.registerEngine(eng);
  const progress = [];
  const j = await EM.renderVideo({ ...shared, engine: 'remotion', onFrame: (i) => progress.push(i) });
  assert.equal(j.status, 'done');
  assert.equal(j.engine, 'remotion');
  assert.equal(await frameCount(shared.out), 400);
  assert.deepEqual(progress, Array.from({ length: 400 }, (_, i) => i), 'progress is reported once per frame, in order');
  for (const i of [0, 29, 30, 95, 299, 300, 399]) assert.equal(await colorAt(shared.out, i), colorOf(i), `colour of frame ${i}`);
  assert.equal(eng.calls.produce, 2);
  assert.equal(eng.calls.cleanup, 1);
  const p = await validateOutput(await withAudio(shared.out, 400 / FPS), { width: W, height: H, fps: FPS, duration: 400 / FPS });
  assert.equal(p.video, 'h264');
});

await t('recovery: the same key reuses the encoded segments without producing a frame', async () => {
  const eng = fake('remotion');
  EM.registerEngine(eng);
  fs.rmSync(shared.out);
  const j = await EM.renderVideo({ ...shared, engine: 'remotion' });
  assert.equal(j.status, 'done');
  assert.equal(eng.calls.produce, 0);
  assert.equal(await frameCount(shared.out), 400);
});

await t('a failing engine falls back to legacy; the job records why', async () => {
  EM.registerEngine(fake('remotion', { failAt: 50 }));
  const legacy = fake('legacy');
  EM.registerEngine(legacy);
  const o = job();
  const logs = [];
  const j = await EM.renderVideo({ ...o, engine: 'remotion', log: (l) => logs.push(l) });
  assert.equal(j.engine, 'legacy');
  assert.equal(j.fallbackFrom, 'remotion');
  assert.match(j.fallbackReason, /boom at frame/);
  assert.ok(logs.some((l) => /falling back to the legacy engine/.test(l)));
  assert.equal(await frameCount(o.out), 400);
});

await t('fallback off → the error is reported, not hidden', async () => {
  EM.registerEngine(fake('remotion', { failAt: 10 }));
  await assert.rejects(EM.renderVideo({ ...job(), engine: 'remotion', fallback: false }), /boom at frame/);
  assert.equal(EM.listJobs().at(-1).status, 'error');
});

await t('an engine that delivers too few frames is an error, never a short video', async () => {
  EM.registerEngine(fake('legacy', { short: 3 }));
  const o = job({ total: 60 });
  await assert.rejects(EM.renderVideo({ ...o, engine: 'legacy' }), /delivered 57 of 60 frames/);
  assert.ok(!fs.existsSync(o.out));
});

await t('cancel stops the job, kills ffmpeg, leaves no output and frees the queue slot', async () => {
  EM.registerEngine(fake('legacy', { delay: 5 }));
  const o = job({ total: 600 });
  const ctl = new AbortController();
  const p = EM.renderVideo({ ...o, engine: 'legacy', signal: ctl.signal, onFrame: (i) => { if (i === 40) ctl.abort(); } });
  await assert.rejects(p, /cancelled/);
  const j = EM.listJobs().at(-1);
  assert.equal(j.status, 'cancelled');
  assert.ok(j.frames < 600);
  assert.ok(!fs.existsSync(o.out));
  assert.ok(!fs.readdirSync(o.segDir).some((f) => f.endsWith('.part.mp4')), 'no partial segment left');
  EM.registerEngine(fake('legacy'));
  const after = await EM.renderVideo({ ...job({ total: 30 }), engine: 'legacy' });
  assert.equal(after.status, 'done', 'the next job still runs');
});

await t('cancelJob(id) through the job id (the API path)', async () => {
  EM.registerEngine(fake('legacy', { delay: 5 }));
  let id = null;
  const p = EM.renderVideo({ ...job({ total: 600 }), engine: 'legacy', onJob: (j) => { id = j.id; }, onFrame: (i) => { if (i === 20) EM.cancelJob(id); } });
  await assert.rejects(p, /cancelled/);
  assert.equal(EM.getJob(id).status, 'cancelled');
  assert.equal(EM.cancelJob(id), false, 'a finished job cannot be cancelled again');
});

await t('queue: with maxJobs=1 a second job waits for the first; a queued job can be cancelled', async () => {
  EM.registerEngine(fake('legacy', { delay: 2 }));
  EM.setMaxJobs(1);
  const a = EM.renderVideo({ ...job({ total: 90 }), engine: 'legacy' });
  const logs = [];
  const b = EM.renderVideo({ ...job({ total: 30 }), engine: 'legacy', log: (l) => logs.push(l) });
  const ctl = new AbortController();
  const c = EM.renderVideo({ ...job({ total: 30 }), engine: 'legacy', signal: ctl.signal });
  ctl.abort();
  await assert.rejects(c, /cancelled/);
  const [ja, jb] = await Promise.all([a, b]);
  assert.ok(Date.parse(jb.startedAt) >= Date.parse(ja.finishedAt) - 5, 'b started after a finished');
  assert.ok(logs.some((l) => /render queue: waiting/.test(l)));
  EM.setMaxJobs(2);
  const [x, y] = await Promise.all([EM.renderVideo({ ...job({ total: 60 }), engine: 'legacy' }), EM.renderVideo({ ...job({ total: 60 }), engine: 'legacy' })]);
  assert.ok(Date.parse(y.startedAt) < Date.parse(x.finishedAt), 'maxJobs=2 runs them together');
  EM.setMaxJobs(1);
});

await t('H.265 output when this ffmpeg has libx265 (checked with ffprobe), bitrate mode', async () => {
  const codecs = await availableCodecs();
  EM.registerEngine(fake('legacy'));
  const o = job({ total: 60, codec: 'h265', bitrate: 1500 });
  const j = await EM.renderVideo({ ...o, engine: 'legacy' });
  const p = await validateOutput(await withAudio(o.out, 2), { width: W, height: H, fps: FPS, duration: 2, codec: j.codec });
  if (codecs.h265) assert.equal(p.video, 'hevc'); else { assert.equal(j.codec, 'h264'); console.log('   (libx265 not in this ffmpeg — fell back to h264)'); }
});

await t('watchdog: an engine that stops producing frames is failed after RS_STALL_SEC and the job falls back to legacy', async () => {
  process.env.RS_STALL_SEC = '2';
  try {
    // respects its signal: produces 40 frames, then waits for an abort that only the watchdog can send
    const stuck = { ...fake('remotion'), async produce(i0, i1, emit, ctx) {
      for (let i = i0; i < i0 + 40; i++) await emit(i, JPG[colorOf(i)]);
      await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }));
    } };
    EM.registerEngine(stuck); EM.registerEngine(fake('legacy'));
    const logs = [], t0 = Date.now(), o = job({ total: 60 });
    const j = await EM.renderVideo({ ...o, engine: 'remotion', log: (l) => logs.push(l) });
    assert.equal(j.engine, 'legacy'); assert.equal(j.fallbackFrom, 'remotion');
    assert.match(j.fallbackReason, /stalled: no frame for 2 s \(waiting for frame 40\)/);
    assert.ok(Date.now() - t0 < 15000, 'did not hang');
    assert.equal(await frameCount(o.out), 60);
    // ignores its signal entirely: the race against the watchdog still ends the segment
    const deaf = { ...fake('remotion'), async produce() { await new Promise(() => {}); } };
    EM.registerEngine(deaf);
    const j2 = await EM.renderVideo({ ...job({ total: 30 }), engine: 'remotion' });
    assert.equal(j2.engine, 'legacy'); assert.match(j2.fallbackReason, /stalled/);
    // with fallback off, the stall is the reported error (not a silent hang, not "cancelled")
    await assert.rejects(EM.renderVideo({ ...job({ total: 30 }), engine: 'remotion', fallback: false }), /stalled/);
    assert.equal(EM.listJobs().at(-1).status, 'error');
  } finally { delete process.env.RS_STALL_SEC; }
});

await t('ffmpeg dying while the engine is stuck ends the segment at once with the ffmpeg error (no watchdog wait)', async () => {
  const { killAllChildren } = await import('../server/proc.mjs');
  let abortedWith = null;
  const stuck = { ...fake('remotion'), async produce(i0, i1, emit, ctx) {
    await emit(i0, JPG[0]);
    setTimeout(() => killAllChildren(), 300); // the encoder dies under a producer that waits for nothing it will get
    await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => { abortedWith = ctx.signal.reason; rej(new Error('cancelled')); }, { once: true }));
  } };
  EM.registerEngine(stuck);
  const t0 = Date.now();
  await assert.rejects(EM.renderVideo({ ...job({ total: 30 }), engine: 'remotion', fallback: false }), /ffmpeg exited/);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.match(String(abortedWith?.message), /ffmpeg exited/, 'the engine was told why');
});

await t('validateOutput rejects a wrong size, fps, duration, codec or a missing audio track', async () => {
  const f = shared.out;
  await assert.rejects(validateOutput(f, { width: 1080, height: H, fps: FPS }), /width 320 ≠ 1080/);
  await assert.rejects(validateOutput(f, { width: W, height: H, fps: 60, audio: false }), /fps 30\/1 ≠ 60/);
  await assert.rejects(validateOutput(f, { duration: 20, audio: false }), /duration 13.333 ≠ 20.000/);
  await assert.rejects(validateOutput(f, { codec: 'h265', audio: false }), /codec h264 ≠ hevc/);
  await assert.rejects(validateOutput(f, {}), /no audio stream/);
});

await t('the job log is written as JSON lines', async () => {
  const file = path.join(TMP, 'jobs.jsonl');
  EM.setJobLog(file);
  EM.registerEngine(fake('legacy'));
  await EM.renderVideo({ ...job({ total: 30 }), engine: 'legacy' });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).status, 'done');
  assert.equal(rows.at(-1).engine, 'legacy');
  assert.ok(!('controller' in rows.at(-1)));
  EM.setJobLog(null);
});

EM.registerEngine(legacyEngine);
fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => r[0] === '✖').length;
console.log(failed ? `${failed} of ${results.length} engine tests FAILED` : `${results.length} engine tests passed`);
process.exit(failed ? 1 : 0);
