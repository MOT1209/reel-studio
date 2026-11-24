// Secrets at rest: every API key, OAuth token and MCP header value is stored as "enc:v1:<iv|tag|ciphertext>"
// (AES-256-GCM). The 32-byte master key is protected by the platform:
//   • RS_VAULT_KEY (base64, 32 bytes) in the environment → nothing on disk at all (e.g. from a keychain launcher)
//   • Windows → DPAPI (CurrentUser) through PowerShell, no native module: the key file is useless on another
//     account or machine
//   • otherwise → data/.vault-key with 0600 permissions (protects against reading the JSON alone, e.g. a copied
//     settings file or a backup, not against an attacker who can read the whole data folder as your user)
// Values that fail to decrypt (tampered, or a data folder copied to another Windows user) read as empty and are
// logged once, so the user re-enters them instead of the app crashing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PREFIX = 'enc:v1:';
let cache = null; // { dir, key, protection }
const warned = new Set();

function powershell(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0) throw new Error(`DPAPI: ${(r.stderr || r.error?.message || 'powershell failed').slice(0, 200)}`);
  return r.stdout.trim();
}
const DPAPI = {
  protect: (b64) => powershell("Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($i), $null, 'CurrentUser'))", b64),
  unprotect: (b64) => powershell("Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i), $null, 'CurrentUser'))", b64),
};

/** Master key for a data folder (created on first use). */
export function masterKey(dir) {
  if (cache?.dir === dir) return cache;
  const env = process.env.RS_VAULT_KEY;
  if (env) {
    const key = Buffer.from(env, 'base64');
    if (key.length !== 32) throw new Error('RS_VAULT_KEY must be 32 bytes, base64');
    return (cache = { dir, key, protection: 'env' });
  }
  const file = path.join(dir, '.vault-key');
  const useDpapi = process.platform === 'win32' && process.env.RS_VAULT_DPAPI !== '0';
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = Buffer.from(j.protection === 'dpapi' ? DPAPI.unprotect(j.blob) : j.key, 'base64');
    return (cache = { dir, key, protection: j.protection });
  }
  const key = crypto.randomBytes(32);
  let rec = { v: 1, protection: 'file', key: key.toString('base64') };
  if (useDpapi) {
    try { rec = { v: 1, protection: 'dpapi', blob: DPAPI.protect(key.toString('base64')) }; } catch (e) { process.emitWarning(`DPAPI unavailable, falling back to a 0600 key file: ${e.message}`); }
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return (cache = { dir, key, protection: rec.protection });
}

export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function seal(dir, value) {
  if (typeof value !== 'string' || !value || isSealed(value)) return value;
  const { key } = masterKey(dir);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Plaintext of a sealed value; plaintext passes through (old files); a value that won't decrypt reads as ''. */
export function open(dir, value, label = 'secret') {
  if (!isSealed(value)) return value;
  try {
    const { key } = masterKey(dir);
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    if (!warned.has(label)) { warned.add(label); process.emitWarning(`${label} could not be decrypted (data copied from another user/machine, or edited) — enter it again in Settings`); }
    return '';
  }
}

export function protection(dir) { try { return masterKey(dir).protection; } catch { return 'unavailable'; } }
export const _resetForTests = () => { cache = null; warned.clear(); };
