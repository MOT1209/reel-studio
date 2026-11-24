// Arabic engine tests: bidi word order, subtitles, dialect detection, diacritics, diff, log redaction,
// and real glyph shaping in the browser that renders the video. node tools/arabic-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.RS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ar-'));
const AR = await import('../server/arabic.mjs');
const { buildCues, toSrt, toVtt } = await import('../server/subtitles.mjs');
const { tokenize } = await import('../server/text.mjs');
const { updateSettings } = await import('../server/settings.mjs');
const { log, redact, logFile } = await import('../server/logger.mjs');

const sandbox = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/bidi.js'), 'utf8'), sandbox);
const B = sandbox.globalThis.ReelBidi;

let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
const order = (line, base) => B.visualOrder(line.split(' '), base).map((i) => line.split(' ')[i]).join(' | ');

await test('bidi: an English term inside an Arabic line keeps its left-to-right order', () => {
  // slots from the right edge: الـ, then the LTR run reversed (polymerase sits right of DNA when read leftwards)
  assert.equal(order('الـ DNA polymerase بيعمل نسخة'), 'الـ | polymerase | DNA | بيعمل | نسخة');
});
await test('bidi: numbers in Arabic context stay in RTL slot order; after Latin they join the Latin run', () => {
  assert.equal(order('سنة 2020 و 2021 كانوا'), 'سنة | 2020 | و | 2021 | كانوا');
  assert.equal(order('نظام Windows 11 جديد'), 'نظام | 11 | Windows | جديد');
});
await test('bidi: an English line with one Arabic word keeps LTR base and reverses the Arabic run', () => {
  assert.equal(B.baseDir(['The', 'word', 'سما', 'means', 'sky']), 'ltr');
  assert.equal(order('The word السما الزرقا means sky', 'ltr'), 'The | word | الزرقا | السما | means | sky');
});
await test('bidi: neutral punctuation between two Latin words joins them; at the edge it follows the paragraph', () => {
  assert.equal(order('مثال CO2 - H2O هنا'), 'مثال | H2O | - | CO2 | هنا');
  assert.deepEqual([...B.resolve(['«', 'كلمة', '»'], 'rtl')], ['R', 'R', 'R']);
});

await test('subtitles: cues follow script lines, ≤ 6 words, SRT/VTT stamps, RLM-wrapped Arabic', () => {
  const words = tokenize('السما لونها أزرق عشان الضوء بيتشتت في الجو.\nوالغروب أحمر.').map((t, i) => ({ ...t, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const cues = buildCues(words);
  assert.ok(cues.every((c) => c.text.split(' ').length <= 6));
  assert.equal(cues[cues.length - 1].text, 'والغروب أحمر.');
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n‏/);
  assert.match(toVtt(cues), /^WEBVTT\n\n1\n00:00:00\.000 --> /);
  assert.ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end - 1e-9), 'cues never overlap');
});
await test('subtitles: trim offset shifts times and drops cues outside the clip; Arabic-Indic digits option', () => {
  const words = tokenize('عندنا 30 ثانية بس').map((t, i) => ({ ...t, start: i, end: i + 0.8 }));
  const cues = buildCues(words, { offset: 1, end: 3.5, digits: 'arabic', maxWords: 1 });
  assert.equal(cues[0].text, '٣٠');
  assert.equal(cues[0].start, 0);
  assert.ok(cues.every((c) => c.end <= 2.5 + 1e-9));
});

await test('dialect: Egyptian, Levantine, Gulf, Maghrebi, MSA, mixed, unknown', () => {
  assert.equal(AR.detectDialect('عارف ليه السما لونها أزرق؟ عشان الضوء بيتشتت كده').dialect, 'egyptian');
  assert.equal(AR.detectDialect('هل تعرف لماذا تبدو السماء زرقاء؟ لأن الضوء الذي يصل إلينا يتشتت').dialect, 'msa');
  assert.equal(AR.detectDialect('شو بتعرف ليش السما زرقا؟ هيك الضو بيتشتت كتير هلق').dialect, 'levantine');
  assert.equal(AR.detectDialect('تدري ليش السما زرقا؟ الحين بقولك، الضو يتشتت وايد وهذي السالفة').dialect, 'gulf');
  assert.equal(AR.detectDialect('واش عرفتي علاش السما زرقا؟ دابا نقولك، الضو كيتشتت بزاف').dialect, 'maghrebi');
  assert.equal(AR.detectDialect('ده شو إزاي هلق').dialect, 'mixed');
  assert.equal(AR.detectDialect('the sky').dialect, 'unknown');
  assert.equal(AR.detectDialect('شو').label, 'شامي');
});

const ksb = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/kashida.js'), 'utf8'), ksb);
const K = ksb.globalThis.ReelKashida;
await test('kashida: tatweel only between joining letters — never after ا د ذ ر ز و ة, never inside لا', () => {
  const spotsAfter = (w) => Array.from(K.spots(w), (s) => [...w][s.at - 1]); // plain arrays (vm arrays have another prototype)
  assert.deepEqual(spotsAfter('السلام').sort(), ['س', 'ل'].sort(), 'ال → no spot after alef; لا ligature kept');
  assert.equal(K.spots('وردة').length, 0, 'و ر د ة never connect forward');
  const w = K.justifyWords(['محمد'], 1000, (s) => [...s].length * 10, { maxPerSpot: 2 })[0];
  assert.ok([...w].every((c, i, a) => c !== K.TATWEEL || !'اأإآدذرزوؤةى'.includes(a[i - 1] === K.TATWEEL ? a[i - 2] : a[i - 1])));
  assert.equal(w.replaceAll(K.TATWEEL, ''), 'محمد', 'letters unchanged');
  assert.equal(K.justifyWords(['Hello'], 999, (s) => s.length)[0], 'Hello', 'Latin words are never stretched');
});

await test('kashida in the render browser: a real Arabic line is stretched to the target width and stays shaped', async () => {
  const { launchBrowser } = await import('../server/render.mjs');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const font = fs.readFileSync(path.join(ROOT, 'assets/fonts/library/amiri/Amiri-Regular.ttf')).toString('base64');
    await page.setContent('<canvas id=c width=900 height=200></canvas>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'public/kashida.js'), 'utf8') });
    const r = await page.evaluate(async (b64) => {
      const f = new FontFace('A', `url(data:font/ttf;base64,${b64})`); await f.load(); document.fonts.add(f);
      const ctx = document.getElementById('c').getContext('2d'); ctx.font = '40px A'; ctx.direction = 'rtl';
      const m = (s) => ctx.measureText(s).width;
      const words = ['السماء', 'لونها', 'أزرق', 'بسبب', 'تشتت', 'الضوء'], sp = 12;
      const w0 = words.reduce((a, w) => a + m(w), 0) + sp * 5;
      const target = w0 * 1.18;
      const out = window.ReelKashida.justifyWords(words, target, m, { space: sp });
      return { w0, target, w1: out.reduce((a, w) => a + m(w), 0) + sp * 5, out };
    }, font);
    assert.ok(r.w1 <= r.target + 0.5, `not wider than the target (${r.w1.toFixed(1)} > ${r.target.toFixed(1)})`);
    assert.ok(r.w1 >= r.target - 25, `reaches the target within one tatweel (${r.w1.toFixed(1)} vs ${r.target.toFixed(1)})`);
    assert.ok(r.out.join('').includes('ـ'));
    assert.deepEqual(r.out.map((w) => w.replaceAll('ـ', '')), ['السماء', 'لونها', 'أزرق', 'بسبب', 'تشتت', 'الضوء']);
  } finally { await browser.close(); }
});
await test('diacritics: strip, detect, digits', () => {
  assert.equal(AR.stripTashkeel('السَّمَاءُ زَرْقَاءُ'), 'السماء زرقاء');
  assert.ok(AR.hasTashkeel('عِلْم') && !AR.hasTashkeel('علم'));
  assert.equal(AR.toArabicDigits('2026'), '٢٠٢٦');
  assert.equal(AR.toLatinDigits('٢٠٢٦ ۱۲'), '2026 12');
});
await test('word diff ignores diacritics for equality and marks real edits', () => {
  const d = AR.wordDiff('انا رايح المدرسة', 'أنا رايح المدرسة النهارده');
  assert.deepEqual(d.map((x) => x.op), ['mod', 'eq', 'ins']);
  assert.ok(AR.wordDiff('السماء زرقاء', 'السَّمَاءُ زَرْقَاءُ').every((x) => x.op !== 'del' && x.op !== 'ins'));
});
await test('sentence segmentation keeps script lines and splits on sentence punctuation', () => {
  assert.deepEqual(AR.sentences('أولًا. ثانيًا؟\nثالثًا'), ['أولًا.', 'ثانيًا؟', 'ثالثًا']);
});

await test('logs: stored keys, bearer tokens and key=… values never reach the log file', () => {
  updateSettings({ elevenlabs: { apiKey: 'sk_live_SUPERSECRET123456' } });
  const line = log('error', 'ElevenLabs HTTP 401 for key sk_live_SUPERSECRET123456', { auth: 'Bearer abcdefghijklmnop', url: 'https://x/?api_key=QWERTYUIOP12345' });
  const disk = fs.readFileSync(logFile, 'utf8');
  for (const s of ['sk_live_SUPERSECRET123456', 'abcdefghijklmnop', 'QWERTYUIOP12345']) { assert.ok(!line.includes(s), s); assert.ok(!disk.includes(s), s); }
  assert.match(redact('xi-api-key: abcdef123456789'), /\[REDACTED\]/);
});

await test('glyph shaping: real Arabic sentences are shaped (joined forms, lam-alef ligature) in the render browser', async () => {
  const { launchBrowser } = await import('../server/render.mjs');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const font = fs.readFileSync(path.join(ROOT, 'assets/fonts/IBMPlexSansArabic-Bold.ttf')).toString('base64');
    await page.setContent('<canvas id=c width=800 height=200></canvas>');
    const r = await page.evaluate(async (b64) => {
      const f = new FontFace('T', `url(data:font/ttf;base64,${b64})`); await f.load(); document.fonts.add(f);
      const ctx = document.getElementById('c').getContext('2d'); ctx.font = '48px T'; ctx.direction = 'rtl';
      const w = (s) => ctx.measureText(s).width;
      const sentence = 'السما لونها أزرق عشان الضوء بيتشتت';
      const isolated = [...sentence.replace(/ /g, '')].reduce((a, ch) => a + w(ch), 0);
      return { joined: w(sentence.replace(/ /g, '')), isolated, la: w('لا'), lPlusA: w('ل') + w('ا'), word: w('محمد'), unjoined: w('م\u200Cح\u200Cم\u200Cد') };
    }, font);
    // joined (initial/medial/final) forms are narrower than isolated forms; لا becomes one ligature glyph
    assert.ok(r.joined < r.isolated * 0.9, `joined ${r.joined.toFixed(0)} vs isolated ${r.isolated.toFixed(0)}`);
    assert.ok(r.la < r.lPlusA * 0.95, `lam-alef ${r.la.toFixed(1)} vs ${r.lPlusA.toFixed(1)}`);
    assert.notEqual(r.word.toFixed(1), r.unjoined.toFixed(1), 'محمد with joining vs with ZWNJ (no joining) must differ');
  } finally { await browser.close(); }
});

console.log(`\n${n} Arabic tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
