// Builds assets/icons/icons.json — one JSON holding the hand-drawn set, Health Icons (CC0)
// and Tabler Icons (MIT), plus their licence texts.
//   node tools/build-icons.mjs [healthiconsPackageDir] [tablerPackageDir]
// Without arguments the two npm packages are fetched with `npm pack` into a temp folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HANDDRAWN } from './handdrawn-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'icons', 'icons.json');

function fetchPkg(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-icons-'));
  const file = execSync(`npm pack ${name} --silent`, { cwd: dir }).toString().trim().split('\n').pop();
  execSync(`tar xzf "${file}"`, { cwd: dir });
  return path.join(dir, 'package');
}

const healthDir = process.argv[2] || fetchPkg('healthicons@3');
const tablerDir = process.argv[3] || fetchPkg('@tabler/icons@3');

const icons = {};

// 1) hand-drawn
for (const [name, ic] of Object.entries(HANDDRAWN)) {
  icons[`hd:${name}`] = { v: 24, m: 'stroke', p: ic.paths, t: ic.tags };
}

// 2) Health Icons (outline, 48px, fill paths)
const meta = JSON.parse(fs.readFileSync(path.join(healthDir, 'public/icons/meta-data.json'), 'utf8'));
let hcount = 0;
for (const m of meta) {
  const f = path.join(healthDir, 'public/icons/svg/outline', m.path + '.svg');
  if (!fs.existsSync(f)) continue;
  const svg = fs.readFileSync(f, 'utf8');
  const p = [];
  for (const tag of svg.match(/<path[^>]*>/g) || []) {
    const d = (tag.match(/\sd="([^"]+)"/) || [])[1];
    if (!d) continue;
    p.push(/fill-rule="evenodd"/.test(tag) ? [d, 'evenodd'] : d);
  }
  if (!p.length) continue;
  const tags = [m.title, m.id.replace(/[-_]/g, ' '), ...(m.tags || []).filter((x) => !x.includes(':'))]
    .map((s) => String(s).toLowerCase());
  icons[`hi:${m.id}`] = { v: 48, m: 'fill', p, t: [...new Set(tags)], c: m.category };
  hcount++;
}

// 3) Tabler outline (stroke nodes → path d)
const nodes = JSON.parse(fs.readFileSync(path.join(tablerDir, 'tabler-nodes-outline.json'), 'utf8'));
const tmeta = JSON.parse(fs.readFileSync(path.join(tablerDir, 'icons.json'), 'utf8'));
const n = (v) => Number(v || 0);
function nodeToD([tag, a]) {
  switch (tag) {
    case 'path': return a.d === 'M0 0h24v24H0z' ? null : a.d;
    case 'circle': { const cx = n(a.cx), cy = n(a.cy), r = n(a.r); return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`; }
    case 'ellipse': { const cx = n(a.cx), cy = n(a.cy), rx = n(a.rx), ry = n(a.ry); return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`; }
    case 'line': return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case 'polyline': case 'polygon': {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === 'polygon' ? d + 'z' : d;
    }
    case 'rect': {
      const x = n(a.x), y = n(a.y), w = n(a.width), h = n(a.height), r = Math.min(n(a.rx || a.ry), w / 2, h / 2);
      if (!r) return `M${x} ${y}h${w}v${h}h${-w}z`;
      return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
    }
    default: return null;
  }
}
let tcount = 0;
for (const [name, list] of Object.entries(nodes)) {
  const p = list.map(nodeToD).filter(Boolean);
  if (!p.length) continue;
  const m = tmeta[name] || {};
  const tags = [name.replace(/-/g, ' '), ...(m.tags || [])].map((s) => String(s).toLowerCase());
  icons[`tb:${name}`] = { v: 24, m: 'stroke', p, t: [...new Set(tags)], c: m.category || '' };
  tcount++;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const out = {
  version: 1,
  built: new Date().toISOString(),
  licenses: {
    hd: { name: 'Reel Studio hand-drawn set', license: 'CC0-1.0', url: '', text: 'Original icons drawn for Reel Studio. Dedicated to the public domain (CC0 1.0).' },
    hi: { name: 'Health Icons', license: 'CC0-1.0', url: 'https://healthicons.org', text: read(path.join(healthDir, 'LICENSE')) },
    tb: { name: 'Tabler Icons', license: 'MIT', url: 'https://tabler.io/icons', text: read(path.join(tablerDir, 'LICENSE')) },
  },
  icons,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
fs.writeFileSync(path.join(path.dirname(OUT), 'LICENSES.md'),
  Object.values(out.licenses).map((l) => `## ${l.name} — ${l.license}\n${l.url}\n\n${l.text}\n`).join('\n'));
console.log(`icons.json: ${Object.keys(HANDDRAWN).length} hand-drawn, ${hcount} Health Icons, ${tcount} Tabler → ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
