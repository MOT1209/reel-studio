// Asset library: local media (upload, folders, tags, licence) + stock search (Pexels / Pixabay / Unsplash).
// mountLibrary(el) renders the full page; pickAsset({kind}) opens it as a picker and resolves with the chosen asset.
import { $, $$, esc, api, act, toast, modal, uploadAsset, fmtBytes, fmtTime } from '../ui.js';

const KIND_AR = { image: 'صورة', video: 'فيديو', audio: 'صوت' };
const COMM_AR = { true: '✔ تجاري مسموح', false: '✖ غير تجاري', check: '⚠ راجع الرخصة' };

export function mountLibrary(el, { pick = null, kinds = null, onPick = null } = {}) {
  const st = { tab: 'local', kind: kinds?.length === 1 ? kinds[0] : '', folder: '', q: '', sel: null, provider: 'pexels', skind: kinds?.includes('video') && !kinds.includes('image') ? 'video' : 'image', orientation: 'portrait', sq: '', results: null, providers: null };
  el.innerHTML = `
    <div class="libtabs tabs"><button data-ltab="local" class="on">ملفاتي</button><button data-ltab="stock">بحث في مكتبات الصور</button></div>
    <div data-lpane="local">
      <div class="toolbar">
        <input id="libQ" placeholder="بحث بالاسم أو الوسم أو المصدر…">
        <select id="libKind"><option value="">كل الأنواع</option><option value="image">صور</option><option value="video">فيديو</option><option value="audio">صوت</option></select>
        <select id="libFolder"><option value="">كل الفولدرات</option></select>
        <label class="btn primary">⬆ رفع ملفات<input type="file" id="libFile" multiple accept="image/*,video/*,audio/*" hidden></label>
      </div>
      <details class="uplmeta"><summary>بيانات الرفع (فولدر · وسوم · رخصة)</summary>
        <div class="two"><label>فولدر <input id="upFolder" placeholder="مثلاً: فضاء"></label><label>وسوم (بفاصلة) <input id="upTags"></label></div>
        <div class="two"><label>الرخصة <input id="upLic" placeholder="ملكي / CC0 / CC BY 4.0 …"></label>
          <label>استخدام تجاري <select id="upComm"><option value="">مش متأكد</option><option value="true">مسموح</option><option value="false">مش مسموح</option></select></label></div>
        <label>نص الإسناد (لو مطلوب) <input id="upAttr"></label>
      </details>
      <div class="drop" id="libDrop">اسحب ملفات هنا (صور حتى 25MB · فيديو حتى 600MB · صوت حتى 150MB)</div>
      <div class="libbody"><div class="grid" id="libGrid"></div><aside class="libside" id="libSide"><p class="hint">اختار ملف عشان تشوف تفاصيله ورخصته.</p></aside></div>
    </div>
    <div data-lpane="stock" hidden>
      <div class="toolbar">
        <select id="stProv"></select>
        <select id="stKind"><option value="image">صور</option><option value="video">فيديو</option></select>
        <select id="stOri"><option value="portrait">طولي</option><option value="landscape">عرضي</option><option value="square">مربع</option></select>
        <input id="stQ" placeholder="ابحث بالعربي أو الإنجليزي… (مثلاً: خلية دم)">
        <button id="stGo" class="primary">بحث</button>
      </div>
      <p class="hint" id="stInfo"></p>
      <div class="grid" id="stGrid"></div>
      <div class="tools" id="stMore"></div>
    </div>`;

  const tab = (t) => { st.tab = t; $$('[data-ltab]', el).forEach((b) => b.classList.toggle('on', b.dataset.ltab === t)); $$('[data-lpane]', el).forEach((p) => { p.hidden = p.dataset.lpane !== t; }); return t === 'stock' ? loadProviders() : Promise.resolve(); };
  $$('[data-ltab]', el).forEach((b) => b.addEventListener('click', () => tab(b.dataset.ltab)));
  if (kinds) { $('#libKind', el).value = st.kind; $('#libKind', el).disabled = kinds.length === 1; }

  async function load() {
    const q = new URLSearchParams({ kind: st.kind, folder: st.folder, q: st.q, per: 120 });
    const r = await api('/api/assets?' + q);
    const items = kinds ? r.items.filter((a) => kinds.includes(a.kind)) : r.items;
    const fs = $('#libFolder', el), cur = fs.value;
    fs.innerHTML = '<option value="">كل الفولدرات</option>' + r.folders.map((f) => `<option>${esc(f)}</option>`).join('');
    fs.value = r.folders.includes(cur) ? cur : '';
    $('#libGrid', el).innerHTML = items.length ? items.map((a) => `
      <button class="tile ${st.sel === a.id ? 'sel' : ''}" data-id="${esc(a.id)}" title="${esc(a.name)}">
        ${a.thumb ? `<img loading="lazy" src="/api/assets/${esc(a.id)}/thumb" alt="">` : `<span class="aud">♪</span>`}
        <span class="k ${a.kind}">${KIND_AR[a.kind]}${a.duration ? ' · ' + fmtTime(a.duration) : ''}</span>
        <span class="n">${esc(a.name)}</span>
      </button>`).join('') : `<p class="hint">مفيش ملفات${st.q || st.kind || st.folder ? ' بالفلتر ده' : ' لسه — ارفع أو دوّر في مكتبات الصور'}.</p>`;
    $$('#libGrid .tile', el).forEach((t) => t.addEventListener('click', () => select(t.dataset.id)));
    $$('#libGrid .tile', el).forEach((t) => t.addEventListener('dblclick', () => pick && choose(t.dataset.id)));
  }
  async function select(id) {
    st.sel = id;
    $$('#libGrid .tile', el).forEach((t) => t.classList.toggle('sel', t.dataset.id === id));
    const a = await api('/api/assets/' + id);
    const L = a.license || {};
    $('#libSide', el).innerHTML = `
      <div class="pv">${a.kind === 'image' ? `<img src="/api/assets/${a.id}/file" alt="">` : a.kind === 'video' ? `<video src="/api/assets/${a.id}/file" controls muted></video>` : `<audio src="/api/assets/${a.id}/file" controls></audio>`}</div>
      ${pick ? `<button class="primary wide" id="libChoose">✔ استخدم ده</button>` : ''}
      <label>الاسم <input id="aName" value="${esc(a.name)}"></label>
      <div class="two"><label>فولدر <input id="aFolder" value="${esc(a.folder)}"></label><label>وسوم <input id="aTags" value="${esc((a.tags || []).join(', '))}"></label></div>
      <div class="lic ${String(L.commercial)}"><b>${esc(L.name)}</b> · ${COMM_AR[String(L.commercial)] || ''}
        ${L.url ? `<a href="${esc(L.url)}" target="_blank" rel="noopener">↗ الشروط</a>` : ''}
        ${L.attribution ? `<div>الإسناد: ${esc(L.attribution)}</div>` : ''}${L.attributionRequired ? '<div class="warn">⚠ الإسناد مطلوب — هيتضاف للوصف تلقائيًا</div>' : ''}
        ${L.notes ? `<div class="hint">${esc(L.notes)}</div>` : ''}</div>
      <p class="hint">${esc(a.source?.provider || 'رفع')}${a.source?.author ? ' · ' + esc(a.source.author) : ''}${a.source?.pageUrl ? ` · <a href="${esc(a.source.pageUrl)}" target="_blank" rel="noopener">المصدر</a>` : ''}<br>
        ${a.width ? `${a.width}×${a.height} · ` : ''}${a.duration ? fmtTime(a.duration) + ' · ' : ''}${fmtBytes(a.size)} · ${esc(a.createdAt.slice(0, 10))}</p>
      <div class="tools"><button id="aSave">💾 حفظ</button><button id="aDel" class="danger">حذف</button></div>`;
    $('#libChoose', el)?.addEventListener('click', () => choose(a.id));
    $('#aSave', el).addEventListener('click', () => act(() => api('/api/assets/' + a.id, { method: 'PATCH', body: JSON.stringify({ name: $('#aName', el).value, folder: $('#aFolder', el).value, tags: $('#aTags', el).value }) }), 'اتحفظ').then(load));
    $('#aDel', el).addEventListener('click', async () => { if (!confirm('تحذف الملف ده من المكتبة؟ المشاريع اللي بتستخدمه هتحتاج ملف تاني.')) return; await act(() => api('/api/assets/' + a.id, { method: 'DELETE' })); st.sel = null; $('#libSide', el).innerHTML = ''; load(); });
  }
  async function choose(id) { const a = await api('/api/assets/' + id); onPick?.(a); }

  async function uploadFiles(files) {
    for (const f of files) {
      toast(`بيرفع ${f.name}…`);
      const a = await act(() => uploadAsset(f, { folder: $('#upFolder', el).value, tags: $('#upTags', el).value, licenseName: $('#upLic', el).value, commercial: $('#upComm', el).value, attribution: $('#upAttr', el).value }));
      if (a) { toast(`اترفع: ${a.name}`); st.sel = a.id; }
    }
    await load();
    if (st.sel) select(st.sel);
  }
  $('#libFile', el).addEventListener('change', (e) => uploadFiles([...e.target.files]));
  const drop = $('#libDrop', el);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
  let qt;
  $('#libQ', el).addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value; load(); }, 250); });
  $('#libKind', el).addEventListener('change', (e) => { st.kind = e.target.value; load(); });
  $('#libFolder', el).addEventListener('change', (e) => { st.folder = e.target.value; load(); });

  // ---- stock search ----
  async function loadProviders() {
    if (st.providers) return;
    st.providers = await api('/api/providers');
    $('#stProv', el).innerHTML = Object.entries(st.providers).map(([id, p]) => `<option value="${id}" ${p.configured ? '' : 'disabled'}>${esc(p.name)}${p.configured ? '' : ' (حط المفتاح في الإعدادات)'}</option>`).join('');
    const first = Object.entries(st.providers).find(([, p]) => p.configured);
    if (first) $('#stProv', el).value = first[0];
    else $('#stInfo', el).innerHTML = 'مفيش مكتبة صور متوصلة. حط مفتاح مجاني من <a href="https://www.pexels.com/api/" target="_blank" rel="noopener">Pexels</a> أو <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener">Pixabay</a> أو <a href="https://unsplash.com/developers" target="_blank" rel="noopener">Unsplash</a> في الإعدادات ← المكتبات.';
    $('#stKind', el).value = st.skind;
  }
  async function search(page = 1) {
    const prov = $('#stProv', el).value, q = $('#stQ', el).value.trim();
    if (!prov || !q) return;
    $('#stInfo', el).textContent = 'بيدوّر…';
    const r = await act(() => api(`/api/providers/${prov}/search?` + new URLSearchParams({ q, kind: $('#stKind', el).value, orientation: $('#stOri', el).value, page })));
    if (!r) { $('#stInfo', el).textContent = ''; return; }
    st.results = r;
    const lic = st.providers[prov].license;
    $('#stInfo', el).innerHTML = `${r.total} نتيجة${r.queryUsed !== r.query ? ` · البحث اتترجم لـ «${esc(r.queryUsed)}»` : ''} · رخصة: <a href="${esc(lic.url)}" target="_blank" rel="noopener">${esc(lic.name)}</a> — ${esc(lic.notes)}`;
    $('#stGrid', el).innerHTML = r.items.map((it, i) => `<div class="tile stock"><img loading="lazy" src="${esc(it.thumb)}" alt="${esc(it.alt || '')}">
      <span class="n">${esc(it.author || '')}${it.duration ? ' · ' + fmtTime(it.duration) : ''}</span>
      <button class="small primary" data-imp="${i}">${pick ? 'استورد واستخدم' : '＋ للمكتبة'}</button></div>`).join('') || '<p class="hint">مفيش نتايج.</p>';
    $$('[data-imp]', el).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'بيحمّل…';
      const a = await act(() => api(`/api/providers/${prov}/import`, { method: 'POST', body: JSON.stringify({ item: r.items[b.dataset.imp], folder: 'stock' }) }));
      if (!a) { b.disabled = false; b.textContent = 'جرّب تاني'; return; }
      toast(`اتضاف للمكتبة: ${a.name}`); b.textContent = '✔';
      if (pick) onPick?.(a); else load();
    }));
    $('#stMore', el).innerHTML = r.total > r.page * 20 ? `<button id="stNext">الصفحة ${r.page + 1} ←</button>` : '';
    $('#stNext', el)?.addEventListener('click', () => search(r.page + 1));
  }
  $('#stGo', el).addEventListener('click', () => search());
  $('#stQ', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  if (pick?.query) { $('#stQ', el).value = pick.query; }
  load();
  return { reload: load, tab, search };
}

/** Library as a modal picker. kinds: ['image','video'] etc. query: prefilled stock search. */
export function pickAsset({ kinds = ['image', 'video'], query = '', stock = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('اختار من المكتبة', '<div id="pickRoot"></div>', { wide: true, onClose: () => { if (!done) resolve(null); } });
    const lib = mountLibrary($('#pickRoot', m.el), { pick: { query }, kinds, onPick: (a) => { done = true; m.close(); resolve(a); } });
    if (stock) lib.tab('stock').then(() => lib.search());
  });
}
