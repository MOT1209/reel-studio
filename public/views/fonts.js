// Arabic Typography Studio: browse / search / preview every font family, pick the title and caption fonts,
// caption presets, digits, direction — saved as the default typography (Settings → look.typography).
// Projects can override it from the editor.
import { $, $$, esc, api, act, toast, loadFamily } from '../ui.js';

const CAT_AR = { sans: 'بدون زوائد (Sans)', naskh: 'نسخ', kufi: 'كوفي', display: 'عناوين / رقعة' };
const STYLE_AR = { boxed: 'مربع على الكلمة', karaoke: 'كاريوكي (لون)', minimal: 'بسيط', outline: 'إطار (سوشيال)' };
const SAMPLE = 'السما لونها أزرق عشان الضوء الأزرق بيتشتت ٤ مرات أكتر من الأحمر — Rayleigh scattering سنة 1871.';

export async function mountFonts(el) {
  const [{ fonts, styles, typography }, S] = await Promise.all([api('/api/fonts'), api('/api/settings')]);
  const typo = { ...typography };
  const st = { q: '', cat: '', size: 40, weight: 700, sample: SAMPLE };
  el.innerHTML = `
    <div class="panel">
      <h3>الخط الحالي للفيديوهات الجديدة</h3>
      <div class="typo-now" id="typoNow"></div>
      <div class="grid3">
        <label>نمط الكابشن <select id="tStyle">${styles.map((s) => `<option value="${s}">${STYLE_AR[s] || s}</option>`).join('')}</select></label>
        <label>حجم الكابشن <input type="number" id="tSize" min="28" max="90" step="2"></label>
        <label>وزن الكابشن <select id="tCapW">${[400, 500, 600, 700, 800, 900].map((w) => `<option>${w}</option>`).join('')}</select></label>
        <label>الأرقام <select id="tDigits"><option value="latin">123 (لاتيني)</option><option value="arabic">١٢٣ (هندي/عربي)</option></select></label>
        <label>اتجاه الكابشن <select id="tDir"><option value="auto">تلقائي (حسب أول حرف قوي)</option><option value="rtl">يمين ← شمال</option><option value="ltr">شمال ← يمين</option></select></label>
        <label>محاذاة <select id="tAlign"><option value="center">وسط</option><option value="right">يمين</option><option value="left">شمال</option></select></label>
      </div>
      <div class="capstyles" id="capPrev"></div>
      <div class="tools"><button class="primary" id="tSave">💾 احفظ كافتراضي</button><span class="hint">المشاريع تقدر تغيّره من المحرر.</span></div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <input id="fQ" placeholder="ابحث عن خط…">
        <select id="fCat"><option value="">كل الأنواع</option>${Object.entries(CAT_AR).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <label class="inl">الحجم <input type="range" id="fSize" min="20" max="90" value="40"></label>
        <label class="inl">الوزن <input type="range" id="fW" min="100" max="1000" step="100" value="700"></label>
      </div>
      <textarea id="fSample" rows="2" dir="auto">${esc(SAMPLE)}</textarea>
      <div class="fontlist" id="fontList"></div>
    </div>
    <div class="panel">
      <h3>استيراد خط</h3>
      <p class="hint">ttf / otf / woff / woff2 حتى 20MB. لازم يكون عندك حق تضمين الخط في الفيديوهات — خطوط Google Fonts كلها OFL ومسموحة.</p>
      <div class="two"><label>اسم الخط <input id="iName"></label><label>الوزن <select id="iW"><option>400</option><option>500</option><option>600</option><option selected>700</option><option>800</option><option value="100 900">متغيّر (100–900)</option></select></label></div>
      <label>الرخصة <select id="iLic"><option value="">— اختار —</option><option value="ofl">SIL OFL (مفتوح)</option><option value="own">أنا صاحب الخط</option><option value="licensed">عندي رخصة تجارية تسمح بالتضمين</option></select></label>
      <label class="btn">اختار ملف الخط<input type="file" id="iFile" accept=".ttf,.otf,.woff,.woff2" hidden></label>
    </div>`;

  const setTypoFields = () => {
    $('#tStyle', el).value = typo.captionStyle; $('#tSize', el).value = typo.captionSize; $('#tCapW', el).value = typo.captionWeight;
    $('#tDigits', el).value = typo.digits; $('#tDir', el).value = typo.direction; $('#tAlign', el).value = typo.align;
    const f = (id) => fonts.find((x) => x.id === id)?.name || id;
    $('#typoNow', el).innerHTML = `العناوين: <b>${esc(f(typo.font))}</b> · الكابشن: <b>${esc(f(typo.captionFont))}</b>`;
    renderCapPreview();
  };
  async function renderCapPreview() {
    const fam = fonts.find((x) => x.id === typo.captionFont) || fonts[0];
    const name = await loadFamily(fam);
    const words = ['نور', 'الشمس', 'فيه', 'كل', 'الألوان'];
    $('#capPrev', el).innerHTML = styles.map((s) => `<div class="cap ${s} ${s === typo.captionStyle ? 'on' : ''}" data-style="${s}" style="font-family:'${name}';font-weight:${typo.captionWeight}">
      ${words.map((w, i) => `<span class="${i < 2 ? 'lit' : ''} ${i === 1 ? 'act' : ''}">${esc(w)}</span>`).join(' ')}<small>${STYLE_AR[s]}</small></div>`).join('');
    $$('#capPrev .cap', el).forEach((c) => c.addEventListener('click', () => { typo.captionStyle = c.dataset.style; setTypoFields(); }));
  }
  async function renderList() {
    const q = st.q.toLowerCase();
    const list = fonts.filter((f) => (!st.cat || f.category === st.cat) && (!q || f.name.toLowerCase().includes(q) || (f.use || '').includes(st.q)));
    $('#fontList', el).innerHTML = list.map((f) => `
      <div class="fontcard ${typo.font === f.id || typo.captionFont === f.id ? 'used' : ''}" data-f="${esc(f.id)}">
        <div class="fhead"><b dir="ltr">${esc(f.name)}</b><span class="hint">${esc(CAT_AR[f.category] || f.category)} · ${esc(f.use || '')}</span>
          <span class="hint flic">${esc(f.license?.name || '')}</span></div>
        <div class="fprev" dir="auto" data-prev style="font-size:${st.size}px;font-weight:${st.weight}">${esc(st.sample)}</div>
        <div class="tools">
          <button class="small ${typo.font === f.id ? 'primary' : ''}" data-use="font">${typo.font === f.id ? '✔ ' : ''}للعناوين</button>
          <button class="small ${typo.captionFont === f.id ? 'primary' : ''}" data-use="captionFont">${typo.captionFont === f.id ? '✔ ' : ''}للكابشن</button>
          <span class="hint">أوزان: ${f.faces.map((x) => x.weight).join(' · ')}</span>
          ${f.source === 'imported' ? '<button class="small danger" data-del>حذف</button>' : ''}
        </div>
      </div>`).join('') || '<p class="hint">مفيش خطوط بالبحث ده.</p>';
    for (const card of $$('.fontcard', el)) {
      const f = fonts.find((x) => x.id === card.dataset.f);
      loadFamily(f).then((name) => { card.querySelector('[data-prev]').style.fontFamily = `'${name}'`; });
      card.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => { typo[b.dataset.use] = f.id; setTypoFields(); renderList(); }));
      card.querySelector('[data-del]')?.addEventListener('click', async () => { if (!confirm(`تحذف ${f.name}؟`)) return; await act(() => api('/api/fonts/' + f.id, { method: 'DELETE' })); mountFonts(el); });
    }
  }
  $('#fQ', el).addEventListener('input', (e) => { st.q = e.target.value; renderList(); });
  $('#fCat', el).addEventListener('change', (e) => { st.cat = e.target.value; renderList(); });
  $('#fSize', el).addEventListener('input', (e) => { st.size = Number(e.target.value); $$('[data-prev]', el).forEach((p) => { p.style.fontSize = st.size + 'px'; }); });
  $('#fW', el).addEventListener('input', (e) => { st.weight = Number(e.target.value); $$('[data-prev]', el).forEach((p) => { p.style.fontWeight = st.weight; }); });
  $('#fSample', el).addEventListener('input', (e) => { st.sample = e.target.value; $$('[data-prev]', el).forEach((p) => { p.textContent = st.sample; }); });
  for (const [id, k, num] of [['#tStyle', 'captionStyle'], ['#tSize', 'captionSize', 1], ['#tCapW', 'captionWeight', 1], ['#tDigits', 'digits'], ['#tDir', 'direction'], ['#tAlign', 'align']]) {
    $(id, el).addEventListener('change', (e) => { typo[k] = num ? Number(e.target.value) : e.target.value; setTypoFields(); });
  }
  $('#tSave', el).addEventListener('click', () => act(() => api('/api/settings', { method: 'PUT', body: JSON.stringify({ look: { theme: S.look.theme, typography: { font: typo.font, captionFont: typo.captionFont, captionStyle: typo.captionStyle, captionSize: typo.captionSize, captionWeight: typo.captionWeight, digits: typo.digits, direction: typo.direction, align: typo.align } } }) }), 'اتحفظت الطباعة الافتراضية'));
  $('#iFile', el).addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!$('#iLic', el).value) { toast('اختار الرخصة الأول', 'bad'); e.target.value = ''; return; }
    const r = await act(() => api('/api/fonts', { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name), 'X-Font-Name': encodeURIComponent($('#iName', el).value || f.name), 'X-Font-Weight': $('#iW', el).value, 'X-Font-License': $('#iLic', el).value } }), 'اتضاف الخط');
    if (r) mountFonts(el);
  });
  setTypoFields();
  renderList();
}
