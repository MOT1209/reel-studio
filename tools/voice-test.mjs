// Voice providers: OpenAI-compatible TTS, timing via Deepgram or estimated locally from the pauses.
// Accuracy is measured against the mock synthesizer's real word onsets. node tools/voice-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-voice-'));
const MOCK_PORT = 4389, MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
await up(`${MOCK}/media/_stats`);
function server(port, extra) {
  procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RS_PORT: String(port), RS_DATA_DIR: path.join(TMP, String(port)),
    LLM_BASE_URL: `${MOCK}/v1`, DEEPGRAM_BASE_URL: MOCK, OPENAI_TTS_BASE_URL: `${MOCK}/v1`, LLM_API_KEY: '', DEEPGRAM_API_KEY: '', ...extra } }));
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { Origin: base, 'Content-Type': 'application/json' } }); const b = await r.json(); if (!r.ok) throw new Error(JSON.stringify(b)); return b; };
  return { base, api };
}
async function runToTiming({ api }) {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ tts: { provider: 'openai' }, openaiTts: { model: 'gpt-4o-mini-tts', voice: 'nova', apiKey: 'sk-test-openai-1234' } }) });
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: 'ليه السما لونها أزرق؟', seconds: 20, options: { research: false }, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } }) });
  for (let i = 0; i < 600; i++) {
    const q = await api(`/api/projects/${p.id}`);
    const err = Object.values(q.stages).find((s) => s.status === 'error');
    if (err) throw new Error(err.error);
    if (q.stages.storyboard.status === 'review') return q;
    await sleep(200);
  }
  throw new Error('timeout');
}
async function errors(q) {
  const truth = (await (await fetch(`${MOCK}/v1/_truth`, { method: 'POST', body: JSON.stringify({ text: q.script.text }) })).json()).words;
  assert.equal(truth.length, q.words.length, 'same word count');
  const e = q.words.map((w, i) => Math.abs(w.start - truth[i].start)).sort((a, b) => a - b);
  return { median: e[Math.floor(e.length / 2)], p90: e[Math.floor(e.length * 0.9)], max: e[e.length - 1] };
}

const withDg = server(4309, { DEEPGRAM_API_KEY: 'mock' });
const noDg = server(4310, {});
await up(`${withDg.base}/api/health`); await up(`${noDg.base}/api/health`);

await test('OpenAI-compatible TTS: key stays masked, connection test works', async () => {
  const s = await withDg.api('/api/settings', { method: 'PUT', body: JSON.stringify({ openaiTts: { apiKey: 'sk-test-openai-1234' } }) });
  assert.equal(s.openaiTts.apiKey, '••••1234');
  assert.equal(s._source['openaiTts.baseUrl'], 'env (locked)');
  const t = await withDg.api('/api/test/openaiTts', { method: 'POST', body: '{}' });
  assert.equal(t.ok, true, t.message);
});
await test('OpenAI TTS + Deepgram: words aligned with real timing (median error < 80 ms)', async () => {
  const q = await runToTiming(withDg);
  assert.equal(q.voice.source, 'openai');
  assert.equal(q.timing.source, 'openai'); assert.equal(q.timing.estimated, false);
  const e = await errors(q);
  console.log(`   Deepgram timing error: median ${(e.median * 1000).toFixed(0)} ms · p90 ${(e.p90 * 1000).toFixed(0)} ms`);
  assert.ok(e.median < 0.08, `median ${e.median}`);
});
await test('OpenAI TTS without Deepgram: timing estimated from the pauses, flagged, usable (median < 300 ms)', async () => {
  const q = await runToTiming(noDg);
  assert.equal(q.timing.source, 'estimate'); assert.equal(q.timing.estimated, true);
  assert.match(q.stages.timing.log.join('\n'), /estimating word timing/);
  const e = await errors(q);
  console.log(`   estimated timing error: median ${(e.median * 1000).toFixed(0)} ms · p90 ${(e.p90 * 1000).toFixed(0)} ms · max ${(e.max * 1000).toFixed(0)} ms`);
  assert.ok(e.median < 0.3 && e.max < 1.2, JSON.stringify(e));
  for (let i = 1; i < q.words.length; i++) assert.ok(q.words[i].start >= q.words[i - 1].start, 'monotonic');
});

console.log(`\n${n} voice tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
