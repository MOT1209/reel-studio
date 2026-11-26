// Long-form tests (no network, no browser, no ffmpeg): node tools/longform-test.mjs
// Covers the raised duration/scene ceilings, chapter planning, progress/resume, the joined timeline the editor and
// subtitles read, and mapping an editor edit back onto the chapters.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.RS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-longform-'));
const { LENGTHS, MAX_SECONDS, WORDS_PER_SECOND, scriptMessages } = await import('../server/text.mjs');
const { MAX_SCENES, sceneTarget, storyboardMessages } = await import('../server/storyboard.mjs');
const {
  planChapters, newChapter, chapterDuration, layoutChapters, assembleProject, chapterProgress,
  distributeEdits, splitScriptByWordCounts, chapterEdit, pendingChapters, MIN_CHAPTER_SECONDS, CHAPTER_SECONDS,
} = await import('../server/chapters.mjs');
const { renderData, createProject, publicProject } = await import('../server/pipeline.mjs');
const { makeStages } = await import('../server/stage-run.mjs');
const { updateSettings } = await import('../server/settings.mjs');

let n = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const wordsOf = (count) => Array.from({ length: count }, (_, i) => ({
  i, text: 'w' + i, line: 0, start: +(i * 0.4).toFixed(3), end: +(i * 0.4 + 0.35).toFixed(3), weak: false, match: 1,
}));
const scene = (at = 0, title = 's') => ({
  type: 'intro', template: 'cards', at, title, items: [{ label: 'x', icon: 'leaf', value: null, at: null }],
  organ: '', value: null, max: null, unit: '', query: 'leaf', image: null, bg: 'card', imageOffset: 0, transition: null, titleAnim: null,
});
function chapterWith(index, seconds, wordCount, { voice = seconds } = {}) {
  const ch = newChapter({ index, id: `ch-0${index + 1}`, seconds });
  ch.voice = { file: 'voice.mp3', source: 'elevenlabs', duration: voice };
  ch.words = wordsOf(wordCount);
  ch.script = { title: 'chapter ' + (index + 1), text: 'w0 w1', sources: [], words: wordCount, model: 'mock' };
  ch.storyboard = { scenes: [scene(0, 'chapter ' + (index + 1))], accents: [[1, 'accent']] };
  ch.timing = { weak: 0, matchAvg: 0.95, source: 'elevenlabs', estimated: false };
  ch.stages = { script: 'done', voice: 'done', timing: 'done', storyboard: 'done', render: 'idle' };
  return ch;
}
function twoChapterProject() {
  const p = {
    id: '20260101-abcdef', topic: 'موضوع طويل', seconds: 240, voiceMode: 'tts', options: { chapters: 'auto', research: false },
    edit: {}, stages: {}, chapters: [chapterWith(0, 120, 12), chapterWith(1, 120, 10)],
  };
  assembleProject(p);
  return p;
}

// ---- ceilings ---------------------------------------------------------------------------------------------
test('durations run up to 30 minutes (the 60 s cap is gone)', () => {
  for (const s of [90, 120, 180, 300, 600, 900, 1800]) assert.ok(LENGTHS.includes(s), `LENGTHS is missing ${s}`);
  assert.ok(!LENGTHS.includes(3600), '30 minutes is the hard cap');
  assert.equal(MAX_SECONDS, 1800);
  assert.equal(LENGTHS[LENGTHS.length - 1], 'auto');
});

test('a 10-minute duration asks the writer for the right number of words', () => {
  const messages = scriptMessages('topic', 600);
  const user = messages[1].content;
  assert.match(user, new RegExp(`TARGET_WORDS: ${Math.round(600 * WORDS_PER_SECOND)}`));
});

test('a chapter script prompt says which chapter it is and what came before', () => {
  const m = scriptMessages('topic', 120, { chapter: { index: 6, total: 10, seconds: 120, prevTail: 'آخر كلمة' } });
  const user = m[1].content;
  assert.match(user, /Chapter 7 of 10/);
  assert.match(user, /آخر كلمة/);
  assert.match(user, new RegExp(`TARGET_WORDS: ${Math.round(120 * WORDS_PER_SECOND)}`));
});

test('the 12-scene ceiling is raised to 30 and scales with the duration', () => {
  assert.equal(MAX_SCENES, 30);
  assert.ok(sceneTarget(60) > 12, 'a 60 s storyboard may have more than 12 scenes now');
  assert.equal(sceneTarget(120), 30);
  assert.equal(sceneTarget(1800), 30);
  assert.equal(sceneTarget(10), 3);
  assert.equal(sceneTarget(0), 2);
  const words = wordsOf(40);
  const system = storyboardMessages({ title: 't', words, duration: 120 }).at(0).content;
  assert.doesNotMatch(system, /About 12 scenes/);
  assert.match(system, /About 30 scenes/);
});

// ---- planning ---------------------------------------------------------------------------------------------
test('chapters cover the whole duration with no gaps, each at least 45 s', () => {
  for (const total of [90, 120, 240, 300, 600, 900, 1800]) {
    const plan = planChapters(total);
    assert.ok(plan.length >= 2, `${total} s should get at least two chapters`);
    assert.ok(Math.abs(plan.reduce((a, x) => a + x.seconds, 0) - total) < 0.05, `${total} s does not add up`);
    for (const x of plan) assert.ok(x.seconds >= MIN_CHAPTER_SECONDS - 0.01, `${x.id} is ${x.seconds} s`);
    assert.deepEqual(plan.map((x) => x.id), plan.map((_, i) => `ch-${String(i + 1).padStart(2, '0')}`));
  }
  assert.equal(planChapters(1800).length, 15);
  assert.equal(planChapters(1800)[0].seconds, CHAPTER_SECONDS);
  assert.equal(planChapters(90).length, 2);
  assert.deepEqual(planChapters('auto'), []);
});

// ---- joined timeline --------------------------------------------------------------------------------------
test('chapters are joined into one global timeline (words, scenes, accents, duration)', () => {
  const p = twoChapterProject();
  const d1 = chapterDuration(p.chapters[0]);
  const d2 = chapterDuration(p.chapters[1]);
  assert.equal(p.words.length, 22);
  assert.equal(p.words[0].start, 0);
  assert.ok(Math.abs(p.words[12].start - (d1 + 0)) < 0.01, 'chapter 2 starts where chapter 1 ends');
  assert.ok(p.words.every((w, i) => i === 0 || w.start >= p.words[i - 1].start), 'global times are monotonic');
  assert.equal(p.chapters[1].from, 12);
  assert.deepEqual(p.storyboard.scenes.map((s) => s.at), [0, 12]);
  assert.deepEqual(p.storyboard.accents.map(([k]) => k), [1, 13]);
  assert.equal(p.voice.duration, +(d1 + d2).toFixed(3));
  assert.equal(p.voice.chapters, 2);
  assert.equal(p.script.chapters, 2);
  assert.equal(p.script.text.split('\n\n').length, 2, 'the joined script keeps one block per chapter');
  assert.equal(p.timing.chapters, 2);
});

test('progress is counted per chapter and per stage', () => {
  const p = twoChapterProject();
  p.chapters[0].stages.render = 'done';
  p.chapters[0].render = { frames: 360, fps: 30, duration: 12 };
  const pr = chapterProgress(p);
  assert.equal(pr.total, 2);
  assert.equal(pr.done, 1, 'chapter 1 is finished, chapter 2 still needs its render');
  assert.equal(pr.stages.script.done, 2);
  assert.equal(pr.stages.render.done, 1);
  assert.equal(pr.seconds, 12);
  assert.deepEqual(pendingChapters(p, 'render').map((ch) => ch.id), ['ch-02']);
  p.chapters[1].stages.render = 'done';
  assert.equal(chapterProgress(p).done, 2);
});

test('renderData serves the joined project and one chapter (render-data?chapter=)', () => {
  const p = twoChapterProject();
  const all = renderData(p);
  assert.equal(all.words.length, 22);
  assert.equal(all.scenes.length, 2);
  assert.equal(all.duration, p.voice.duration);
  const one = renderData(p, { chapter: 'ch-02' });
  assert.equal(one.words.length, 10);
  assert.equal(one.scenes.length, 1);
  assert.equal(one.title, 'chapter 2');
  assert.ok(Math.abs(one.duration - chapterDuration(p.chapters[1])) < 0.01);
  assert.equal(one.start, 0);
  // a single-pass trim/cut must not leak into a chapter render (the render page fetches this too)
  p.edit = { trim: { start: 10 }, cuts: [[1, 2]] };
  const trimmed = renderData(p, { chapter: 'ch-02' });
  assert.equal(trimmed.start, 0);
  assert.ok(Math.abs(trimmed.duration - chapterDuration(p.chapters[1])) < 0.01);
  assert.throws(() => renderData(p, { chapter: 'ch-99' }), /chapter ch-99 not found/);
});

// ---- editing ----------------------------------------------------------------------------------------------
test('an editor edit of the joined timeline goes back to the right chapter', () => {
  const p = twoChapterProject();
  const before = p.chapters[1].words[2].text;
  const words = p.words.map((w, i) => ({ ...w, start: w.start + 1, end: w.end + 1, text: i === 14 ? 'معدلة' : w.text }));
  const sb = { scenes: p.storyboard.scenes.map((s) => ({ ...s, title: s.title + '!' })), accents: p.storyboard.accents };
  const fixes = distributeEdits(p, words, sb);
  assert.ok(Array.isArray(fixes));
  assert.equal(p.chapters[0].words[0].start, 1, 'chapter 1 words shift by the edit, not by a chapter offset');
  assert.equal(p.chapters[1].words[2].text, 'معدلة');
  assert.notEqual(before, p.chapters[1].words[2].text);
  assert.equal(p.chapters[1].words[0].start, 1, 'chapter-local times are the edited global time minus the chapter start');
  assert.equal(p.chapters[0].storyboard.scenes[0].at, 0);
  assert.equal(p.chapters[1].storyboard.scenes[0].at, 0, 'a chapter storyboard is always local');
  assert.match(p.chapters[1].storyboard.scenes[0].title, /!/);
  assert.equal(p.words.length, 22, 'the joined timeline is rebuilt from the chapters');
});

test('an edited full script is split back into chapter-sized pieces, in order', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `سطر ${i + 1}`);
  const parts = splitScriptByWordCounts(lines.join('\n'), [6, 2]);
  assert.equal(parts.length, 2);
  assert.deepEqual(lines.join('\n').split('\n'), parts.join('\n').split('\n'), 'no line is lost or reordered');
  assert.ok(parts[0].split('\n').length > parts[1].split('\n').length);
});

test('a chapter render is chapter-local: overlays shift, trim/cuts/order/music are dropped', () => {
  const p = twoChapterProject();
  const hex = 'a1b2c3d4e5f6';
  p.edit = {
    trim: { start: 3 }, cuts: [[2, 3]], sequence: [{ from: 0, to: 1 }],
    audio: { music: { asset: hex, volume: 0.2 }, tracks: [{ asset: hex, start: 130, end: 140, volume: 1 }] },
    overlays: [
      { id: 'a', kind: 'image', asset: hex, start: 2, end: 5 },
      { id: 'b', kind: 'image', asset: hex, start: 125, end: 128 },
    ],
  };
  const first = chapterEdit(p.edit, p.chapters[0]);
  assert.deepEqual(first.trim, { start: 0, end: null });
  assert.deepEqual(first.cuts, []);
  assert.equal(first.sequence, null);
  assert.equal(first.audio.music, null);
  assert.deepEqual(first.overlays.map((o) => [o.id, o.start, o.end]), [['a', 2, 5]]);
  assert.deepEqual(first.audio.tracks, []);
  const second = chapterEdit(p.edit, p.chapters[1]);
  assert.equal(second.overlays.length, 1);
  assert.equal(second.overlays[0].id, 'b');
  assert.ok(Math.abs(second.overlays[0].start - (125 - p.chapters[1].offset)) < 1e-9);
});

// ---- projects ---------------------------------------------------------------------------------------------
test('a 30-minute project is accepted; 25 minutes is not a listed duration', () => {
  const p = createProject({ topic: 'طويل', seconds: 1800, options: { chapters: 'auto' } });
  assert.equal(p.seconds, 1800);
  assert.equal(p.options.chapters, 'auto');
  assert.equal(p.chapters, null, 'the plan is made when the pipeline starts');
  assert.equal(publicProject(p).chapterProgress, null);
  assert.throws(() => createProject({ topic: 'x', seconds: 1500 }), /length must be one of/);
  const short = createProject({ topic: 'قصير', seconds: 30 });
  assert.equal(short.options.chapters, 'auto');
  const off = createProject({ topic: 'x', seconds: 300, options: { chapters: false } });
  assert.equal(off.options.chapters, false);
});

// ---- the script stage, chapter by chapter (no ffmpeg: the LLM is a local SSE mock) -------------------------
test('long-form script: one request per chapter, saved as it goes, resumed without rewriting', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      bodies.push(body);
      const content = `TITLE: عنوان تجريبي\nSCRIPT:\n${Array.from({ length: 300 }, (_, i) => 'كلمة' + i).join('\n')}\nSOURCES:\n- مصدر`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    updateSettings({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-key', model: 'mock' } });
    const p = createProject({ topic: 'موضوع طويل', seconds: 120, options: { research: false } });
    p.chapters = planChapters(p.seconds).map(newChapter);
    const saved = [];
    const stages = makeStages({
      log: () => {}, save: () => saved.push(p.chapters.filter((ch) => ch.stages.script === 'done').length),
      bus: () => ({ emit() {} }), projectDir: () => os.tmpdir(), renderData: () => ({}), port: () => 0,
    });
    await stages.script(p, new AbortController().signal);
    assert.equal(p.chapters.length, 2);
    assert.ok(p.chapters.every((ch) => ch.stages.script === 'done' && ch.script.words >= 250), 'both chapters have a script');
    assert.equal(bodies.length, 2, 'one LLM request per chapter');
    assert.match(bodies[0], /Chapter 1 of 2/);
    assert.match(bodies[1], /Chapter 2 of 2/);
    assert.match(bodies[1], /previous chapter ended with/, 'the next chapter sees how the previous one ended');
    assert.equal(p.script.chapters, 2);
    assert.equal(p.script.text.split('\n\n').length, 2);
    assert.ok(saved.length >= 2, 'progress is saved after every chapter');
    const before = bodies.length;
    await stages.script(p, new AbortController().signal);
    assert.equal(bodies.length, before, 'a resumed run does not rewrite finished chapters');
  } finally { server.close(); }
});

let failed = 0;
for (const [name, fn] of queue) {
  try { await fn(); n++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.error(`  ✖ ${name}\n    ${e.message}`); }
}
console.log(`\n${n}/${queue.length} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
