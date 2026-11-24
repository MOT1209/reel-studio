// Fast unit tests (no network, no browser): node tools/unit.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.RS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-unit-'));
const { ThinkStripper, stripThink } = await import('../server/apis.mjs');
const { parseScript, tokenize, normWord, charsToWords, wordsWithChars, alignWords, countWords } = await import('../server/text.mjs');
const { repairStoryboard, extractJson } = await import('../server/storyboard.mjs');
const { resolveIconKey, iconsFor } = await import('../server/icons.mjs');
const { updateSettings, getPublicSettings, getSettings } = await import('../server/settings.mjs');

let n = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]); // run in order at the end; async tests are awaited

test('<think> stripped even when tags are split across chunks', () => {
  const src = 'A<think>secret plan</think>B<th' + 'ink>more</thi' + 'nk>C';
  for (const size of [1, 2, 3, 5, 7]) {
    const s = new ThinkStripper(); let out = '';
    for (let i = 0; i < src.length; i += size) out += s.feed(src.slice(i, i + size));
    out += s.flush();
    assert.equal(out, 'ABC', `chunk size ${size}`);
  }
  assert.equal(stripThink('reasoning…</think>TITLE: x'), 'TITLE: x');
});

test('parseScript reads TITLE / SCRIPT / SOURCES (with markdown noise)', () => {
  const r = parseScript('**TITLE:** ليه بنتاوب؟\n**SCRIPT:**\n- التثاؤب معدي.\nعارف ليه؟\n[music]\nيعني باختصار: كده.\n**SOURCES:**\n1. Provine 2005\n- Platek 2003');
  assert.equal(r.title, 'ليه بنتاوب؟');
  assert.equal(r.text, 'التثاؤب معدي.\nعارف ليه؟\nيعني باختصار: كده.');
  assert.deepEqual(r.sources, ['Provine 2005', 'Platek 2003']);
});

test('tokenize keeps punctuation with words and tracks lines', () => {
  const t = tokenize('الأزرق بيتشتت ، أكتر\nعارف ليه ؟');
  assert.deepEqual(t.map((x) => x.text), ['الأزرق', 'بيتشتت،', 'أكتر', 'عارف', 'ليه؟']);
  assert.deepEqual(t.map((x) => x.line), [0, 0, 0, 1, 1]);
  assert.equal(countWords('الـ DNA بيتنسخ'), 3);
});

test('normWord unifies Arabic spelling variants', () => {
  assert.equal(normWord('أَكْتَر'), normWord('اكتر'));
  assert.equal(normWord('الطاقة'), normWord('الطاقه'));
  assert.equal(normWord('مستشفى'), normWord('مستشفي'));
  assert.equal(normWord('DNA,'), 'dna');
  assert.equal(normWord('٣٧'), '37');
});

test('LCS alignment: script spelling kept, ASR drift + missing/extra words handled', () => {
  const script = tokenize('الشمس بتطلع ضوء أبيض\nفيه كل الألوان');
  // ASR heard: different spelling, a dropped word ("كل"), and an extra word ("يعني")
  const heard = [['الشمس', 0.0, 0.4], ['بتطلع', 0.45, 0.8], ['يعني', 0.85, 1.0], ['ضو', 1.05, 1.3], ['ابيض', 1.35, 1.7], ['فيه', 2.0, 2.2], ['الالوان', 2.6, 3.1]]
    .map(([text, start, end]) => ({ text, start, end }));
  const w = alignWords(script, wordsWithChars(heard));
  assert.deepEqual(w.map((x) => x.text), ['الشمس', 'بتطلع', 'ضوء', 'أبيض', 'فيه', 'كل', 'الألوان']);
  assert.equal(w[0].start, 0);
  assert.ok(Math.abs(w[2].start - 1.05) < 0.01, `ضوء at ${w[2].start}`);
  assert.ok(Math.abs(w[3].start - 1.35) < 0.01);
  assert.ok(w[5].weak && w[5].start >= w[4].end - 1e-9 && w[5].start <= w[6].start, 'missing word interpolated + weak');
  assert.ok(!w[0].weak && !w[3].weak);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].start, 'monotonic');
});

test('ElevenLabs characters → words', () => {
  const chars = [...'ab cd'].map((c, i) => ({ c, start: i * 0.1, end: i * 0.1 + 0.1 }));
  assert.deepEqual(charsToWords(chars).map((w) => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]), [['ab', 0, 0.2], ['cd', 0.3, 0.5]]);
});

const words = Array.from({ length: 30 }, (_, i) => ({ i, text: 'w' + i, start: i * 0.4, end: i * 0.4 + 0.35 }));
test('storyboard repair: indices, sorting, intro at 0, no triple template', () => {
  const raw = {
    scenes: [
      { type: 'stat', template: 'gauge', at: 999, value: 5 },
      { type: 'concept', template: 'cards', at: 4, items: [{ label: 'a', icon: 'Heart!' }] },
      { type: 'process', template: 'cards', at: 10, items: [{ label: 'b' }] },
      { type: 'weird', template: 'cards', at: 16, items: [{ label: 'c' }] },
      { type: 'compare', template: 'chart', at: 22, items: [{ label: 'x' }] },
      { type: 'stat', template: 'meter', at: 25, value: 7 },
    ],
    accents: [[3, 'accent'], [3, 'blue'], [99, 'accent'], [5, 'neon']],
  };
  const { storyboard: sb, fixes } = repairStoryboard(raw, words);
  assert.equal(sb.scenes[0].at, 0);
  assert.equal(sb.scenes[0].type, 'intro');
  for (let i = 1; i < sb.scenes.length; i++) assert.ok(sb.scenes[i].at > sb.scenes[i - 1].at);
  assert.ok(sb.scenes.every((s) => s.at < words.length));
  for (let i = 2; i < sb.scenes.length; i++) assert.ok(!(sb.scenes[i].template === sb.scenes[i - 1].template && sb.scenes[i].template === sb.scenes[i - 2].template));
  assert.equal(sb.scenes.find((s) => s.template === 'chart'), undefined, 'chart without numbers is replaced');
  assert.ok(sb.scenes.some((s) => s.template === 'meter' && s.max >= s.value));
  assert.ok(fixes.some((f) => f.includes('999')) && fixes.some((f) => f.includes('merged')), 'out-of-range clamped, too-short last scene merged');
  assert.deepEqual(sb.accents, [[3, 'accent'], [5, 'accent'], [29, 'accent']]);
  assert.equal(sb.scenes[0].items[0]?.icon ?? sb.scenes.flatMap((s) => s.items).find((it) => it.label === 'a').icon, 'heart');
  assert.ok(fixes.length > 3);
});

test('storyboard repair: zoom needs 2 items, body needs an organ', () => {
  const { storyboard: sb } = repairStoryboard({ scenes: [{ type: 'intro', template: 'zoom', at: 0, items: [{ label: 'x', icon: 'leaf' }] }, { type: 'concept', template: 'body', at: 12, items: [] }] }, words);
  assert.equal(sb.scenes[0].items.length, 2);
  assert.equal(sb.scenes[1].template, 'zoom');
});

test('extractJson tolerates fences and trailing commas', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":[1,2,],}\n```'), { a: [1, 2] });
});

test('icons: nouns resolve across the three sets, payload has only used icons', () => {
  assert.equal(resolveIconKey('heart'), 'hi:heart-organ');
  assert.equal(resolveIconKey('DNA'), 'hd:dna');
  assert.ok(resolveIconKey('volcano').startsWith('tb:'));
  assert.equal(resolveIconKey('zzzz-not-a-thing'), 'hd:dot');
  const pay = iconsFor(['sun', 'sun', 'lungs']);
  assert.deepEqual(Object.keys(pay).sort(), ['lungs', 'sun']);
  assert.ok(pay.sun.p.length > 0 && [24, 48].includes(pay.lungs.v));
});

test('settings: keys masked to last 4, masked values never overwrite', () => {
  updateSettings({ llm: { apiKey: 'sk-abcdef-1234', baseUrl: 'http://x/v1' }, seriesTag: 'سلسلة' });
  const pub = getPublicSettings();
  assert.equal(pub.llm.apiKey, '••••1234');
  assert.ok(!JSON.stringify(pub).includes('abcdef'));
  updateSettings({ llm: { apiKey: '••••1234' } });
  assert.equal(getSettings().llm.apiKey, 'sk-abcdef-1234');
  updateSettings({ llm: { apiKey: '' } });
  assert.equal(getPublicSettings().llm.apiKey, process.env.LLM_API_KEY ? getPublicSettings().llm.apiKey : '');
});

const { resolvePalette, THEMES } = await import('../server/settings.mjs');
const { scriptMessages, readExamples } = await import('../server/text.mjs');

test('look: theme presets + validated colour overrides', () => {
  assert.equal(resolvePalette({ theme: 'paper', colors: {} }).bg, THEMES.paper.bg);
  const p = resolvePalette({ theme: 'dark', colors: { accent: '#ff0000', text: 'red; injection', nope: '#000000' } });
  assert.equal(p.accent, '#ff0000');
  assert.equal(p.text, THEMES.dark.text, 'invalid colour ignored');
  assert.ok(!('nope' in p));
  updateSettings({ look: { theme: 'paper', colors: { accent: '#123456', bg: 'bad' }, grid: false }, audio: { sfxVolume: 7, tick: false }, render: { fps: 61 }, approvals: { voice: 'wait', bogus: 'wait' } });
  const s = getSettings();
  assert.equal(s.look.theme, 'paper'); assert.equal(s.look.grid, false);
  assert.deepEqual(s.look.colors, { accent: '#123456' });
  assert.equal(s.audio.sfxVolume, 1); assert.equal(s.audio.tick, false);
  assert.equal(s.render.fps, 30, 'unsupported fps rejected');
  assert.equal(s.approvals.voice, 'wait'); assert.ok(!('bogus' in s.approvals));
  updateSettings({ look: { theme: 'dark', colors: {}, grid: true }, approvals: { voice: 'auto' } });
});

test('script prompt: fixed length vs auto, reference scripts appended', () => {
  const fixed = scriptMessages('x', 30);
  assert.match(fixed[1].content, /TARGET_WORDS: 78/);
  const auto = scriptMessages('x', 'auto');
  assert.match(auto[1].content, /LENGTH_SECONDS: auto/);
  const ex = readExamples();
  assert.ok(ex.length >= 1 && ex.every((e) => !/readme/i.test(e.file)));
  assert.ok(fixed[0].content.includes(ex[0].text.split('\n')[0]), 'examples included in system prompt');
});

const TL = await import('../server/timeline.mjs');
const { buildCues } = await import('../server/subtitles.mjs');
test('timeline: cuts are merged/clipped; kept segments and time mapping are exact', () => {
  const cuts = TL.cleanCuts([{ start: 5, end: 6 }, { start: 2, end: 3 }, { start: 2.9, end: 3.5 }, { start: 9, end: 9.05 }, { start: 11, end: 20 }], 12);
  assert.deepEqual(cuts, [{ start: 2, end: 3.5 }, { start: 5, end: 6 }, { start: 11, end: 12 }]);
  const segs = TL.keptSegments(1, 12, cuts);
  assert.deepEqual(segs, [[1, 2], [3.5, 5], [6, 11]]);
  assert.equal(TL.outDuration(segs), 7.5);
  assert.equal(TL.outToSrc(0, segs), 1); assert.equal(TL.outToSrc(1.2, segs), 3.7); assert.equal(TL.outToSrc(2.5, segs), 6);
  assert.equal(TL.srcToOut(4, segs), 1.5); assert.equal(TL.srcToOut(3, segs), null); assert.equal(TL.srcToOut(0.5, segs), null);
  for (const tau of [0, 0.7, 1.9, 2.6, 7.4]) assert.ok(Math.abs(TL.srcToOut(TL.outToSrc(tau, segs), segs) - tau) < 1e-9, `round trip ${tau}`);
});
test('subtitles follow cuts: cut words vanish, later cues move earlier, a cue split by a cut keeps both parts', () => {
  const words = tokenize('واحد اتنين تلاتة.\nأربعة خمسة ستة.\nسبعة تمانية').map((t, i) => ({ ...t, start: i, end: i + 0.8 }));
  const segs = TL.keptSegments(0, 9, [{ start: 3, end: 6 }]); // removes the whole second line
  const cues = buildCues(words, { segments: segs });
  assert.ok(!cues.some((c) => /أربعة|خمسة|ستة/.test(c.text)));
  assert.equal(cues.find((c) => c.text.startsWith('سبعة')).start, 3);
  // the cut sits in the middle of «اتنين»: the cue becomes two parts and the cut word is in neither
  const split = buildCues(words, { segments: TL.keptSegments(0, 9, [{ start: 1.2, end: 1.6 }]) }).slice(0, 2).map((c) => c.text);
  assert.deepEqual(split, ['واحد', 'تلاتة.']);
});

test('sequence: reordered parts + a pause map both ways; overlap and empty lists are refused', () => {
  const seq = TL.cleanSequence([{ start: 6, end: 9 }, { hold: 1.5, at: 6 }, { start: 0, end: 4 }], 10);
  const segs = TL.sequenceToSegments(seq);
  assert.deepEqual(segs, [[6, 9], [6, 6, 1.5], [0, 4]]);
  assert.equal(TL.outDuration(segs), 8.5);
  assert.equal(TL.outToSrc(1, segs), 7);
  assert.equal(TL.outToSrc(3.7, segs), 6, 'inside the pause the frame is held');
  assert.equal(TL.outToSrc(4.5, segs), 0);
  assert.equal(TL.srcToOut(0, segs), 4.5); assert.equal(TL.srcToOut(8, segs), 2); assert.equal(TL.srcToOut(5, segs), null);
  assert.throws(() => TL.cleanSequence([{ start: 0, end: 5 }, { start: 4, end: 6 }], 10), /same moment/);
  assert.throws(() => TL.cleanSequence([{ hold: 1, at: 0 }], 10), /at least one part/);
  assert.throws(() => TL.cleanSequence([{ start: 0, end: 2 }, { hold: 30, at: 0 }], 10), /0.1–10/);
  const words = tokenize('أول جملة هنا.\nتاني جملة هنا').map((t, i) => ({ ...t, start: i, end: i + 0.8 }));
  const cues = buildCues(words, { segments: [[3, 6], [3, 3, 1], [0, 3]] });
  assert.deepEqual(cues.map((c) => c.text), ['تاني جملة هنا', 'أول جملة هنا.'], 'subtitles come out in the new order');
  assert.equal(cues[1].start, 4, 'after the 3 s part and the 1 s pause');
});

// regressions from the PR #3 review
test('review: a word onset right after an inserted pause plays where the narration resumes', () => {
  const segs = [[0, 1], [1, 1, 2], [1, 2]];
  assert.equal(TL.srcToOut(1, segs), 3);
  assert.equal(TL.srcToOut(2, segs), 4, 'the very end still maps');
  assert.equal(TL.srcToOut(0.5, [[1, 2], [0, 1]]), 1.5);
});
test('review: a cue clipped at a shared boundary keeps its own part\'s output offset (no inverted cue)', () => {
  const words = [{ text: 'أ', start: 0.2, end: 1, line: 0 }, { text: 'ب', start: 1.1, end: 1.8, line: 0 }];
  const cues = buildCues(words, { segments: [[1, 2], [0, 1]], maxWords: 1 });
  for (const c of cues) assert.ok(c.end > c.start, JSON.stringify(c));
  assert.deepEqual(cues.map((c) => [c.text, c.start]), [['ب', 0.1], ['أ', 1.2]]);
});
test('review: a custom sequence shorter than 0.5 s is refused instead of silently replaced', () => {
  assert.throws(() => TL.cleanSequence([{ start: 0, end: 0.2 }], 10), /half a second/);
});
test('review: estimated timing — boundary goes to the next interval; snaps keep the remaining budget', async () => {
  const { allocateWords } = await import('../server/estimate.mjs');
  const two = allocateWords('ab ab', [[0, 1], [3, 4]]);
  assert.equal(two[1].start, 3, 'second word starts when speech resumes');
  const w = allocateWords('a a\na a\na a a a a', [[0, 1], [2, 3], [4, 5]]);
  for (const x of w) assert.ok(x.end > x.start, `usable interval ${JSON.stringify(x)}`);
  assert.ok(w[w.length - 1].start < 5, 'last word starts before the audio ends');
});
test('review: OpenAI TTS never sends a key over plain HTTP to a remote host; responses must be audio', async () => {
  const { assertSafeKeyUrl, isAudio } = await import('../server/apis.mjs');
  assert.throws(() => assertSafeKeyUrl('http://tts.example.com/v1', 'sk-1'), /plain HTTP/);
  assert.doesNotThrow(() => assertSafeKeyUrl('http://127.0.0.1:4399/v1', 'sk-1'));
  assert.doesNotThrow(() => assertSafeKeyUrl('https://api.openai.com/v1', 'sk-1'));
  assert.doesNotThrow(() => assertSafeKeyUrl('http://tts.example.com/v1', ''));
  assert.equal(isAudio(Buffer.from('<html><body>' + 'x'.repeat(400))), false);
  assert.equal(isAudio(Buffer.from('ID3\x04\x00\x00', 'latin1')), true);
});

for (const [name, fn] of queue) { await fn(); n++; console.log('✔', name); }
console.log(`\n${n} unit tests passed`);
