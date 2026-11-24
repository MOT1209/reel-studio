// MCP client (Streamable HTTP transport only — no stdio, so connecting a server never spawns a process here).
// Servers are added by the owner; every tool starts DISABLED and must be allowed one by one. Arguments are checked
// against the tool's input schema, results are size-limited, and every call is logged (redacted).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, writeFileAtomic, mask } from './settings.mjs';
import { log as slog, addSecret } from './logger.mjs';
import { seal, open as unseal } from './vault.mjs';

const FILE = path.join(DATA_DIR, 'mcp.json');
const RUNS = path.join(DATA_DIR, 'logs', 'mcp-calls.jsonl');
const PROTOCOL = '2025-06-18';
const MAX_RESULT = 100 * 1024;
const err = (status, message) => Object.assign(new Error(message), { status });

function load() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { servers: [] }; }
  for (const s of cfg.servers) s.headers = Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, unseal(DATA_DIR, v, `MCP ${s.name} ${k}`)]).filter(([, v]) => v));
  return cfg;
}
function store(cfg) {
  for (const s of cfg.servers) for (const v of Object.values(s.headers || {})) addSecret(v);
  const out = { ...cfg, servers: cfg.servers.map((s) => ({ ...s, headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, seal(DATA_DIR, v)])) })) };
  writeFileAtomic(FILE, JSON.stringify(out, null, 1), { mode: 0o600 });
}
load().servers.forEach((s) => Object.values(s.headers || {}).forEach(addSecret));

/** Public view: header values masked, never sent back in full. */
const pub = (s) => ({ ...s, headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, mask(v)])) });
/** Loopback, link-local and private-network hosts (IPv4 literals, IPv6 loopback/ULA, localhost). DNS names are not resolved. */
export function isPrivateHost(host) {
  let h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (the URL parser turns [::ffff:127.0.0.1] into ::ffff:7f00:1): check the IPv4 inside
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
  if (mapped) h = mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function listServers() { return load().servers.map(pub); }

export function upsertServer(body) {
  const cfg = load();
  const url = String(body.url || '').trim();
  let u; try { u = new URL(url); } catch { throw err(400, 'رابط الخادم مش صحيح'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw err(400, 'MCP عن طريق HTTP/HTTPS بس (Streamable HTTP)');
  const prevServer = cfg.servers.find((x) => x.id === body.id);
  const allowPrivate = body.allowPrivate === true || (body.allowPrivate === undefined && prevServer?.allowPrivate === true);
  if (isPrivateHost(u.hostname) && !allowPrivate) throw err(400, 'العنوان ده جوّه جهازك/شبكتك الداخلية — لو متأكد فعّل «خادم محلي» صراحةً');
  const id = body.id && cfg.servers.some((s) => s.id === body.id) ? body.id : crypto.randomBytes(4).toString('hex');
  const prev = cfg.servers.find((s) => s.id === id);
  const headers = { ...(prev?.headers || {}) };
  for (const [k, v] of Object.entries(body.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(k)) continue;
    if (typeof v === 'string' && v.startsWith('••••')) continue; // masked = keep
    if (v === '' || v === null) delete headers[k]; else headers[k] = String(v).slice(0, 2000);
  }
  const s = { id, allowPrivate, name: String(body.name || u.host).slice(0, 60), url, headers, enabled: body.enabled !== false, allowedTools: prev?.allowedTools || [], tools: prev?.tools || [], lastSync: prev?.lastSync || null };
  cfg.servers = [...cfg.servers.filter((x) => x.id !== id), s];
  store(cfg);
  return pub(s);
}
export function removeServer(id) { const cfg = load(); cfg.servers = cfg.servers.filter((s) => s.id !== id); store(cfg); }

export function setPermissions(id, { allowedTools, enabled }) {
  const cfg = load();
  const s = cfg.servers.find((x) => x.id === id);
  if (!s) throw err(404, 'MCP server not found');
  if (Array.isArray(allowedTools)) s.allowedTools = allowedTools.filter((t) => s.tools.some((x) => x.name === t));
  if (typeof enabled === 'boolean') s.enabled = enabled;
  store(cfg);
  return pub(s);
}

// ---- transport ---------------------------------------------------------------------------------
const sessions = new Map(); // server id → Mcp-Session-Id
async function rpc(s, method, params, { notify = false, timeout = 30000 } = {}) {
  const id = notify ? undefined : crypto.randomBytes(6).toString('hex');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, ...s.headers };
  const sent = sessions.get(s.id) || null; // the session THIS request carries
  if (sent) headers['Mcp-Session-Id'] = sent;
  const res = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(timeout), redirect: 'manual' })
    .catch((e) => { throw err(502, `MCP ${s.name}: ${e.message}`); });
  if (res.status >= 300 && res.status < 400) throw err(502, `MCP ${s.name}: الخادم بيحوّل لعنوان تاني (HTTP ${res.status}) — حدّث الرابط`);
  // 404 on a request that carried a session = that session expired; only forget it if no newer one replaced it meanwhile
  if (res.status === 404 && sent) { if (sessions.get(s.id) === sent) sessions.delete(s.id); throw Object.assign(err(502, `MCP ${s.name}: الجلسة انتهت`), { sessionExpired: true }); }
  const sid = res.headers.get('mcp-session-id'); if (sid) sessions.set(s.id, sid);
  if (notify) return null;
  if (res.status === 401 || res.status === 403) throw err(401, `MCP ${s.name}: الصلاحية مرفوضة (${res.status})`);
  if (!res.ok) throw err(502, `MCP ${s.name}: HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (text.length > MAX_RESULT * 4) throw err(502, `MCP ${s.name}: الرد أكبر من المسموح`);
  let msg;
  if (ct.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try { const j = JSON.parse(data); if (j.id === id) { msg = j; break; } } catch {}
    }
  } else { try { msg = JSON.parse(text); } catch {} }
  if (!msg) throw err(502, `MCP ${s.name}: رد غير مفهوم`);
  if (msg.error) throw err(502, `MCP ${s.name}: ${msg.error.message || JSON.stringify(msg.error).slice(0, 200)}`);
  return msg.result;
}

async function connect(s) {
  const r = await rpc(s, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'reel-studio', version: '2.1.0' } });
  await rpc(s, 'notifications/initialized', null, { notify: true }).catch(() => {});
  return r;
}

/** Connects and refreshes the tool list. New tools are NOT allowed until the owner allows them. */
export async function syncServer(id) {
  const cfg = load();
  const s = cfg.servers.find((x) => x.id === id);
  if (!s) throw err(404, 'MCP server not found');
  sessions.delete(s.id);
  const info = await connect(s);
  const r = await rpc(s, 'tools/list', {});
  s.tools = (r?.tools || []).slice(0, 200).map((t) => ({ name: String(t.name).slice(0, 80), description: String(t.description || '').slice(0, 500), inputSchema: t.inputSchema || { type: 'object' } }));
  s.allowedTools = s.allowedTools.filter((t) => s.tools.some((x) => x.name === t));
  s.serverInfo = info?.serverInfo || null;
  s.lastSync = new Date().toISOString();
  store(cfg);
  return pub(s);
}

/** Minimal JSON-schema check (object, required, primitive/array types, enum, string length). */
export function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = schema?.properties || {};
  for (const r of schema?.required || []) if (args[r] === undefined) return `missing "${r}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema?.additionalProperties === false) return `unknown argument "${k}"`; continue; }
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const want = [].concat(p.type || []);
    if (want.length && !want.some((w) => w === type || (w === 'integer' && Number.isInteger(v)) || (w === 'number' && type === 'number'))) return `"${k}" must be ${want.join('|')}`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
    if (type === 'string' && p.maxLength && v.length > p.maxLength) return `"${k}" is too long`;
  }
  return null;
}

export async function callTool(serverId, tool, args, { by = 'user' } = {}) {
  const s = load().servers.find((x) => x.id === serverId);
  if (!s) throw err(404, 'MCP server not found');
  if (!s.enabled) throw err(403, `MCP ${s.name} متوقف`);
  if (!s.allowedTools.includes(tool)) throw err(403, `الأداة "${tool}" مش مسموحة — اسمح بيها من مدير المهارات ← MCP`);
  const def = s.tools.find((t) => t.name === tool);
  const bad = checkArgs(def?.inputSchema, args);
  if (bad) throw err(400, `MCP ${tool}: ${bad}`);
  const t0 = Date.now();
  let result, error = null;
  try {
    if (!sessions.get(s.id)) await connect(s);
    try { result = await rpc(s, 'tools/call', { name: tool, arguments: args }, { timeout: 60000 }); }
    catch (e) { // server-side session expired (HTTP 404): open a new one and retry exactly once
      if (!e.sessionExpired) throw e;
      await connect(s);
      result = await rpc(s, 'tools/call', { name: tool, arguments: args }, { timeout: 60000 });
    }
  } catch (e) { error = e; }
  const text = result ? (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').slice(0, MAX_RESULT) : '';
  const rec = { ts: new Date().toISOString(), server: s.name, tool, by, ms: Date.now() - t0, ok: !error && !result?.isError, args: JSON.stringify(args).slice(0, 500), out: (error?.message || text).slice(0, 500) };
  try { fs.mkdirSync(path.dirname(RUNS), { recursive: true }); fs.appendFileSync(RUNS, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch {}
  slog(rec.ok ? 'info' : 'warn', 'mcp tool call', rec);
  if (error) throw error;
  if (result?.isError) throw err(502, `MCP ${tool}: ${text || 'tool error'}`);
  return { text, structured: result?.structuredContent ?? null, ms: rec.ms };
}

export function callLog(limit = 100) {
  try { return fs.readFileSync(RUNS, 'utf8').trim().split('\n').slice(-limit).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}
