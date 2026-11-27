// Estimate test: node tools/estimate-test.mjs
// Proves the pre-render estimate follows the measured render rates: the range brackets the midpoint, the anchors
// reproduce real renders, export settings move the estimate the way they move the renderer, and cost stays null
// until prices are configured.
import assert from 'node:assert/strict';
import { estimateRender as estimateProject, MEASURED } from '../server/render-estimate.mjs';

let passed = 0;
const ok = (name, detail = '') => { passed++; console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`); };

const edit = (x = {}) => ({ export: { aspect: '9:16', resolution: 720, quality: 'draft', fps: 24, engine: 'legacy', ...x } });
const long = { topic: 't', seconds: 1800, options: { chapters: true, chapterSeconds: 300, research: true }, edit: edit() };

const a = estimateProject(long);
assert.equal(a.chapters, 6);
assert.equal(a.words, 4680);
assert.equal(a.ttsCharacters, Math.round(4680 * 6.2));
assert.ok(a.renderSecondsMin < a.renderSeconds && a.renderSeconds < a.renderSecondsMax, `range ${a.renderSecondsMin}…${a.renderSeconds}…${a.renderSecondsMax}`);
assert.equal(a.renderMinutesMin, +(a.renderSecondsMin / 60).toFixed(1));
assert.equal(a.renderMinutesMax, +(a.renderSecondsMax / 60).toFixed(1));
assert.ok(a.renderSeconds > 600 && a.renderSeconds < 1200, `30 min on the legacy engine at 720p/draft measured ~13 min, model says ${a.renderSeconds} s`);
ok('30-minute chaptered project', `${a.chapters} chapters · ${a.words} words · ~${a.renderMinutesMin}–${a.renderMinutesMax} min render · ~${a.diskMB} MB`);

// the anchor of the measurement: the 3 × 13 s project that tools/estimate-calibrate.mjs rendered took 96.7 s
const anchor = estimateProject({ topic: 't', seconds: 39.1, options: { chapters: true, chapterSeconds: 13, research: false }, edit: edit({ resolution: 1080, quality: 'standard', fps: 30, engine: 'auto' }) });
assert.ok(Math.abs(anchor.renderSeconds - 96.7) / 96.7 < 0.05, `calibration anchor: model ${anchor.renderSeconds} s, measured render stage 96.7 s`);
ok('the model reproduces the render it was calibrated on', `${anchor.renderSeconds} s estimated · 96.7 s measured (3 chapters, 1080p, standard, 30 fps)`);

const hd = estimateProject({ ...long, edit: edit({ resolution: 1080, quality: 'high' }) });
// measured: 1080p costs 1.41× 720p on the legacy engine and 1.26× on Remotion (pixel fit), not the 2.25× a
// linear pixel count would suggest
const hdRatio = hd.ratePerSecond / a.ratePerSecond;
assert.ok(hdRatio > 1.3 && hdRatio < 2, `1080p/high is ${hdRatio.toFixed(2)}× 720p/draft`);
ok('1080p/high costs more render time', `×${hdRatio.toFixed(2)}`);

const rem = estimateProject({ ...long, edit: edit({ engine: 'remotion' }) });
assert.ok(rem.renderSeconds > a.renderSeconds * 2.5, `remotion ${rem.renderSeconds} s vs legacy ${a.renderSeconds} s`);
const auto = estimateProject({ ...long, edit: edit({ engine: 'auto' }) });
assert.equal(auto.renderSeconds, rem.renderSeconds, 'auto is estimated at the worst case (Remotion)');
ok('engine changes the render estimate', `legacy ${a.renderSeconds} s · remotion ${rem.renderSeconds} s`);

const fps60 = estimateProject({ ...long, edit: edit({ fps: 60 }) });
assert.ok(fps60.ratePerSecond > a.ratePerSecond * 2.3, `60 fps: ${fps60.ratePerSecond} vs 24 fps: ${a.ratePerSecond}`);
ok('frame rate scales the frame work', `${a.ratePerSecond} s/s at 24 fps · ${fps60.ratePerSecond} s/s at 60 fps`);

const square = estimateProject({ ...long, edit: edit({ aspect: '1:1', resolution: 1080, quality: 'standard' }) });
const portrait = estimateProject({ ...long, edit: edit({ resolution: 1080, quality: 'standard' }) });
assert.ok(square.ratePerSecond < portrait.ratePerSecond, 'a square frame has fewer pixels than 9:16');
ok('aspect changes the pixel count', `1:1 ${square.ratePerSecond} s/s · 9:16 ${portrait.ratePerSecond} s/s`);

assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(MEASURED.at) && a.measuredAt === MEASURED.at, 'the estimate says when it was measured');

const script = estimateProject({ ...long, seconds: 'auto', script: { text: 'كلمة '.repeat(500), words: 500 } });
assert.equal(script.words, 500);
assert.equal(script.ttsCharacters, 'كلمة '.repeat(500).length);
assert.ok(script.renderSeconds < a.renderSeconds, 'a shorter script estimates less');
ok('a written script sets the length and the character count', `${script.seconds} s · ${script.words} words · ${script.ttsCharacters} chars`);

assert.equal(a.cost, null);
process.env.RS_PRICE_TTS_PER_1K_CHARS = '0.30';
process.env.RS_PRICE_LLM_PER_1K_TOKENS = '0.002';
process.env.RS_PRICE_RENDER_PER_MINUTE = '0.01';
const priced = estimateProject(long);
assert.ok(priced.cost && priced.cost.total > 0);
const wantTts = +(priced.ttsCharacters / 1000 * 0.3).toFixed(2);
assert.equal(priced.cost.tts, wantTts);
const wantTotal = +(priced.ttsCharacters / 1000 * 0.3 + priced.llmTokens / 1000 * 0.002 + priced.renderSeconds / 60 * 0.01).toFixed(2);
assert.equal(priced.cost.total, wantTotal);
delete process.env.RS_PRICE_TTS_PER_1K_CHARS;
delete process.env.RS_PRICE_LLM_PER_1K_TOKENS;
delete process.env.RS_PRICE_RENDER_PER_MINUTE;
ok('cost appears only when prices are set', `total $${priced.cost.total} · TTS $${priced.cost.tts}`);

const silence = estimateProject({ topic: 't', seconds: 60, edit: edit() });
assert.ok(silence.renderSeconds > 0 && silence.words > 0);
ok('a project before its script still gets an estimate', `${silence.chapters} chapter(s) · ${silence.words} words`);

console.log(`\n${passed}/${passed} checks passed`);
