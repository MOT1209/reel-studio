// Voice & Subtitle Studio + Arabic language tools.
// Voice: ElevenLabs voice, speed, stability, style, pronunciation dictionary (TTS text only).
// Arabic tools: dialect analysis, local fixes (diacritics, digits) and LLM proposals shown as a diff.
import { $, $$, esc, api, act, toast, diffHtml } from '../ui.js';

export async function mountVoice(el) {
  const S = await api('/api/settings');
  const { ops } = await api('/api/arabic/ops');
  el.innerHTML = `
    <div class="cols2">
      <div class="panel">
        <h3>مزوّد الصوت</h3>
        <label class="row"><input type="radio" name="vProv" value="elevenlabs" ${S.tts?.provider !== 'openai' ? 'checked' : ''}> ElevenLabs — توقيت كل حرف مع الصوت (الأدق للكابشن)</label>
        <label class="row"><input type="radio" name="vProv" value="openai" ${S.tts?.provider === 'openai' ? 'checked' : ''}> OpenAI أو أي API متوافق (<code dir="ltr">/audio/speech</code>) — التوقيت من Deepgram، ولو مفيش مفتاح بيتقدّر من السكتات</label>
        <div id="oaiBox" ${S.tts?.provider === 'openai' ? '' : 'hidden'}>
          <div class="two"><label>Base URL <input id="oBase" dir="ltr" value="${esc(S.openaiTts.baseUrl)}" ${S._source['openaiTts.baseUrl'] === 'env (locked)' ? 'disabled' : ''}></label>
            <label>API key <input id="oKey" dir="ltr" autocomplete="off" placeholder="${esc(S.openaiTts.apiKey || 'مش متسجل')}"></label></div>
          <div class="two"><label>Model <input id="oModel" dir="ltr" value="${esc(S.openaiTts.model)}"></label><label>Voice <input id="oVoice" dir="ltr" value="${esc(S.openaiTts.voice)}" list="oVoices"></label></div>
          <datalist id="oVoices">${['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((v) => `<option value="${v}">`).join('')}</datalist>
          <label>السرعة <input type="number" id="oSpeed" min="0.25" max="4" step="0.05" value="${S.openaiTts.speed}"></label>
          <label>تعليمات الأداء (للموديلات اللي بتدعمها) <input id="oInstr" value="${esc(S.openaiTts.instructions || '')}"></label>
          <div class="tools"><button id="oTest">اختبار الاتصال</button><span class="testres" id="oRes"></span></div>
        </div>
      </div>
      <div class="panel">
        <h3>الصوت (ElevenLabs)</h3>
        <div class="two">
          <label>الصوت <select id="vVoice" dir="ltr"><option value="${esc(S.elevenlabs.voiceId)}">${esc(S.elevenlabs.voiceId || '— حمّل الأصوات —')}</option></select></label>
          <label>الموديل <input id="vModel" dir="ltr" value="${esc(S.elevenlabs.modelId)}"></label>
        </div>
        <label>السرعة <span class="hint" id="vSpeedV"></span><input type="range" id="vSpeed" min="0.7" max="1.2" step="0.05" value="${S.elevenlabs.speed ?? 1}"></label>
        <label>الثبات (أقل = تعبير أكتر) <span class="hint" id="vStabV"></span><input type="range" id="vStab" min="0" max="1" step="0.05" value="${S.elevenlabs.stability ?? 0.45}"></label>
        <label>الأسلوب <span class="hint" id="vStyleV"></span><input type="range" id="vStyle" min="0" max="1" step="0.05" value="${S.elevenlabs.style ?? 0.2}"></label>
        <h4>قاموس النطق</h4>
        <p class="hint">سطر لكل كلمة: <code>الكلمة = إزاي تتنطق</code>. بيتطبق على الكلام المبعوت للصوت بس — الكابشن بيفضل بإملاء السكريبت.</p>
        <textarea id="vPron" rows="6" dir="auto" placeholder="DNA = دي إن إيه&#10;CO2 = سي أو تو">${esc(S.pronunciation || '')}</textarea>
        <div class="tools"><button id="vLoad">تحميل الأصوات</button><button class="primary" id="vSave">💾 حفظ</button></div>
      </div>
      <div class="panel">
        <h3>الترجمة (Subtitles)</h3>
        <p class="hint">كل مشروع بيطلّع ملفات <b>SRT</b> و <b>VTT</b> من المحرر (أو من مرحلة التوقيت) — نفس تقسيم الكابشن المحروق في الفيديو، مع علامات RTL عشان الترقيم العربي يظهر صح في المشغلات، وبيحترم القص (trim) وإعداد الأرقام.</p>
        <p class="hint">شكل الكابشن (الخط، النمط، الحجم، الأرقام، الاتجاه) من <a href="#/fonts">استوديو الخطوط</a>، ولكل مشروع من المحرر.</p>
        <label class="row"><input type="checkbox" id="vCaps" ${(S.look.typography?.captions ?? true) ? 'checked' : ''}> كابشن محروق في الفيديو (افتراضي)</label>
      </div>
    </div>
    <div class="panel">
      <h3>أدوات اللغة العربية</h3>
      <p class="hint">التحليل والتشكيل المحلي بيشتغلوا على جهازك. أدوات الـ LLM بتطلع <b>اقتراح</b> بالفروقات — مفيش حاجة بتتغيّر غير لما تنسخها أو تطبقها على السكريبت من المشروع.</p>
      <textarea id="arText" rows="6" dir="auto" placeholder="الصق نص عربي…"></textarea>
      <div class="tools">
        <button id="arAnalyze">تحليل اللهجة</button>
        <button data-local="strip-tashkeel">شيل التشكيل</button><button data-local="arabic-digits">أرقام ١٢٣</button><button data-local="latin-digits">أرقام 123</button>
        ${Object.entries(ops).map(([k, v]) => `<button data-op="${k}" class="ai">✦ ${esc(v)}</button>`).join('')}
      </div>
      <div id="arOut"></div>
    </div>`;
  const vals = () => { $('#vSpeedV', el).textContent = '×' + $('#vSpeed', el).value; $('#vStabV', el).textContent = $('#vStab', el).value; $('#vStyleV', el).textContent = $('#vStyle', el).value; };
  $$('input[type=range]', el).forEach((r) => r.addEventListener('input', vals)); vals();
  $('#vLoad', el).addEventListener('click', async () => {
    const r = await act(() => api('/api/voices'));
    if (!r) return;
    const sel = $('#vVoice', el), cur = sel.value;
    sel.innerHTML = r.voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.labels?.accent ? ' · ' + esc(v.labels.accent) : ''}</option>`).join('');
    if (r.voices.some((v) => v.id === cur)) sel.value = cur;
    toast(`${r.voices.length} صوت`);
  });
  el.querySelectorAll('[name=vProv]').forEach((r) => r.addEventListener('change', () => { $('#oaiBox', el).hidden = !(r.value === 'openai' && r.checked); }));
  const oai = () => ({ ...(!$('#oBase', el).disabled ? { baseUrl: $('#oBase', el).value } : {}), ...($('#oKey', el).value ? { apiKey: $('#oKey', el).value } : {}), model: $('#oModel', el).value, voice: $('#oVoice', el).value, speed: Number($('#oSpeed', el).value), instructions: $('#oInstr', el).value });
  $('#oTest', el).addEventListener('click', async () => {
    const out = $('#oRes', el); out.className = 'testres wait'; out.textContent = 'بيختبر…';
    try { const r = await api('/api/test/openaiTts', { method: 'POST', body: JSON.stringify(oai()) }); out.className = 'testres ' + (r.ok ? 'ok' : 'bad'); out.textContent = (r.ok ? '✔ ' : '✖ ') + r.message; }
    catch (e) { out.className = 'testres bad'; out.textContent = '✖ ' + e.message; }
  });
  $('#vSave', el).addEventListener('click', () => act(() => api('/api/settings', { method: 'PUT', body: JSON.stringify({
    tts: { provider: el.querySelector('[name=vProv]:checked').value }, openaiTts: oai(),
    elevenlabs: { voiceId: $('#vVoice', el).value, modelId: $('#vModel', el).value, speed: Number($('#vSpeed', el).value), stability: Number($('#vStab', el).value), style: Number($('#vStyle', el).value) },
    pronunciation: $('#vPron', el).value, look: { theme: S.look.theme, typography: { ...(S.look.typography || {}), captions: $('#vCaps', el).checked } },
  }) }), 'اتحفظ'));

  const out = $('#arOut', el);
  const text = () => $('#arText', el).value;
  const showProposal = (r) => {
    out.innerHTML = `<div class="proposal"><div class="diff" dir="auto">${diffHtml(r.diff)}</div>
      ${r.warnings?.length ? `<p class="warn">${r.warnings.map(esc).join('<br>')}</p>` : ''}
      <div class="tools"><button class="primary" id="arUse">استخدم النتيجة</button><button id="arCopy">نسخ</button></div></div>`;
    $('#arUse', el).addEventListener('click', () => { $('#arText', el).value = r.text; out.innerHTML = ''; });
    $('#arCopy', el).addEventListener('click', () => navigator.clipboard?.writeText(r.text).then(() => toast('اتنسخ')));
  };
  $('#arAnalyze', el).addEventListener('click', async () => {
    const r = await act(() => api('/api/arabic/analyze', { method: 'POST', body: JSON.stringify({ text: text() }) }));
    if (!r) return;
    const S2 = r.scores, L = { egyptian: 'مصري', levantine: 'شامي', gulf: 'خليجي', maghrebi: 'مغاربي', msa: 'فصحى' };
    out.innerHTML = `<p>اللهجة: <b>${esc(r.label)}</b> (${Object.entries(S2).filter(([, v]) => v).map(([k, v]) => `${L[k]} ${v}`).join(' · ') || 'مفيش مؤشرات'}${r.colloquial ? ` · عامي عام ${r.colloquial}` : ''}) · ${r.words} كلمة · ${r.sentences.length} جملة · مصطلحات إنجليزي: ${r.latinTerms} · ${r.tashkeel ? 'فيه تشكيل' : 'من غير تشكيل'}</p>`;
  });
  $$('[data-local]', el).forEach((b) => b.addEventListener('click', async () => { const r = await act(() => api('/api/arabic/' + b.dataset.local, { method: 'POST', body: JSON.stringify({ text: text() }) })); if (r) showProposal(r); }));
  $$('[data-op]', el).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; out.innerHTML = '<p class="hint">الـ LLM بيشتغل…</p>';
    const r = await act(() => api('/api/arabic/' + b.dataset.op, { method: 'POST', body: JSON.stringify({ text: text() }) }));
    b.disabled = false;
    if (r) showProposal(r); else out.innerHTML = '';
  }));
}
