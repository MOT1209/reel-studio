// Engine benchmark: node bench/bench.mjs <legacy|remotion> [runs=3] [concurrency=2]
// Measures wall time and the PEAK resident memory of the whole process tree (node + Chromium + ffmpeg), sampled every 100 ms,
// and verifies each output with ffprobe. Results: bench/results-<engine>.json
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const [engine, runs = 3, conc = 2] = [process.argv[2], Number(process.argv[3] || 3), Number(process.argv[4] || 2)];
const tree = (root) => { // total RSS (KB) of root + all descendants
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp, rss] of rows) { (kids.get(pp) || kids.set(pp, []).get(pp)).push([p, rss]); }
  const own = new Map(rows.map(([p, , rss]) => [p, rss])); let sum = 0; const st = [root];
  while (st.length) { const p = st.pop(); sum += own.get(p) || 0; for (const [k] of kids.get(p) || []) st.push(k); }
  return sum;
};
const results = [];
for (let i = 0; i < runs; i++) {
  const out = path.join(os.tmpdir(), `bench-${engine}-${i}.mp4`); fs.rmSync(out, { force: true });
  const args = engine === 'legacy' ? ['bench/legacy-render.mjs', out] : ['bench/remotion-render.mjs', out, String(conc)];
  const t0 = Date.now(); let peak = 0, ok = true, err = '';
  const p = spawn('node', args, { cwd: path.join(dir, '..'), env: { ...process.env, RS_RENDER_WORKERS: String(conc), RS_RENDER_WORKERS_FORCE: '1', CHROME_PATH: process.env.CHROME_PATH || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let phases = null; p.stdout.on('data', (d) => { const m = String(d).match(/PHASES (\{.*\})/); if (m) phases = JSON.parse(m[1]); });
  p.stderr.on('data', (d) => { err += d; });
  const timer = setInterval(() => { try { peak = Math.max(peak, tree(p.pid)); } catch {} }, 100);
  const code = await new Promise((r) => p.on('close', r)); clearInterval(timer);
  const wall = (Date.now() - t0) / 1000; ok = code === 0 && fs.existsSync(out);
  let info = null;
  if (ok) { const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_packets', '-of', 'json', out]).toString()); info = j.streams[0]; }
  results.push({ run: i + 1, ok, wallSec: +wall.toFixed(1), phases, peakRssMB: Math.round(peak / 1024), output: info, error: ok ? undefined : err.slice(-300) });
  console.log(JSON.stringify(results.at(-1)));
}
const good = results.filter((r) => r.ok); const med = (k) => good.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(good.length / 2)];
const sum = { engine, concurrency: conc, runs, failures: results.length - good.length, medianWallSec: med('wallSec'), medianRenderSec: good.map((r) => r.phases?.renderSec).sort((a, b) => a - b)[Math.floor(good.length / 2)], medianPeakRssMB: med('peakRssMB'), cpus: os.cpus().length, node: process.version };
console.log('SUMMARY', JSON.stringify(sum)); fs.writeFileSync(path.join(dir, `results-${engine}.json`), JSON.stringify({ summary: sum, results }, null, 1));
