// External API clients: OpenAI-compatible LLM (FreeLLMAPI), ElevenLabs TTS, Deepgram STT.
import { fetchRetry } from './net.mjs';
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

async function failText(res) {
  let t = '';
  try { t = (await res.text()).slice(0, 400); } catch {}
  return `HTTP ${res.status} ${res.statusText}${t ? ' — ' + t : ''}`;
}

/** Streaming filter that removes <think>…</think> blocks, even when tags are split across chunks. */
export class ThinkStripper {
  constructor() { this.buf = ''; this.inThink = false; }
  feed(chunk) {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end < 0) { this.buf = this.buf.slice(-8); return out; }
        this.buf = this.buf.slice(end + 8); this.inThink = false;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start < 0) {
          // keep a possible partial "<think" tail in the buffer
          const keep = partialTail(this.buf, '<think>');
          out += this.buf.slice(0, this.buf.length - keep); this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        out += this.buf.slice(0, start); this.buf = this.buf.slice(start + 7); this.inThink = true;
      }
    }
  }
  flush() { const r = this.inThink ? '' : this.buf; this.buf = ''; return r; }
}
function partialTail(s, tag) {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k;
  return 0;
}
/** Final clean-up: also handles a stray "</think>" with no opening tag (some reasoning models). */
export function stripThink(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const i = t.lastIndexOf('</think>');
  if (i >= 0) t = t.slice(i + 8);
  return t.replace(/<think>[\s\S]*$/, '').trim();
}

/**
 * Streams a chat completion. onDelta(visibleText) receives text with <think> removed.
 * Works with SSE streams and with servers that ignore `stream` and return plain JSON.
 */
export async function chatStream(settings, messages, { onDelta = () => {}, signal, temperature, maxTokens = 4096, idleMs = Number(process.env.LLM_IDLE_TIMEOUT_MS) || 120000 } = {}) {
  const { baseUrl, apiKey, model } = settings.llm;
  // Abort when the caller cancels OR when the server goes silent for idleMs (a stalled provider must not hang a stage).
  const ctl = new AbortController();
  let timedOut = false, timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, idleMs); };
  const onParent = () => ctl.abort();
  if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', onParent, { once: true });
  arm();
  try {
    return await chatStreamInner(settings, messages, { onDelta, signal: ctl.signal, temperature, maxTokens, baseUrl, apiKey, model, arm });
  } catch (e) {
    if (timedOut && !signal?.aborted) throw new Error(`LLM ما ردّش لمدة ${Math.round(idleMs / 1000)} ثانية — جرّب تاني أو غيّر الموديل`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParent);
  }
}

async function chatStreamInner(settings, messages, { onDelta, signal, temperature, maxTokens, baseUrl, apiKey, model, arm }) {
  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: model || 'auto', messages, stream: true, temperature: temperature ?? settings.llm.temperature ?? 0.8, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM ${await failText(res)}`);
  const strip = new ThinkStripper();
  let raw = '';
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    const j = await res.json();
    raw = j?.choices?.[0]?.message?.content ?? '';
    onDelta(strip.feed(raw) + strip.flush());
    return { text: stripThink(raw), model: j?.model };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let pending = '', usedModel;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    arm(); // data arrived — reset the inactivity timer
    pending += dec.decode(value, { stream: true });
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(`LLM stream error: ${JSON.stringify(j.error).slice(0, 300)}`);
      usedModel = usedModel || j.model;
      const d = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? '';
      if (d) { raw += d; const vis = strip.feed(d); if (vis) onDelta(vis); }
    }
  }
  const tail = strip.flush(); if (tail) onDelta(tail);
  if (!raw.trim()) throw new Error('LLM returned an empty response');
  return { text: stripThink(raw), model: usedModel };
}

// ---- connection tests (Settings → «اختبار الاتصال») ---------------------------------
const withTimeout = (ms) => AbortSignal.timeout(ms);

/** LLM: lists /models; if the server has no /models, sends a 1-token chat. */
export async function testLlm(settings) {
  const { baseUrl, apiKey, model } = settings.llm;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`${trimSlash(baseUrl)}/models`, { headers, signal: withTimeout(10000) });
    if (res.ok) {
      const j = await res.json();
      const n = (j.data || j.models || []).length;
      if (n) return { ok: true, message: `متصل — ${n} موديل متاح`, detail: (j.data || j.models).slice(0, 8).map((m) => m.id || m.name) };
    } else if (res.status === 401 || res.status === 403) return { ok: false, message: `المفتاح مرفوض (${res.status})` };
  } catch (e) {
    if (e.name === 'TimeoutError' || /fetch failed|ECONNREFUSED/.test(e.message + (e.cause?.code || ''))) {
      return { ok: false, message: `مش قادر يوصل لـ ${baseUrl} — اتأكد إن FreeLLMAPI شغال` };
    }
  }
  const res = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
    method: 'POST', signal: withTimeout(30000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: model || 'auto', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
  });
  if (!res.ok) return { ok: false, message: `LLM ${await failText(res)}` };
  return { ok: true, message: 'متصل — الموديل رد' };
}

export async function testElevenLabs(settings) {
  const voices = await listVoices(settings);
  return { ok: true, message: `متصل — ${voices.length} صوت`, detail: voices.slice(0, 8).map((v) => v.name) };
}

export async function testDeepgram(settings) {
  const { baseUrl, apiKey } = settings.deepgram;
  if (!apiKey) return { ok: false, message: 'مفيش مفتاح Deepgram' };
  const res = await fetch(`${trimSlash(baseUrl)}/v1/projects`, { headers: { Authorization: `Token ${apiKey}` }, signal: withTimeout(10000) });
  if (!res.ok) return { ok: false, message: `Deepgram ${await failText(res)}` };
  const j = await res.json();
  return { ok: true, message: `متصل — ${(j.projects || []).length} مشروع على الحساب` };
}

// ---- ElevenLabs --------------------------------------------------------------
export async function listVoices(settings) {
  const { baseUrl, apiKey } = settings.elevenlabs;
  if (!apiKey) throw new Error('ElevenLabs API key is missing (Settings).');
  const res = await fetchRetry(`${trimSlash(baseUrl)}/v1/voices`, { headers: { 'xi-api-key': apiKey } }, { timeout: 20000, retries: 2, label: 'ElevenLabs' });
  if (!res.ok) throw new Error(`ElevenLabs ${await failText(res)}`);
  const j = await res.json();
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {}, category: v.category }));
}

/**
 * TTS with per-character timings. Returns { audio: Buffer(mp3), chars:[{c,start,end}] }.
 */
export async function ttsWithTimestamps(settings, text, { signal } = {}) {
  const { baseUrl, apiKey, voiceId, modelId } = settings.elevenlabs;
  if (!apiKey) throw new Error('ElevenLabs API key is missing (Settings).');
  if (!voiceId) throw new Error('No ElevenLabs voice selected (Settings → load voices).');
  const url = `${trimSlash(baseUrl)}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const res = await fetchRetry(url, {
    method: 'POST', signal,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text, model_id: modelId || 'eleven_multilingual_v2', voice_settings: {
      stability: settings.elevenlabs.stability ?? 0.45, similarity_boost: 0.8, style: settings.elevenlabs.style ?? 0.2, use_speaker_boost: true,
      ...(Number(settings.elevenlabs.speed) && Number(settings.elevenlabs.speed) !== 1 ? { speed: Number(settings.elevenlabs.speed) } : {}),
    } }),
  }, { timeout: 180000, retries: 2, label: 'ElevenLabs' });
  if (!res.ok) throw new Error(`ElevenLabs ${await failText(res)}`);
  const j = await res.json();
  const al = j.alignment || j.normalized_alignment;
  if (!j.audio_base64 || !al?.characters) throw new Error('ElevenLabs response has no audio/alignment');
  const chars = al.characters.map((c, i) => ({ c, start: al.character_start_times_seconds[i], end: al.character_end_times_seconds[i] }));
  return { audio: Buffer.from(j.audio_base64, 'base64'), chars };
}

// ---- Deepgram ----------------------------------------------------------------
/** Word timings for an uploaded voice-over. Returns [{text,start,end,confidence}]. */
export async function transcribeWords(settings, audioBuf, mime, { signal } = {}) {
  const { baseUrl, apiKey, model, language } = settings.deepgram;
  if (!apiKey) throw new Error('Deepgram API key is missing (Settings).');
  const q = new URLSearchParams({ model: model || 'nova-3', language: language || 'ar', punctuate: 'true' });
  const res = await fetchRetry(`${trimSlash(baseUrl)}/v1/listen?${q}`, {
    method: 'POST', signal,
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mime || 'audio/mpeg' },
    body: audioBuf,
  }, { timeout: 300000, retries: 2, label: 'Deepgram' });
  if (!res.ok) throw new Error(`Deepgram ${await failText(res)}`);
  const j = await res.json();
  const words = j?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  return words.map((w) => ({ text: w.punctuated_word || w.word, start: w.start, end: w.end, confidence: w.confidence }));
}

/**
 * Pronunciation dictionary ("word = spoken form" per line) applied to the text sent to TTS only.
 * The captions keep the script spelling: timing aligns the spoken characters back onto script words.
 */
export function applyPronunciation(text, dict) {
  const rules = String(dict || '').split('\n').map((l) => l.split('=')).filter((x) => x.length === 2)
    .map(([a, b]) => [a.trim(), b.trim()]).filter(([a, b]) => a && b && a.length <= 60 && b.length <= 120);
  let out = String(text);
  for (const [from, to] of rules) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s«"(])${esc}(?=$|[\\s.،,!؟?:»")])`, 'gu'), `$1${to}`);
  }
  return { text: out, applied: rules.length };
}
