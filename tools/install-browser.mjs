// Installs Playwright's Chromium; if the download fails, checks for a system Chrome/Edge
// (the renderer then launches with channel "chrome" or "msedge" automatically).
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status === 0) { console.log('✔ Playwright Chromium installed'); process.exit(0); }

console.warn('⚠ Chromium download failed — looking for a system browser…');
const { chromium } = await import('playwright');
for (const channel of ['chrome', 'msedge']) {
  try {
    const b = await chromium.launch({ channel });
    await b.close();
    console.log(`✔ will use the system "${channel}" browser for rendering`);
    process.exit(0);
  } catch {}
}
console.error('✖ No usable browser. Install Google Chrome, or retry "npx playwright install chromium".');
process.exit(1);
