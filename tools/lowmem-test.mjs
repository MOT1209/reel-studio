// Low-memory test: the large project (60 s script, 6000×4000 photos, video overlay, 1080p) rendered with the whole server
// confined to a memory cgroup (default 1.5 GB). Passes only if the render completes, the kernel OOM-killer never fired and
// the memory limit was never hit. Needs Linux + a writable cgroup v1 memory controller (root); otherwise it SKIPS.
//   node tools/lowmem-test.mjs [limitMB=1536]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = '/sys/fs/cgroup/memory', dir = path.join(base, `rs-lowmem-${process.pid}`);
const limitMB = Number(process.argv[2] || 1536);
try { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'memory.limit_in_bytes'), String(limitMB * 1048576)); }
catch (e) { console.log(`SKIP: no writable cgroup v1 memory controller (${e.code || e.message})`); process.exit(0); }
const num = (f) => Number(fs.readFileSync(path.join(dir, f), 'utf8').trim());
const oom = () => Number(/oom_kill (\d+)/.exec(fs.readFileSync(path.join(dir, 'memory.oom_control'), 'utf8'))?.[1] || 0);
try {
  const r = spawnSync('node', ['tools/perf-test.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 900000, env: { ...process.env, PERF_CGROUP: dir, PERF_ONLY: 'large' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const crashes = (out.match(/Target crashed/g) || []).length;
  console.log(out.split('\n').filter((l) => /✔|✖|peakRss|crash/.test(l)).map((l) => l.slice(0, 260)).join('\n'));
  const result = { limitMB, maxUsageMB: Math.round(num('memory.max_usage_in_bytes') / 1048576), limitHits: num('memory.failcnt'), oomKills: oom(), browserCrashes: crashes, exit: r.status };
  console.log('RESULT ' + JSON.stringify(result));
  const ok = r.status === 0 && result.oomKills === 0 && crashes === 0 && result.maxUsageMB < limitMB;
  console.log(ok ? `✔ rendered inside ${limitMB} MB: peak ${result.maxUsageMB} MB, no OOM kill, no browser crash` : `✖ low-memory run failed`);
  process.exitCode = ok ? 0 : 1;
} finally { try { fs.rmdirSync(dir); } catch {} }
