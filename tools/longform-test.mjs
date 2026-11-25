// Long-form production tests (chapters, 2–30 min):
//  1. offline unit checks — outline repair, TTS splitting, chapter ranges, windowed alignment on 30 minutes of text
//     (time, memory, agreement with the exact LCS), storyboard windows, YouTube chapter rules, streamed SFX memory,
//     and that short-reel prompts are unchanged;
//  2. a real 3-minute long-form project through the whole pipeline on the offline mocks: chapters with approval,
//     chapter edit/move/rename/add/delete/regenerate, voice in cached parts (an edit re-voices one part only),
//     resume after a cancel, a rendered MP4 checked with ffprobe, and chapter timestamps for YouTube.
//   node tools/longform-test.mjs            (--unit for the offline unit part only)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lf-'));
process.env.RS_DATA_DIR = path.join(TMP, 'unit-data');
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.stack?.split('\n').slice(0, 3).join(' | ') || e.message); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LF = await import('../server/longform.mjs');
const PR = await import('../server/profiles.mjs');
const TX = await import('../server/text.mjs');
const SB = await import('../server/storyboard.mjs');
const FF = await import('../server/engines/ffmpeg.mjs');

// ---- 1. unit ------------------------------------------------------------------------------
await test('profiles: every profile is complete; durations categorised; long-form from 120 s', () => {
  for (const [id, p] of Object.entries(PR.PROFILES)) {
    for (const k of ['name', 'en', 'description', 'defaultSeconds', 'platform', 'sceneSeconds', 'chapterSeconds']) assert.ok(p[k] !== undefined && p[k] !== '', `${id}.${k}`);
    for (const t of p.templates) assert.ok(SB.TEMPLATES.includes(t), `${id}: unknown template ${t}`);
  }
  assert.equal(PR.PROFILES.short.writer, ''); assert.equal(PR.PROFILES.short.visual, '');
  assert.deepEqual([15, 90, 91, 300, 301, 900, 901, 1800].map(PR.durationCategory), ['shorts', 'shorts', 'short', 'short', 'medium', 'medium', 'long', 'long']);
  assert.equal(LF.isLongform({ seconds: 60 }), false); assert.equal(LF.isLongform({ seconds: 'auto' }), false); assert.equal(LF.isLongform({ seconds: 120 }), true);
  assert.equal(LF.chapterCount(1800, 'documentary'), 9); assert.equal(LF.chapterCount(180, 'educational'), 2); assert.equal(LF.chapterCount(1800, 'cartoon'), 15);
});

await test('short-reel prompts are unchanged by the profile system (no brief, no window options)', () => {
  const words = [{ i: 0, text: 'أ', start: 0 }, { i: 1, text: 'ب', start: 1 }];
  const a = SB.storyboardMessages({ title: 't', words, duration: 10 })[0].content;
  assert.ok(a.includes('The first scene is type "intro" at 0.') && !a.includes('Visual direction') && !a.includes('Prefer these templates'));
  const s = TX.scriptMessages('topic', 30, {})[0].content;
  assert.ok(!s.includes('Production profile'));
  const w = SB.storyboardMessages({ title: 't', words: [{ i: 50, text: 'x', start: 20 }], duration: 100, sceneSeconds: 7, maxScenes: 16, window: { first: false, chapter: 'ch' }, visual: 'V', templates: ['flow'] })[0].content;
  assert.ok(w.includes('starts at word 50') && w.includes('About 14 scenes') && w.includes('Visual direction: V') && w.includes('Prefer these templates when they fit: flow'));
});

await test('outline: too few/many chapters repaired, durations rescaled to the total, ids unique', () => {
  const o = LF.parseOutline({ title: 'T', chapters: [{ title: 'a', seconds: 10 }, { title: 'b', seconds: 10 }] }, { seconds: 600, count: 4, topic: 'x' });
  assert.equal(o.chapters.length, 4);
  const sum = o.chapters.reduce((a, c) => a + c.seconds, 0);
  assert.ok(Math.abs(sum - 600) <= 4, `sum ${sum}`);
  assert.equal(new Set(o.chapters.map((c) => c.id)).size, 4);
  assert.ok(o.chapters.every((c) => c.status === 'pending' && c.text === '' && c.approved === false));
  const o2 = LF.parseOutline({ chapters: Array.from({ length: 9 }, () => ({ title: 'x', seconds: 100 })) }, { seconds: 300, count: 3 });
  assert.equal(o2.chapters.length, 3); assert.ok(o2.fixes.length);
  const o3 = LF.parseOutline(null, { seconds: 200, count: 2, topic: 'موضوع' });
  assert.equal(o3.title, 'موضوع'); assert.equal(o3.chapters.length, 2);
});

await test('chapter prompt: outline + continuity + target words; parseChapter cleans like a script', () => {
  const chapters = [{ title: 'أ', goal: 'g1', seconds: 100, text: 'سطر أول\nسطر تاني\nآخر سطر' }, { title: 'ب', goal: 'g2', seconds: 100, text: '' }];
  const m = LF.chapterMessages({ topic: 'T', title: 'V', chapters, k: 1, profile: 'documentary', dialect: 'msa', hint: 'أقصر' });
  assert.ok(m[0].content.includes('[[TASK:CHAPTER]]') && m[0].content.includes('DOCUMENTARY') && m[0].content.includes('Modern Standard Arabic') && m[0].content.includes('LAST chapter'));
  assert.ok(m[1].content.includes('TARGET_WORDS: 260') && m[1].content.includes('آخر سطر') && m[1].content.includes('EDITOR NOTE: أقصر') && m[1].content.includes('← WRITE THIS ONE'));
  assert.equal(LF.parseChapter('SCRIPT:\n- سطر [music]\n\nسطر ٢'), 'سطر\nسطر ٢');
  assert.equal(LF.parseChapter('بدون علامة\nسطر'), 'بدون علامة\nسطر');
});

await test('chapter ranges: word counts add up to tokenize(joined), lines never span chapters', () => {
  const chapters = [{ id: 'a', title: 'A', text: 'كلمة واحدة!\nو تانية ،' }, { id: 'b', title: 'B', text: '، بداية\nDNA polymerase' }, { id: 'c', title: 'C', text: '   ' }];
  const r = LF.chapterRanges(chapters);
  const all = TX.tokenize(LF.joinChapters(chapters));
  assert.equal(r.length, 2); assert.equal(r[0].w0, 0); assert.equal(r[1].w0, r[0].w1); assert.equal(r[1].w1, all.length);
});

await test('splitForTts: parts ≤ limit, at line breaks, nothing lost (also one very long line)', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `السطر رقم ${i} فيه كلام عن الـ DNA والخلايا.`);
  const text = lines.join('\n');
  const parts = LF.splitForTts(text, 1000);
  assert.ok(parts.length > 5 && parts.every((x) => x.text.length <= 1000));
  assert.equal(parts.map((x, i) => x.text + (i < parts.length - 1 ? x.sep : '')).join(''), text);
  const long = Array.from({ length: 300 }, (_, i) => `جملة ${i}.`).join(' ');
  const lp = LF.splitForTts(long, 500);
  assert.ok(lp.every((x) => x.text.length <= 500));
  assert.equal(lp.map((x) => x.text).join(' ').replace(/\s+/g, ' '), long);
  assert.deepEqual(LF.splitForTts('قصير', 4500), [{ text: 'قصير', sep: '' }]);
});

// synthetic narration + "TTS" characters (some dropped/changed letters, like a real voice) → alignment quality
function synthetic(lineCount) {
  const vocab = ['السما', 'لونها', 'أزرق', 'نور', 'الشمس', 'فيه', 'كل', 'الألوان', 'oxygen', 'الموجة', 'قصيرة', 'بتتشتت', 'أكتر', 'عينك', 'تشوف', '37', 'حوالي', 'والأحمر'];
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const lines = Array.from({ length: lineCount }, () => Array.from({ length: 4 + Math.floor(rnd() * 6) }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' '));
  const text = lines.join('\n');
  const chars = []; const truth = [];
  let t = 0.1;
  for (const tok of TX.tokenize(text)) {
    const cs = [...tok.text];
    truth.push(t);
    cs.forEach((c, k) => { if (rnd() < 0.03) return; chars.push({ c: rnd() < 0.02 ? 'ه' : c, start: t + k * 0.06, end: t + (k + 1) * 0.06 }); });
    t += cs.length * 0.06 + 0.08;
    chars.push({ c: ' ', start: t - 0.08, end: t });
  }
  return { text, chars, truth, duration: t };
}

await test('windowed alignment: a script far above the old 4e7 limit aligns to the true word onsets (TTS with dropped/changed letters)', () => {
  const { text, chars } = synthetic(600);
  const tokens = TX.tokenize(text);
  const timed = TX.charsToWords(chars);
  const S = tokens.reduce((a, t) => a + TX.normWord(t.text).length, 0);
  assert.ok(S * chars.length > TX.ALIGN_DIRECT_MAX * 5, `script chars ${S}`); // this used to throw "Alignment too large"
  const out = TX.alignWords(tokens, timed);
  const bad = out.filter((w, i) => Math.abs(w.start - timed[i]?.start) > 0.25).length;
  assert.ok(bad / out.length < 0.01, `${bad} of ${out.length} words more than 0.25 s off`);
});

await test('windowed alignment: 30 minutes of narration aligns in seconds with bounded memory, ≥ 99% of words within 0.25 s', () => {
  const { text, chars, truth, duration } = synthetic(900);
  // stretch to ~30 min: repeat the narration 2× per pass until ≥ 1800 s
  let T = text, C = chars, TR = truth, D = duration;
  while (D < 1800) { const off = D; T = `${T}\n${text}`; C = C.concat(chars.map((c) => ({ c: c.c, start: c.start + off, end: c.end + off }))); TR = TR.concat(truth.map((x) => x + off)); D += duration; }
  const tokens = TX.tokenize(T);
  const timed = TX.charsToWords(C);
  const S = tokens.reduce((a, t) => a + TX.normWord(t.text).length, 0);
  assert.ok(S * C.length > TX.ALIGN_DIRECT_MAX * 10, `input ${S}×${C.length} is far above the old limit`);
  global.gc?.();
  const m0 = process.memoryUsage().rss, t0 = Date.now();
  const out = TX.alignWords(tokens, timed);
  const ms = Date.now() - t0, mb = (process.memoryUsage().rss - m0) / 1e6;
  assert.equal(out.length, tokens.length);
  const within = out.filter((w, i) => Math.abs(w.start - TR[i]) <= 0.25).length / out.length;
  assert.ok(within >= 0.99, `only ${(within * 100).toFixed(2)}% within 0.25 s`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start, 'monotonic');
  assert.ok(ms < 60000, `${ms} ms`);
  console.log(`   ${(D / 60).toFixed(1)} min · ${tokens.length} words · ${S} chars → ${ms} ms, +${mb.toFixed(0)} MB RSS, ${(within * 100).toFixed(2)}% within 0.25 s`);
});

await test('storyboard windows cover every word exactly once and never cross a chapter', () => {
  const { text, chars } = synthetic(300);
  const words = TX.alignWords(TX.tokenize(text), TX.charsToWords(chars));
  const third = Math.floor(words.length / 3);
  const ranges = [{ id: 'a', title: 'A', w0: 0, w1: third }, { id: 'b', title: 'B', w0: third, w1: 2 * third }, { id: 'c', title: 'C', w0: 2 * third, w1: words.length }];
  const ws = LF.storyboardWindows(ranges, words, { windowSec: 30 });
  assert.equal(ws[0].w0, 0); assert.equal(ws.at(-1).w1, words.length);
  for (let i = 1; i < ws.length; i++) assert.equal(ws[i].w0, ws[i - 1].w1);
  for (const w of ws) { const r = ranges.find((x) => x.id === w.chapter); assert.ok(w.w0 >= r.w0 && w.w1 <= r.w1); }
  assert.equal(new Set(ws.map((w) => w.key)).size, ws.length);
  const merged = LF.mergeWindowDrafts(ws, ws.map((w) => ({ scenes: [{ at: w.w0 + 3, template: 'flow' }, { at: w.w1 + 99 }, { at: -5 }], accents: [[w.w0 + 1, 'accent'], [w.w1 + 5, 'blue']] })));
  for (const r of ranges) assert.ok(merged.scenes.some((s) => s.at === r.w0), `chapter ${r.id} starts with a scene`);
  assert.ok(merged.scenes.every((s) => s.at >= 0 && s.at < words.length));
  const rep = SB.repairStoryboard(merged, words);
  assert.ok(rep.storyboard.scenes.length >= 3);
});

await test('YouTube chapters: 0:00 first, ≥ 3 chapters, ≥ 10 s each — otherwise none', () => {
  const marks = [{ title: 'أ', start: 0 }, { title: 'ب', start: 65.4 }, { title: 'ج', start: 3725 }];
  assert.equal(LF.youtubeChapters(marks, 4000), '0:00 أ\n1:05 ب\n1:02:05 ج');
  assert.equal(LF.youtubeChapters(marks.slice(0, 2), 4000), '');
  assert.equal(LF.youtubeChapters([{ title: 'a', start: 0 }, { title: 'b', start: 5 }, { title: 'c', start: 30 }], 60), '');
  assert.equal(LF.youtubeChapters([{ title: 'a', start: 2 }, { title: 'b', start: 30 }, { title: 'c', start: 60 }], 90), '');
});

await test('SFX track for 30 minutes is streamed: flat memory, exact WAV size', () => {
  const f = path.join(TMP, 'sfx.wav');
  global.gc?.();
  const m0 = process.memoryUsage().rss;
  FF.writeSfx(f, 1800, Array.from({ length: 250 }, (_, i) => i * 7.2), Array.from({ length: 800 }, (_, i) => i * 2.25), 0.6);
  const mb = (process.memoryUsage().rss - m0) / 1e6;
  assert.equal(fs.statSync(f).size, 44 + Math.ceil(1800 * 48000) * 2);
  assert.ok(mb < 120, `+${mb.toFixed(0)} MB`);
  fs.rmSync(f);
});

// ---- 2. end to end on the mocks ---------------------------------------------------------------
if (process.env.LF_SKIP_E2E || process.argv.includes('--unit')) { finish(); }
else {
  const MOCK_PORT = Number(process.env.LF_MOCK_PORT || 4396), PORT = Number(process.env.LF_PORT || 4306);
  const BASE = `http://127.0.0.1:${PORT}`;
  const procs = [];
  const start = (args, env, tag) => { const p = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...env } }); p.stderr.on('data', (d) => process.env.LF_VERBOSE && process.stderr.write(`[${tag}] ${d}`)); p.stdout.on('data', (d) => process.env.LF_VERBOSE && process.stdout.write(`[${tag}] ${d}`)); procs.push(p); return p; };
  process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
  const api = async (p, opts = {}) => {
    const res = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(opts.headers || {}) } });
    const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const e = new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body)}`); e.status = res.status; throw e; }
    return body;
  };
  const post = (p, body = {}) => api(p, { method: 'POST', body: JSON.stringify(body) });
  const put = (p, body = {}) => api(p, { method: 'PUT', body: JSON.stringify(body) });
  const ttsCalls = async () => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/_stats/tts`)).json()).calls;
  async function waitFor(desc, fn, ms = 240000) {
    const t0 = Date.now();
    for (;;) {
      const v = await fn().catch((e) => { if (e.fatal) throw e; return null; });
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${desc}`);
      await sleep(400);
    }
  }
  const stageIs = (id, stage, statuses) => async () => {
    const p = await api(`/api/projects/${id}`);
    if (p.stages[stage].status === 'error') { const e = new Error(`${stage} failed: ${p.stages[stage].error}\n${p.stages[stage].log.slice(-8).join('\n')}`); e.fatal = true; throw e; }
    return statuses.includes(p.stages[stage].status) && !p.running ? p : null;
  };
  try {
    start(['tools/mock-apis.mjs'], { MOCK_PORT: String(MOCK_PORT) }, 'mock');
    start(['server/index.mjs'], {
      RS_PORT: String(PORT), RS_DATA_DIR: path.join(TMP, 'data'), RS_TTS_MAX_CHARS: '600',
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'k', DEEPGRAM_API_KEY: '', ELEVENLABS_VOICE_ID: 'mock-voice-eg', YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '',
    }, 'app');
    await waitFor('server', () => api('/api/health'), 90000);
    await waitFor('mock', () => fetch(`http://127.0.0.1:${MOCK_PORT}/_stats/tts`).then((r) => r.ok), 30000);
    await put('/api/settings', { elevenlabs: { apiKey: 'el-k', voiceId: 'mock-voice-eg' }, llm: { apiKey: 'k' } });

    let id;
    await test('API: profiles listed; a custom 3-minute educational project is long-form and defaults to 16:9 YouTube', async () => {
      const pr = await api('/api/profiles');
      assert.ok(pr.profiles.documentary && pr.profiles.short && pr.max === 1800 && pr.longformFrom === 120);
      await assert.rejects(post('/api/projects', { topic: 'x', seconds: 1801, autostart: false }), /400/);
      await assert.rejects(post('/api/projects', { topic: 'x', seconds: 95.5, autostart: false }), /400/);
      const p = await post('/api/projects', { topic: 'ليه السما لونها أزرق؟', seconds: 180, approvals: { script: 'wait', storyboard: 'wait' }, options: { profile: 'educational', research: false } });
      id = p.id;
      assert.equal(p.options.profile, 'educational'); assert.equal(p.category, 'short'); assert.equal(p.edit.export.aspect, '16:9');
    });

    let proj;
    await test('script: outline → 2 chapters written one by one, then waits for approval', async () => {
      proj = await waitFor('script review', stageIs(id, 'script', ['review']));
      assert.equal(proj.chapters.length, 2);
      assert.ok(proj.chapters.every((c) => c.status === 'written' && c.words > 150 && !c.approved));
      assert.equal(proj.script.text, proj.chapters.map((c) => c.text).join('\n'));
      assert.ok(proj.stages.script.log.some((l) => l.includes('planning 2 chapters')));
    });

    await test('chapters: rename, add, edit, move, delete, regenerate — the narration follows; a free edit of the joined text is refused', async () => {
      let p = await post(`/api/projects/${id}/chapters/0/rename`, { title: 'مقدمة' });
      assert.equal(p.chapters[0].title, 'مقدمة'); assert.equal(p.stages.script.status, 'review');
      p = await post(`/api/projects/${id}/chapters`, { after: 1, title: 'فصل زيادة', text: 'ده سطر زيادة في آخر الفيديو.\nوسطر تاني.' });
      assert.equal(p.chapters.length, 3); assert.equal(p.chapters[2].title, 'فصل زيادة');
      p = await post(`/api/projects/${id}/chapters/2/move`, { to: 0 });
      assert.equal(p.chapters[0].title, 'فصل زيادة');
      assert.ok(p.script.text.startsWith('ده سطر زيادة'));
      p = await post(`/api/projects/${id}/chapters/0/delete`);
      assert.equal(p.chapters.length, 2); assert.equal(p.chapters[0].title, 'مقدمة');
      const before = p.chapters[1].text;
      p = await post(`/api/projects/${id}/chapters/1/regenerate`, { hint: 'نسخة تانية' });
      assert.notEqual(p.chapters[1].text, before); assert.ok(p.chapters[1].text.includes('نسخة جديدة'));
      p = await put(`/api/projects/${id}/chapters/1`, { text: `${p.chapters[1].text}\nوده سطر أضافه المحرر.` });
      assert.ok(p.chapters[1].edited && p.script.text.endsWith('وده سطر أضافه المحرر.'));
      await assert.rejects(put(`/api/projects/${id}/stages/script`, { title: 'x', text: 'نص حر' }), /409/);
      await assert.rejects(post(`/api/projects/${id}/chapters/9/rename`, { title: 'x' }), /400/);
      await assert.rejects(post(`/api/projects/${id}/chapters/0/delete`).then(() => post(`/api/projects/${id}/chapters/0/delete`)), /409/);
    });

    await test('approval: approving every chapter approves the script stage and the pipeline continues', async () => {
      // the delete above left one chapter — add a second one back so the video keeps chapters
      let p = await post(`/api/projects/${id}/chapters`, { title: 'الخلاصة', text: 'يعني باختصار: الأزرق بيتشتت أكتر.\nوده سبب لون السما.' });
      assert.equal(p.chapters.length, 2);
      p = await post(`/api/projects/${id}/chapters/0/approve`);
      assert.equal(p.stages.script.status, 'review');
      p = await post(`/api/projects/${id}/chapters/1/approve`);
      assert.equal(p.stages.script.status, 'done');
    });

    let calls0;
    await test('voice: narration voiced in cached parts, placed back to back (sum of parts = voice length)', async () => {
      proj = await waitFor('storyboard review', stageIs(id, 'storyboard', ['review']));
      assert.ok(proj.voice.parts >= 3, `${proj.voice.parts} parts`);
      assert.equal(proj.voice.reusedParts, 0);
      const line = proj.stages.voice.log.find((l) => l.includes('sum of parts'));
      const sum = Number(line.match(/sum of parts ([\d.]+) s/)[1]);
      assert.ok(Math.abs(sum - proj.voice.duration) < 0.15, `parts ${sum} vs mp3 ${proj.voice.duration}`);
      calls0 = await ttsCalls();
    });

    await test('timing + storyboard: every word timed in order; each chapter starts a scene; schema-valid', async () => {
      const words = proj.words;
      assert.equal(words.length, TX.tokenize(proj.script.text).length);
      for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].start);
      assert.ok(words.at(-1).end <= proj.voice.duration + 0.5 && words.at(-1).end > proj.voice.duration - 2);
      const ranges = LF.chapterRanges(proj.chapters);
      for (const r of ranges) assert.ok(proj.storyboard.scenes.some((s) => s.at === r.w0), `chapter ${r.title} starts a scene`);
      assert.ok(proj.storyboardDrafts && Object.keys(proj.storyboardDrafts).length >= 2);
      assert.ok(proj.stages.storyboard.log.some((l) => l.includes('storyboard windows')));
    });

    await test('render: draft 16:9 MP4 of the whole narration, ffprobe-checked; chapter timestamps for YouTube', async () => {
      await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify({ edit: { export: { aspect: '16:9', resolution: 720, fps: 24, quality: 'draft', engine: 'legacy' } } }) });
      await post(`/api/projects/${id}/stages/storyboard/approve`);
      proj = await waitFor('render', stageIs(id, 'render', ['done']), 900000);
      assert.equal(proj.render.width, 1280); assert.equal(proj.render.height, 720);
      assert.ok(Math.abs(proj.render.duration - proj.voice.duration) < 1.5, `${proj.render.duration} vs ${proj.voice.duration}`);
      assert.ok(proj.render.chapters.length === 2 && proj.render.chapters[0].start === 0 && proj.render.chapters[1].start > 30);
      assert.ok(proj.stages.render.log.some((l) => l.includes('checked:')));
      const vid = path.join(TMP, 'data', 'projects', id, 'video.mp4');
      const R = await import('../server/render.mjs');
      const { out } = await R.run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', vid]);
      const j = JSON.parse(out);
      assert.ok(j.streams.some((s) => s.codec_type === 'audio') && j.streams.some((s) => s.codec_type === 'video' && s.width === 1280));
      assert.ok(Math.abs(Number(j.format.duration) - proj.render.duration) < 0.2);
      fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
      fs.copyFileSync(vid, path.join(ROOT, 'output', 'test-longform-3min.mp4'));
      console.log(`   ${proj.render.duration.toFixed(1)} s · ${proj.render.frames} frames · rendered in ${proj.render.renderSeconds} s (${proj.render.engine}) · chapters ${proj.render.chapters.map((c) => `${c.start.toFixed(1)}s ${c.title}`).join(', ')}`);
    });

    await test('edit one chapter after the render: only that chapter is voiced again (others from the cache)', async () => {
      let p = await put(`/api/projects/${id}/chapters/1`, { text: 'يعني باختصار: الأزرق بيتشتت أكتر من أي لون.\nوده سبب لون السما.' });
      assert.equal(p.stages.voice.status, 'idle');
      await post(`/api/projects/${id}/run`);
      p = await waitFor('storyboard again', stageIs(id, 'storyboard', ['review']));
      const voiced = (await ttsCalls()) - calls0;
      assert.equal(voiced, 1, `${voiced} TTS requests`);
      assert.equal(p.voice.reusedParts, p.voice.parts - 1);
      // storyboard windows of the unchanged chapter come from the cache too
      assert.ok(p.stages.storyboard.log.some((l) => /\d+ windows asked, [1-9]\d* reused/.test(l)), p.stages.storyboard.log.join('\n'));
    });

    await test('resume: cancel mid-script keeps the written chapters; ▶ continue writes only the rest', async () => {
      const q = await post('/api/projects', { topic: 'رحلة الضوء', seconds: 600, approvals: { script: 'wait' }, options: { profile: 'documentary', research: false } });
      await waitFor('two chapters written', async () => { const p = await api(`/api/projects/${q.id}`); return p.chapters?.filter((c) => c.status === 'written').length >= 1 ? p : null; }, 60000);
      await post(`/api/projects/${q.id}/cancel`);
      const mid = await api(`/api/projects/${q.id}`);
      const done = mid.chapters.filter((c) => c.status === 'written').map((c) => c.text);
      assert.ok(done.length >= 1 && mid.chapters.length === 3);
      await post(`/api/projects/${q.id}/run`);
      const p = await waitFor('script review', stageIs(q.id, 'script', ['review']));
      assert.ok(p.stages.script.log.some((l) => l.includes('resuming:')));
      assert.deepEqual(p.chapters.slice(0, done.length).map((c) => c.text), done);
      assert.ok(p.chapters.every((c) => c.status === 'written'));
      // ↻ re-run means a new outline
      await post(`/api/projects/${q.id}/stages/script/rerun`);
      const r = await waitFor('script review again', stageIs(q.id, 'script', ['review']));
      assert.ok(r.stages.script.log.some((l) => l.includes('planning 3 chapters')));
    });

    await test('short reels still take the classic path (no chapters, one TTS request)', async () => {
      const c0 = await ttsCalls();
      const q = await post('/api/projects', { topic: 'ليه السما زرقا؟', seconds: 10, approvals: { script: 'auto', storyboard: 'wait' }, options: { research: false } });
      const p = await waitFor('short storyboard', stageIs(q.id, 'storyboard', ['review']));
      assert.equal(p.chapters, null); assert.equal(p.voice.parts, undefined);
      assert.equal((await ttsCalls()) - c0, 1);
      assert.notEqual(p.edit.export?.aspect, '16:9'); // no platform chosen → the reel default (9:16)
    });
  } finally { finish(); }
}

function finish() {
  console.log(`\n${n} long-form tests passed${failed ? `, ${failed} FAILED` : ''}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
