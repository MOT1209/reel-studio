// External API clients: OpenAI-compatible LLM (FreeLLMAPI), ElevenLabs TTS, Deepgram STT.
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
export async function chatStream(settings, messages, { onDelta = () => {}, signal, temperature, maxTokens = 4096 } = {}) {
  const { baseUrl, apiKey, model } = settings.llm;
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

// ---- ElevenLabs --------------------------------------------------------------
export async function listVoices(settings) {
  const { baseUrl, apiKey } = settings.elevenlabs;
  if (!apiKey) throw new Error('ElevenLabs API key is missing (Settings).');
  const res = await fetch(`${trimSlash(baseUrl)}/v1/voices`, { headers: { 'xi-api-key': apiKey } });
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
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text, model_id: modelId || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }),
  });
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
  const res = await fetch(`${trimSlash(baseUrl)}/v1/listen?${q}`, {
    method: 'POST', signal,
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mime || 'audio/mpeg' },
    body: audioBuf,
  });
  if (!res.ok) throw new Error(`Deepgram ${await failText(res)}`);
  const j = await res.json();
  const words = j?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  return words.map((w) => ({ text: w.punctuated_word || w.word, start: w.start, end: w.end, confidence: w.confidence }));
}
