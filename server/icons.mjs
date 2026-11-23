// Resolves simple English nouns ("heart", "sunlight", "virus") against the local icon library.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './settings.mjs';

let LIB = null, INDEX = null;
function lib() {
  if (LIB) return LIB;
  LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'icons', 'icons.json'), 'utf8'));
  // tag → keys, ordered hand-drawn > health > tabler
  INDEX = new Map();
  const order = { hd: 0, hi: 1, tb: 2 };
  const keys = Object.keys(LIB.icons).sort((a, b) => order[a.slice(0, 2)] - order[b.slice(0, 2)]);
  for (const k of keys) {
    for (const tag of LIB.icons[k].t || []) {
      if (!INDEX.has(tag)) INDEX.set(tag, []);
      INDEX.get(tag).push(k);
    }
  }
  return LIB;
}

// Preferred picks for common science nouns (anatomy from Health Icons, abstract ideas from the hand-drawn set).
const PREFERRED = {
  heart: 'hi:heart-organ', lung: 'hi:lungs', lungs: 'hi:lungs', brain: 'tb:brain', stomach: 'hi:stomach',
  liver: 'hi:liver', kidney: 'hi:kidneys', kidneys: 'hi:kidneys', intestine: 'hi:intestine', gut: 'hi:intestine',
  bone: 'hi:bone', skeleton: 'hi:skeleton', skull: 'hi:skull', spine: 'hi:spine', tooth: 'hi:tooth', teeth: 'hi:tooth',
  blood: 'hi:blood-drop', vein: 'hi:blood-vessel', artery: 'hi:blood-vessel', 'blood vessel': 'hi:blood-vessel',
  ear: 'hi:ear', nose: 'hi:nose', mouth: 'hi:mouth', skin: 'hi:tissue', muscle: 'tb:barbell', hair: 'hi:hair',
  bladder: 'hi:bladder', pancreas: 'hi:pancreas', thyroid: 'hi:thyroid', nerve: 'hd:neuron', neuron: 'hd:neuron',
  antibody: 'hi:antibody', immune: 'hi:antibody', bacteria: 'hd:bacteria', germ: 'hd:bacteria', virus: 'hd:virus',
  cell: 'hd:cell', dna: 'hd:dna', gene: 'hd:dna', atom: 'hd:atom', molecule: 'hd:molecule', water: 'hd:drop',
  sun: 'hd:sun', light: 'hd:sun', sunlight: 'hd:sun', energy: 'hd:bolt', electricity: 'hd:bolt', fire: 'hd:flame',
  heat: 'hd:flame', plant: 'hd:leaf', leaf: 'hd:leaf', earth: 'tb:world', planet: 'hd:planet', moon: 'tb:moon',
  star: 'tb:star', space: 'hd:rocket', time: 'hd:clock', temperature: 'hd:thermometer', sound: 'hd:wave',
  wave: 'hd:wave', idea: 'hd:bulb', question: 'hd:question', eye: 'hd:eye', person: 'hd:person', human: 'hd:person',
  body: 'hd:person', magnet: 'hd:magnet', cloud: 'hd:cloud', mountain: 'hd:mountain', oxygen: 'hd:molecule',
  sugar: 'tb:cube', food: 'tb:apple', sleep: 'tb:moon', phone: 'tb:device-mobile', car: 'tb:car', factory: 'tb:building-factory',
  battery: 'hd:battery', microscope: 'hd:microscope', ocean: 'tb:ripple', sea: 'tb:ripple', rain: 'tb:cloud-rain',
  wind: 'tb:wind', snow: 'tb:snowflake', ice: 'tb:snowflake', tree: 'tb:tree', fish: 'tb:fish', bird: 'tb:feather',
  dog: 'tb:dog', cat: 'tb:cat', coffee: 'tb:coffee', check: 'hd:check', pill: 'hi:pill-1', medicine: 'hi:pill-1',
  photon: 'hd:wave', mitochondria: 'hd:cell', mitochondrion: 'hd:cell', nucleus: 'hd:atom', electron: 'hd:atom',
  yawn: 'tb:mood-tongue', smile: 'tb:mood-smile', mirror: 'tb:flip-vertical', chemical: 'hd:molecule',
  vaccine: 'hi:vaccine-protected', protein: 'hd:molecule', hormone: 'hd:molecule', signal: 'hd:wave', speed: 'tb:gauge',
};

function singular(w) {
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(w)) return w;
  if (w.endsWith('es') && /(sh|ch|x|s)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\b(a|an|the)\b/g, '').replace(/\s+/g, ' ').trim();

/** Returns the library key for a noun (always returns something; falls back to "hd:dot"). */
export function resolveIconKey(noun) {
  const L = lib();
  const n = clean(noun);
  if (!n) return 'hd:dot';
  const cands = [n, singular(n), n.replace(/ /g, '-'), singular(n).replace(/ /g, '-')];
  for (const c of cands) if (PREFERRED[c] && L.icons[PREFERRED[c]]) return PREFERRED[c];
  for (const c of cands) for (const p of ['hd:', 'hi:', 'tb:']) if (L.icons[p + c.replace(/-/g, p === 'hd:' ? '_' : '-')]) return p + c.replace(/-/g, p === 'hd:' ? '_' : '-');
  for (const c of cands) { const k = INDEX.get(c.replace(/-/g, ' ')); if (k?.length) return k[0]; }
  // last word of a multi-word noun ("red blood cell" → "cell")
  const last = singular(n.split(' ').pop());
  if (last !== n) { const k = resolveIconKey(last); if (k !== 'hd:dot') return k; }
  // partial tag match
  for (const [tag, keys] of INDEX) if (tag.split(' ').includes(singular(n))) return keys[0];
  return 'hd:dot';
}

/** Builds the minimal icon payload for a project: { noun: {key,v,m,p} } for only the nouns used. */
export function iconsFor(nouns) {
  const L = lib();
  const out = {};
  for (const noun of new Set(nouns.filter(Boolean))) {
    const key = resolveIconKey(noun);
    const ic = L.icons[key];
    out[noun] = { key, v: ic.v, m: ic.m, p: ic.p };
  }
  return out;
}

export function iconLicenses() {
  const L = lib();
  return Object.fromEntries(Object.entries(L.licenses).map(([k, v]) => [k, { name: v.name, license: v.license, url: v.url }]));
}
