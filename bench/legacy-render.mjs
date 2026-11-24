// Renders the same scene with the legacy engine (Canvas + Playwright + FFmpeg): node bench/legacy-render.mjs <out.mp4>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const W = Number(process.env.BENCH_W) || 720, H = Number(process.env.BENCH_H) || 1280, DUR = Number(process.env.BENCH_DUR) || 10;
const srv = http.createServer((q, r) => { const u = q.url.split('?')[0]; const f = u === '/' ? 'legacy-scene.html' : u.slice(1); const p = path.join(dir, f);
  if (!p.startsWith(dir) || !fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.ttf') ? 'font/ttf' : 'text/html' }); r.end(fs.readFileSync(p)); }).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const { renderFrames } = await import('../server/render.mjs');
const t0 = Date.now();
await renderFrames({ url: `http://127.0.0.1:${srv.address().port}/?w=${W}&h=${H}`, out: process.argv[2], duration: DUR, fps: 30, width: W, height: H, quality: 'standard', segDir: path.join(path.dirname(process.argv[2]), 'seg-' + process.pid), key: 'bench' });
fs.rmSync(path.join(path.dirname(process.argv[2]), 'seg-' + process.pid), { recursive: true, force: true });
console.log('PHASES ' + JSON.stringify({ bundleSec: 0, renderSec: +((Date.now() - t0) / 1000).toFixed(1) }));
srv.close(); process.exit(0);
