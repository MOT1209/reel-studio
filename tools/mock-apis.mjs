// Offline stand-ins for FreeLLMAPI (OpenAI-compatible), ElevenLabs and Deepgram on 127.0.0.1:4399.
// Run: node tools/mock-apis.mjs   then start the app with
//   LLM_BASE_URL=http://127.0.0.1:4399/v1 ELEVENLABS_BASE_URL=http://127.0.0.1:4399 DEEPGRAM_BASE_URL=http://127.0.0.1:4399
// The fake TTS voice is a buzzy "syllable" per word with a sharp onset, so caption sync can be measured.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 4399);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SR = 44100;
let lastTtsText = '';

const HOOK = 'السما لونها أزرق… بس نور الشمس أبيض!';
const QUESTION = 'عارف ليه؟';
const MIDDLE = [
  'نور الشمس فيه كل الألوان.',
  'ولما يخبط في جزيئات الـ oxygen والـ nitrogen…',
  'الأزرق بيتشتت أكتر من الأحمر.',
  'تخيّل كورة صغيرة بتخبط في دبابيس كتير.',
  'الأزرق موجاته قصيرة… فبيتنطط في كل حتة.',
  'فعينك تشوفه جاي من كل السما.',
  'وعند الغروب النور بيمشي مسافة أطول…',
  'فالأزرق يضيع، ويفضل البرتقالي والأحمر.',
  'والظاهرة دي اسمها Rayleigh scattering.',
  'وده نفس السبب إن البحر أحيانًا بيبان أزرق.',
  'كل ما الموجة أقصر، كل ما التشتت أقوى.',
  'البنفسجي أقصر كمان… بس عينك مش حساسة له قوي.',
];
const RECAP = 'يعني باختصار: السما زرقا عشان الأزرق بيتشتت أكتر.';
const wc = (s) => s.split(/\s+/).filter(Boolean).length;

function mockScript(topic, target) {
  const lines = [HOOK, QUESTION];
  let n = wc(HOOK) + wc(QUESTION) + wc(RECAP);
  for (const l of MIDDLE) { if (n + wc(l) > target * 1.05 && lines.length > 2) break; lines.push(l); n += wc(l); }
  lines.push(RECAP);
  return `<think>The user wants about ${target} words on "${topic}". I will plan the hook first…</think>TITLE: ليه السما لونها أزرق؟\nSCRIPT:\n${lines.join('\n')}\nSOURCES:\n- NASA Space Place, "Why is the sky blue?"\n- Encyclopaedia Britannica, "Rayleigh scattering"`;
}

const ITEMS = {
  body: () => ({ organ: 'eye', items: [{ label: 'العين', icon: 'eye' }] }),
  zoom: () => ({ items: [{ label: 'السما', icon: 'cloud' }, { label: 'جزيئات الهوا', icon: 'molecule' }] }),
  flow: () => ({ items: [{ label: 'نور الشمس', icon: 'sun' }, { label: 'جزيئات', icon: 'molecule' }, { label: 'عينك', icon: 'eye' }] }),
  cycle: () => ({ items: [{ label: 'شمس', icon: 'sun' }, { label: 'تشتت', icon: 'wave' }, { label: 'سما', icon: 'cloud' }, { label: 'عين', icon: 'eye' }] }),
  timeline: () => ({ items: [{ label: 'نيوتن والمنشور', icon: 'bulb', value: 1666 }, { label: 'تجربة تيندال', icon: 'flask', value: 1859 }, { label: 'معادلة رايلي', icon: 'wave', value: 1871 }] }),
  chart: () => ({ unit: 'قوة التشتت ×', items: [{ label: 'أزرق', icon: 'drop', value: 5.5 }, { label: 'أخضر', icon: 'leaf', value: 2.4 }, { label: 'أحمر', icon: 'flame', value: 1 }] }),
  layers: () => ({ items: [{ label: 'الغلاف الجوي', icon: 'cloud' }, { label: 'طبقة الأوزون', icon: 'sun' }, { label: 'سطح الأرض', icon: 'mountain' }] }),
  cards: () => ({ items: [{ label: 'أزرق: موجة قصيرة', icon: 'drop' }, { label: 'أحمر: موجة طويلة', icon: 'flame' }] }),
  meter: () => ({ value: 5.5, max: 10, unit: 'مرات أكتر', items: [{ label: 'الأزرق بيتشتت أكتر' }] }),
};
const TYPE_FOR = { body: 'concept', zoom: 'concept', flow: 'process', cycle: 'process', timeline: 'process', chart: 'stat', layers: 'concept', cards: 'compare', meter: 'stat' };

function mockStoryboard(userMsg, systemMsg) {
  const words = [...userMsg.matchAll(/(\d+):\S+@([\d.]+)/g)].map((m) => ({ i: +m[1], t: +m[2] }));
  const n = words.length;
  const duration = Number((userMsg.match(/DURATION:\s*([\d.]+)/) || [])[1]) || n / 2.6;
  const force = (systemMsg.match(/TEST MODE: use template "(\w+)"/) || [])[1];
  const count = Math.max(2, Math.min(8, Math.round(duration / 3)));
  // Deliberately messy so the validator has work: unsorted, an out-of-range index,
  // first scene not an intro, and the same template three times in a row.
  const pool = force ? Array(count).fill(force) : ['zoom', 'cards', 'cards', 'cards', 'flow', 'meter', 'chart', 'body', 'cycle', 'layers', 'timeline'];
  const scenes = [];
  for (let k = 0; k < count; k++) {
    const at = Math.round((k * n) / count);
    const template = pool[k % pool.length];
    const sc = { type: k === 0 ? 'concept' : k === count - 1 ? 'recap' : TYPE_FOR[template], template, at: k === 0 ? 1 : at, title: ['الفكرة', 'السر هنا', 'بالأرقام', 'إزاي؟', 'الخلاصة'][k % 5], ...ITEMS[template]() };
    sc.items = sc.items.map((it, j) => ({ ...it, at: at + 1 + j }));
    scenes.push(sc);
  }
  if (scenes.length > 2) [scenes[1], scenes[2]] = [scenes[2], scenes[1]];
  scenes.push({ type: 'stat', template: 'gauge', at: n + 50, items: [] });
  return JSON.stringify({ scenes, accents: [[2, 'accent'], [Math.min(n - 1, 6), 'underline'], [Math.min(n - 1, 11), 'blue'], [n + 3, 'accent']] });
}

function mockReview(userMsg) {
  const cur = JSON.parse(userMsg.slice(userMsg.indexOf('CURRENT STORYBOARD:') + 19).trim());
  cur.scenes.forEach((s) => { if (s.template === 'cards' && s.items.length === 2) s.type = s.type === 'recap' ? 'recap' : 'compare'; });
  return '```json\n' + JSON.stringify(cur) + '\n```';
}

// ---- audio --------------------------------------------------------------------------
/** Synthesises a buzzy syllable per word; returns {wav, chars:[{c,start,end}]} */
function synth(text) {
  const chars = [];
  const segs = [];
  let t = 0.15;
  const toks = text.split(/(\s+)/);
  for (const tok of toks) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      const pause = tok.includes('\n') ? 0.22 : 0.07;
      for (const c of tok) chars.push({ c, start: t, end: t + pause / tok.length });
      t += pause;
      continue;
    }
    const len = [...tok].length;
    const dur = Math.min(0.75, 0.14 + 0.042 * len);
    segs.push([t, dur]);
    [...tok].forEach((c, i) => chars.push({ c, start: t + (dur * i) / len, end: t + (dur * (i + 1)) / len }));
    t += dur;
    if (/[.!؟?…،,]$/.test(tok)) t += 0.12;
  }
  const total = t + 0.2;
  const N = Math.ceil(total * SR);
  const pcm = Buffer.alloc(44 + N * 2);
  const buf = new Float32Array(N);
  segs.forEach(([s, d], k) => {
    const f0 = 135 + (k % 5) * 9;
    const a = Math.round(s * SR), b = Math.round((s + d) * SR);
    for (let i = a; i < b && i < N; i++) {
      const tt = (i - a) / SR, rel = (i - a) / (b - a);
      const env = Math.min(1, tt / 0.012) * Math.min(1, (1 - rel) / 0.15);
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) * (h === 3 || h === 4 ? 0.5 : 0.25) / h;
      buf[i] += v * env * 0.6;
    }
  });
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + N * 2, 4); pcm.write('WAVE', 8); pcm.write('fmt ', 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(SR, 24);
  pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  return { wav: pcm, chars };
}

function ff(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.slice(-500)))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Energy-based word segmentation of any audio (for the fake Deepgram). */
async function segmentWords(audio) {
  const pcm = await ff(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], audio);
  const n = pcm.length / 2, hop = 160; // 10 ms
  const rms = [];
  for (let i = 0; i + hop <= n; i += hop) { let s = 0; for (let k = 0; k < hop; k++) { const v = pcm.readInt16LE((i + k) * 2) / 32768; s += v * v; } rms.push(Math.sqrt(s / hop)); }
  const peak = Math.max(...rms, 1e-6);
  const on = rms.map((r) => r > peak * 0.08);
  const segs = [];
  for (let i = 0; i < on.length; i++) {
    if (on[i] && (i === 0 || !on[i - 1])) segs.push([i, i]);
    if (on[i]) segs[segs.length - 1][1] = i;
  }
  const merged = [];
  for (const s of segs) { const last = merged[merged.length - 1]; if (last && s[0] - last[1] < 4) last[1] = s[1]; else merged.push([...s]); }
  return merged.filter((s) => s[1] - s[0] >= 4).map(([a, b]) => ({ start: a / 100, end: (b + 1) / 100 }));
}

// ---- server ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };

async function streamText(res, text, model = 'mock-llm') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  // irregular chunk sizes (splits <think> tags across chunks on purpose)
  let i = 0, k = 0;
  while (i < text.length) {
    const size = 3 + ((k * 7) % 11);
    const part = text.slice(i, i + size);
    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
    i += size; k++;
    if (k % 8 === 0) await sleep(4);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const sys = body.messages.find((m) => m.role === 'system')?.content || '';
      const user = body.messages.filter((m) => m.role === 'user').pop()?.content || '';
      let reply;
      if (sys.includes('[[TASK:SCRIPT]]')) {
        reply = mockScript((user.match(/TOPIC:\s*(.*)/) || [])[1] || '', Number((user.match(/TARGET_WORDS:\s*(\d+)/) || [])[1]) || (/TARGET_WORDS:\s*auto/.test(user) ? 52 : 26));
      } else if (sys.includes('[[TASK:STORYBOARD]]')) reply = mockStoryboard(user, sys);
      else if (sys.includes('[[TASK:REVIEW]]')) reply = mockReview(user);
      else reply = 'mock reply';
      if (body.stream === false) return json(res, 200, { choices: [{ message: { role: 'assistant', content: reply } }], model: 'mock-llm' });
      return streamText(res, reply);
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: ['auto', 'mock-llm', 'mock-llm-mini'].map((id) => ({ id, object: 'model' })) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/projects') {
      if (!/^Token /.test(req.headers.authorization || '')) return json(res, 401, { err_msg: 'missing token' });
      return json(res, 200, { projects: [{ project_id: 'mock-project', name: 'Mock' }] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/voices') {
      return json(res, 200, { voices: [{ voice_id: 'mock-voice-eg', name: 'Mock Egyptian Narrator', category: 'premade', labels: { accent: 'egyptian' } }, { voice_id: 'mock-voice-2', name: 'Mock Calm', category: 'premade', labels: {} }] });
    }
    const tts = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/);
    if (req.method === 'POST' && tts) {
      if (!req.headers['xi-api-key']) return json(res, 401, { detail: 'missing xi-api-key' });
      const { text } = JSON.parse((await readBody(req)).toString('utf8'));
      lastTtsText = text;
      const { wav, chars } = synth(text);
      // encode to a real file so LAME writes its gapless header (encoder delay is then trimmed on decode)
      const tmp = path.join(os.tmpdir(), `mock-tts-${process.pid}-${Date.now()}.mp3`);
      await ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '128k', tmp], wav);
      const mp3 = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
      return json(res, 200, {
        audio_base64: mp3.toString('base64'),
        alignment: { characters: chars.map((c) => c.c), character_start_times_seconds: chars.map((c) => +c.start.toFixed(3)), character_end_times_seconds: chars.map((c) => +c.end.toFixed(3)) },
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/listen') {
      if (!/^Token /.test(req.headers.authorization || '')) return json(res, 401, { err_msg: 'missing token' });
      const audio = await readBody(req);
      const segs = await segmentWords(audio);
      // Use the last TTS text as "what was said", with ASR-style spelling drift (ة→ه, أ→ا, no punctuation).
      const said = lastTtsText.split(/\s+/).filter(Boolean);
      const words = segs.map((s, i) => {
        const w = (said[i] || 'كلمة').replace(/[.!؟?…،,:]/g, '');
        return { word: w.replace(/ة/g, 'ه').replace(/أ/g, 'ا'), punctuated_word: said[i] || w, start: s.start, end: s.end, confidence: 0.9 };
      });
      return json(res, 200, { metadata: { model_info: { name: 'mock-nova-3' } }, results: { channels: [{ alternatives: [{ transcript: words.map((w) => w.word).join(' '), words }] }] } });
    }
    json(res, 404, { error: 'mock: unknown endpoint ' + url.pathname });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock APIs on http://127.0.0.1:${PORT}  (LLM /v1/chat/completions · ElevenLabs /v1/text-to-speech · Deepgram /v1/listen)`));
