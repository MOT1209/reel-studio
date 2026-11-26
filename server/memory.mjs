// How much memory the renderer may plan with, and how many parallel browser pages that allows.
import fs from 'node:fs';
import os from 'node:os';

export const MAX_WORKERS = 4;
const readNum = (f) => { try { const t = fs.readFileSync(f, 'utf8').trim(); return t === 'max' ? Infinity : Number(t); } catch { return NaN; } };
const statKey = (f, key) => { try { const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(fs.readFileSync(f, 'utf8')); return m ? Number(m[1]) : 0; } catch { return 0; } };

/**
 * Memory this process tree can really use: the smaller of the machine's free RAM and what is left under a container/cgroup
 * limit (cgroup v2 `memory.max`, or v1 `memory.limit_in_bytes`), page cache not counted. Containers and VMs with a memory
 * limit report the HOST's free RAM through os.freemem(), which let the renderer start pages that the kernel then OOM-killed
 * (measured: a 1.5 GB cgroup, 3 pages → "Target crashed").
 */
export function availableMemory() {
  let free = os.freemem();
  // the cgroup THIS process lives in (…/memory/<name> on v1, /<name> on v2), then the root one as a fallback
  let own1 = '', own2 = '';
  try { for (const l of fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n')) { const [, ctl, p] = l.split(':'); if (ctl === 'memory') own1 = p || ''; else if (ctl === '') own2 = p || ''; } } catch {}
  const cands = [[`/sys/fs/cgroup${own2}`, 'memory.max', 'memory.current', 'memory.stat', 'inactive_file'], ['/sys/fs/cgroup', 'memory.max', 'memory.current', 'memory.stat', 'inactive_file'],
    [`/sys/fs/cgroup/memory${own1}`, 'memory.limit_in_bytes', 'memory.usage_in_bytes', 'memory.stat', 'total_inactive_file'], ['/sys/fs/cgroup/memory', 'memory.limit_in_bytes', 'memory.usage_in_bytes', 'memory.stat', 'total_inactive_file']];
  for (const [dir, lf, uf, sf, key] of cands) {
    const limit = readNum(`${dir}/${lf}`), used = readNum(`${dir}/${uf}`);
    if (Number.isFinite(limit) && Number.isFinite(used) && limit < 2 ** 60) { free = Math.min(free, Math.max(0, limit - Math.max(0, used - statKey(`${dir}/${sf}`, key)))); break; }
  }
  return free;
}

/**
 * Parallel pages for one render. `raw` (RS_RENDER_WORKERS / RS_REMOTION_CONCURRENCY) must be an integer 1–MAX_WORKERS;
 * anything else (text, 0, negative, fractions, Infinity, out of range) is rejected with a note and the memory-aware
 * automatic value is used. An explicit valid value is still capped by available RAM (≈450 MB per page + 600 MB base,
 * measured) unless `force`. Pure: pass cpus / freeMem in tests.
 */
export function parseWorkers(raw, { cpus = os.cpus().length, freeMem = availableMemory(), force = false, name = 'RS_RENDER_WORKERS' } = {}) {
  const byCpu = Math.max(1, cpus - 1);
  const byMem = Math.max(1, Math.floor((freeMem / 1024 ** 2 - 600) / 450));
  const auto = Math.max(1, Math.min(MAX_WORKERS, byCpu, byMem));
  if (raw === undefined || raw === null || String(raw).trim() === '') return { n: auto, note: null };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > MAX_WORKERS) return { n: auto, note: `${name}="${raw}" is invalid (use an integer 1–${MAX_WORKERS}) — using ${auto}` };
  if (force) return { n: v, note: null };
  const n = Math.min(v, byMem);
  return { n, note: n < v ? `${name}=${v} reduced to ${n}: only ${(freeMem / 1024 ** 3).toFixed(1)} GB RAM is available` : null };
}
