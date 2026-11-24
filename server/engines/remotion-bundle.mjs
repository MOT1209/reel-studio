// Child process: builds the Remotion bundle (webpack is CPU-heavy and holds ~0.5 GB while it runs — kept out of the
// server process so the UI and the API stay responsive). argv: entry outDir publicPath. Progress → stdout lines.
import { bundle } from '@remotion/bundler';

const [entryPoint, outDir, publicPath] = process.argv.slice(2);
let last = -10;
await bundle({
  entryPoint, outDir, publicPath, enableCaching: true,
  onProgress: (p) => { if (p - last >= 25) { last = p; process.stdout.write(`progress ${Math.round(p)}\n`); } },
});
process.stdout.write('done\n');
