// Secrets at rest: sealed on disk, readable in memory, migrated from plaintext, tamper-evident, key options.
// node tools/vault-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-vault-'));
process.env.RS_DATA_DIR = DATA;
delete process.env.RS_VAULT_KEY;
process.env.RS_VAULT_DPAPI = '0';
const V = await import('../server/vault.mjs');
const S = await import('../server/settings.mjs');
const FILE = path.join(DATA, 'settings.json');
let n = 0, failed = 0;
function test(name, fn) { try { fn(); n++; console.log('✔', name); } catch (e) { failed++; console.log('✖', name, '—', e.message); } }
const KEY = 'sk_live_VAULT_TEST_123456789';

test('keys are written sealed (AES-256-GCM) and read back in memory', () => {
  S.updateSettings({ elevenlabs: { apiKey: KEY }, pexels: { apiKey: 'pexels-abcdef-123' } });
  const disk = fs.readFileSync(FILE, 'utf8');
  assert.ok(!disk.includes(KEY) && !disk.includes('pexels-abcdef-123'), 'no plaintext on disk');
  assert.match(JSON.parse(disk).elevenlabs.apiKey, /^enc:v1:/);
  assert.equal(S.getSettings().elevenlabs.apiKey, KEY);
  assert.equal(S.getPublicSettings().elevenlabs.apiKey, '••••6789');
  assert.equal(S.getPublicSettings()._vault, 'file');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(DATA, '.vault-key')).mode & 0o777, 0o600);
});
test('each write uses a fresh IV (same key → different ciphertext)', () => {
  assert.notEqual(V.seal(DATA, 'same-secret-value'), V.seal(DATA, 'same-secret-value'));
});
test('plaintext secrets from an older version are sealed on first read', () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  j.llm = { apiKey: 'old-plain-llm-key-999' };
  fs.writeFileSync(FILE, JSON.stringify(j));
  assert.equal(S.getSettings().llm.apiKey, 'old-plain-llm-key-999');
  assert.ok(!fs.readFileSync(FILE, 'utf8').includes('old-plain-llm-key-999'));
});
test('a tampered value reads as missing (GCM tag) instead of crashing; other keys still work', () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const raw = Buffer.from(j.elevenlabs.apiKey.slice(7), 'base64'); raw[raw.length - 1] ^= 1;
  j.elevenlabs.apiKey = 'enc:v1:' + raw.toString('base64');
  fs.writeFileSync(FILE, JSON.stringify(j));
  assert.equal(S.getSettings().elevenlabs.apiKey, '');
  assert.equal(S.getSettings().pexels.apiKey, 'pexels-abcdef-123');
});
test('a data folder opened with another master key: secrets read as missing, the app keeps working', () => {
  fs.renameSync(path.join(DATA, '.vault-key'), path.join(DATA, '.vault-key.bak'));
  V._resetForTests();
  assert.equal(S.getSettings().pexels.apiKey, '');
  assert.equal(S.getPublicSettings().pexels.apiKey, '');
  fs.rmSync(path.join(DATA, '.vault-key'));
  fs.renameSync(path.join(DATA, '.vault-key.bak'), path.join(DATA, '.vault-key'));
  V._resetForTests();
  assert.equal(S.getSettings().pexels.apiKey, 'pexels-abcdef-123');
});
test('RS_VAULT_KEY: the master key comes from the environment and is never written to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-vault-env-'));
  process.env.RS_VAULT_KEY = crypto.randomBytes(32).toString('base64');
  V._resetForTests();
  const sealed = V.seal(dir, 'env-protected');
  assert.equal(V.open(dir, sealed), 'env-protected');
  assert.ok(!fs.existsSync(path.join(dir, '.vault-key')));
  assert.equal(V.protection(dir), 'env');
  process.env.RS_VAULT_KEY = Buffer.alloc(5).toString('base64'); V._resetForTests();
  assert.throws(() => V.seal(dir, 'x'), /32 bytes/);
  delete process.env.RS_VAULT_KEY; V._resetForTests();
});

console.log(`\n${n} vault tests passed${failed ? `, ${failed} FAILED` : ''}`);
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
