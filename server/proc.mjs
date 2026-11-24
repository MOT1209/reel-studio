// Child processes (ffmpeg / ffprobe and friends): one runner with cancellation, output caps and readable errors.
import path from 'node:path';
import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(cmd, args, { signal, input, collect = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { if (collect) out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
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
