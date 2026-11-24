// fetch with a per-attempt timeout and bounded retries for transient failures (network errors, 408, 425, 429, 5xx).
// 4xx (bad key, bad request) is never retried. The caller's AbortSignal (user cancel) always wins immediately.

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});

export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function retryDelay(res, attempt, base = Number(process.env.RS_RETRY_BASE_MS) || 800) {
  const ra = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(ra) && ra >= 0) return Math.min(30000, ra * 1000);
  return Math.min(15000, base * 2 ** attempt);
}

export async function fetchRetry(url, init = {}, { timeout = 60000, retries = 2, label = 'request', onRetry } = {}) {
  const user = init.signal;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (user?.aborted) throw new Error('cancelled');
    const ctl = new AbortController();
    const onUser = () => ctl.abort(new Error('cancelled'));
    user?.addEventListener('abort', onUser, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${Math.round(timeout / 1000)} s`)), timeout);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(timer);
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        const d = retryDelay(res, attempt);
        await res.body?.cancel().catch(() => {});
        onRetry?.(attempt + 1, `HTTP ${res.status}`, d);
        await sleep(d, user);
        continue;
      }
      user?.removeEventListener('abort', onUser);
      return res;
    } catch (e) {
      clearTimeout(timer);
      user?.removeEventListener('abort', onUser);
      if (user?.aborted) throw new Error('cancelled');
      lastErr = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
      if (attempt >= retries) break;
      const d = retryDelay(null, attempt);
      onRetry?.(attempt + 1, lastErr.message, d);
      await sleep(d, user);
    }
  }
  throw new Error(`${label}: ${lastErr?.cause?.code || lastErr?.message || 'network error'}`);
}
