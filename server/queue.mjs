// Job queue with a resource limit. Used for the render stage: Chromium + ffmpeg are the memory hogs, so by default
// only ONE render runs at a time (RS_MAX_RENDERS, integer 1–4) and the rest wait here, in priority order.
// States: pending → running → done | failed | cancelled. `retry` re-queues a failed job with backoff.

export function parseLimit(raw, { def = 1, max = 4 } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { n: def, note: null };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > max) return { n: def, note: `RS_MAX_RENDERS="${raw}" is invalid (use an integer 1–${max}) — using ${def}` };
  return { n: v, note: null };
}

export class JobQueue {
  constructor({ limit = 1, keep = 100 } = {}) { this.limit = limit; this.keep = keep; this.jobs = []; this.seq = 0; this.listeners = new Set(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit() { for (const f of this.listeners) { try { f(this.snapshot()); } catch {} } }
  snapshot() {
    const pos = new Map(); this.#pending().forEach((j, i) => pos.set(j.id, i + 1));
    return this.jobs.map((j) => ({ id: j.id, key: j.key, status: j.status, priority: j.priority, position: pos.get(j.id) || 0, attempts: j.attempts, error: j.error, queuedAt: j.queuedAt, startedAt: j.startedAt, endedAt: j.endedAt }));
  }
  #pending() { return this.jobs.filter((j) => j.status === 'pending').sort((a, b) => b.priority - a.priority || a.seq - b.seq); }
  get running() { return this.jobs.filter((j) => j.status === 'running').length; }

  /**
   * Waits for a free slot, then resolves with a `release(outcome)` function. Rejects with Error('cancelled') if the
   * signal aborts while the job is still waiting (the job is marked cancelled and never takes a slot).
   */
  acquire(key, { priority = 0, signal, onWait } = {}) {
    const job = { id: `j${++this.seq}`, seq: this.seq, key, priority, status: 'pending', attempts: 0, error: null, queuedAt: new Date().toISOString(), startedAt: null, endedAt: null };
    this.jobs.push(job);
    return new Promise((resolve, reject) => {
      job.start = () => {
        job.status = 'running'; job.startedAt = new Date().toISOString(); job.attempts++;
        signal?.removeEventListener('abort', job.abort);
        this.#emit();
        let released = false;
        resolve((outcome = 'done', error = null) => {
          if (released) return; released = true;
          job.status = outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'done';
          job.error = error ? String(error.message || error).slice(0, 300) : null; job.endedAt = new Date().toISOString();
          this.#trim(); this.#emit(); this.#pump();
        });
      };
      job.abort = () => { if (job.status !== 'pending') return; job.status = 'cancelled'; job.endedAt = new Date().toISOString(); this.#emit(); reject(new Error('cancelled')); };
      if (signal?.aborted) return job.abort();
      signal?.addEventListener('abort', job.abort, { once: true });
      this.#emit(); this.#pump();
      if (job.status === 'pending') onWait?.(this.snapshot().find((j) => j.id === job.id)?.position || 1);
    });
  }
  #pump() { while (this.running < this.limit) { const next = this.#pending()[0]; if (!next) return; next.start(); } }
  #trim() { const done = this.jobs.filter((j) => !['pending', 'running'].includes(j.status)); for (const j of done.slice(0, Math.max(0, done.length - this.keep))) this.jobs.splice(this.jobs.indexOf(j), 1); }
}

/**
 * Runs fn() inside a queue slot with a retry policy: only errors for which `retryable(e)` is true are retried
 * (never a cancel), at most `retries` times, with exponential backoff.
 */
export async function runQueued(queue, key, fn, { priority = 0, signal, retries = 0, backoffMs = 2000, retryable = () => false, onWait, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    const release = await queue.acquire(key, { priority, signal, onWait });
    try { const r = await fn(attempt); release('done'); return r; }
    catch (e) {
      const cancelled = signal?.aborted || e.message === 'cancelled';
      release(cancelled ? 'cancelled' : 'failed', e);
      if (cancelled || attempt >= retries || !retryable(e)) throw e;
      onRetry?.(attempt + 1, e);
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
      if (signal?.aborted) throw new Error('cancelled');
    }
  }
}
