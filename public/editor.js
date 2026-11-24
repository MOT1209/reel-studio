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
  E().audio.tracks = E().audio.tracks || [];
  const sn = { on: true, grid: 0 }; // magnet to word/scene/clip edges + the playhead; optional time grid
  E().typography = E().typography || {};
  E().trim = E().trim || { start: 0, end: null };
  E().cuts = E().cuts || [];
  let mark = { in: null, out: null }; // I / O marks for cutting a range out of the middle

  el.innerHTML = `
  <div class="editor">
    <div class="etool">
      <button class="small" id="edUndo" title="تراجع (Ctrl+Z)">↶</button><button class="small" id="edRedo" title="إعادة (Ctrl+Y)">↷</button>
      <button class="small primary" id="edPlay" title="تشغيل (مسافة)">▶</button><span class="mono" id="edTime">0:00.0</span>
      <label class="inl">زووم <input type="range" id="edZoom" min="20" max="240" value="70"></label>
      <label class="inl" title="التقاط الحواف: الكلمات والمشاهد والعناصر والمؤشر"><input type="checkbox" id="snapOn" checked> مغناطيس</label>
      <select id="gridSel" title="شبكة زمنية"><option value="0">بدون شبكة</option><option value="0.25">شبكة 0.25 ث</option><option value="0.5">شبكة 0.5 ث</option><option value="1">شبكة 1 ث</option></select>
      <span class="sep"></span>
      <button class="small" id="markIn" title="بداية المقطع عند المؤشر (I)">[ بداية</button><button class="small" id="markOut" title="نهاية المقطع عند المؤشر (O)">نهاية ]</button>
      <button class="small danger" id="cutRange" title="احذف المقطع المحدد من الفيديو والصوت والكابشن (X)" disabled>✂ احذف المقطع</button>
      <span class="hint" id="edDur"></span>
      <span class="sep"></span>
      <select id="edAspect" title="مقاس الفيديو"><option value="9:16">9:16 طولي</option><option value="1:1">1:1 مربع</option><option value="16:9">16:9 عرضي</option></select>
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
        <div class="tl-lab">المشاهد</div>
        <div class="tl-lab">صور/فيديو <button class="small" id="addMedia" title="إضافة صورة أو فيديو عند المؤشر">＋</button></div>
        <div class="tl-lab">نصوص <button class="small" id="addText" title="إضافة نص عند المؤشر">＋</button></div>
        <div class="tl-lab">الكابشن</div>
        <div class="tl-lab">الصوت</div>
        <div class="tl-lab">موسيقى <button class="small" id="addMusic" title="موسيقى خلفية">＋</button></div>
        <div class="tl-lab">أصوات <button class="small" id="addTrack" title="مسار صوت مستقل (مؤثر، تعليق ثاني…) عند المؤشر">＋</button></div>
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
    if (sel?.kind === 'track' && !E().audio.tracks.some((x) => x.id === sel.id)) sel = null;
    if (sel?.kind === 'cut' && !E().cuts[sel.i]) sel = null;
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
    h += `<div class="trimh" data-drag="trimStart" style="left:${X(tr.start || 0)}px" title="بداية القص"></div><div class="trimh end" data-drag="trimEnd" style="left:${X(tr.end || full)}px" title="نهاية القص"></div>`;
    E().cuts.forEach((c, k) => { h += `<div class="cutblk ${sel?.kind === 'cut' && sel.i === k ? 'sel' : ''}" data-cut="${k}" style="left:${X(c.start)}px;width:${Math.max(3, X(c.end - c.start))}px" title="مقطع محذوف ${c.start.toFixed(2)}–${c.end.toFixed(2)} — دوس عشان ترجّعه"></div>`; });
    if (mark.in != null) h += `<div class="markh in" style="left:${X(mark.in)}px" title="بداية المقطع"></div>`;
    if (mark.out != null) h += `<div class="markh out" style="left:${X(mark.out)}px" title="نهاية المقطع"></div>`;
    if (mark.in != null && mark.out != null && mark.out > mark.in) h += `<div class="markrange" style="left:${X(mark.in)}px;width:${X(mark.out - mark.in)}px"></div>`;
    h += `</div>`;
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
    h += `<div class="tl-row" data-seek>${E().audio.tracks.map((x) => `<div class="blk trk ${sel?.kind === 'track' && sel.id === x.id ? 'sel' : ''}" data-trk="${esc(x.id)}" data-drag="trkMove" style="left:${X(x.start)}px;width:${Math.max(6, X(x.end - x.start))}px"><i class="h l" data-drag="trkStart"></i><span>🔊 ${esc(x.name || 'صوت')} · ${Math.round((x.volume ?? 1) * 100)}%</span><i class="h r" data-drag="trkEnd"></i></div>`).join('')}</div>`;
    E().cuts.forEach((c) => { h += `<div class="cutshade" style="left:${X(c.start)}px;width:${X(c.end - c.start)}px"></div>`; });
    h += `<div class="playhead" id="tlHead" style="left:${X(t)}px"></div>`;
    inner.style.width = W + 'px';
    inner.innerHTML = h;
    drawWave();
  }

  const isSelOv = (oid) => (sel?.kind === 'overlay' && sel.id === oid) || (sel?.kind === 'overlays' && sel.ids.includes(oid));
  const selOvIds = () => (sel?.kind === 'overlay' ? [sel.id] : sel?.kind === 'overlays' ? sel.ids : []);
  function outLen() {
    const a = E().trim?.start || 0, b = E().trim?.end || full;
    return Math.max(0, b - a - E().cuts.reduce((s2, c) => s2 + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0));
  }

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
        <div class="two"><label>إزاحة أفقية <input type="number" step="0.01" min="-1" max="1" data-o="x" value="${o.x || 0}"></label><label>إزاحة رأسية <input type="number" step="0.01" min="-1" max="1" data-o="y" value="${o.y || 0}"></label></div>
        <label>دوران (درجة) <input type="number" step="1" min="-360" max="360" data-o="rot" value="${o.rot || 0}"></label>
        <h5>الطبقات</h5><div class="tools"><button class="small" id="lyFront" title="أمام كل العناصر">⇧⇧ أمام الكل</button><button class="small" id="lyUp">⇧ للأمام</button><button class="small" id="lyDown">⇩ للخلف</button><button class="small" id="lyBack">⇩⇩ خلف الكل</button></div>
        <p class="hint">ترتيب الطبقة: ${E().overlays.indexOf(o) + 1} من ${E().overlays.length} (الأعلى رقمًا يظهر قدّام).</p>
        <h5>كي فريمات (حركة)</h5>
        ${(o.keyframes || []).map((k, ki) => `<div class="kf" data-ki="${ki}"><label>ث <input type="number" step="0.05" min="0" data-kf="t" value="${k.t}"></label>${['x', 'y', 'scale', 'opacity', 'rot'].map((p) => `<label>${p} <input type="number" step="0.05" data-kf="${p}" value="${k[p] ?? ''}" placeholder="—"></label>`).join('')}<label>سلاسة <select data-kf="ease">${opt(['linear', 'in', 'out', 'inOut', 'hold'], k.ease || 'linear', { linear: 'خطي', in: 'بداية بطيئة', out: 'نهاية بطيئة', inOut: 'الاتنين', hold: 'ثبات' })}</select></label><button class="small danger" data-kfdel="${ki}">✕</button></div>`).join('') || '<p class="hint">مفيش كي فريمات — العنصر ثابت. حط المؤشر على اللحظة وضيف كي فريم، بعدين غيّر القيم.</p>'}
        <div class="tools"><button class="small" id="kfAdd">＋ كي فريم عند المؤشر</button></div>
        <div class="tools"><button class="small danger" id="ovDel">حذف (Delete)</button></div>`;
    } else if (sel.kind === 'track') {
      const x = E().audio.tracks.find((y) => y.id === sel.id);
      box.innerHTML = `<h4>مسار صوت</h4><p>${esc(x.name || x.asset)}</p>
        <label>المستوى <span class="hint">${Math.round((x.volume ?? 1) * 100)}%</span><input type="range" min="0" max="2" step="0.05" data-x="volume" value="${x.volume ?? 1}"></label>
        <div class="two"><label>البداية <input type="number" step="0.05" data-x="start" value="${x.start}"></label><label>النهاية <input type="number" step="0.05" data-x="end" value="${x.end}"></label></div>
        <label>يبدأ من ثانية في الملف <input type="number" step="0.1" min="0" data-x="offset" value="${x.offset || 0}"></label>
        <div class="two"><label>ظهور تدريجي (ث) <input type="number" min="0" max="5" step="0.1" data-x="fadeIn" value="${x.fadeIn || 0}"></label><label>اختفاء تدريجي (ث) <input type="number" min="0" max="5" step="0.1" data-x="fadeOut" value="${x.fadeOut || 0}"></label></div>
        <div class="tools"><button class="small danger" id="trkDel">حذف (Delete)</button></div>
        <p class="hint">المسار بيتقص مع المقاطع المحذوفة زي صوت الكليبات. اتأكد من رخصة الملف.</p>`;
    } else if (sel.kind === 'cut') {
      const c = E().cuts[sel.i];
      box.innerHTML = `<h4>مقطع محذوف</h4><p class="hint">الجزء ده مش هيظهر في الفيديو ولا الصوت ولا الترجمة، والباقي بيتلم على بعضه.</p>
        <div class="two"><label>من <input type="number" step="0.05" data-c="start" value="${c.start}"></label><label>لحد <input type="number" step="0.05" data-c="end" value="${c.end}"></label></div>
        <div class="tools"><button class="small primary" id="cutUndo">↺ رجّع المقطع</button></div>`;
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
      const moveLayer = (to) => change(() => { const a = E().overlays, i = a.indexOf(o); a.splice(i, 1); a.splice(to(i, a.length), 0, o); });
      $('#lyFront', box).addEventListener('click', () => moveLayer((i, n) => n));
      $('#lyUp', box).addEventListener('click', () => moveLayer((i, n) => Math.min(n, i + 1)));
      $('#lyDown', box).addEventListener('click', () => moveLayer((i) => Math.max(0, i - 1)));
      $('#lyBack', box).addEventListener('click', () => moveLayer(() => 0));
      $('#kfAdd', box).addEventListener('click', () => change(() => {
        const rel = +Math.max(0, Math.min(o.end - o.start, t - o.start)).toFixed(2), v = ReelAnim.sample(o, rel);
        o.keyframes = [...(o.keyframes || []).filter((k) => k.t !== rel), { t: rel, x: +v.x.toFixed(3), y: +v.y.toFixed(3), scale: +v.scale.toFixed(3), opacity: +v.opacity.toFixed(3), rot: +v.rot.toFixed(1), ease: 'inOut' }].sort((a, b) => a.t - b.t);
      }));
      $$('[data-kf]', box).forEach((i) => i.addEventListener('change', () => change(() => {
        const k = o.keyframes[Number(i.closest('[data-ki]').dataset.ki)], f = i.dataset.kf;
        if (f === 'ease') k.ease = i.value; else if (i.value === '') delete k[f]; else k[f] = Number(i.value);
        o.keyframes.sort((a, b) => a.t - b.t);
      })));
      $$('[data-kfdel]', box).forEach((b) => b.addEventListener('click', () => change(() => { o.keyframes.splice(Number(b.dataset.kfdel), 1); if (!o.keyframes.length) delete o.keyframes; })));
      $('#ovSwap', box)?.addEventListener('click', async () => { const a = await pickAsset({ kinds: [o.kind] }); if (a) change(() => { o.asset = a.id; o.name = a.name; }); });
    }
    if (sel?.kind === 'track') {
      const x = E().audio.tracks.find((y) => y.id === sel.id);
      $$('[data-x]', box).forEach((i) => i.addEventListener('change', () => change(() => { x[i.dataset.x] = val(i); if (x.end < x.start + 0.1) x.end = x.start + 0.1; })));
      $('#trkDel', box).addEventListener('click', () => removeSelected());
    }
    if (sel?.kind === 'cut') {
      const c = E().cuts[sel.i];
      $$('[data-c]', box).forEach((i) => i.addEventListener('change', () => change(() => { c[i.dataset.c] = Number(i.value); if (c.end < c.start + 0.1) c.end = c.start + 0.1; normCuts(); })));
      $('#cutUndo', box).addEventListener('click', () => change(() => { E().cuts.splice(sel.i, 1); sel = null; }));
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
    change(() => { E().cuts.push({ start: a, end: b }); normCuts(); sel = { kind: 'cut', i: E().cuts.findIndex((c) => c.start <= a && c.end >= b) }; });
    mark = { in: null, out: null };
    toast(`اتحذف ${(b - a).toFixed(1)} ث — الفيديو بقى ${outLen().toFixed(1)} ث`);
  }
  function removeSelected() {
    if (sel?.kind === 'cut') { change(() => { E().cuts.splice(sel.i, 1); sel = null; }); return; }
    if (sel?.kind === 'overlay' || sel?.kind === 'overlays') { const ids = selOvIds(); change(() => { E().overlays = E().overlays.filter((o) => !ids.includes(o.id)); sel = null; }); return; }
    else if (sel?.kind === 'music') change(() => { E().audio.music = null; sel = null; });
    else if (sel?.kind === 'track') change(() => { E().audio.tracks = E().audio.tracks.filter((x) => x.id !== sel.id); sel = null; });
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
  async function addTrack() {
    const a = await pickAsset({ kinds: ['audio'] });
    if (a) change(() => { const x = { id: uid(), asset: a.id, name: a.name, start: +t.toFixed(2), end: +Math.min(full, t + (a.duration || 5)).toFixed(2), offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 }; E().audio.tracks.push(x); sel = { kind: 'track', id: x.id }; });
  }
  $('#addTrack', el).addEventListener('click', addTrack);
  $('#snapOn', el).addEventListener('change', (e) => { sn.on = e.target.checked; });
  $('#gridSel', el).addEventListener('change', (e) => { sn.grid = Number(e.target.value); });
  $('#addMedia', el).addEventListener('click', addMedia);
  $('#markIn', el).addEventListener('click', () => setMark('in'));
  $('#markOut', el).addEventListener('click', () => setMark('out'));
  $('#cutRange', el).addEventListener('click', cutRange);
  $('#addMusic', el).addEventListener('click', addMusic);
  $('#addText', el).addEventListener('click', () => change(() => { const o = { id: uid(), kind: 'text', text: 'نص جديد', start: +t.toFixed(2), end: +Math.min(full, t + 2.5).toFixed(2), pos: 'top', size: 44, anim: 'pop', box: true, scale: 1, opacity: 1 }; E().overlays.push(o); sel = { kind: 'overlay', id: o.id }; }));

  // ---------- pointer interactions ----------
  const inner = $('#tlInner', el), scroller = $('#tlScroll', el);
  const timeOf = (e) => T(e.clientX - inner.getBoundingClientRect().left);
  let lastSeek = 0;
  function seek(sec) { t = Math.max(0, Math.min(full, sec)); lastSeek = performance.now(); post({ type: 'reel:seek', t }); updateHead(); }
  function updateHead() { const h = $('#tlHead', el); if (h) h.style.left = X(t) + 'px'; $('#edTime', el).textContent = fmtTime(t); }
  inner.addEventListener('pointerdown', (e) => {
    const d = e.target.closest('[data-drag]');
    const blk = e.target.closest('[data-scene],[data-ov],[data-trk],[data-word],[data-music],[data-voice],[data-cut]');
    if (blk) {
      const s0 = sel;
      if (blk.dataset.cut !== undefined) { sel = { kind: 'cut', i: Number(blk.dataset.cut) }; renderAll(); return; }
      if (blk.dataset.scene !== undefined) sel = { kind: 'scene', i: Number(blk.dataset.scene) };
      else if (blk.dataset.ov && e.shiftKey) {
        const ids = new Set(selOvIds()); ids.has(blk.dataset.ov) ? ids.delete(blk.dataset.ov) : ids.add(blk.dataset.ov);
        sel = ids.size > 1 ? { kind: 'overlays', ids: [...ids] } : ids.size ? { kind: 'overlay', id: [...ids][0] } : null;
        renderAll(); return;
      } else if (blk.dataset.ov) { if (!isSelOv(blk.dataset.ov)) sel = { kind: 'overlay', id: blk.dataset.ov }; }
      else if (blk.dataset.trk) sel = { kind: 'track', id: blk.dataset.trk };
      else if (blk.dataset.word !== undefined) sel = { kind: 'word', i: Number(blk.dataset.word) };
      else if (blk.dataset.music !== undefined) sel = { kind: 'music' };
      else sel = { kind: 'voice' };
      if (JSON.stringify(s0) !== JSON.stringify(sel)) { renderInspector(); $$('.blk.sel', inner).forEach((x) => x.classList.remove('sel')); blk.classList.add('sel'); }
    } else if (e.target.closest('[data-seek]')) { sel = null; renderInspector(); seek(timeOf(e)); }
    if (!d) return;
    e.preventDefault();
    dragging = { type: d.dataset.drag, x0: e.clientX, before: snap(), moved: false, i: Number(d.dataset.i ?? blk?.dataset.word), ov: blk?.dataset.ov, trk: blk?.dataset.trk };
    if (dragging.trk) { const x = E().audio.tracks.find((y) => y.id === dragging.trk); dragging.o0 = { start: x.start, end: x.end }; }
    if (dragging.ov) {
      const o = E().overlays.find((x) => x.id === dragging.ov); dragging.o0 = { start: o.start, end: o.end };
      // moving one block of a multi-selection moves the whole group
      dragging.group = dragging.type === 'ovMove' && sel?.kind === 'overlays' ? E().overlays.filter((x) => sel.ids.includes(x.id)).map((x) => ({ o: x, start: x.start, end: x.end })) : null;
    }
    if (dragging.type === 'wordMove') { const w = S.words[dragging.i]; dragging.w0 = { start: w.start, end: w.end }; }
    inner.setPointerCapture(e.pointerId);
  });
  // ---------- snapping (magnet to edges + optional grid) ----------
  function snapPoints(skipOv = [], skipTrk = null) {
    const pts = [0, full, t];
    S.storyboard.scenes.forEach((_, i) => { pts.push(sceneTimes()[i].start); });
    S.words.forEach((w) => pts.push(w.start, w.end));
    for (const o of E().overlays) if (!skipOv.includes(o.id)) pts.push(o.start, o.end);
    for (const x of E().audio.tracks) if (x.id !== skipTrk) pts.push(x.start, x.end);
    for (const c of E().cuts) pts.push(c.start, c.end);
    if (E().trim.start) pts.push(E().trim.start); if (E().trim.end) pts.push(E().trim.end);
    if (mark.in != null) pts.push(mark.in); if (mark.out != null) pts.push(mark.out);
    return pts;
  }
  /** Shift (seconds) that aligns the interval [a,b] — or a single time when a===b — to the nearest edge/grid line, or 0. */
  function snapBy(a, b, pts) {
    const thr = 8 / pps;
    let shift = sn.on ? ReelAnim.snapShift(a, b, pts, thr) : 0;
    if (!shift && sn.grid > 0) {
      const ga = Math.round(a / sn.grid) * sn.grid - a, gb = Math.round(b / sn.grid) * sn.grid - b;
      const g = Math.abs(ga) <= Math.abs(gb) ? ga : gb;
      if (Math.abs(g) < thr) shift = g;
    }
    return shift;
  }
  let raf = 0;
  inner.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragging.x0) / pps;
    if (Math.abs(e.clientX - dragging.x0) > 2) dragging.moved = true;
    if (!dragging.moved) return;
    const g = dragging;
    const tt = timeOf(e);
    const pts = snapPoints(g.group ? g.group.map((x) => x.o.id) : g.ov ? [g.ov] : [], g.trk);
    const tts = tt + snapBy(tt, tt, pts.filter((p) => p !== E().trim.start && p !== E().trim.end));
    if (g.type === 'trimStart') E().trim = { ...E().trim, start: +Math.max(0, Math.min((E().trim.end || full) - 1, tts)).toFixed(2) };
    else if (g.type === 'trimEnd') E().trim = { ...E().trim, end: +Math.min(full, Math.max((E().trim.start || 0) + 1, tts)).toFixed(2) };
    else if (g.trk) {
      const x = E().audio.tracks.find((y) => y.id === g.trk), len = g.o0.end - g.o0.start;
      if (g.type === 'trkMove') { const s0 = g.o0.start + dx; x.start = +Math.max(0, Math.min(full - len, s0 + snapBy(s0, s0 + len, pts))).toFixed(2); x.end = +(x.start + len).toFixed(2); }
      if (g.type === 'trkStart') { const v = g.o0.start + dx; x.start = +Math.max(0, Math.min(x.end - 0.1, v + snapBy(v, v, pts))).toFixed(2); }
      if (g.type === 'trkEnd') { const v = g.o0.end + dx; x.end = +Math.min(full + 30, Math.max(x.start + 0.1, v + snapBy(v, v, pts))).toFixed(2); }
    }
    else if (g.type === 'sceneStart') {
      const sc = S.storyboard.scenes, lo = sc[g.i - 1].at + 1, hi = sc[g.i + 1] ? sc[g.i + 1].at - 1 : S.words.length - 1;
      sc[g.i].at = Math.max(lo, Math.min(hi, wordAt(tt)));
    } else if (g.ov) {
      const o = E().overlays.find((x) => x.id === g.ov), len = g.o0.end - g.o0.start;
      if (g.type === 'ovMove' && g.group) {
        const lo = -Math.min(...g.group.map((x) => x.start)), hi = full - Math.max(...g.group.map((x) => x.end));
        const gs = Math.min(...g.group.map((x) => x.start)) + dx, ge = Math.max(...g.group.map((x) => x.end)) + dx;
        const d = Math.max(lo, Math.min(hi, dx + snapBy(gs, ge, pts)));
        for (const x of g.group) { x.o.start = +(x.start + d).toFixed(2); x.o.end = +(x.end + d).toFixed(2); }
      } else if (g.type === 'ovMove') { const s0 = g.o0.start + dx; o.start = +Math.max(0, Math.min(full - len, s0 + snapBy(s0, s0 + len, pts))).toFixed(2); o.end = +(o.start + len).toFixed(2); }
      if (g.type === 'ovStart') { const v = g.o0.start + dx; o.start = +Math.max(0, Math.min(o.end - 0.2, v + snapBy(v, v, pts))).toFixed(2); }
      if (g.type === 'ovEnd') { const v = g.o0.end + dx; o.end = +Math.min(full, Math.max(o.start + 0.2, v + snapBy(v, v, pts))).toFixed(2); }
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
  inner.addEventListener('dragstart', (e) => { const b = e.target.closest('[data-scene]'); if (!b || dragging) { e.preventDefault(); return; } e.dataTransfer.setData('text/scene', b.dataset.scene); });
  inner.addEventListener('dragover', (e) => { if (e.target.closest('[data-scene]')) e.preventDefault(); });
  inner.addEventListener('drop', (e) => {
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
  const setAspectCss = () => { frame.parentElement.style.aspectRatio = { '9:16': '9/16', '1:1': '1/1', '16:9': '16/9' }[$('#edAspect', el).value]; };
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
    if (!dragging) { t = e.data.t; updateHead(); if (e.data.playing) { const h = X(t); if (h < scroller.scrollLeft || h > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = h - 60; } }
    if (playing !== e.data.playing) { playing = e.data.playing; $('#edPlay', el).textContent = playing ? '❚❚' : '▶'; }
  };
  window.addEventListener('message', onMsg);
  const onKey = (e) => {
    if (!el.isConnected) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === ' ' && !typing) { e.preventDefault(); togglePlay(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ['overlay', 'overlays', 'music', 'cut', 'track'].includes(sel?.kind)) { e.preventDefault(); removeSelected(); }
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
    $('#edDur', el).textContent = `الفيديو: ${outLen().toFixed(1)} ث${E().cuts.length ? ` · ${E().cuts.length} مقطع محذوف` : ''}`;
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
