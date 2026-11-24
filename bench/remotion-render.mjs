// Renders the Remotion PoC scene: node bench/remotion-render.mjs <out.mp4> <concurrency>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remotion-poc');
const req = createRequire(path.join(dir, 'package.json'));
const { bundle } = req('@remotion/bundler'); const { renderMedia, selectComposition } = req('@remotion/renderer');
const [out, conc] = [process.argv[2], Number(process.argv[3] || 2)];
const browserExecutable = process.env.CHROME_PATH || undefined;
const t0 = Date.now();
const serveUrl = await bundle({ entryPoint: path.join(dir, 'src/index.jsx'), publicDir: path.join(dir, 'public') });
const tBundle = Date.now();
const composition = await selectComposition({ serveUrl, id: 'Scene', browserExecutable });
const tSel = Date.now();
await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: out, concurrency: conc, browserExecutable, crf: 20, logLevel: 'error' });
console.log('PHASES ' + JSON.stringify({ bundleSec: +((tBundle - t0) / 1000).toFixed(1), selectSec: +((tSel - tBundle) / 1000).toFixed(1), renderSec: +((Date.now() - tSel) / 1000).toFixed(1) }));
