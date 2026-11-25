// fetch with a per-attempt timeout and bounded retries for transient failures (network errors, 408, 425, 429, 5xx).
// 4xx (bad key, bad request) is never retried — except 408/425/429, which mean "not processed, try later".
// The caller's AbortSignal (user cancel) always wins immediately.
//
// Requests that cost money or create something (TTS, transcription: POST) are NOT idempotent: once the request may
// have reached the provider, sending it again could bill it twice. For those (idempotent: false — the default for
// anything but GET/HEAD) only failures that prove the provider did not process it are retried: 429 answers and
// connection errors before anything was sent (refused, DNS).
//
// The timeout covers the whole exchange, body included: the body is read here and the returned Response is buffered,
// so a provider that sends headers and then stalls cannot hang a stage forever.

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('cancelled'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('cancelled')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Answers that establish the provider rejected the request before processing it — safe to retry even a paid POST.
 *  Only 429 (rate limit) qualifies; a 503 can come after the work was done (and billed), so it is reported instead. */
const NOT_PROCESSED_STATUS = new Set([429]);
/** Longest wait the app accepts before a retry; a provider asking for longer gets its answer returned, not an early retry. */
export const MAX_RETRY_WAIT_MS = 30000;
/** Connection failures that happen before the request is sent. */
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function retryDelay(res, attempt, base = Number(process.env.RS_RETRY_BASE_MS) || 800) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw != null && String(raw).trim() !== '') { // a missing header must not become Number(null) = 0
    // never shortened: retrying before the provider's delay is exactly what Retry-After forbids (the caller stops instead)
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
    const at = Date.parse(raw); // HTTP-date form
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(15000, base * 2 ** attempt);
}

export async function fetchRetry(url, init = {}, { timeout = 60000, retries = 2, label = 'request', onRetry, retryStatus = RETRY_STATUS, idempotent } = {}) {
  const user = init.signal;
  const safe = idempotent ?? ['GET', 'HEAD', undefined].includes(init.method?.toUpperCase?.() ?? init.method);
  let lastErr, noRetry = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (user?.aborted) throw new Error('cancelled');
    const ctl = new AbortController();
    const onUser = () => ctl.abort(new Error('cancelled'));
    user?.addEventListener('abort', onUser, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${Math.round(timeout / 1000)} s`)), timeout);
    const done = () => { clearTimeout(timer); user?.removeEventListener('abort', onUser); };
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      const retryable = safe ? retryStatus.has(res.status) : NOT_PROCESSED_STATUS.has(res.status);
      const wait = retryable && attempt < retries ? retryDelay(res, attempt) : null;
      if (wait !== null && wait <= MAX_RETRY_WAIT_MS) {
        done();
        const d = wait;
        await res.body?.cancel().catch(() => {});
        onRetry?.(attempt + 1, `HTTP ${res.status}`, d);
        await sleep(d, user);
        continue;
      }
      // the provider asked for a longer wait than the app accepts: whatever happens while reading this answer, no retry
      if (wait !== null) noRetry = true;
      // read the body under the same timeout / cancel, then hand back a buffered Response
      const body = await res.arrayBuffer();
      done();
      return new Response(body.byteLength || ![204, 205, 304].includes(res.status) ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      done();
      if (user?.aborted) throw new Error('cancelled');
      lastErr = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
      const code = e?.cause?.code || e?.code;
      // a paid request that may have reached the provider (timeout, reset mid-way) is reported, never sent again
      if (noRetry || attempt >= retries || (!safe && !PRE_SEND_CODES.has(code))) break;
      const d = retryDelay(null, attempt);
      onRetry?.(attempt + 1, lastErr.message, d);
      await sleep(d, user);
    }
  }
  throw new Error(`${label}: ${lastErr?.cause?.code || lastErr?.message || 'network error'}`);
}
