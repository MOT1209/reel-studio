// README parity test: node tools/readme-test.mjs
// The README ships two complete versions in one file — English first, then Arabic. This keeps them in sync: the same
// section headings (in the same order), the same npm commands (all of which must exist in package.json), the same
// link targets, balanced code fences, and every relative link points at a file that exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const md = read('README.md');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const check = (name, fn) => {
  try { fn(); } catch (e) { console.error(`✖ ${name} — ${e.message.split('\n')[0]}`); process.exitCode = 1; throw e; }
  passed++;
  console.log(`✔ ${name}`);
};

// The Arabic version starts at its h1; everything before it is the English one.
const marker = md.indexOf('\n# العربية\n');
assert.ok(marker > 0, 'README has an English section followed by an Arabic one');
const halves = { en: md.slice(0, marker), ar: md.slice(marker) };

// One row per section: [English heading, Arabic heading]. Both versions must have exactly these, in this order.
const SECTIONS = [
  ['Quick start', 'البدء السريع'],
  ['How it works', 'كيف يعمل'],
  ['Long-form video', 'الفيديو الطويل'],
  ['Editor', 'المحرر'],
  ['Arabic', 'العربية'],
  ['Render engines', 'محركات الرندر'],
  ['Security', 'الأمان'],
  ['Configuration', 'الإعدادات (متغيرات البيئة)'],
  ['Tests', 'الاختبارات'],
  ['Project layout', 'بنية المشروع'],
  ['Docs', 'التوثيق'],
  ['License', 'الرخصة'],
];
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const commands = (text) => new Set([...text.matchAll(/npm (?:run )?([a-z:0-9-]+)/g)].map((m) => {
  const name = m[1];
  return name === 'test' ? 'npm test' : `npm run ${name}`;
}));
const links = (text) => new Set([...text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1].trim()).filter((l) => !/^(mailto:)/.test(l)));

const enH = headings(halves.en), arH = headings(halves.ar);
const enC = commands(halves.en), arC = commands(halves.ar);
const enL = links(halves.en), arL = links(halves.ar);

check('both versions have the same sections, in the same order', () => {
  assert.equal(enH.length, SECTIONS.length, `English has ${enH.length} sections, expected ${SECTIONS.length}`);
  assert.equal(arH.length, SECTIONS.length, `Arabic has ${arH.length} sections, expected ${SECTIONS.length}`);
  SECTIONS.forEach(([en, ar], i) => {
    assert.equal(enH[i], en, `English section ${i + 1} is "${enH[i]}", expected "${en}"`);
    assert.equal(arH[i], ar, `Arabic section ${i + 1} is "${arH[i]}", expected "${ar}"`);
  });
});

check('every section has a body in both versions', () => {
  for (const [lang, text, list] of [['English', halves.en, enH], ['Arabic', halves.ar, arH]]) {
    for (let i = 0; i < list.length; i++) {
      const from = text.indexOf(`## ${list[i]}`) + list[i].length + 3;
      const to = i + 1 < list.length ? text.indexOf(`## ${list[i + 1]}`, from) : text.length;
      assert.ok(text.slice(from, to).trim().length > 0, `${lang} section "${list[i]}" is empty`);
    }
  }
});

check('both versions list the same npm commands', () => {
  const onlyEn = [...enC].filter((c) => !arC.has(c));
  const onlyAr = [...arC].filter((c) => !enC.has(c));
  assert.deepEqual(onlyEn, [], `only in English: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyAr, [], `only in Arabic: ${onlyAr.join(', ')}`);
  assert.ok(enC.has('npm test'), 'the test suite command is documented');
});

check('every documented npm command exists in package.json', () => {
  const missing = [...enC].filter((c) => c !== 'npm test' && !pkg.scripts[c.slice(8)]);
  assert.deepEqual(missing, [], `not in package.json scripts: ${missing.join(', ')}`);
});

check('both versions link to the same targets', () => {
  const onlyEn = [...enL].filter((l) => !arL.has(l));
  const onlyAr = [...arL].filter((l) => !enL.has(l));
  assert.deepEqual(onlyEn, [], `only in English: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyAr, [], `only in Arabic: ${onlyAr.join(', ')}`);
});

check('every relative link exists on disk', () => {
  const missing = [...enL].filter((l) => !/^https?:/.test(l) && !fs.existsSync(path.join(ROOT, decodeURI(l))));
  assert.deepEqual(missing, [], `broken links: ${missing.join(', ')}`);
});

check('code fences are balanced in both versions', () => {
  for (const [lang, text] of [['English', halves.en], ['Arabic', halves.ar]]) {
    const fences = (text.match(/^```/gm) || []).length;
    assert.equal(fences % 2, 0, `${lang} has ${fences} fence markers`);
  }
});

console.log(`\n${passed}/${passed} checks passed · ${enH.length} sections · ${enC.size} commands · ${enL.size} links`);
