// Outbound webhooks: the Svix message shape, the no-key no-op and an API error that never reaches the caller.
// Runs offline against a local Svix stand-in. node tools/webhooks-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-webhooks-'));
delete process.env.SVIX_API_KEY;

let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log('✔', name); }
  catch (e) { failed++; console.log('✖', name, '—', e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('timed out waiting for the request');
}

const reqs = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (mode === 'fail') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'invalid token' }));
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test_1', eventType: 'test', payload: {}, createdAt: new Date().toISOString() }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.SVIX_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const W = await import('../server/webhooks.mjs');

await test('no SVIX_API_KEY: nothing is sent and nothing throws', async () => {
  const r = await W.sendWebhook('project.created', { a: 1 });
  assert.equal(r.sent, false);
  W.notifyProject({ id: '20261126-abc123', topic: 'x' }, 'project.created');
  await sleep(50);
  assert.equal(reqs.length, 0);
  assert.equal(W.webhooksEnabled(), false);
  assert.equal(W.svixClient(), null);
});

await test('message.create posts to the app uid with eventType, eventId and payload', async () => {
  process.env.SVIX_API_KEY = 'test_key_not_a_real_secret';
  const r = await W.sendWebhook('project.stage.done', { stage: 'render' }, { eventId: 'evt-1' });
  assert.equal(r.sent, true);
  assert.equal(r.id, 'msg_test_1');
  assert.equal(reqs.length, 1);
  const q = reqs[0];
  assert.equal(q.method, 'POST');
  assert.equal(q.url, '/api/v1/app/reel-studio/msg?with_content=false');
  assert.equal(q.auth, 'Bearer test_key_not_a_real_secret');
  assert.equal(q.body.eventType, 'project.stage.done');
  assert.equal(q.body.eventId, 'evt-1');
  assert.deepEqual(q.body.payload, { stage: 'render' });
  assert.deepEqual(q.body.application, { name: 'Reel Studio', uid: 'reel-studio' });
});

await test('notifyProject sends the project summary with a unique event id', async () => {
  reqs.length = 0;
  const p = { id: '20261126-abc123', topic: 'ليه بنتاوب؟', seconds: 90, script: { title: 'التثاؤب' }, chapters: [{}, {}] };
  W.notifyProject(p, 'project.created');
  await until(() => reqs.length === 1);
  const { body } = reqs[0];
  assert.equal(body.eventType, 'project.created');
  assert.match(body.eventId, /^20261126-abc123-project\.created-\d+$/);
  assert.equal(body.payload.project.id, p.id);
  assert.equal(body.payload.project.title, 'التثاؤب');
  assert.equal(body.payload.project.seconds, 90);
  assert.equal(body.payload.project.chapters, 2);
  assert.match(body.payload.at, /^\d{4}-\d{2}-\d{2}T/);
});

await test('an API error is reported, never thrown or leaked', async () => {
  mode = 'fail';
  const r = await W.sendWebhook('project.stage.failed', { stage: 'render' });
  assert.equal(r.sent, false);
  assert.ok(r.error, 'an error message is returned');
  assert.ok(!r.error.includes('test_key_not_a_real_secret'), 'the API key is not in the error');
  mode = 'ok';
});

console.log(`\n${n} webhook tests passed${failed ? `, ${failed} FAILED` : ''}`);
server.close();
fs.rmSync(process.env.RS_DATA_DIR, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
