// Child processes (ffmpeg / ffprobe and friends): one runner with cancellation, output caps and readable errors.
import path from 'node:path';
import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Every child process and browser is registered so a shutdown can never leave orphans behind.
const children = new Set();
const browsers = new Set();
export function trackChild(p) { children.add(p); p.once('close', () => children.delete(p)); return p; }
export function trackBrowser(b) { browsers.add(b); b.on?.('disconnected', () => browsers.delete(b)); return b; }
export const activeProcessCount = () => children.size + browsers.size;
/** Kills every ffmpeg/ffprobe child and closes every Chromium started by a render. */
export async function killAllChildren() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  await Promise.all([...browsers].map((b) => Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))])));
  browsers.clear();
}

/** Default execution limits: probing is instant; a transcode/mix/concat of a long project can take a while. RS_FFMPEG_TIMEOUT_MIN overrides the latter (1–720). */
const FFMPEG_TIMEOUT_MS = (() => { const v = Number(process.env.RS_FFMPEG_TIMEOUT_MIN); return (Number.isInteger(v) && v >= 1 && v <= 720 ? v : 45) * 60000; })();

export function run(cmd, args, { signal, input, collect = true, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const limit = timeoutMs ?? (/ffprobe/i.test(path.basename(cmd)) ? 60000 : FFMPEG_TIMEOUT_MS);
    const p = trackChild(spawn(cmd, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, limit); timer.unref?.();
    let out = '', err = '';
    p.stdout.on('data', (d) => { if (collect) out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`${cmd}: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) return reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(limit / 1000)} s and was killed`));
      if (signal?.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-800)}`));
    });
    if (input) p.stdin.end(input);
  });
}

export async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${path.basename(file)}`);
  return d;
}

export async function checkFfmpeg() {
  try { const { out } = await run(FFMPEG, ['-version']); return out.split('\n')[0]; } catch { return null; }
}
