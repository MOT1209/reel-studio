// Storyboard: LLM prompt, JSON extraction, validation/repair, self-review prompt.
import { resolveIconKey } from './icons.mjs';

export const TYPES = ['intro', 'question', 'concept', 'process', 'compare', 'stat', 'recap'];
export const TEMPLATES = ['body', 'zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter', 'photo', 'type'];
export const BGS = ['card', 'full'];
export const TONES = ['accent', 'blue', 'success', 'warning', 'underline'];
/** Animation presets a scene may choose (null = the project default). Implemented in public/render.js. */
export const SCENE_TRANSITIONS = ['push', 'fade', 'zoom', 'slide', 'wipe', 'rise', 'none'];
export const TITLE_ANIMS = ['rise', 'fade', 'pop', 'words', 'none'];
export const ITEM_RANGE = { body: [1, 1], zoom: [2, 2], flow: [2, 4], cycle: [3, 5], timeline: [2, 5], chart: [2, 5], layers: [2, 5], cards: [1, 3], meter: [0, 1], photo: [0, 2], type: [0, 3] };

const TYPE_DEFAULT = { intro: 'zoom', question: 'cards', concept: 'zoom', process: 'flow', compare: 'cards', stat: 'meter', recap: 'cards' };
const ITEMS = ITEM_RANGE;
const ALT = {
  body: ['zoom', 'cards'], zoom: ['cards', 'layers'], flow: ['timeline', 'cycle', 'cards'], cycle: ['flow', 'cards'],
  timeline: ['flow', 'cards'], chart: ['cards', 'meter'], layers: ['cards', 'flow'], cards: ['layers', 'flow', 'zoom'], meter: ['chart', 'cards'],
  photo: ['cards', 'type'], type: ['cards', 'zoom'],
};
const TEMPLATE_ALIAS = { image: 'photo', picture: 'photo', video: 'photo', footage: 'photo', text: 'type', quote: 'type', typography: 'type', headline: 'type', news: 'type', compare: 'cards', versus: 'cards', card: 'cards', bars: 'chart', bar: 'chart', gauge: 'meter', organ: 'body', anatomy: 'body', macro: 'zoom', micro: 'zoom', steps: 'flow', process: 'flow', loop: 'cycle', stack: 'layers', history: 'timeline' };
const MIN_SCENE_SEC = 1.2;

/**
 * Full-storyboard prompt. Long-form passes one window of a chapter: `window` = { first, chapter } (the window is not the
 * start of the video unless `first`), plus the profile's pace (`sceneSeconds`), visual direction and preferred templates.
 * With none of those options the prompt is exactly the short-reel prompt.
 */
export function storyboardMessages({ title, words, duration, forceTemplate, sceneSeconds = 3.2, maxScenes = 12, window = null, visual = '', templates = [] }) {
  const wordList = words.map((w) => `${w.i}:${w.text}@${w.start.toFixed(2)}`).join(' ');
  const target = Math.max(2, Math.min(maxScenes, Math.round(duration / sceneSeconds)));
  const opening = !window || window.first
    ? 'The first scene is type "intro" at 0.'
    : `This is one part of a longer video (chapter "${window.chapter}"): the first scene starts at word ${words[0].i}; do NOT use type "intro".`;
  const direction = `${visual ? `\n- Visual direction: ${visual}` : ''}${templates.length ? `\n- Prefer these templates when they fit: ${templates.join(', ')}.` : ''}`;
  return [
    { role: 'system', content: `[[TASK:STORYBOARD]]
You are the motion designer of a faceless science-explainer reel (dark technical illustrations, one illustration card per scene).
Return ONLY a JSON object, no prose, no code fences:
{"scenes":[{"type":..., "template":..., "at":<wordIndex>, "title":"<short Arabic headline ≤ 4 words>", "query":"<English stock-media keywords>", "items":[{"label":"<Arabic ≤ 3 words>","icon":"<simple English noun>","value":<number|null>,"at":<wordIndex|null>}], "organ":"<English noun, body only>", "value":<number, meter only>, "max":<number, meter only>, "unit":"<unit, meter/chart>"}],
 "accents":[[<wordIndex>, "<tone>"]]}

Scene types: intro, question, concept, process, compare, stat, recap.
Templates (pick the one that best SHOWS what is being said):
- body: an organ inside a human body outline. Needs "organ" (heart, lungs, brain, stomach, liver, kidneys, intestine, bone, skin, eye…) + 1 item (its label).
- zoom: macro → micro. Exactly 2 items: [big thing, tiny thing inside it] (e.g. body → cell, leaf → chloroplast).
- flow: A → B → C cause/effect or steps. 2–4 items.
- cycle: a repeating loop. 3–5 items.
- timeline: events in time order. 2–5 items, value = year or time.
- chart: bar comparison of numbers. 2–5 items, each with a numeric value; "unit".
- layers: stacked layers/levels (skin layers, atmosphere, earth). 2–5 items, top first.
- cards: 1–3 labelled icon cards; good for compare (2 cards) and recap.
- meter: one number on a gauge. "value", "max", "unit", optional 1 item as label.
- photo: a real photo/video of the subject fills the card (places, animals, objects, events). 0–2 items as captions. Needs a good "query".
- type: animated typography — the title and up to 3 short phrases appear big (a definition, a quote, a key sentence, a news-style headline).
Every scene also has "query": 2–4 English keywords to find a matching stock photo or video for it.
Rules:
- About ${target} scenes for ${duration.toFixed(1)} s. Each scene lasts at least ${MIN_SCENE_SEC}s. ${opening}
- "at" = index of the word where the scene starts — the word that introduces what the scene shows. Sorted ascending.
- item "at" = word index where that item should pop in (inside the scene), or null.
- Never use the same template three scenes in a row. Vary templates.
- Icons are simple, concrete English nouns (heart, sun, cell, virus, water, clock, brain). One or two words.
- Labels are Egyptian Arabic and short; keep English science terms in English (DNA, oxygen).
- accents: 2–6 key words. tones: accent (main term), blue (secondary term), success (good/positive), warning (danger only), underline (the key number or the answer).${direction}${forceTemplate ? `\n- TEST MODE: use template "${forceTemplate}" for every scene.` : ''}` },
    { role: 'user', content: `TITLE: ${title}\nDURATION: ${duration.toFixed(2)}s\nWORDS (index:word@startSeconds):\n${wordList}` },
  ];
}

/** Regenerates ONE scene: the words it covers, its neighbours for context, an optional user hint. */
export function sceneMessages({ title, words, scene, prev, next, hint }) {
  const wordList = words.map((w) => `${w.i}:${w.text}@${w.start.toFixed(2)}`).join(' ');
  return [
    { role: 'system', content: `[[TASK:SCENE]]
You redesign ONE scene of a science-explainer reel storyboard. Return ONLY one JSON object (no prose, no code fences):
{"type":..., "template":..., "title":"<short Arabic headline ≤ 4 words>", "query":"<English stock keywords>", "items":[{"label":"<Arabic ≤ 3 words>","icon":"<simple English noun>","value":<number|null>,"at":<wordIndex|null>}], "organ":"<body only>", "value":<meter only>, "max":<meter only>, "unit":"<meter/chart>", "transition":"push|fade|zoom|slide|wipe|rise|none", "titleAnim":"rise|fade|pop|words|none"}
Templates: body, zoom, flow, cycle, timeline, chart, layers, cards, meter, photo, type (same rules as the full storyboard: item counts per template, chart needs numbers, meter needs value).
Pick a DIFFERENT angle than the current scene unless the hint says otherwise. Item "at" values must be word indices from the list below.` },
    { role: 'user', content: `TITLE: ${title}
PREVIOUS SCENE: ${prev ? JSON.stringify({ type: prev.type, template: prev.template, title: prev.title }) : 'none'}
CURRENT SCENE: ${JSON.stringify({ type: scene.type, template: scene.template, title: scene.title, items: scene.items })}
NEXT SCENE: ${next ? JSON.stringify({ type: next.type, template: next.template, title: next.title }) : 'none'}
${hint ? `HINT FROM THE EDITOR: ${hint}\n` : ''}WORDS OF THIS SCENE (index:word@startSeconds):
${wordList}` },
  ];
}

export function reviewMessages({ title, words, duration, storyboard, notes }) {
  const wordList = words.map((w) => `${w.i}:${w.text}@${w.start.toFixed(2)}`).join(' ');
  return [
    { role: 'system', content: `[[TASK:REVIEW]]
You are reviewing a storyboard for a science-explainer reel. Improve weak scene choices and return the FULL improved storyboard as JSON only (same schema, no prose, no code fences).
Checklist:
- Does each template actually SHOW what the narration says at that moment? (process → flow/cycle/timeline, numbers → meter/chart, organs → body, small-inside-big → zoom, contrast → cards with 2 items.)
- Does each scene start on the word that introduces its idea?
- Replace icons marked UNKNOWN with simpler, concrete English nouns.
- Scenes longer than ~6 s should be split; scenes shorter than ${MIN_SCENE_SEC}s merged.
- No template three times in a row. First scene: intro at 0.
- 2–6 accents on the key terms; warning tone only for danger.
Keep everything that is already good.` },
    { role: 'user', content: `TITLE: ${title}\nDURATION: ${duration.toFixed(2)}s\nWORDS:\n${wordList}\n\nNOTES FROM VALIDATOR:\n${notes.length ? notes.map((n) => '- ' + n).join('\n') : '- none'}\n\nCURRENT STORYBOARD:\n${JSON.stringify(storyboard)}` },
  ];
}

/** Extracts and parses the first JSON object in an LLM reply, tolerating fences and trailing commas. */
export function extractJson(text) {
  let t = String(text).replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('No JSON object in LLM reply');
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch {}
  // line comments only when "//" starts the line or follows JSON punctuation — never inside "https://…"
  const fixed = t.replace(/(^|[\[{,]\s*)\/\/[^\n]*/gm, '$1').replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
  return JSON.parse(fixed);
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const nounOf = (v) => str(v, 32).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim();
const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };

/**
 * Validates and repairs a storyboard against the word timings.
 * Returns { storyboard, fixes:[], notes:[] } — fixes = what was changed, notes = hints for the self-review pass.
 */
export function repairStoryboard(raw, words, { forceTemplate } = {}) {
  const fixes = [], notes = [];
  if (!words?.length) throw new Error('storyboard needs timed words (timing produced none)');
  const n = words.length;
  const last = n - 1;
  const t0 = (i) => words[Math.max(0, Math.min(last, i))].start;
  const endT = n ? words[last].end : 0;
  let scenes = Array.isArray(raw?.scenes) ? raw.scenes.filter((s) => s && typeof s === 'object') : [];
  if (!Array.isArray(raw?.scenes)) fixes.push('scenes missing → created');

  scenes = scenes.map((s, k) => {
    let type = str(s.type, 20).toLowerCase();
    if (!TYPES.includes(type)) { fixes.push(`scene ${k}: unknown type "${s.type}" → concept`); type = 'concept'; }
    let template = str(s.template, 20).toLowerCase();
    template = TEMPLATE_ALIAS[template] || template;
    if (!TEMPLATES.includes(template)) { const d = TYPE_DEFAULT[type]; if (s.template) fixes.push(`scene ${k}: unknown template "${s.template}" → ${d}`); template = d; }
    if (forceTemplate) template = forceTemplate;
    let at = intIn(s.at ?? s.word ?? s.start, 0, last);
    if (at === null) { at = 0; fixes.push(`scene ${k}: invalid "at" → 0`); }
    else if (Number(s.at) !== at) fixes.push(`scene ${k}: at ${s.at} → ${at}`);
    const items = (Array.isArray(s.items) ? s.items : []).filter((it) => it && typeof it === 'object').map((it) => ({
      label: str(it.label ?? it.text ?? it.title, 30), icon: nounOf(it.icon), value: num(it.value), at: it.at == null ? null : intIn(it.at, 0, last),
    }));
    return {
      type, template, at, title: str(s.title, 40), items, organ: nounOf(s.organ), value: num(s.value), max: num(s.max), unit: str(s.unit, 12),
      query: str(s.query, 60), image: /^[a-f0-9]{12}$/.test(s.image || '') ? s.image : null, bg: BGS.includes(s.bg) ? s.bg : 'card',
      imageOffset: Math.max(0, Number(s.imageOffset) || 0),
      transition: SCENE_TRANSITIONS.includes(s.transition) ? s.transition : null, titleAnim: TITLE_ANIMS.includes(s.titleAnim) ? s.titleAnim : null,
    };
  });

  // sort + dedupe "at"
  const before = scenes.map((s) => s.at).join(',');
  scenes.sort((a, b) => a.at - b.at);
  if (scenes.map((s) => s.at).join(',') !== before) fixes.push('scenes re-sorted by word index');
  scenes = scenes.filter((s, i) => { if (i && s.at === scenes[i - 1].at) { fixes.push(`duplicate scene at word ${s.at} dropped`); return false; } return true; });

  // first scene = intro at 0
  if (!scenes.length) scenes.push({ type: 'intro', template: forceTemplate || 'zoom', at: 0, title: '', items: [], organ: '', value: null, max: null, unit: '', query: '', image: null, bg: 'card', imageOffset: 0, transition: null, titleAnim: null });
  if (scenes[0].at !== 0) { fixes.push(`first scene moved from word ${scenes[0].at} to 0`); scenes[0].at = 0; }
  if (scenes[0].type !== 'intro') { fixes.push(`first scene type ${scenes[0].type} → intro`); scenes[0].type = 'intro'; }

  // minimum duration — merge short scenes into the previous one
  for (let i = 1; i < scenes.length; i++) {
    const end = i + 1 < scenes.length ? t0(scenes[i + 1].at) : endT;
    if (end - t0(scenes[i].at) < MIN_SCENE_SEC || t0(scenes[i].at) - t0(scenes[i - 1].at) < MIN_SCENE_SEC) {
      fixes.push(`scene at word ${scenes[i].at} too short → merged`);
      scenes.splice(i, 1); i--;
    }
  }

  // fit items/params to each template
  scenes.forEach((s, i) => fitTemplate(s, i, words, scenes, fixes));

  // no template three times in a row
  if (!forceTemplate) {
    for (let i = 2; i < scenes.length; i++) {
      if (scenes[i].template === scenes[i - 1].template && scenes[i].template === scenes[i - 2].template) {
        const from = scenes[i].template;
        const alt = ALT[from].find((t) => t !== scenes[i - 1].template && (i + 1 >= scenes.length || t !== scenes[i + 1].template)) || 'cards';
        scenes[i].template = alt;
        fixes.push(`scene ${i}: ${from} three times in a row → ${alt}`);
        fitTemplate(scenes[i], i, words, scenes, fixes);
      }
    }
  }

  // item "at" must fall inside its scene
  scenes.forEach((s, i) => {
    const hi = i + 1 < scenes.length ? scenes[i + 1].at - 1 : last;
    for (const it of s.items) if (it.at !== null && (it.at < s.at || it.at > hi)) { it.at = null; }
    let prev = -1;
    for (const it of s.items) { if (it.at !== null) { if (it.at < prev) it.at = null; else prev = it.at; } }
  });

  // review hints
  scenes.forEach((s, i) => {
    const end = i + 1 < scenes.length ? t0(scenes[i + 1].at) : endT;
    if (end - t0(s.at) > 6.5) notes.push(`scene ${i} (${s.template}) lasts ${(end - t0(s.at)).toFixed(1)}s — consider splitting`);
    for (const noun of [s.organ, ...s.items.map((it) => it.icon)].filter(Boolean)) {
      if (resolveIconKey(noun) === 'hd:dot') notes.push(`scene ${i}: icon "${noun}" is UNKNOWN in the icon library`);
    }
  });

  // accents
  const seen = new Set();
  const accents = (Array.isArray(raw?.accents) ? raw.accents : []).map((a) => {
    if (Array.isArray(a)) return [intIn(a[0], 0, last), str(a[1], 12).toLowerCase()];
    if (a && typeof a === 'object') return [intIn(a.at ?? a.word ?? a.i, 0, last), str(a.tone, 12).toLowerCase()];
    return [null, ''];
  }).filter(([i, tone]) => {
    if (i === null || seen.has(i)) return false;
    seen.add(i);
    return true;
  }).map(([i, tone]) => [i, TONES.includes(tone) ? tone : 'accent']).sort((a, b) => a[0] - b[0]);

  return { storyboard: { scenes, accents }, fixes, notes };
}

function fitTemplate(s, i, words, scenes, fixes) {
  const [lo, hi] = ITEMS[s.template];
  const hiIdx = i + 1 < scenes.length ? scenes[i + 1].at : words.length;
  const sceneWords = words.slice(s.at, hiIdx);
  const numsInWords = sceneWords.map((w) => Number(String(w.text).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[^\d.]/g, ''))).filter((x) => Number.isFinite(x) && x > 0);
  if (s.template === 'meter') {
    if (s.value === null) s.value = s.items.find((it) => it.value !== null)?.value ?? numsInWords[0] ?? null;
    if (s.value === null) { s.template = 'cards'; fixes.push(`scene ${i}: meter without a number → cards`); return fitTemplate(s, i, words, scenes, fixes); }
    if (!(s.max > 0) || s.max < s.value) s.max = niceMax(s.value);
  }
  if (s.template === 'chart') {
    const withVal = s.items.filter((it) => it.value !== null);
    if (withVal.length < 2) { s.template = 'cards'; fixes.push(`scene ${i}: chart without 2 numeric items → cards`); return fitTemplate(s, i, words, scenes, fixes); }
    s.items = withVal;
  }
  if (s.template === 'body' && !s.organ) {
    s.organ = s.items[0]?.icon || '';
    if (!s.organ) { s.template = 'zoom'; fixes.push(`scene ${i}: body without organ → zoom`); return fitTemplate(s, i, words, scenes, fixes); }
  }
  if (s.items.length > hi) { fixes.push(`scene ${i}: ${s.items.length} items > ${hi} for ${s.template} → trimmed`); s.items = s.items.slice(0, hi); }
  while (s.items.length < lo) {
    const k = s.items.length;
    const fallbackLabel = s.title || sceneWords.slice(k * 2, k * 2 + 2).map((w) => w.text).join(' ') || '…';
    s.items.push({ label: fallbackLabel.slice(0, 30), icon: k === 0 ? (s.organ || 'cell') : ['atom', 'molecule', 'bolt', 'clock', 'check'][k % 5], value: null, at: null });
    fixes.push(`scene ${i}: padded ${s.template} item ${k + 1}`);
  }
  if (s.template === 'body' && !s.items[0].label) s.items[0].label = s.title || s.organ;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v * 1.1) return m * p;
  return 10 * p;
}

/** All icon nouns a storyboard uses. */
export function storyboardNouns(sb) {
  const out = [];
  for (const s of sb.scenes) { if (s.organ) out.push(s.organ); for (const it of s.items) if (it.icon) out.push(it.icon); }
  return out;
}
