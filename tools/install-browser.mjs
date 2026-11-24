// Installs Playwright's Chromium; if the download fails, checks for a system Chrome/Edge
// (the renderer then launches with channel "chrome" or "msedge" automatically).
import { spawnSync } from 'node:child_process';

/** Remotion engine: a headless shell (Playwright's, or Remotion's own download) + the composition bundle built once. */
async function prepareRemotion() {
  try {
    const { findBrowser, ensureBundle } = await import('../server/engines/remotion.mjs');
    if (!findBrowser()) {
      console.log('… downloading Chrome Headless Shell for the Remotion engine');
      const { ensureBrowser } = await import('@remotion/renderer');
      await ensureBrowser();
    }
    await ensureBundle((l) => console.log('  ' + l));
    console.log('✔ Remotion engine ready');
  } catch (e) {
    console.warn(`⚠ Remotion engine not ready (${e.message.split('\n')[0]}) — renders use the legacy engine until it is`);
  }
}

const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status === 0) { console.log('✔ Playwright Chromium installed'); await prepareRemotion(); process.exit(0); }

console.warn('⚠ Chromium download failed — looking for a system browser…');
const { chromium } = await import('playwright');
for (const channel of ['chrome', 'msedge']) {
  try {
    const b = await chromium.launch({ channel });
    await b.close();
    console.log(`✔ will use the system "${channel}" browser for rendering`);
    await prepareRemotion();
    process.exit(0);
  } catch {}
}
console.error('✖ No usable browser. Install Google Chrome, or retry "npx playwright install chromium".');
process.exit(1);
