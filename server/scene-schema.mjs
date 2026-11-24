// Scene JSON validation: the JSON Schema (schemas/scene.schema.json, structure and value types) + the rules a schema
// cannot express (word indices inside the script, ascending scene starts, item counts per template, item times
// inside their scene). Runs after every AI generation / repair and again before any render engine starts.
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT } from './settings.mjs';
import { ITEM_RANGE } from './storyboard.mjs';

export const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'scene.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const check = ajv.compile(SCHEMA);

/** → { ok, errors: ["scenes/2/template: must be equal to one of the allowed values", …] } */
export function validateStoryboard(sb, { words = null } = {}) {
  const errors = [];
  if (!check(sb)) {
    for (const e of check.errors) errors.push(`${e.instancePath.slice(1) || '(root)'}: ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.filter((x) => x !== null).join(', ')})` : ''}`);
    return { ok: false, errors };
  }
  const last = words ? words.length - 1 : Infinity;
  sb.scenes.forEach((s, i) => {
    if (i === 0 && s.at !== 0) errors.push('scenes/0/at: the first scene must start at word 0');
    if (i > 0 && s.at <= sb.scenes[i - 1].at) errors.push(`scenes/${i}/at: must be after the previous scene (${sb.scenes[i - 1].at})`);
    if (s.at > last) errors.push(`scenes/${i}/at: word ${s.at} does not exist (last is ${last})`);
    const [lo, hi] = ITEM_RANGE[s.template];
    if (s.items.length < lo || s.items.length > hi) errors.push(`scenes/${i}/items: ${s.template} needs ${lo}–${hi} items, has ${s.items.length}`);
    const end = i + 1 < sb.scenes.length ? sb.scenes[i + 1].at - 1 : last;
    s.items.forEach((it, k) => { if (it.at !== null && (it.at < s.at || it.at > end)) errors.push(`scenes/${i}/items/${k}/at: word ${it.at} is outside its scene (${s.at}–${end})`); });
    if (s.template === 'meter' && s.value === null) errors.push(`scenes/${i}/value: meter needs a number`);
    if (s.template === 'chart' && s.items.filter((it) => it.value !== null).length < 2) errors.push(`scenes/${i}/items: chart needs 2 numeric items`);
  });
  for (const [k] of sb.accents) if (k > last) { errors.push(`accents: word ${k} does not exist`); break; }
  return { ok: !errors.length, errors };
}

/** Throws a readable error listing the first problems. */
export function assertStoryboard(sb, opts) {
  const r = validateStoryboard(sb, opts);
  if (!r.ok) throw Object.assign(new Error(`scene JSON is invalid: ${r.errors.slice(0, 5).join('; ')}${r.errors.length > 5 ? ` (+${r.errors.length - 5} more)` : ''}`), { status: 422, errors: r.errors });
  return sb;
}
