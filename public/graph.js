// Read-only node canvas for the pipeline (n8n-style): one node per stage, a group node for the chapters of a
// long-form project, and the edges between them. Nothing here writes: a node click selects the stage, exactly
// like the old stage strip did.
//
// Lifecycle (why this is not just "re-render the HTML"): the canvas lives across SSE `state` events. `update()`
// patches the status/meta/approval of the existing nodes in place, so the user's pan/zoom, the focused node and
// the ResizeObserver survive; it returns false only when the graph's shape changed (a stage appeared/disappeared),
// and the caller then remounts. `destroy()` disconnects the observer so a re-mount cannot leak one per event.
import { esc } from './ui.js';

const NW = 168, NH = 104;        // stage node
const SW = 150, SH = 62;         // the manual editor node under the render node
const GW = 38, PAD = 24, DOWN = 26;
const CH_W = 208;

export const STAGE_LABEL = { script: 'السكريبت', voice: 'الصوت', timing: 'التوقيت', storyboard: 'الستوري بورد', render: 'الرندر', editor: 'المحرر', publish: 'يوتيوب' };
const STATUS = { idle: 'مستني', running: 'شغال…', review: 'مراجعة', done: 'تمام', error: 'خطأ' };
const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];

const ICONS = {
  script: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/>',
  voice: '<path d="M4 13v-2M8 9v6M12 6v12M16 9v6M20 12v2"/>',
  timing: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  storyboard: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
  chapters: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  render: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 9l4-2v10l-4-2z"/>',
  editor: '<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2"/><circle cx="15" cy="16" r="2"/>',
  publish: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/** pan/zoom per project id, so a re-mount after a shape change keeps what the user set. */
const VIEWS = new Map();

export function mountGraph(host, p, { selected = null, onSelect = () => {}, onApproval = () => {} } = {}) {
  let model = build(p, selected);

  host.innerHTML = `
    <div class="gbar">
      <span class="gtitle">مسار المشروع</span>
      <span class="ghint">اسحب للتنقل · Ctrl + عجلة للتصغير</span>
      <span class="gzoom">
        <button type="button" class="small" data-gz="out" aria-label="تصغير" title="تصغير">−</button>
        <span class="gpct" data-gpct>100%</span>
        <button type="button" class="small" data-gz="in" aria-label="تكبير" title="تكبير">＋</button>
        <button type="button" class="small" data-gfit title="اعرض كل النودز">ملاءمة</button>
      </span>
    </div>
    <div class="gview" data-gview tabindex="0" role="group" aria-label="مخطط مراحل المشروع">
      <div class="glayer" data-glayer>
        <svg class="gedges" width="${model.contentW}" height="${model.contentH}" aria-hidden="true">
          ${model.edges.map((e) => `<path class="gedge ${edgeClass(e)}" d="${edgePath(e)}" data-edge="${e.a.key}>${e.b.key}"/>`).join('')}
        </svg>
        ${model.chain.map((n) => nodeHtml(n, p, selected)).join('')}
        ${model.below.map((n) => nodeHtml(n, p, selected)).join('')}
      </div>
    </div>`;

  const vw = host.querySelector('[data-gview]');
  const ly = host.querySelector('[data-glayer]');
  const pid = p.id || 'project';
  let v = VIEWS.get(pid);
  if (!v) { v = { s: 1, tx: 0, ty: 0, touched: false, fitW: 0 }; VIEWS.set(pid, v); }

  const apply = () => {
    ly.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    const pct = host.querySelector('[data-gpct]');
    if (pct) pct.textContent = Math.round(v.s * 100) + '%';
  };
  const fit = () => {
    const w = vw.clientWidth || 1, h = vw.clientHeight || 1;
    const s = clamp(Math.min((w - 8) / model.contentW, (h - 8) / model.contentH, 1), 0.35, 1);
    v.s = s; v.tx = (w - model.contentW * s) / 2; v.ty = (h - model.contentH * s) / 2; v.touched = false; v.fitW = w;
    apply();
  };
  const zoomAt = (px, py, k) => {
    const s2 = clamp(v.s * k, 0.25, 1.8);
    const wx = (px - v.tx) / v.s, wy = (py - v.ty) / v.s;
    v.s = s2; v.tx = px - wx * s2; v.ty = py - wy * s2; v.touched = true; apply();
  };

  // re-fit on a mount after the layout changed (the editor hides the project sidebar and widens the canvas)
  if (!v.touched || Math.abs((v.fitW || 0) - (vw.clientWidth || 0)) > 80) fit(); else apply();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!v.touched) fit(); }) : null;
  ro?.observe(vw);

  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('.gnode, button, input, label')) return;
    drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
    vw.setPointerCapture(e.pointerId);
    vw.classList.add('grabbing');
  };
  const onMove = (e) => {
    if (!drag) return;
    v.tx = drag.tx + (e.clientX - drag.x); v.ty = drag.ty + (e.clientY - drag.y);
    v.touched = true; apply();
  };
  const onUp = () => { drag = null; vw.classList.remove('grabbing'); };
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // a plain wheel still scrolls the page
    e.preventDefault();
    const r = vw.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };
  vw.addEventListener('pointerdown', onDown);
  vw.addEventListener('pointermove', onMove);
  vw.addEventListener('pointerup', onUp);
  vw.addEventListener('pointercancel', onUp);
  vw.addEventListener('wheel', onWheel, { passive: false });

  // ---- selection (read-only: it only picks the stage whose panel is shown) ----
  const pick = (stage) => { if (stage) onSelect(stage); };
  const onClick = (e) => {
    if (e.target.closest('input, label, button')) return;
    const n = e.target.closest('.gnode[data-stage]');
    if (n) pick(n.dataset.stage);
  };
  const onKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.matches('input')) return;
    const n = e.target.closest?.('.gnode[data-stage]');
    if (!n) return;
    e.preventDefault();
    pick(n.dataset.stage);
  };
  // the approval checkbox lives in the node, so the canvas owns its handler (bound once, on the nodes it renders)
  const onChange = (e) => {
    const box = e.target.closest('[data-wait]');
    if (box) onApproval(box.dataset.wait, box.checked);
  };
  vw.addEventListener('click', onClick);
  vw.addEventListener('keydown', onKey);
  vw.addEventListener('change', onChange);

  const zoomIn = () => zoomAt(vw.clientWidth / 2, vw.clientHeight / 2, 1.15);
  const zoomOut = () => zoomAt(vw.clientWidth / 2, vw.clientHeight / 2, 1 / 1.15);
  const zIn = host.querySelector('[data-gz="in"]'), zOut = host.querySelector('[data-gz="out"]'), zFit = host.querySelector('[data-gfit]');
  zIn?.addEventListener('click', zoomIn);
  zOut?.addEventListener('click', zoomOut);
  zFit?.addEventListener('click', fit);

  return {
    host,
    projectId: p.id,
    /** patch statuses/metas in place; false = the graph shape changed and the caller must remount */
    update(np, nsel) {
      const m2 = build(np, nsel);
      if (signature(m2) !== signature(model)) return false;
      paint(host, m2, np, nsel);
      model = m2;
      return true;
    },
    /** the running node's bar, from SSE `progress` (the render stage reports frames) */
    setProgress(pct) {
      const bar = host.querySelector('[data-gprog]');
      if (bar) bar.style.width = clamp(pct, 0, 100).toFixed(1) + '%';
    },
    destroy() {
      ro?.disconnect();
      vw.removeEventListener('pointerdown', onDown);
      vw.removeEventListener('pointermove', onMove);
      vw.removeEventListener('pointerup', onUp);
      vw.removeEventListener('pointercancel', onUp);
      vw.removeEventListener('wheel', onWheel);
      vw.removeEventListener('click', onClick);
      vw.removeEventListener('keydown', onKey);
      vw.removeEventListener('change', onChange);
    },
  };
}

// ---------- model ----------
function build(p, selected) {
  const st = (s) => p.stages?.[s]?.status || 'idle';
  const meta = {
    script: p.script?.words ? `${p.script.words} كلمة` : 'لسه',
    voice: p.voice?.duration ? `${Number(p.voice.duration).toFixed(1)} ث` : 'لسه',
    timing: p.words?.length ? `${p.words.length} كلمة` : 'لسه',
    storyboard: p.storyboard?.scenes ? `${p.storyboard.scenes.length} مشهد` : 'لسه',
    render: p.render?.frames ? `${p.render.frames} فريم` : (p.edit?.export?.aspect ? `${p.edit.export.aspect} · ${p.edit.export.fps || 30}fps` : 'لسه'),
  };

  const chain = [];
  for (const s of ['script', 'voice', 'timing', 'storyboard']) {
    chain.push({ key: s, stage: s, w: NW, h: NH, status: st(s), icon: s, label: STAGE_LABEL[s], meta: meta[s], appr: true });
  }
  const chapters = chapterNode(p);
  if (chapters) chain.push(chapters);
  const renderNode = { key: 'render', stage: 'render', w: NW, h: NH, status: st('render'), icon: 'render', label: STAGE_LABEL.render, meta: meta.render, appr: true };
  chain.push(renderNode);
  // publishing is the tail of the flow, so it sits in the chain (only once a publish has actually started)
  const pub = p.publish?.status;
  if (pub && pub !== 'idle') {
    const ps = pub === 'done' ? 'done' : pub === 'running' ? 'running' : 'error';
    chain.push({ key: 'publish', stage: 'render', w: NW, h: NH, status: ps, icon: 'publish', label: STAGE_LABEL.publish, meta: ps === 'done' ? 'اتنشر على يوتيوب' : ps === 'running' ? 'بيرفع…' : 'فشل الرفع', appr: false });
  }

  // the editor is not part of the automatic flow: it hangs under the render node as a manual node
  const editorReady = !!(p.storyboard && p.words);
  const below = [{ key: 'editor', stage: 'editor', w: SW, h: SH, status: editorReady ? 'ready' : 'off', icon: 'editor', label: STAGE_LABEL.editor, meta: editorReady ? 'جاهز للتعديل' : 'بعد الستوري بورد' }];

  // ---- layout: RTL chain (the first stage is the rightmost node), the editor under the render node ----
  const chainW = chain.reduce((a, n) => a + n.w, 0) + GW * (chain.length - 1);
  const chainH = Math.max(...chain.map((n) => n.h));
  const contentW = PAD * 2 + chainW;
  const contentH = PAD * 2 + chainH + (below.length ? DOWN + SH : 0);
  let right = PAD + chainW;
  for (const n of chain) { n.x = right - n.w; n.y = PAD + (chainH - n.h) / 2; right = n.x - GW; }
  for (const n of below) { n.x = renderNode.x; n.y = PAD + chainH + DOWN; }

  const edges = [];
  for (let i = 0; i < chain.length - 1; i++) edges.push({ a: chain[i], b: chain[i + 1], kind: 'chain' });
  for (const n of below) edges.push({ a: renderNode, b: n, kind: 'down' });

  return { chain, below, edges, contentW, contentH };
}

/** the model's shape: same signature = the existing DOM can be patched, no re-mount needed */
function signature(m) {
  const keys = [...m.chain, ...m.below].map((n) => n.key).join('|');
  const chapters = m.chain.find((n) => n.key === 'chapters')?.rows.map((r) => r.id).join(',') || '';
  return `${keys}#${chapters}`;
}

function chapterNode(p) {
  const chs = p.chapters || [];
  if (!chs.length) return null;
  const pr = p.chapterProgress || { total: chs.length, done: 0, stages: {} };
  const anyRunning = chs.some((ch) => STAGES.some((s) => ch.stages?.[s] === 'running'));
  const status = anyRunning ? 'running' : (pr.done === chs.length ? 'done' : 'idle');
  const rows = chs.map((ch) => ({
    id: ch.id,
    title: ch.title || '—',
    stages: STAGES.map((s) => ch.stages?.[s] || 'idle'),
  }));
  return {
    key: 'chapters', stage: null, w: CH_W, h: Math.min(304, 84 + chs.length * 20), status, icon: 'chapters',
    label: `الفصول · ${pr.done || 0}/${chs.length}`, meta: `${Math.round(pr.seconds || 0)} ث مترندرة`, rows,
  };
}

// ---------- markup ----------
function nodeClass(n, selected) {
  return ['stage', 'gnode',
    n.key === 'chapters' ? 'gchapters' : '',
    n.status === 'running' ? 'running' : '',
    n.status === 'error' ? 'error' : '',
    n.status === 'off' ? 'off' : '',
    n.key === 'editor' ? 'manual' : '',
    selected && selected === n.stage ? 'sel' : '',
  ].filter(Boolean).join(' ');
}

function nodeHtml(n, p, selected) {
  const style = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`;

  if (n.key === 'chapters') {
    return `<div class="${nodeClass(n, selected)}" data-key="chapters" style="${style}" role="group" aria-label="فصول المشروع" title="فصول المشروع">
      <div class="ghead"><span class="gic">${svg('chapters')}</span><span class="gname">${esc(n.label)}</span><span class="gdot ${n.status}"></span></div>
      <div class="gmeta">${esc(n.meta)}</div>
      <div class="gchlist">${n.rows.map((r) => `
        <div class="gchrow" data-ch="${esc(r.id)}">
          <span class="mono">${esc(r.id)}</span>
          <span class="pips">${r.stages.map((s, i) => `<span class="pip ${esc(s)}" title="${STAGE_LABEL[STAGES[i]]}"></span>`).join('')}</span>
          <span class="gcht">${esc(r.title)}</span>
        </div>`).join('')}</div>
    </div>`;
  }

  const badge = n.key === 'editor' ? '' : `<span class="badge ${n.status === 'ready' ? '' : n.status}">${STATUS[n.status] || ''}</span>`;
  const prog = n.stage === 'render' ? '<div class="gprog"><i data-gprog style="width:0%"></i></div>' : '';
  const appr = n.appr ? `<label class="gappr" title="المرحلة تستنى موافقتك قبل ما تبدأ"><input type="checkbox" data-wait="${n.stage}" ${p.approvals?.[n.stage] === 'wait' ? 'checked' : ''}> استنى موافقتي</label>` : '';
  return `<div class="${nodeClass(n, selected)}" data-key="${n.key}" data-stage="${n.stage}" role="button" tabindex="0" aria-pressed="${selected === n.stage}" title="${esc(n.label)}" style="${style}">
    <div class="ghead"><span class="gic">${svg(n.icon)}</span><span class="gname">${esc(n.label)}</span><span class="gdot ${n.status}"></span></div>
    <div class="grow">${badge}<span class="gmeta">${esc(n.meta)}</span></div>
    ${prog}
    ${appr}
  </div>`;
}

/** patch the existing nodes/edges with the new model (same shape) — keeps pan/zoom, focus and the observer */
function paint(host, next, p, selected) {
  for (const n of [...next.chain, ...next.below]) {
    const el = host.querySelector(`.gnode[data-key="${n.key}"]`);
    if (!el) continue;
    el.className = nodeClass(n, selected);
    el.setAttribute('aria-pressed', String(selected === n.stage));
    const name = el.querySelector('.gname'); if (name) name.textContent = n.label;
    const meta = el.querySelector('.gmeta'); if (meta) meta.textContent = n.meta;
    const dot = el.querySelector('.gdot'); if (dot) dot.className = 'gdot ' + n.status;
    const badge = el.querySelector('.badge');
    if (badge) { badge.className = 'badge ' + (n.status === 'ready' ? '' : n.status); badge.textContent = STATUS[n.status] || ''; }
    const box = el.querySelector('[data-wait]');
    if (box) box.checked = p.approvals?.[n.stage] === 'wait';
    // chapter rows: pips only (their ids/titles cannot change without a shape change)
    if (n.rows) {
      for (const r of n.rows) {
        const row = el.querySelector(`.gchrow[data-ch="${r.id}"]`);
        if (!row) continue;
        [...row.querySelectorAll('.pip')].forEach((pip, i) => { pip.className = 'pip ' + (r.stages[i] || 'idle'); });
      }
    }
  }
  for (const e of next.edges) {
    const el = host.querySelector(`[data-edge="${e.a.key}>${e.b.key}"]`);
    if (el) el.setAttribute('class', 'gedge ' + edgeClass(e));
  }
}

function edgePath(e) {
  const a = e.a, b = e.b;
  if (e.kind === 'down') {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h;
    const x2 = b.x + b.w / 2, y2 = b.y;
    return `M${x1} ${y1} C ${x1} ${y1 + 34}, ${x2} ${y2 - 34}, ${x2} ${y2}`;
  }
  const x1 = a.x, y1 = a.y + a.h / 2;          // left side of the right-hand node
  const x2 = b.x + b.w, y2 = b.y + b.h / 2;    // right side of the left-hand node
  const dx = Math.max(24, (x1 - x2) * 0.45);
  return `M${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
}

/** manual (the editor hangs off the flow) · done · flow (the target is running) · error · quiet */
function edgeClass(e) {
  if (e.kind === 'down') return 'manual'; // the only node under the render node is the manual editor
  const a = e.a.status, b = e.b.status;
  if (b === 'running') return 'flow';
  if (b === 'error') return 'error';
  if (a === 'done' && b === 'done') return 'done';
  return '';
}
