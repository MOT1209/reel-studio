// Structured server log: JSON lines in data/logs/server.log (rotated at 5 MB, one backup).
// Every line passes through redact(): stored API keys, OAuth tokens and key-looking query/header values never reach disk.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, secretValues } from './settings.mjs';

const DIR = path.join(DATA_DIR, 'logs');
const FILE = path.join(DIR, 'server.log');
const MAX = 5 * 1024 * 1024;
const extra = new Set(); // runtime secrets (OAuth access/refresh tokens) registered by their owners

export function addSecret(v) { if (typeof v === 'string' && v.length >= 6) extra.add(v); }

const PATTERNS = [
  [/(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|xi-api-key|key|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]'],
];

export function redact(text) {
  let out = String(text);
  let secrets = [];
  try { secrets = secretValues(); } catch {}
  for (const v of [...secrets, ...extra]) if (out.includes(v)) out = out.split(v).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function write(line) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { if (fs.statSync(FILE).size > MAX) fs.renameSync(FILE, FILE + '.1'); } catch {}
    fs.appendFileSync(FILE, line + '\n', { mode: 0o600 });
  } catch { /* logging must never break a request */ }
}

/** log('error', 'render failed', { project, stage, err }) */
export function log(level, msg, fields = {}) {
  const rec = { ts: new Date().toISOString(), level, msg };
  for (const [k, v] of Object.entries(fields)) rec[k] = v instanceof Error ? v.message : v;
  const line = redact(JSON.stringify(rec));
  write(line);
  if (level === 'error' || level === 'warn') console.error(line);
  return line;
}
export const logFile = FILE;
