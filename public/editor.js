// Video editor: multi-track timeline (scenes · media · text · captions · voice · music), inspector, undo/redo,
// autosave to PUT /api/projects/:id/edit, and a live preview (render.html in an iframe — the same renderer that
// makes the MP4, so what you see is what gets exported).
import { $, $$, esc, api, act, toast, fmtTime } from './ui.js';
import { pickAsset } from './views/library.js';

const TEMPLATES = ['zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter', 'body', 'photo', 'type'];
const TPL_AR = { zoom: 'تكبير', flow: 'تسلسل', cycle: 'دورة', timeline: 'خط زمني', chart: 'رسم بياني', layers: 'طبقات', cards: 'كروت', meter: 'عدّاد', body: 'جسم الإنسان', photo: 'صورة/فيديو', type: 'نص متحرك' };
const TYPES = ['intro', 'question', 'concept', 'process', 'compare', 'stat', 'recap'];
const TYPE_AR = { intro: 'بداية', question: 'سؤال', concept: 'فكرة', process: 'خطوات', compare: 'مقارنة', stat: 'أرقام', recap: 'خلاصة' };
const STYLE_AR = { boxed: 'مربع', karaoke: 'كاريوكي', minimal: 'بسيط', outline: 'إطار' };
const VISUAL_KEYS = ['type', 'template', 'title', 'items', 'organ', 'value', 'max', 'unit', 'query', 'image', 'bg', 'imageOffset'];
const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = () => Math.random().toString(36).slice(2, 10);

export function mountEditor(el, project, { fonts = [] } = {}) {
  const id = project.id;
  let S = { storyboard: clone(project.storyboard), words: project.words.map((w) => ({ i: w.i, text: w.text, start: w.start, end: w.end, line: w.line })), edit: clone(project.edit || {}) };
  const full = Math.max(project.voice?.duration || 0, project.words[project.words.length - 1].end + 0.3) + 0.6;
  const hist = { undo: [], redo: [] };
  let sel = null; // {kind:'scene'|'overlay'|'word'|'music'|'voice', i|id}
  let pps = 70, t = 0, playing = false, dragging = null, saveTimer = null, saving = Promise.resolve(), dirty = false;
  const E = () => S.edit;
  E().export = E().export || {};
  E().audio = E().audio || {};
  E().overlays = E().overlays || [];
  E().typography = E().typography || {};
  E().trim = E().trim || { start: 0, end: null };
  E().cuts = E().cuts || [];
  E().sequence = E().sequence || null;
  let mark = { in: null, out: null }; // I / O marks for cutting a range out of the middle

  el.innerHTML = `
  <div class="editor">
    <div class="etool">
      <button class="small" id="edUndo" title="تراجع (Ctrl+Z)">↶</button><button class="small" id="edRedo" title="إعادة (Ctrl+Y)">↷</button>
      <button class="small primary" id="edPlay" title="تشغيل (مسافة)">▶</button><span class="mono" id="edTime">0:00.0</span>
      <label class="inl">زووم <input type="range" id="edZoom" min="20" max="240" value="70"></label>
      <span class="sep"></span>
      <button class="small" id="markIn" title="بداية المقطع عند المؤشر (I)">[ بداية</button><button class="small" id="markOut" title="نهاية المقطع عند المؤشر (O)">نهاية ]</button>
      <button class="small danger" id="cutRange" title="احذف المقطع المحدد من الفيديو والصوت والكابشن (X)" disabled>✂ احذف المقطع</button>
      <span class="hint" id="edDur"></span>
      <span class="sep"></span>
      <select id="edPlatform" title="المنصة: المقاس والفريمات ومنطقة الأمان والمدة"><option value="">منصة: بدون</option></select>
      <label class="inl small" title="ارسم المناطق اللي أزرار المنصة بتغطيها (في المعاينة بس)"><input type="checkbox" id="edGuides"> منطقة الأمان</label>
      <select id="edAspect" title="مقاس الفيديو"><option value="9:16">9:16 طولي</option><option value="4:5">4:5 منشور</option><option value="1:1">1:1 مربع</option><option value="16:9">16:9 عرضي</option></select>
      <select id="edRes" title="الدقة"><option value="1080">1080p</option><option value="720">720p</option></select>
      <select id="edFps" title="فريم/ث"><option>24</option><option>25</option><option selected>30</option><option>60</option></select>
      <select id="edQ" title="الجودة"><option value="draft">مسودة (سريع)</option><option value="standard">عادي</option><option value="high">عالي</option></select>
      <select id="edTr" title="الانتقالات"><option value="push">انتقال: دفع</option><option value="fade">تلاشي</option><option value="zoom">زووم</option><option value="slide">انزلاق</option><option value="none">قطع مباشر</option></select>
      <span class="sep"></span>
      <span class="hint" id="edStatus">✓ محفوظ</span>
      <a class="btnlink small" href="/api/projects/${esc(id)}/subtitles.srt" download>SRT</a><a class="btnlink small" href="/api/projects/${esc(id)}/subtitles.vtt" download>VTT</a>
      <button class="primary" id="edRender">⬢ رندر الفيديو</button>
    </div>
    <div class="emain">
      <div class="epreview"><iframe id="edFrame" src="/render.html?project=${encodeURIComponent(id)}&play=1&embed=1&v=${Date.now()}" title="معاينة"></iframe></div>
      <div class="einspect" id="edInsp"></div>
    </div>
    <div class="etimeline" dir="ltr">
      <div class="tl-labels">
        <div class="tl-lab ruler-l">الوقت</div>
        <div class="tl-lab">الترتيب <span><button class="small" id="addPause" title="سكوت ثانية عند المؤشر">＋⏸</button><button class="small" id="seqReset" title="رجّع الترتيب الأصلي" hidden>↺</button></span></div>
        <div class="tl-lab">المشاهد</div>
        <div class="tl-lab">صور/فيديو <button class="small" id="addMedia" title="إضافة صورة أو فيديو عند المؤشر">＋</button></div>
        <div class="tl-lab">نصوص <button class="small" id="addText" title="إضافة نص عند المؤشر">＋</button></div>
        <div class="tl-lab">الكابشن</div>
        <div class="tl-lab">الصوت</div>
        <div class="tl-lab">موسيقى <button class="small" id="addMusic" title="موسيقى خلفية">＋</button></div>
      </div>
      <div class="tl-scroll" id="tlScroll"><div class="tl-inner" id="tlInner"></div></div>
    </div>
  </div>`;
  const frame = $('#edFrame', el);
  const post = (m) => frame.contentWindow?.postMessage(m, location.origin);

  // ---------- derived ----------
  const sceneTimes = () => S.storyboard.scenes.map((sc, i, a) => ({ start: i === 0 ? 0 : S.words[sc.at].start, end: i + 1 < a.length ? S.words[a[i + 1].at].start : full }));
  const X = (sec) => sec * pps;
  const T = (px) => Math.max(0, Math.min(full, px / pps));
  const wordAt = (sec) => { let best = 0; S.words.forEach((w, i) => { if (Math.abs(w.start - sec) < Math.abs(S.words[best].start - sec)) best = i; }); return best; };

  // ---------- history + save ----------
  const snap = () => JSON.stringify(S);
  function change(fn, { record = true } = {}) {
    if (record) { hist.undo.push(snap()); if (hist.undo.length > 150) hist.undo.shift(); hist.redo = []; }
    fn();
    renderAll(); scheduleSave();
  }
  function undo() { if (!hist.undo.length) return; hist.redo.push(snap()); S = JSON.parse(hist.undo.pop()); fixSel(); renderAll(); scheduleSave(); }
  function redo() { if (!hist.redo.length) return; hist.undo.push(snap()); S = JSON.parse(hist.redo.pop()); fixSel(); renderAll(); scheduleSave(); }
  function fixSel() {
    if (sel?.kind === 'scene' && !S.storyboard.scenes[sel.i]) sel = null;
    if (sel?.kind === 'overlay' && !E().overlays.some((o) => o.id === sel.id)) sel = null;
    if (sel?.kind === 'music' && !E().audio.music) sel = null;
    if (sel?.kind === 'cut' && !E().cuts[sel.i]) sel = null;
    if (sel?.kind === 'seg' && !derivedSegs()[sel.i]) sel = null;
    if (sel?.kind === 'overlays') { sel.ids = sel.ids.filter((x) => E().overlays.some((o) => o.id === x)); if (sel.ids.length < 2) sel = sel.ids.length ? { kind: 'overlay', id: sel.ids[0] } : null; }
  }
  function status(txt, cls = '') { const s = $('#edStatus', el); s.textContent = txt; s.className = 'hint ' + cls; }
  function scheduleSave() { dirty = true; status('… تعديلات مش محفوظة'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
  function save() {
    if (dragging) { scheduleSave(); return saving; }
    saving = saving.then(async () => {
      if (!dirty) return;
      dirty = false; status('بيحفظ…');
      const body = { storyboard: S.storyboard, words: S.words.map((w) => ({ start: w.start, end: w.end, text: w.text })), edit: S.edit };
      try {
        const r = await api(`/api/projects/${id}/edit`, { method: 'PUT', body: JSON.stringify(body) });
        // the server validates and may repair (e.g. merge a too-short scene): adopt its version
        const serverSb = r.project.storyboard;
        if (JSON.stringify(serverSb) !== JSON.stringify(S.storyboard) && !dirty) { S.storyboard = serverSb; fixSel(); renderAll(); }
        if (r.fixes?.length) toast('تصليح تلقائي: ' + r.fixes.slice(0, 2).join(' · '));
        status('✓ محفوظ', 'ok');
        post({ type: 'reel:reload' });
      } catch (e) { status('✖ ' + e.message, 'bad'); toast(e.message, 'bad'); }
    });
    return saving;
  }

  // ---------- timeline ----------
  let peaks = null;
  async function loadWave() {
    try {
      const buf = await (await fetch(`/api/projects/${encodeURIComponent(id)}/files/voice.mp3`)).arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ac.decodeAudioData(buf);
      const ch = audio.getChannelData(0), per = Math.floor(audio.sampleRate / 100);
      peaks = new Float32Array(Math.ceil(ch.length / per));
      for (let i = 0; i < peaks.length; i++) { let m = 0; for (let k = i * per; k < Math.min(ch.length, (i + 1) * per); k += 4) m = Math.max(m, Math.abs(ch[k])); peaks[i] = m; }
      ac.close?.();
      drawWave();
    } catch { /* no waveform (codec) — the track still works */ }
  }
  function drawWave() {
    const c = $('#tlWave', el); if (!c || !peaks) return;
    const w = Math.min(30000, Math.ceil(X(full))), h = 44; c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = 'rgba(39,184,199,.55)';
    const vv = E().audio.voiceVolume ?? 1;
    for (let x = 0; x < w; x++) { const p = peaks[Math.floor((x / pps) * 100)] || 0; const ph = Math.min(h, p * h * vv * 1.6); g.fillRect(x, (h - ph) / 2, 1, Math.max(1, ph)); }
  }
  function renderTimeline() {
    const inner = $('#tlInner', el);
    const W = Math.ceil(X(full)) + 60;
    const st = sceneTimes();
    const tr = E().trim || {};
    const tickEvery = pps >= 50 ? 1 : pps >= 25 ? 2 : 5;
    let h = `<div class="tl-row ruler" data-seek>`;
    for (let s = 0; s <= full; s += tickEvery) h += `<span class="tick" style="left:${X(s)}px">${fmtTime(s).replace(/\.0$/, '')}</span>`;
    if (tr.start > 0) h += `<div class="trimshade" style="left:0;width:${X(tr.start)}px"></div>`;
    if (tr.end) h += `<div class="trimshade" style="left:${X(tr.end)}px;width:${X(full - tr.end)}px"></div>`;
    if (!E().sequence?.length) h += `<div class="trimh" data-drag="trimStart" style="left:${X(tr.start || 0)}px" title="بداية القص"></div><div class="trimh end" data-drag="trimEnd" style="left:${X(tr.end || full)}px" title="نهاية القص"></div>`;
    E().cuts.forEach((c, k) => { h += `<div class="cutblk ${sel?.kind === 'cut' && sel.i === k ? 'sel' : ''}" data-cut="${k}" style="left:${X(c.start)}px;width:${Math.max(3, X(c.end - c.start))}px" title="مقطع محذوف ${c.start.toFixed(2)}–${c.end.toFixed(2)} — دوس عشان ترجّعه"></div>`; });
    if (mark.in != null) h += `<div class="markh in" style="left:${X(mark.in)}px" title="بداية المقطع"></div>`;
    if (mark.out != null) h += `<div class="markh out" style="left:${X(mark.out)}px" title="نهاية المقطع"></div>`;
    if (mark.in != null && mark.out != null && mark.out > mark.in) h += `<div class="markrange" style="left:${X(mark.in)}px;width:${X(mark.out - mark.in)}px"></div>`;
    h += `</div>`;
    // output order: what the export plays, left to right (drag to reorder; ⏸ = pause)
    { let acc = 0; const custom = !!E().sequence?.length;
      h += `<div class="tl-row seqrow ${custom ? 'custom' : ''}" data-seekout>${derivedSegs().map((sg, i) => { const l = segLen(sg), x0 = acc; acc += l;
        return `<div class="blk seg ${isHold(sg) ? 'hold' : ''} ${sel?.kind === 'seg' && sel.i === i ? 'sel' : ''}" draggable="true" data-seg="${i}" style="left:${X(x0)}px;width:${Math.max(6, X(l) - 2)}px" title="${isHold(sg) ? `سكوت ${l.toFixed(1)} ث` : `${sg[0].toFixed(2)}–${sg[1].toFixed(2)} ث من الصوت`}"><span>${isHold(sg) ? `⏸ ${l.toFixed(1)}` : `${i + 1}`}</span></div>`; }).join('')}<div class="outhead" id="tlOutHead"></div></div>`; }
    h += `<div class="tl-row" data-seek>${S.storyboard.scenes.map((sc, i) => `<div class="blk scene ${sel?.kind === 'scene' && sel.i === i ? 'sel' : ''}" draggable="true" data-scene="${i}" style="left:${X(st[i].start)}px;width:${Math.max(4, X(st[i].end - st[i].start) - 2)}px">
      ${i > 0 ? `<i class="h l" data-drag="sceneStart" data-i="${i}"></i>` : ''}<span>${i + 1}. ${esc(TPL_AR[sc.template] || sc.template)}${sc.image ? ' 🖼' : ''} · ${esc(sc.title)}</span></div>`).join('')}</div>`;
    const ovRow = (kinds) => E().overlays.filter((o) => kinds.includes(o.kind)).map((o) => `<div class="blk ov ${o.kind} ${isSelOv(o.id) ? 'sel' : ''}" data-ov="${esc(o.id)}" data-drag="ovMove" style="left:${X(o.start)}px;width:${Math.max(6, X(o.end - o.start))}px">
      <i class="h l" data-drag="ovStart"></i><span>${o.kind === 'text' ? esc(o.text || 'نص') : (o.kind === 'video' ? '🎞 ' : '🖼 ') + esc(o.name || '')}</span><i class="h r" data-drag="ovEnd"></i></div>`).join('');
    h += `<div class="tl-row" data-seek>${ovRow(['image', 'video'])}</div>`;
    h += `<div class="tl-row" data-seek>${ovRow(['text'])}</div>`;
    h += `<div class="tl-row words" data-seek>${S.words.map((w, i) => `<div class="blk word ${sel?.kind === 'word' && sel.i === i ? 'sel' : ''}" data-word="${i}" data-drag="wordMove" dir="auto" style="left:${X(w.start)}px;width:${Math.max(3, X(w.end - w.start) - 1)}px" title="${esc(w.text)} ${w.start.toFixed(2)}s">${esc(w.text)}</div>`).join('')}</div>`;
    h += `<div class="tl-row voice ${sel?.kind === 'voice' ? 'sel' : ''}" data-voice><canvas id="tlWave"></canvas></div>`;
    const mu = E().audio.music;
    h += `<div class="tl-row" data-seek>${mu ? `<div class="blk music ${sel?.kind === 'music' ? 'sel' : ''}" data-music style="left:${X(tr.start || 0)}px;width:${X((tr.end || full) - (tr.start || 0))}px"><span>♪ ${esc(mu.name || 'موسيقى')} · ${Math.round((mu.volume ?? 0.25) * 100)}%${mu.duck !== false ? ' · تخفيض تحت الصوت' : ''}</span></div>` : ''}</div>`;
    E().cuts.forEach((c) => { h += `<div class="cutshade" style="left:${X(c.start)}px;width:${X(c.end - c.start)}px"></div>`; });
    h += `<div class="playhead" id="tlHead" style="left:${X(t)}px"></div>`;
    inner.style.width = W + 'px';
    inner.innerHTML = h;
    drawWave();
  }

  // ---------- output order (segments) ----------
  const isHold = (sg) => sg.length === 3;
  const segLen = (sg) => (isHold(sg) ? sg[2] : sg[1] - sg[0]);
  function derivedSegs() {
    if (E().sequence?.length) return E().sequence.map((x) => (x.hold !== undefined ? [x.at, x.at, x.hold] : [x.start, x.end]));
    const a = E().trim?.start || 0, b = E().trim?.end || full, segs = [];
    let cur = a;
    for (const c of [...E().cuts].sort((x, y) => x.start - y.start)) { if (c.end <= cur || c.start >= b) continue; if (c.start > cur) segs.push([cur, Math.min(c.start, b)]); cur = Math.max(cur, c.end); }
    if (cur < b) segs.push([cur, b]);
    return segs;
  }
  const toSeq = (segs) => segs.map((sg) => (isHold(sg) ? { hold: sg[2], at: sg[0] } : { start: +sg[0].toFixed(3), end: +sg[1].toFixed(3) }));
  function outOf(tSrc) { let acc = 0; for (const sg of derivedSegs()) { if (!isHold(sg) && tSrc >= sg[0] && tSrc <= sg[1]) return acc + tSrc - sg[0]; acc += segLen(sg); } return null; }
  function srcOf(tau) { let acc = 0; for (const sg of derivedSegs()) { const l = segLen(sg); if (tau < acc + l) return isHold(sg) ? sg[0] : sg[0] + tau - acc; acc += l; } return full; }
  /** Insert a pause at the playhead: the part that contains it is split in two around the pause. */
  function addPause() {
    const segs = derivedSegs();
    const k = segs.findIndex((sg) => !isHold(sg) && t >= sg[0] && t <= sg[1]);
    if (k < 0) { toast('حط المؤشر على جزء من الصوت الأول', 'bad'); return; }
    const [a, b] = segs[k];
    const parts = [t - a >= 0.1 ? [a, t] : null, [t, t, 1], b - t >= 0.1 ? [t, b] : null].filter(Boolean);
    change(() => { segs.splice(k, 1, ...parts); E().sequence = toSeq(segs); sel = { kind: 'seg', i: k + (parts[0] && !isHold(parts[0]) ? 1 : 0) }; });
  }

  const isSelOv = (oid) => (sel?.kind === 'overlay' && sel.id === oid) || (sel?.kind === 'overlays' && sel.ids.includes(oid));
  const selOvIds = () => (sel?.kind === 'overlay' ? [sel.id] : sel?.kind === 'overlays' ? sel.ids : []);
  const outLen = () => derivedSegs().reduce((a, sg) => a + segLen(sg), 0);

  // ---------- inspector ----------
  const opt = (list, cur, labels = {}) => list.map((v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(labels[v] || v)}</option>`).join('');
  function renderInspector() {
    const box = $('#edInsp', el);
    const ty = E().typography;
    if (!sel) {
      const tr = E().trim;
      box.innerHTML = `<h4>المشروع</h4>
        <div class="two"><label>بداية القص (ث) <input type="number" step="0.1" min="0" data-f="trim.start" value="${tr.start || 0}"></label><label>نهاية القص (ث) <input type="number" step="0.1" min="0" data-f="trim.end" value="${tr.end || ''}" placeholder="${full.toFixed(1)}"></label></div>
        <h4>الطباعة</h4>
        <div class="two"><label>خط العناوين <select data-f="typography.font"><option value="">الافتراضي</option>${opt(fonts.map((f) => f.id), ty.font, Object.fromEntries(fonts.map((f) => [f.id, f.name])))}</select></label>
        <label>خط الكابشن <select data-f="typography.captionFont"><option value="">الافتراضي</option>${opt(fonts.map((f) => f.id), ty.captionFont, Object.fromEntries(fonts.map((f) => [f.id, f.name])))}</select></label></div>
        <div class="two"><label>نمط الكابشن <select data-f="typography.captionStyle"><option value="">الافتراضي</option>${opt(Object.keys(STYLE_AR), ty.captionStyle, STYLE_AR)}</select></label>
        <label>حجم الكابشن <input type="number" min="28" max="90" step="2" data-f="typography.captionSize" value="${ty.captionSize || ''}" placeholder="52"></label></div>
        <div class="two"><label>الأرقام <select data-f="typography.digits"><option value="">الافتراضي</option>${opt(['latin', 'arabic'], ty.digits, { latin: '123', arabic: '١٢٣' })}</select></label>
        <label>اتجاه الكابشن <select data-f="typography.direction"><option value="">الافتراضي</option>${opt(['auto', 'rtl', 'ltr'], ty.direction, { auto: 'تلقائي', rtl: 'يمين←شمال', ltr: 'شمال←يمين' })}</select></label></div>
        <label>محاذاة الكابشن <select data-f="typography.align"><option value="">الافتراضي</option>${opt(['center', 'right', 'left', 'justify'], ty.align, { center: 'وسط', right: 'يمين', left: 'شمال', justify: 'ضبط بالكشيدة' })}</select></label>
        <label class="row"><input type="checkbox" data-f="typography.captions" ${ty.captions === false ? '' : 'checked'}> كابشن في الفيديو</label>
        <h4>الصوت</h4>
        <label>صوت الراوي <span class="hint">${Math.round((E().audio.voiceVolume ?? 1) * 100)}%</span><input type="range" min="0" max="2" step="0.05" data-f="audio.voiceVolume" value="${E().audio.voiceVolume ?? 1}"></label>
        <label>المؤثرات <span class="hint">${Math.round((E().audio.sfxVolume ?? 0.6) * 100)}%</span><input type="range" min="0" max="1" step="0.05" data-f="audio.sfxVolume" value="${E().audio.sfxVolume ?? 0.6}"></label>
        <p class="hint">اختار أي عنصر في الخط الزمني عشان تعدّله. اسحب حواف المشاهد والعناصر، واسحب مشهد على مشهد عشان تبدّل محتواهم.</p>`;
    } else if (sel.kind === 'scene') {
      const sc = S.storyboard.scenes[sel.i], tm = sceneTimes()[sel.i];
      box.innerHTML = `<h4>مشهد ${sel.i + 1} <span class="hint">${tm.start.toFixed(2)}–${tm.end.toFixed(2)} ث</span></h4>
        <div class="two"><label>القالب <select data-s="template">${opt(TEMPLATES, sc.template, TPL_AR)}</select></label><label>النوع <select data-s="type">${opt(TYPES, sc.type, TYPE_AR)}</select></label></div>
        <label>العنوان <input data-s="title" value="${esc(sc.title)}" maxlength="40"></label>
        <h5>العناصر</h5>${sc.items.map((it, k) => `<div class="two"><input data-item="${k}" data-k="label" value="${esc(it.label)}" placeholder="نص"><input data-item="${k}" data-k="icon" dir="ltr" value="${esc(it.icon)}" placeholder="icon (english)"></div>`).join('')}
        <div class="tools"><button class="small" id="itAdd">＋ عنصر</button>${sc.items.length ? '<button class="small" id="itDel">− آخر عنصر</button>' : ''}</div>
        <h5>صورة / فيديو</h5>
        ${sc.image ? `<div class="thumbrow"><img src="/api/assets/${esc(sc.image)}/thumb" alt="" onerror="this.style.display='none'"><button class="small danger" id="imgDel">شيل</button></div>` : '<p class="hint">مفيش.</p>'}
        <label>كلمات البحث (إنجليزي) <input data-s="query" dir="ltr" value="${esc(sc.query || '')}"></label>
        <div class="tools"><button class="small" id="imgPick">من المكتبة</button><button class="small" id="imgStock">✦ اقترح من مكتبات الصور</button></div>
        <label>الخلفية <select data-s="bg">${opt(['card', 'full'], sc.bg || 'card', { card: 'داخل الكارت', full: 'الشاشة كلها (ورا الكارت)' })}</select></label>
        <div class="tools"><button class="small" id="scSplit">✂ قسّم عند المؤشر</button>${sel.i > 0 ? '<button class="small danger" id="scDel">دمج مع اللي قبله</button>' : ''}</div>`;
    } else if (sel.kind === 'overlay') {
      const o = E().overlays.find((x) => x.id === sel.id);
      box.innerHTML = `<h4>${o.kind === 'text' ? 'نص' : o.kind === 'video' ? 'فيديو' : 'صورة'} فوق الفيديو</h4>
        ${o.kind === 'text' ? `<label>النص <textarea data-o="text" rows="2" dir="auto">${esc(o.text || '')}</textarea></label>
          <div class="two"><label>الحجم <input type="number" min="18" max="120" data-o="size" value="${o.size || 44}"></label><label>اللون <input type="color" data-o="color" value="${esc(o.color || '#F4F3EE')}"></label></div>
          <label class="row"><input type="checkbox" data-o="box" ${o.box === false ? '' : 'checked'}> خلفية للنص</label>` : `<div class="thumbrow"><img src="/api/assets/${esc(o.asset)}/thumb" alt=""><button class="small" id="ovSwap">تغيير</button></div>${o.kind === 'video' ? `<label>يبدأ من ثانية في الكليب <input type="number" step="0.1" min="0" data-o="offset" value="${o.offset || 0}"></label>
          <label>صوت الكليب <span class="hint">${Math.round((o.volume || 0) * 100)}%${o.volume ? '' : ' (صامت)'}</span><input type="range" min="0" max="2" step="0.05" data-o="volume" value="${o.volume || 0}"></label>` : ''}`}
        <div class="two"><label>البداية <input type="number" step="0.05" data-o="start" value="${o.start}"></label><label>النهاية <input type="number" step="0.05" data-o="end" value="${o.end}"></label></div>
        <div class="two"><label>المكان <select data-o="pos">${opt(['top', 'center', 'bottom', 'full'], o.pos, { top: 'فوق', center: 'وسط', bottom: 'تحت', full: 'ملء الشاشة' })}</select></label>
        <label>الحركة <select data-o="anim">${opt(['fade', 'pop', 'slide', 'none'], o.anim, { fade: 'تلاشي', pop: 'نطّة', slide: 'انزلاق', none: 'بدون' })}</select></label></div>
        <div class="two"><label>الحجم النسبي <input type="range" min="0.15" max="1" step="0.05" data-o="scale" value="${o.scale ?? 0.6}"></label><label>الشفافية <input type="range" min="0.1" max="1" step="0.05" data-o="opacity" value="${o.opacity ?? 1}"></label></div>
        <div class="tools"><button class="small danger" id="ovDel">حذف (Delete)</button></div>`;
    } else if (sel.kind === 'cut') {
      const c = E().cuts[sel.i];
      box.innerHTML = `<h4>مقطع محذوف</h4><p class="hint">الجزء ده مش هيظهر في الفيديو ولا الصوت ولا الترجمة، والباقي بيتلم على بعضه.</p>
        <div class="two"><label>من <input type="number" step="0.05" data-c="start" value="${c.start}"></label><label>لحد <input type="number" step="0.05" data-c="end" value="${c.end}"></label></div>
        <div class="tools"><button class="small primary" id="cutUndo">↺ رجّع المقطع</button></div>`;
    } else if (sel.kind === 'seg') {
      const sg = derivedSegs()[sel.i];
      box.innerHTML = isHold(sg) ? `<h4>سكوت</h4><p class="hint">الصورة بتقف على اللحظة دي، وصوت الراوي ساكت. الموسيقى والمؤثرات بيكمّلوا.</p>
          <label>المدة (ث) <input type="number" min="0.1" max="10" step="0.1" data-sg="hold" value="${sg[2]}"></label>
          <div class="tools"><button class="small danger" id="sgDel">حذف السكوت</button></div>`
        : `<h4>جزء ${sel.i + 1} من الصوت</h4><p class="hint">اسحبه في صف «الترتيب» عشان يتعرض قبل أو بعد جزء تاني.</p>
          <div class="two"><label>من <input type="number" step="0.05" data-sg="start" value="${sg[0]}"></label><label>لحد <input type="number" step="0.05" data-sg="end" value="${sg[1]}"></label></div>
          <div class="tools"><button class="small danger" id="sgDel">شيل الجزء ده</button></div>`;
      box.innerHTML += E().sequence?.length ? `<div class="tools"><button class="small" id="sgReset">↺ الترتيب الأصلي</button></div>` : '';
    } else if (sel.kind === 'overlays') {
      box.innerHTML = `<h4>${sel.ids.length} عناصر محددة</h4><p class="hint">اسحب أي واحد منهم وكلهم هيتحركوا مع بعض. Shift + ضغطة عشان تضيف أو تشيل من التحديد.</p>
        <div class="tools"><button class="small" id="ovAlign">ابدأهم كلهم عند المؤشر</button><button class="small danger" id="ovDelAll">حذف الكل (Delete)</button></div>`;
    } else if (sel.kind === 'word') {
      const w = S.words[sel.i];
      box.innerHTML = `<h4>كلمة كابشن #${sel.i + 1}</h4><label>النص <input data-w="text" dir="auto" value="${esc(w.text)}"></label>
        <div class="two"><label>البداية <input type="number" step="0.01" data-w="start" value="${w.start}"></label><label>النهاية <input type="number" step="0.01" data-w="end" value="${w.end}"></label></div>
        <p class="hint">الكلمة بتنوّر في الفيديو عند «البداية». اسحبها في الخط الزمني لو الصوت سابقها أو متأخر عنها.</p>`;
    } else if (sel.kind === 'music') {
      const mu = E().audio.music;
      box.innerHTML = `<h4>موسيقى الخلفية</h4><p>${esc(mu.name || mu.asset)}</p>
        <label>المستوى <span class="hint">${Math.round(mu.volume * 100)}%</span><input type="range" min="0" max="1" step="0.05" data-m="volume" value="${mu.volume}"></label>
        <label class="row"><input type="checkbox" data-m="duck" ${mu.duck !== false ? 'checked' : ''}> وطّي الموسيقى تلقائيًا تحت صوت الراوي</label>
        <div class="two"><label>ظهور تدريجي (ث) <input type="number" min="0" max="5" step="0.5" data-m="fadeIn" value="${mu.fadeIn ?? 1}"></label><label>اختفاء تدريجي (ث) <input type="number" min="0" max="5" step="0.5" data-m="fadeOut" value="${mu.fadeOut ?? 1.5}"></label></div>
        <div class="tools"><button class="small" id="muSwap">تغيير</button><button class="small danger" id="muDel">شيل الموسيقى</button></div>
        <p class="hint">اتأكد إن رخصة الموسيقى بتسمح بالنشر — بتظهر في تفاصيل الملف في المكتبة.</p>`;
    } else if (sel.kind === 'voice') {
      box.innerHTML = `<h4>صوت الراوي</h4><label>المستوى <input type="range" min="0" max="2" step="0.05" data-f="audio.voiceVolume" value="${E().audio.voiceVolume ?? 1}"></label><p class="hint">التسجيل نفسه بيتغيّر من مرحلة الصوت.</p>`;
    }
    bindInspector(box);
  }
  function setPath(obj, pathStr, v) { const ks = pathStr.split('.'); let o = obj; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; if (v === '' || v === undefined) delete o[ks.at(-1)]; else o[ks.at(-1)] = v; }
  const val = (i) => (i.type === 'checkbox' ? i.checked : i.type === 'number' || i.type === 'range' ? (i.value === '' ? '' : Number(i.value)) : i.value);
  function bindInspector(box) {
    $$('[data-f]', box).forEach((i) => i.addEventListener('change', () => change(() => {
      let v = val(i); if (i.dataset.f === 'trim.end' && !v) v = null;
      if (i.dataset.f.startsWith('trim')) { E().trim = { ...E().trim }; E().trim[i.dataset.f.split('.')[1]] = v === '' ? (i.dataset.f === 'trim.start' ? 0 : null) : v; }
      else setPath(E(), i.dataset.f, v);
    })));
    if (sel?.kind === 'scene') {
      const sc = S.storyboard.scenes[sel.i];
      $$('[data-s]', box).forEach((i) => i.addEventListener('change', () => change(() => { sc[i.dataset.s] = val(i); })));
      $$('[data-item]', box).forEach((i) => i.addEventListener('change', () => change(() => { sc.items[i.dataset.item][i.dataset.k] = i.value; })));
      $('#itAdd', box)?.addEventListener('click', () => change(() => sc.items.push({ label: 'عنصر', icon: 'cell', value: null, at: null })));
      $('#itDel', box)?.addEventListener('click', () => change(() => sc.items.pop()));
      $('#imgDel', box)?.addEventListener('click', () => change(() => { sc.image = null; }));
      const setImg = (a) => a && change(() => { sc.image = a.id; if (!['photo'].includes(sc.template) && sc.bg !== 'full') sc.template = 'photo'; });
      $('#imgPick', box).addEventListener('click', async () => setImg(await pickAsset({ kinds: ['image', 'video'] })));
      $('#imgStock', box).addEventListener('click', async () => setImg(await pickAsset({ kinds: ['image', 'video'], query: sc.query || sc.title, stock: true })));
      $('#scSplit', box).addEventListener('click', () => splitScene(sel.i));
      $('#scDel', box)?.addEventListener('click', () => change(() => { S.storyboard.scenes.splice(sel.i, 1); sel = null; }));
    }
    if (sel?.kind === 'overlay') {
      const o = E().overlays.find((x) => x.id === sel.id);
      $$('[data-o]', box).forEach((i) => i.addEventListener('change', () => change(() => { o[i.dataset.o] = val(i); if (o.end <= o.start) o.end = o.start + 0.5; })));
      $('#ovDel', box).addEventListener('click', () => removeSelected());
      $('#ovSwap', box)?.addEventListener('click', async () => { const a = await pickAsset({ kinds: [o.kind] }); if (a) change(() => { o.asset = a.id; o.name = a.name; }); });
    }
    if (sel?.kind === 'cut') {
      const c = E().cuts[sel.i];
      $$('[data-c]', box).forEach((i) => i.addEventListener('change', () => change(() => { c[i.dataset.c] = Number(i.value); if (c.end < c.start + 0.1) c.end = c.start + 0.1; normCuts(); })));
      $('#cutUndo', box).addEventListener('click', () => change(() => { E().cuts.splice(sel.i, 1); sel = null; }));
    }
    if (sel?.kind === 'seg') {
      $$('[data-sg]', box).forEach((i) => i.addEventListener('change', () => change(() => {
        const segs = derivedSegs(), sg = segs[sel.i], v = Number(i.value);
        if (i.dataset.sg === 'hold') sg[2] = Math.max(0.1, Math.min(10, v)); else if (i.dataset.sg === 'start') sg[0] = Math.max(0, Math.min(sg[1] - 0.1, v)); else sg[1] = Math.min(full, Math.max(sg[0] + 0.1, v));
        E().sequence = toSeq(segs);
      })));
      $('#sgDel', box).addEventListener('click', () => {
        const segs = derivedSegs();
        if (segs.filter((x) => !isHold(x)).length === 1 && !isHold(segs[sel.i])) { toast('لازم يفضل جزء واحد على الأقل من الصوت', 'bad'); return; }
        change(() => { segs.splice(sel.i, 1); E().sequence = toSeq(segs); sel = null; });
      });
      $('#sgReset', box)?.addEventListener('click', () => change(() => { E().sequence = null; sel = null; }));
    }
    if (sel?.kind === 'overlays') {
      $('#ovDelAll', box).addEventListener('click', removeSelected);
      $('#ovAlign', box).addEventListener('click', () => change(() => { for (const o of E().overlays) if (sel.ids.includes(o.id)) { const len = o.end - o.start; o.start = +t.toFixed(2); o.end = +Math.min(full, t + len).toFixed(2); } }));
    }
    if (sel?.kind === 'word') {
      const w = S.words[sel.i];
      $$('[data-w]', box).forEach((i) => i.addEventListener('change', () => change(() => { w[i.dataset.w] = val(i); if (w.end < w.start + 0.05) w.end = w.start + 0.05; })));
    }
    if (sel?.kind === 'music') {
      const mu = E().audio.music;
      $$('[data-m]', box).forEach((i) => i.addEventListener('change', () => change(() => { mu[i.dataset.m] = val(i); })));
      $('#muDel', box).addEventListener('click', () => change(() => { E().audio.music = null; sel = null; }));
      $('#muSwap', box).addEventListener('click', addMusic);
    }
  }

  // ---------- operations ----------
  function splitScene(i) {
    const w = wordAt(t);
    const st = S.storyboard.scenes;
    if (w <= st[i].at || (st[i + 1] && w >= st[i + 1].at)) { toast('حط المؤشر جوه المشهد (مش على بدايته) وجرّب تاني', 'bad'); return; }
    change(() => { st.splice(i + 1, 0, { ...clone(st[i]), at: w, type: 'concept', title: '', items: st[i].items.length ? [clone(st[i].items.at(-1))] : [] }); sel = { kind: 'scene', i: i + 1 }; });
  }
  function normCuts() {
    const list = E().cuts.map((c) => [Math.max(0, c.start), Math.min(full, c.end)]).filter(([a, b]) => b - a >= 0.1).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of list) { const l = out[out.length - 1]; if (l && a <= l[1] + 0.02) l[1] = Math.max(l[1], b); else out.push([a, b]); }
    E().cuts = out.map(([a, b]) => ({ start: +a.toFixed(3), end: +b.toFixed(3) }));
  }
  function setMark(which) {
    mark[which] = +t.toFixed(2);
    if (mark.in != null && mark.out != null && mark.out < mark.in) [mark.in, mark.out] = [mark.out, mark.in];
    renderAll();
  }
  function cutRange() {
    if (!(mark.in != null && mark.out != null && mark.out - mark.in >= 0.1)) { toast('حدّد بداية ونهاية المقطع الأول (I و O)', 'bad'); return; }
    const a = mark.in, b = mark.out;
    if (outLen() - (b - a) < 1) { toast('مش هينفع تحذف الفيديو كله', 'bad'); return; }
    if (E().sequence?.length) {
      change(() => {
        const segs = derivedSegs().flatMap((sg) => (isHold(sg) || sg[1] <= a || sg[0] >= b ? [sg] : [[sg[0], a], [b, sg[1]]].filter(([x, y]) => y - x >= 0.1)));
        E().sequence = toSeq(segs); sel = null;
      });
    } else change(() => { E().cuts.push({ start: a, end: b }); normCuts(); sel = { kind: 'cut', i: E().cuts.findIndex((c) => c.start <= a && c.end >= b) }; });
    mark = { in: null, out: null };
    toast(`اتحذف ${(b - a).toFixed(1)} ث — الفيديو بقى ${outLen().toFixed(1)} ث`);
  }
  function removeSelected() {
    if (sel?.kind === 'cut') { change(() => { E().cuts.splice(sel.i, 1); sel = null; }); return; }
    if (sel?.kind === 'overlay' || sel?.kind === 'overlays') { const ids = selOvIds(); change(() => { E().overlays = E().overlays.filter((o) => !ids.includes(o.id)); sel = null; }); return; }
    else if (sel?.kind === 'music') change(() => { E().audio.music = null; sel = null; });
  }
  async function addMedia() {
    const a = await pickAsset({ kinds: ['image', 'video'] });
    if (!a) return;
    change(() => { const o = { id: uid(), kind: a.kind, asset: a.id, name: a.name, start: +t.toFixed(2), end: +Math.min(full, t + (a.kind === 'video' ? Math.min(4, a.duration || 4) : 3)).toFixed(2), pos: 'center', scale: 0.6, anim: 'pop', opacity: 1, offset: 0 }; E().overlays.push(o); sel = { kind: 'overlay', id: o.id }; });
  }
  async function addMusic() {
    const a = await pickAsset({ kinds: ['audio'] });
    if (a) change(() => { E().audio.music = { ...(E().audio.music || { volume: 0.25, duck: true, fadeIn: 1, fadeOut: 1.5 }), asset: a.id, name: a.name }; sel = { kind: 'music' }; });
  }
  $('#addMedia', el).addEventListener('click', addMedia);
  $('#addPause', el).addEventListener('click', addPause);
  $('#seqReset', el).addEventListener('click', () => change(() => { E().sequence = null; sel = null; }));
  $('#markIn', el).addEventListener('click', () => setMark('in'));
  $('#markOut', el).addEventListener('click', () => setMark('out'));
  $('#cutRange', el).addEventListener('click', cutRange);
  $('#addMusic', el).addEventListener('click', addMusic);
  $('#addText', el).addEventListener('click', () => change(() => { const o = { id: uid(), kind: 'text', text: 'نص جديد', start: +t.toFixed(2), end: +Math.min(full, t + 2.5).toFixed(2), pos: 'top', size: 44, anim: 'pop', box: true, scale: 1, opacity: 1 }; E().overlays.push(o); sel = { kind: 'overlay', id: o.id }; }));

  // ---------- pointer interactions ----------
  const inner = $('#tlInner', el), scroller = $('#tlScroll', el);
  const timeOf = (e) => T(e.clientX - inner.getBoundingClientRect().left);
  let lastSeek = 0;
  function seekOut(tau) { t = srcOf(tau); lastSeek = performance.now(); post({ type: 'reel:seekOut', tau }); updateHead(); }
  function seek(sec) { t = Math.max(0, Math.min(full, sec)); lastSeek = performance.now(); post({ type: 'reel:seek', t }); updateHead(); }
  function updateHead(tau) {
    const h = $('#tlHead', el); if (h) h.style.left = X(t) + 'px';
    const o = tau ?? outOf(t), oh = $('#tlOutHead', el);
    if (oh) { oh.style.display = o === null ? 'none' : 'block'; if (o !== null) oh.style.left = X(o) + 'px'; }
    $('#edTime', el).textContent = fmtTime(t) + (o !== null && Math.abs(o - t) > 0.05 ? ` · ناتج ${fmtTime(o)}` : '');
  }
  inner.addEventListener('pointerdown', (e) => {
    const d = e.target.closest('[data-drag]');
    const segEl = e.target.closest('[data-seg]');
    if (segEl) { sel = { kind: 'seg', i: Number(segEl.dataset.seg) }; seekOut(timeOf(e)); renderAll(); return; }
    if (e.target.closest('[data-seekout]')) { sel = null; seekOut(timeOf(e)); renderAll(); return; }
    const blk = e.target.closest('[data-scene],[data-ov],[data-word],[data-music],[data-voice],[data-cut]');
    if (blk) {
      const s0 = sel;
      if (blk.dataset.cut !== undefined) { sel = { kind: 'cut', i: Number(blk.dataset.cut) }; renderAll(); return; }
      if (blk.dataset.scene !== undefined) sel = { kind: 'scene', i: Number(blk.dataset.scene) };
      else if (blk.dataset.ov && e.shiftKey) {
        const ids = new Set(selOvIds()); ids.has(blk.dataset.ov) ? ids.delete(blk.dataset.ov) : ids.add(blk.dataset.ov);
        sel = ids.size > 1 ? { kind: 'overlays', ids: [...ids] } : ids.size ? { kind: 'overlay', id: [...ids][0] } : null;
        renderAll(); return;
      } else if (blk.dataset.ov) { if (!isSelOv(blk.dataset.ov)) sel = { kind: 'overlay', id: blk.dataset.ov }; }
      else if (blk.dataset.word !== undefined) sel = { kind: 'word', i: Number(blk.dataset.word) };
      else if (blk.dataset.music !== undefined) sel = { kind: 'music' };
      else sel = { kind: 'voice' };
      if (JSON.stringify(s0) !== JSON.stringify(sel)) { renderInspector(); $$('.blk.sel', inner).forEach((x) => x.classList.remove('sel')); blk.classList.add('sel'); }
    } else if (e.target.closest('[data-seek]')) { sel = null; renderInspector(); seek(timeOf(e)); }
    if (!d) return;
    e.preventDefault();
    dragging = { type: d.dataset.drag, x0: e.clientX, before: snap(), moved: false, i: Number(d.dataset.i ?? blk?.dataset.word), ov: blk?.dataset.ov };
    if (dragging.ov) {
      const o = E().overlays.find((x) => x.id === dragging.ov); dragging.o0 = { start: o.start, end: o.end };
      // moving one block of a multi-selection moves the whole group
      dragging.group = dragging.type === 'ovMove' && sel?.kind === 'overlays' ? E().overlays.filter((x) => sel.ids.includes(x.id)).map((x) => ({ o: x, start: x.start, end: x.end })) : null;
    }
    if (dragging.type === 'wordMove') { const w = S.words[dragging.i]; dragging.w0 = { start: w.start, end: w.end }; }
    inner.setPointerCapture(e.pointerId);
  });
  let raf = 0;
  inner.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragging.x0) / pps;
    if (Math.abs(e.clientX - dragging.x0) > 2) dragging.moved = true;
    if (!dragging.moved) return;
    const tt = timeOf(e);
    const g = dragging;
    if (g.type === 'trimStart') E().trim = { ...E().trim, start: +Math.max(0, Math.min((E().trim.end || full) - 1, tt)).toFixed(2) };
    else if (g.type === 'trimEnd') E().trim = { ...E().trim, end: +Math.min(full, Math.max((E().trim.start || 0) + 1, tt)).toFixed(2) };
    else if (g.type === 'sceneStart') {
      const sc = S.storyboard.scenes, lo = sc[g.i - 1].at + 1, hi = sc[g.i + 1] ? sc[g.i + 1].at - 1 : S.words.length - 1;
      sc[g.i].at = Math.max(lo, Math.min(hi, wordAt(tt)));
    } else if (g.ov) {
      const o = E().overlays.find((x) => x.id === g.ov), len = g.o0.end - g.o0.start;
      if (g.type === 'ovMove' && g.group) {
        const lo = -Math.min(...g.group.map((x) => x.start)), hi = full - Math.max(...g.group.map((x) => x.end));
        const d = Math.max(lo, Math.min(hi, dx));
        for (const x of g.group) { x.o.start = +(x.start + d).toFixed(2); x.o.end = +(x.end + d).toFixed(2); }
      } else if (g.type === 'ovMove') { o.start = +Math.max(0, Math.min(full - len, g.o0.start + dx)).toFixed(2); o.end = +(o.start + len).toFixed(2); }
      if (g.type === 'ovStart') o.start = +Math.max(0, Math.min(o.end - 0.2, g.o0.start + dx)).toFixed(2);
      if (g.type === 'ovEnd') o.end = +Math.min(full, Math.max(o.start + 0.2, g.o0.end + dx)).toFixed(2);
    } else if (g.type === 'wordMove') {
      const w = S.words[g.i], prev = S.words[g.i - 1], next = S.words[g.i + 1], len = g.w0.end - g.w0.start;
      w.start = +Math.max(prev ? prev.start + 0.02 : 0, Math.min(next ? next.start - 0.02 : full, g.w0.start + dx)).toFixed(3);
      w.end = +(w.start + len).toFixed(3);
    }
    cancelAnimationFrame(raf); raf = requestAnimationFrame(renderTimeline);
  });
  const endDrag = () => {
    if (!dragging) return;
    const g = dragging; dragging = null;
    if (g.moved && g.before !== snap()) { hist.undo.push(g.before); hist.redo = []; renderAll(); scheduleSave(); }
  };
  inner.addEventListener('pointerup', endDrag);
  inner.addEventListener('pointercancel', endDrag);
  // drag a scene onto another → swap what they show (times stay with the narration)
  inner.addEventListener('dragstart', (e) => {
    const sgEl = e.target.closest('[data-seg]');
    if (sgEl && !dragging) { e.dataTransfer.setData('text/seg', sgEl.dataset.seg); return; }
    const b = e.target.closest('[data-scene]'); if (!b || dragging) { e.preventDefault(); return; } e.dataTransfer.setData('text/scene', b.dataset.scene);
  });
  inner.addEventListener('dragover', (e) => { if (e.target.closest('[data-scene],[data-seg],[data-seekout]')) e.preventDefault(); });
  inner.addEventListener('drop', (e) => {
    const fromSeg = e.dataTransfer.getData('text/seg');
    if (fromSeg !== '' && e.target.closest('[data-seekout]')) {
      e.preventDefault();
      const segs = derivedSegs(), from = Number(fromSeg);
      // drop position (output time) → index to insert before
      const tau = timeOf(e); let acc = 0, to = segs.length;
      for (let k = 0; k < segs.length; k++) { const l = segLen(segs[k]); if (tau < acc + l / 2) { to = k; break; } acc += l; }
      if (to === from || to === from + 1) return;
      change(() => { const [m] = segs.splice(from, 1); segs.splice(to > from ? to - 1 : to, 0, m); E().sequence = toSeq(segs); sel = { kind: 'seg', i: to > from ? to - 1 : to }; });
      toast('اتغيّر الترتيب — الفيديو هيتعرض بالترتيب الجديد');
      return;
    }
    const b = e.target.closest('[data-scene]'); const from = Number(e.dataTransfer.getData('text/scene'));
    if (!b || Number.isNaN(from)) return;
    e.preventDefault();
    const to = Number(b.dataset.scene);
    if (from === to) return;
    change(() => {
      const A = S.storyboard.scenes[from], B = S.storyboard.scenes[to];
      for (const k of VISUAL_KEYS) [A[k], B[k]] = [B[k], A[k]];
      for (const sc of [A, B]) sc.items.forEach((it) => { it.at = null; });
      sel = { kind: 'scene', i: to };
    });
    toast(`اتبدّل محتوى المشهد ${from + 1} و ${to + 1}`);
  });

  // ---------- toolbar ----------
  const ex = E().export;
  $('#edAspect', el).value = ex.aspect || project.render?.aspect || '9:16';
  $('#edRes', el).value = String(ex.resolution || 1080);
  $('#edFps', el).value = String(ex.fps || 30);
  $('#edQ', el).value = ex.quality || 'standard';
  $('#edTr', el).value = E().transition || 'push';
  const setAspectCss = () => { frame.parentElement.style.aspectRatio = { '9:16': '9/16', '1:1': '1/1', '16:9': '16/9', '4:5': '4/5' }[$('#edAspect', el).value]; };
  // platforms: format + fps from the preset; safe-zone guides in the preview; duration warning in the toolbar
  let PLATS = {};
  api('/api/platforms').then((r) => {
    PLATS = r.platforms;
    $('#edPlatform', el).innerHTML = '<option value="">منصة: بدون</option>' + Object.entries(PLATS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    $('#edPlatform', el).value = E().export.platform || '';
    renderAll();
  }).catch(() => {});
  $('#edPlatform', el).addEventListener('change', (e) => {
    const id = e.target.value, pf = PLATS[id];
    change(() => { E().export = pf ? { ...E().export, platform: id, aspect: pf.aspect, resolution: pf.resolution, fps: pf.fps } : { ...E().export, platform: null }; });
    if (pf) { $('#edAspect', el).value = pf.aspect; $('#edRes', el).value = String(pf.resolution); $('#edFps', el).value = String(pf.fps); setAspectCss(); }
  });
  $('#edGuides', el).addEventListener('change', (e) => post({ type: 'reel:guides', on: e.target.checked }));
  frame.addEventListener('load', () => setTimeout(() => post({ type: 'reel:guides', on: $('#edGuides', el).checked }), 300));
  setAspectCss();
  for (const [sel_, key, num] of [['#edAspect', 'aspect'], ['#edRes', 'resolution', 1], ['#edFps', 'fps', 1], ['#edQ', 'quality']]) {
    $(sel_, el).addEventListener('change', (e) => { change(() => { E().export = { ...E().export, [key]: num ? Number(e.target.value) : e.target.value }; }); setAspectCss(); });
  }
  $('#edTr', el).addEventListener('change', (e) => change(() => { E().transition = e.target.value; }));
  $('#edUndo', el).addEventListener('click', undo);
  $('#edRedo', el).addEventListener('click', redo);
  $('#edZoom', el).addEventListener('input', (e) => { pps = Number(e.target.value); renderTimeline(); });
  const togglePlay = () => { playing = !playing; post({ type: playing ? 'reel:play' : 'reel:pause' }); $('#edPlay', el).textContent = playing ? '❚❚' : '▶'; };
  $('#edPlay', el).addEventListener('click', togglePlay);
  $('#edRender', el).addEventListener('click', async () => {
    clearTimeout(saveTimer); dirty = true; await save();
    await act(() => api(`/api/projects/${id}/stages/render/rerun`, { method: 'POST' }), 'الرندر بدأ — تابعه من مرحلة «الرندر»');
  });
  const onMsg = (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'reel:time' || e.source !== frame.contentWindow) return;
    // a time report sent before the preview handled our seek would jump the playhead back: ignore it briefly
    if (!e.data.playing && performance.now() - lastSeek < 400) return;
    if (!dragging) { t = e.data.t; updateHead(e.data.tau); if (e.data.playing) { const h = X(t); if (h < scroller.scrollLeft || h > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = h - 60; } }
    if (playing !== e.data.playing) { playing = e.data.playing; $('#edPlay', el).textContent = playing ? '❚❚' : '▶'; }
  };
  window.addEventListener('message', onMsg);
  const onKey = (e) => {
    if (!el.isConnected) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === ' ' && !typing) { e.preventDefault(); togglePlay(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ['overlay', 'overlays', 'music', 'cut'].includes(sel?.kind)) { e.preventDefault(); removeSelected(); }
    else if (!typing && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'i') setMark('in');
    else if (!typing && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'o') setMark('out');
    else if (!typing && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'x') cutRange();
  };
  document.addEventListener('keydown', onKey);
  const onLeave = (e) => { if (dirty) { save(); e.preventDefault(); } };
  window.addEventListener('beforeunload', onLeave);

  function renderAll() {
    $('#edUndo', el).disabled = !hist.undo.length; $('#edRedo', el).disabled = !hist.redo.length;
    $('#cutRange', el).disabled = !(mark.in != null && mark.out != null && mark.out - mark.in >= 0.1);
    $('#edDur', el).textContent = `الفيديو: ${outLen().toFixed(1)} ث${E().sequence?.length ? ' · ترتيب مخصص' : E().cuts.length ? ` · ${E().cuts.length} مقطع محذوف` : ''}`;
    $('#seqReset', el).hidden = !E().sequence?.length;
    const pf = PLATS[E().export?.platform];
    if (pf) {
      const len = outLen();
      const over = pf.maxSec && len > pf.maxSec, odd = pf.idealSec && (len < pf.idealSec[0] || len > pf.idealSec[1]);
      $('#edDur', el).innerHTML = `${esc($('#edDur', el).textContent)} · <span class="${over ? 'bad' : odd ? 'warnc' : 'ok'}">${esc(pf.name)}: ${over ? `أطول من الحد (${pf.maxSec} ث)` : odd ? `المعتاد ${pf.idealSec[0]}–${pf.idealSec[1]} ث` : '✓ المدة مناسبة'}</span>`;
    }
    renderTimeline(); renderInspector(); updateHead();
  }
  renderAll();
  loadWave();
  return {
    flush: () => { clearTimeout(saveTimer); return save(); },
    destroy: () => { clearTimeout(saveTimer); if (dirty) save(); window.removeEventListener('message', onMsg); document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); },
    get state() { return S; },
  };
}
