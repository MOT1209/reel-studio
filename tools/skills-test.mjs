// AI Skills + MCP: validation, permissions, import/export, runs and logs, over HTTP with the offline mocks.
// node tools/skills-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-skills-'));
const DATA = path.join(TMP, 'data');
const MOCK_PORT = 4391, PORT = 4307, MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${PORT}`;
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(u) { for (let i = 0; i < 100; i++) { try { await fetch(u); return; } catch { await sleep(100); } } throw new Error('not up ' + u); }
let n = 0, failed = 0;
async function test(name, fn) { try { await fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { Origin: BASE, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
}

procs.push(spawn('node', ['tools/mock-apis.mjs'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore' }));
procs.push(spawn('node', ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RS_PORT: String(PORT), RS_DATA_DIR: DATA, LLM_BASE_URL: `${MOCK}/v1` } }));
await up(`${MOCK}/media/_stats`); await up(`${BASE}/api/health`);
const SCRIPT = 'انا عايز اعرف ازاي السما زرقا.\nعارف ليه؟';

await test('built-in skills are listed; Arabic correction returns a diff proposal, nothing applied', async () => {
  const { body } = await api('/api/skills');
  for (const id of ['ar-correct', 'ar-tashkeel', 'ar-msa', 'ar-egyptian', 'titles', 'claims']) assert.ok(body.skills.some((s) => s.id === id && s.builtin), id);
  const r = await api('/api/skills/ar-correct/run', { method: 'POST', body: JSON.stringify({ input: SCRIPT }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.text, /أنا/); assert.match(r.body.text, /إزاي/);
  assert.ok(r.body.diff.some((d) => d.op === 'mod' || d.op === 'ins' || d.op === 'del'));
});
await test('JSON skill output is validated (required keys) and returned as data', async () => {
  const r = await api('/api/skills/titles/run', { method: 'POST', body: JSON.stringify({ input: SCRIPT }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.json.titles.length, 3);
});
await test('a disabled skill refuses to run; enabling it again works', async () => {
  assert.equal((await api('/api/skills/titles', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).body.enabled, false);
  assert.equal((await api('/api/skills/titles/run', { method: 'POST', body: JSON.stringify({ input: 'x' }) })).status, 403);
  await api('/api/skills/titles', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
});
await test('custom skills are validated (template needs {{input}}, no code, reserved ids) — import is all-or-nothing', async () => {
  const bad = await api('/api/skills/import', { method: 'POST', body: JSON.stringify([{ id: 'ok-one', name: 'OK', kind: 'prompt', prompt: 'Summarise: {{input}}' }, { id: 'bad', name: 'Bad', kind: 'script', code: 'process.exit()' }]) });
  assert.equal(bad.status, 400);
  assert.ok(!(await api('/api/skills')).body.skills.some((s) => s.id === 'ok-one'), 'nothing imported when one skill is invalid');
  assert.equal((await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'ar-correct', name: 'x', kind: 'prompt', prompt: '{{input}}' }) })).status, 400);
  assert.equal((await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'no-input', name: 'x', kind: 'prompt', prompt: 'hello' }) })).status, 400);
});
await test('custom skill: create → run → export → import (renamed on collision) → delete', async () => {
  const c = await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'summary', name: 'تلخيص', kind: 'prompt', prompt: 'Summarise in Arabic: {{input}}', output: { type: 'text' } }) });
  assert.equal(c.status, 201);
  const r = await api('/api/skills/summary/run', { method: 'POST', body: JSON.stringify({ input: SCRIPT }) });
  assert.match(r.body.text, /mock skill output/);
  const exp = await api('/api/skills/summary/export');
  assert.equal(exp.body.id, 'summary'); assert.equal(exp.body.builtin, undefined);
  const imp = await api('/api/skills/import', { method: 'POST', body: JSON.stringify(exp.body) });
  assert.match(imp.body.imported[0].id, /^summary-[a-f0-9]{4}$/);
  for (const id of ['summary', imp.body.imported[0].id]) assert.equal((await api(`/api/skills/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/api/skills/ar-msa', { method: 'DELETE' })).status, 400, 'built-ins cannot be deleted');
});

let sid;
await test('MCP: add server (secret header masked), sync tools — every tool starts disallowed', async () => {
  const r = await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'Mock MCP', url: `${MOCK}/mcp`, allowPrivate: true, headers: { Authorization: 'Bearer mcp-secret-token' } }) });
  assert.equal(r.status, 201);
  assert.ok(!JSON.stringify(r.body).includes('mcp-secret-token'));
  sid = r.body.id;
  const s = await api(`/api/mcp/${sid}/sync`, { method: 'POST' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.tools.map((t) => t.name), ['lookup_fact', 'delete_everything']);
  assert.deepEqual(s.body.allowedTools, []);
  assert.ok(!JSON.stringify((await api('/api/mcp')).body).includes('mcp-secret-token'));
  const logf = path.join(DATA, 'logs', 'server.log');
  if (fs.existsSync(logf)) assert.ok(!fs.readFileSync(logf, 'utf8').includes('mcp-secret-token'));
  const mcpDisk = fs.readFileSync(path.join(DATA, 'mcp.json'), 'utf8');
  assert.ok(!mcpDisk.includes('mcp-secret-token') && mcpDisk.includes('enc:v1:'), 'MCP auth header encrypted at rest');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(DATA, 'mcp.json')).mode & 0o777, 0o600, 'mcp.json (holds the token) is owner-only');
});
await test('MCP: a tool that is not allowed never reaches the server', async () => {
  const r = await api(`/api/mcp/${sid}/call`, { method: 'POST', body: JSON.stringify({ tool: 'delete_everything', arguments: {} }) });
  assert.equal(r.status, 403);
  assert.deepEqual((await (await fetch(`${MOCK}/media/_stats`)).json()).mcpCalls, []);
});
await test('MCP: allowed tool runs (SSE reply); arguments are checked against its schema; calls are logged', async () => {
  await api(`/api/mcp/${sid}/permissions`, { method: 'PUT', body: JSON.stringify({ allowedTools: ['lookup_fact', 'not_a_tool'] }) });
  const bad = await api(`/api/mcp/${sid}/call`, { method: 'POST', body: JSON.stringify({ tool: 'lookup_fact', arguments: { query: 5 } }) });
  assert.equal(bad.status, 400);
  const extra = await api(`/api/mcp/${sid}/call`, { method: 'POST', body: JSON.stringify({ tool: 'lookup_fact', arguments: { query: 'sky', cmd: 'rm -rf' } }) });
  assert.equal(extra.status, 400);
  const ok = await api(`/api/mcp/${sid}/call`, { method: 'POST', body: JSON.stringify({ tool: 'lookup_fact', arguments: { query: 'sky' } }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.text, /Rayleigh/);
  const { body } = await api('/api/mcp');
  assert.deepEqual(body.servers[0].allowedTools, ['lookup_fact'], 'unknown tool names are dropped');
  assert.ok(body.calls.some((c) => c.tool === 'lookup_fact' && c.ok));
});
await test('MCP: an expired server session (HTTP 404) is re-opened and the call retried once', async () => {
  const before = (await (await fetch(`${MOCK}/mcp/_stats`)).json()).initializes;
  await fetch(`${MOCK}/mcp/_expire`);
  const r = await api(`/api/mcp/${sid}/call`, { method: 'POST', body: JSON.stringify({ tool: 'lookup_fact', arguments: { query: 'again' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.text, /again/);
  assert.equal((await (await fetch(`${MOCK}/mcp/_stats`)).json()).initializes, before + 1, 'exactly one new session was opened');
});
await test('MCP: a redirect is not followed (headers never leave for another host)', async () => {
  const r = await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'redir', url: `${MOCK}/mcp-redirect`, allowPrivate: true, headers: { Authorization: 'Bearer x' } }) });
  const sy = await api(`/api/mcp/${r.body.id}/sync`, { method: 'POST' });
  assert.equal(sy.status, 502); assert.match(sy.body.error, /بيحوّل|HTTP 302/);
});
await test('MCP skill: needs an allowed tool; runs through the same permission check', async () => {
  assert.equal((await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'danger', name: 'x', kind: 'mcp', mcp: { server: sid, tool: 'delete_everything' } }) })).status, 400);
  const c = await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: 'fact', name: 'حقيقة علمية', kind: 'mcp', mcp: { server: sid, tool: 'lookup_fact', args: { query: '{{input}}' } } }) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await api('/api/skills/fact/run', { method: 'POST', body: JSON.stringify({ input: 'blue sky' }) });
  assert.match(r.body.text, /FACT about blue sky/);
  await api(`/api/mcp/${sid}/permissions`, { method: 'PUT', body: JSON.stringify({ allowedTools: [] }) });
  assert.equal((await api('/api/skills/fact/run', { method: 'POST', body: JSON.stringify({ input: 'x' }) })).status, 403, 'revoking the tool blocks the skill');
  const runs = (await api('/api/skills')).body.runs;
  assert.ok(runs.some((x) => x.skill === 'fact' && x.ok) && runs.some((x) => x.skill === 'fact' && !x.ok));
});
await test('MCP: only http(s) servers can be added', async () => {
  for (const url of ['file:///etc/passwd', 'stdio://python server.py', 'javascript:alert(1)']) assert.equal((await api('/api/mcp', { method: 'POST', body: JSON.stringify({ url }) })).status, 400, url);
});
await test('MCP: loopback / private addresses need an explicit allowPrivate; public ones do not', async () => {
  for (const url of ['http://127.0.0.1:9/mcp', 'http://localhost/mcp', 'http://10.1.2.3/mcp', 'http://192.168.1.5/mcp', 'http://172.20.0.1/mcp', 'http://169.254.169.254/latest', 'http://[::1]/mcp']) assert.equal((await api('/api/mcp', { method: 'POST', body: JSON.stringify({ url }) })).status, 400, url);
  assert.equal((await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'pub', url: 'https://example.com/mcp' }) })).status, 201);
  assert.equal((await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'loc', url: 'http://127.0.0.1:9/mcp', allowPrivate: true }) })).status, 201);
});

console.log(`\n${n} skills/MCP tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
