// AI Skills: declarative, data-only extensions (no code is ever executed). A skill is a prompt template run on the
// configured LLM, or a call to one allowed MCP tool, with a typed input and a validated output.
// Built-in skills ship with the app (read-only, can be disabled); the owner adds more by import or in the UI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getSettings, writeFileAtomic } from './settings.mjs';
import { chatStream } from './apis.mjs';
import { extractJson } from './storyboard.mjs';
import * as AR from './arabic.mjs';
import * as MCP from './mcp.mjs';
import { redact } from './logger.mjs';

const DIR = path.join(DATA_DIR, 'skills');
const STATE = path.join(DIR, '_state.json'); // enabled flags for built-ins
const RUNS = path.join(DATA_DIR, 'logs', 'skill-runs.jsonl');
const err = (status, message) => Object.assign(new Error(message), { status });
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

const BUILTIN = [
  ...Object.entries(AR.OPS).map(([op, v]) => ({ id: `ar-${op}`, name: v.label, description: 'محرك العربي: اقتراح بفروقات، مفيش حاجة بتتطبق من غير موافقتك.', kind: 'arabic', op, input: { type: 'script' }, output: { type: 'text' }, permissions: ['llm'], category: 'arabic' })),
  { id: 'titles', name: 'عناوين بديلة', description: '٣ عناوين قصيرة جذابة للفيديو', kind: 'prompt', input: { type: 'script' }, output: { type: 'json', required: ['titles'] }, permissions: ['llm'], category: 'writing', temperature: 0.8,
    prompt: 'Write 3 alternative short, catchy Arabic titles (≤ 8 words each) for this educational video script, in the same dialect. Return ONLY JSON: {"titles":["…","…","…"]}\n\nSCRIPT:\n{{input}}' },
  { id: 'hooks', name: 'هوك بديل', description: '٣ جمل افتتاحية أقوى', kind: 'prompt', input: { type: 'script' }, output: { type: 'json', required: ['hooks'] }, permissions: ['llm'], category: 'writing', temperature: 0.9,
    prompt: 'Suggest 3 stronger opening lines (hooks, ≤ 14 words each) for this Arabic educational script, same dialect and facts — no new claims. Return ONLY JSON: {"hooks":["…","…","…"]}\n\nSCRIPT:\n{{input}}' },
  { id: 'hashtags', name: 'هاشتاجات ووصف', description: 'وصف قصير وهاشتاجات للنشر', kind: 'prompt', input: { type: 'script' }, output: { type: 'json', required: ['description', 'hashtags'] }, permissions: ['llm'], category: 'publish', temperature: 0.6,
    prompt: 'For this Arabic educational short video, write a 2-sentence Arabic description and 8 relevant hashtags (Arabic and English). Return ONLY JSON: {"description":"…","hashtags":["#…"]}\n\nSCRIPT:\n{{input}}' },
  { id: 'claims', name: 'ادعاءات محتاجة مصدر', description: 'بيطلّع كل معلومة في السكريبت محتاجة تتأكد منها (مش بيتحقق بنفسه)', kind: 'prompt', input: { type: 'script' }, output: { type: 'json', required: ['claims'] }, permissions: ['llm'], category: 'quality', temperature: 0.1,
    prompt: 'List every factual claim in this Arabic script that a careful editor should verify before publishing. Do NOT judge them as true or false; say what kind of source would confirm each. Return ONLY JSON: {"claims":[{"claim":"<Arabic, as in the script>","why":"<Arabic>","source_type":"<e.g. textbook, NASA, WHO, peer-reviewed review>"}]}\n\nSCRIPT:\n{{input}}' },
].map((s) => ({ ...s, builtin: true, version: '1.0.0' }));

function state() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { disabled: [] }; } }
function userSkills() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).flatMap((f) => {
    try { return [{ ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')), builtin: false }]; } catch { return []; }
  });
}
export function listSkills() {
  const st = state();
  return [...BUILTIN.map((s) => ({ ...s, enabled: !st.disabled.includes(s.id) })), ...userSkills()];
}
export const getSkill = (id) => listSkills().find((s) => s.id === id);

/** Validates a skill definition (import or create). Throws 400 with every problem found. */
export function validateSkill(def, { mcpServers = MCP.listServers() } = {}) {
  const problems = [];
  if (!def || typeof def !== 'object') throw err(400, 'skill must be a JSON object');
  const id = String(def.id || '').toLowerCase();
  if (!ID.test(id)) problems.push('id: حروف إنجليزي صغيرة وأرقام و - (2–40)');
  if (BUILTIN.some((b) => b.id === id)) problems.push(`id "${id}" محجوز لمهارة جاهزة`);
  const name = String(def.name || '').trim();
  if (!name || name.length > 60) problems.push('name: مطلوب (≤ 60 حرف)');
  const kind = def.kind;
  if (!['prompt', 'mcp'].includes(kind)) problems.push('kind: prompt أو mcp');
  const inputType = def.input?.type || 'text';
  if (!['text', 'script', 'topic'].includes(inputType)) problems.push('input.type: text | script | topic');
  const outType = def.output?.type || 'text';
  if (!['text', 'json'].includes(outType)) problems.push('output.type: text | json');
  const required = Array.isArray(def.output?.required) ? def.output.required.map(String).filter((k) => /^[A-Za-z_][\w]{0,30}$/.test(k)).slice(0, 10) : [];
  const out = { id, name, description: String(def.description || '').slice(0, 300), version: String(def.version || '1.0.0').slice(0, 20), kind, enabled: def.enabled !== false, category: String(def.category || 'custom').slice(0, 20),
    input: { type: inputType }, output: { type: outType, required } };
  if (kind === 'prompt') {
    const prompt = String(def.prompt || '');
    if (!prompt.includes('{{input}}')) problems.push('prompt لازم يحتوي على {{input}}');
    if (prompt.length > 8000) problems.push('prompt أطول من 8000 حرف');
    const t = Number(def.temperature ?? 0.5);
    Object.assign(out, { prompt, temperature: Number.isFinite(t) ? Math.max(0, Math.min(1.5, t)) : 0.5, permissions: ['llm'] });
  }
  if (kind === 'mcp') {
    const sv = mcpServers.find((s) => s.id === def.mcp?.server || s.name === def.mcp?.server);
    if (!sv) problems.push('mcp.server: الخادم مش متضاف');
    else if (!sv.allowedTools.includes(def.mcp?.tool)) problems.push(`mcp.tool: "${def.mcp?.tool}" مش مسموحة على ${sv.name}`);
    const args = def.mcp?.args && typeof def.mcp.args === 'object' ? Object.fromEntries(Object.entries(def.mcp.args).slice(0, 20).map(([k, v]) => [k, String(v).slice(0, 500)])) : { input: '{{input}}' };
    if (sv) Object.assign(out, { mcp: { server: sv.id, tool: def.mcp.tool, args }, permissions: [`mcp:${sv.id}/${def.mcp.tool}`] });
  }
  if (problems.length) throw err(400, 'مهارة مش صالحة:\n- ' + problems.join('\n- '));
  return out;
}

export function saveSkill(def, { replace = false } = {}) {
  const s = validateSkill(def);
  fs.mkdirSync(DIR, { recursive: true });
  let id = s.id;
  if (!replace) while (fs.existsSync(path.join(DIR, `${id}.json`))) id = `${s.id.slice(0, 32)}-${crypto.randomBytes(2).toString('hex')}`;
  writeFileAtomic(path.join(DIR, `${id}.json`), JSON.stringify({ ...s, id }, null, 1));
  return { ...s, id, builtin: false };
}
export function importSkills(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.skills) ? json.skills : [json];
  if (list.length > 50) throw err(400, 'أقصى عدد 50 مهارة في المرة');
  list.forEach((d, i) => { try { validateSkill(d); } catch (e) { throw err(400, `مهارة رقم ${i + 1}: ${e.message}`); } }); // all-or-nothing
  return list.map((d) => saveSkill(d));
}
export function setEnabled(id, enabled) {
  const sk = getSkill(id);
  if (!sk) throw err(404, 'skill not found');
  if (sk.builtin) {
    const st = state();
    st.disabled = enabled ? st.disabled.filter((x) => x !== id) : [...new Set([...st.disabled, id])];
    fs.mkdirSync(DIR, { recursive: true });
    writeFileAtomic(STATE, JSON.stringify(st));
  } else writeFileAtomic(path.join(DIR, `${id}.json`), JSON.stringify({ ...sk, enabled: !!enabled, builtin: undefined }, null, 1));
  return getSkill(id);
}
export function deleteSkill(id) {
  const sk = getSkill(id);
  if (!sk) throw err(404, 'skill not found');
  if (sk.builtin) throw err(400, 'المهارات الجاهزة تتقفل بس، ما تتحذفش');
  fs.rmSync(path.join(DIR, `${id}.json`), { force: true });
}
export function exportSkill(id) {
  const sk = getSkill(id);
  if (!sk) throw err(404, 'skill not found');
  const { builtin, enabled, ...def } = sk;
  return def;
}

const fill = (tpl, vars) => String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));

/** Runs a skill. Output is validated against output.type/required; every run is logged (redacted, truncated). */
export async function runSkill(id, { input, topic = '' } = {}, { signal } = {}) {
  const sk = getSkill(id);
  if (!sk) throw err(404, 'skill not found');
  if (!sk.enabled) throw err(403, `المهارة «${sk.name}» متقفلة`);
  const text = String(input ?? '').trim();
  if (!text) throw err(400, 'المدخل فاضي');
  if (text.length > 12000) throw err(413, 'المدخل أطول من 12000 حرف');
  const t0 = Date.now();
  let result, error = null;
  try {
    if (sk.kind === 'arabic') result = await AR.rewrite(sk.op, text, { signal });
    else if (sk.kind === 'mcp') {
      const args = Object.fromEntries(Object.entries(sk.mcp.args).map(([k, v]) => [k, fill(v, { input: text, topic })]));
      const r = await MCP.callTool(sk.mcp.server, sk.mcp.tool, args, { by: `skill:${sk.id}` });
      result = shape(sk, r.text);
    } else {
      const { text: out, model } = await chatStream(getSettings(), [
        { role: 'system', content: `[[TASK:SKILL]]\nYou run the skill "${sk.name}". ${sk.output.type === 'json' ? 'Reply with JSON only.' : 'Reply with the result only.'}` },
        { role: 'user', content: fill(sk.prompt, { input: text, topic }) }], { signal, temperature: sk.temperature ?? 0.5, maxTokens: 3000 });
      result = { ...shape(sk, out), model };
    }
  } catch (e) { error = e; }
  const rec = { ts: new Date().toISOString(), skill: sk.id, kind: sk.kind, ms: Date.now() - t0, ok: !error, in: redact(text.slice(0, 300)), out: redact(String(error?.message || result?.text || JSON.stringify(result?.json) || '').slice(0, 500)) };
  try { fs.mkdirSync(path.dirname(RUNS), { recursive: true }); fs.appendFileSync(RUNS, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch {}
  if (error) throw error;
  return { skill: sk.id, ...result, ms: rec.ms };
}
function shape(sk, raw) {
  const t = String(raw || '').trim();
  if (!t) throw err(502, 'المهارة رجّعت نتيجة فاضية');
  if (sk.output.type !== 'json') return { text: t.slice(0, 20000) };
  let j;
  try { j = extractJson(t); } catch { throw err(502, 'المهارة كان المفروض ترجّع JSON ورجّعت نص'); }
  const missing = (sk.output.required || []).filter((k) => j[k] === undefined);
  if (missing.length) throw err(502, `نتيجة المهارة ناقصها: ${missing.join(', ')}`);
  return { json: j };
}
export function runLog(limit = 100) {
  try { return fs.readFileSync(RUNS, 'utf8').trim().split('\n').slice(-limit).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}
