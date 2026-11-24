// AI Skills Manager + MCP servers (permissions per tool, call log).
import { $, $$, esc, api, act, toast, modal, diffHtml } from '../ui.js';

const CAT_AR = { arabic: 'العربي', writing: 'كتابة', publish: 'نشر', quality: 'جودة', custom: 'مخصصة' };

export async function mountSkills(el) {
  const [{ skills, runs }, { servers, calls }] = await Promise.all([api('/api/skills'), api('/api/mcp')]);
  el.innerHTML = `
    <div class="panel">
      <div class="phead"><h3>المهارات</h3><div class="btns">
        <button id="skNew" class="primary">＋ مهارة جديدة</button>
        <label class="btn">⬆ استيراد JSON<input type="file" id="skImp" accept=".json,application/json" hidden></label></div></div>
      <p class="hint">المهارة = تعليمات للـ LLM أو استدعاء أداة MCP مسموحة. <b>مفيش كود بيتنفّذ</b>، والنتيجة بتتراجع قبل أي استخدام.</p>
      <table class="tbl"><thead><tr><th></th><th>المهارة</th><th>النوع</th><th>الصلاحيات</th><th></th></tr></thead><tbody>
      ${skills.map((s) => `<tr data-sk="${esc(s.id)}" class="${s.enabled ? '' : 'off'}">
        <td><input type="checkbox" data-en ${s.enabled ? 'checked' : ''} title="تشغيل/إيقاف"></td>
        <td><b>${esc(s.name)}</b> <span class="hint">${esc(s.description || '')}</span><br><code dir="ltr">${esc(s.id)}</code> ${s.builtin ? '<span class="tag">جاهزة</span>' : ''} <span class="tag">${esc(CAT_AR[s.category] || s.category)}</span></td>
        <td>${s.kind === 'mcp' ? 'MCP' : s.kind === 'arabic' ? 'محرك العربي' : 'LLM'} → ${s.output?.type === 'json' ? 'JSON' : 'نص'}</td>
        <td dir="ltr">${(s.permissions || []).map(esc).join(', ')}</td>
        <td class="nowrap"><button class="small" data-run>تشغيل</button> <a class="btnlink small" href="/api/skills/${esc(s.id)}/export" download>تصدير</a> ${s.builtin ? '' : '<button class="small danger" data-del>حذف</button>'}</td></tr>`).join('')}
      </tbody></table>
      <details><summary>سجل التشغيل (${runs.length})</summary><div class="log">${runs.map((r) => `${esc(r.ts.slice(5, 19).replace('T', ' '))} ${r.ok ? '✔' : '✖'} ${esc(r.skill)} ${r.ms}ms — ${esc(r.out)}`).join('\n')}</div></details>
    </div>
    <div class="panel">
      <div class="phead"><h3>خوادم MCP</h3><div class="btns"><button id="mcNew">＋ إضافة خادم</button></div></div>
      <p class="hint">بس Streamable HTTP (مفيش تشغيل برامج على جهازك). كل أداة جديدة بتبدأ <b>ممنوعة</b> لحد ما تسمح بيها بنفسك، والمدخلات بتتراجع على الـ schema بتاعها.</p>
      <div id="mcList">${servers.length ? servers.map((s) => `
        <div class="mcp" data-mc="${esc(s.id)}">
          <div class="phead"><div><b>${esc(s.name)}</b> <code dir="ltr">${esc(s.url)}</code> ${s.serverInfo ? `<span class="hint">${esc(s.serverInfo.name)} ${esc(s.serverInfo.version || '')}</span>` : ''}
            <div class="hint">${s.lastSync ? 'آخر مزامنة ' + esc(s.lastSync.slice(0, 16).replace('T', ' ')) : 'لسه ما اتزامنش'} · headers: ${Object.keys(s.headers || {}).map(esc).join(', ') || '—'}</div></div>
            <div class="btns"><label class="row"><input type="checkbox" data-mcen ${s.enabled ? 'checked' : ''}> مفعّل</label><button class="small" data-sync>مزامنة الأدوات</button><button class="small danger" data-mdel>حذف</button></div></div>
          ${s.tools.length ? `<table class="tbl"><thead><tr><th>مسموح</th><th>الأداة</th><th>الوصف</th><th></th></tr></thead><tbody>${s.tools.map((t) => `<tr>
            <td><input type="checkbox" data-allow="${esc(t.name)}" ${s.allowedTools.includes(t.name) ? 'checked' : ''}></td><td dir="ltr"><code>${esc(t.name)}</code></td><td class="hint">${esc(t.description)}</td>
            <td><button class="small" data-try="${esc(t.name)}" ${s.allowedTools.includes(t.name) ? '' : 'disabled'}>تجربة</button></td></tr>`).join('')}</tbody></table>` : '<p class="hint">دوس «مزامنة الأدوات».</p>'}
        </div>`).join('') : '<p class="hint">مفيش خوادم.</p>'}</div>
      <details><summary>سجل استدعاءات MCP (${calls.length})</summary><div class="log">${calls.map((c) => `${esc(c.ts.slice(5, 19).replace('T', ' '))} ${c.ok ? '✔' : '✖'} ${esc(c.server)}/${esc(c.tool)} (${esc(c.by)}) ${c.ms}ms — ${esc(c.out)}`).join('\n')}</div></details>
    </div>`;
  const reload = () => mountSkills(el);

  $$('tr[data-sk]', el).forEach((tr) => {
    const id = tr.dataset.sk, sk = skills.find((s) => s.id === id);
    tr.querySelector('[data-en]').addEventListener('change', (e) => act(() => api('/api/skills/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) })).then(reload));
    tr.querySelector('[data-run]').addEventListener('click', () => runDialog(sk));
    tr.querySelector('[data-del]')?.addEventListener('click', async () => { if (confirm(`تحذف «${sk.name}»؟`)) { await act(() => api('/api/skills/' + id, { method: 'DELETE' })); reload(); } });
  });
  $('#skNew', el).addEventListener('click', () => editDialog(servers, reload));
  $('#skImp', el).addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let json; try { json = JSON.parse(await f.text()); } catch { toast('الملف مش JSON صالح', 'bad'); return; }
    const r = await act(() => api('/api/skills/import', { method: 'POST', body: JSON.stringify(json) }));
    if (r) { toast(`اتستورد ${r.imported.length}`); reload(); }
  });

  $$('[data-mc]', el).forEach((box) => {
    const id = box.dataset.mc, s = servers.find((x) => x.id === id);
    box.querySelector('[data-sync]').addEventListener('click', () => act(() => api(`/api/mcp/${id}/sync`, { method: 'POST' }), 'اتزامن').then(reload));
    box.querySelector('[data-mdel]').addEventListener('click', async () => { if (confirm(`تحذف ${s.name}؟`)) { await act(() => api('/api/mcp/' + id, { method: 'DELETE' })); reload(); } });
    box.querySelector('[data-mcen]').addEventListener('change', (e) => act(() => api(`/api/mcp/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) })).then(reload));
    box.querySelectorAll('[data-allow]').forEach((c) => c.addEventListener('change', () => {
      const allowed = [...box.querySelectorAll('[data-allow]:checked')].map((x) => x.dataset.allow);
      act(() => api(`/api/mcp/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ allowedTools: allowed }) }), c.checked ? `اتسمح بـ ${c.dataset.allow}` : `اتمنع ${c.dataset.allow}`).then(reload);
    }));
    box.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => tryTool(s, s.tools.find((t) => t.name === b.dataset.try))));
  });
  $('#mcNew', el).addEventListener('click', () => {
    const m = modal('إضافة خادم MCP', `<label>الاسم <input id="mName"></label><label>الرابط (Streamable HTTP) <input id="mUrl" dir="ltr" placeholder="https://example.com/mcp"></label>
      <label>Authorization (اختياري — بيتحفظ مخفي) <input id="mAuth" dir="ltr" placeholder="Bearer …" autocomplete="off"></label><div class="tools"><button class="primary" id="mOk">إضافة ومزامنة</button></div>`);
    $('#mOk', m.el).addEventListener('click', async () => {
      const r = await act(() => api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: $('#mName', m.el).value, url: $('#mUrl', m.el).value, headers: $('#mAuth', m.el).value ? { Authorization: $('#mAuth', m.el).value } : {} }) }));
      if (!r) return;
      m.close(); await act(() => api(`/api/mcp/${r.id}/sync`, { method: 'POST' })); reload();
    });
  });
}

function runDialog(sk) {
  const m = modal(`تشغيل: ${sk.name}`, `<label>${sk.input?.type === 'topic' ? 'الموضوع' : 'النص / السكريبت'} <textarea id="rIn" rows="6" dir="auto"></textarea></label>
    <div class="tools"><button class="primary" id="rGo">تشغيل</button></div><div id="rOut"></div>`, { wide: true });
  $('#rGo', m.el).addEventListener('click', async () => {
    $('#rOut', m.el).innerHTML = '<p class="hint">بيشتغل…</p>';
    const r = await act(() => api(`/api/skills/${sk.id}/run`, { method: 'POST', body: JSON.stringify({ input: $('#rIn', m.el).value }) }));
    if (!r) { $('#rOut', m.el).innerHTML = ''; return; }
    $('#rOut', m.el).innerHTML = (r.diff ? `<div class="diff" dir="auto">${diffHtml(r.diff)}</div>` : '')
      + (r.warnings?.length ? `<p class="warn">${r.warnings.map(esc).join('<br>')}</p>` : '')
      + `<pre class="out" dir="auto">${esc(r.json ? JSON.stringify(r.json, null, 2) : r.text)}</pre><p class="hint">${r.ms} ms${r.model ? ' · ' + esc(r.model) : ''}</p>`;
  });
}

function editDialog(servers, done) {
  const tools = servers.flatMap((s) => s.allowedTools.map((t) => ({ server: s.id, tool: t, label: `${s.name} / ${t}` })));
  const m = modal('مهارة جديدة', `
    <div class="two"><label>المعرّف (إنجليزي) <input id="eId" dir="ltr" placeholder="my-skill"></label><label>الاسم <input id="eName"></label></div>
    <label>الوصف <input id="eDesc"></label>
    <label>النوع <select id="eKind"><option value="prompt">تعليمات LLM</option><option value="mcp" ${tools.length ? '' : 'disabled'}>أداة MCP مسموحة${tools.length ? '' : ' (مفيش أدوات مسموحة)'}</option></select></label>
    <div id="ePrompt"><label>التعليمات — لازم تحتوي على <code>{{input}}</code> <textarea id="eTpl" rows="6" dir="auto">اكتب ملخص من 3 نقط للنص ده بالعامية المصرية:\n{{input}}</textarea></label>
      <div class="two"><label>المخرج <select id="eOut"><option value="text">نص</option><option value="json">JSON</option></select></label><label>مفاتيح JSON المطلوبة (بفاصلة) <input id="eReq" dir="ltr"></label></div></div>
    <div id="eMcp" hidden><label>الأداة <select id="eTool">${tools.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>
      <label>اسم المعامل اللي هياخد المدخل <input id="eArg" dir="ltr" value="query"></label></div>
    <div class="tools"><button class="primary" id="eSave">حفظ</button></div>`, { wide: true });
  $('#eKind', m.el).addEventListener('change', (e) => { $('#ePrompt', m.el).hidden = e.target.value !== 'prompt'; $('#eMcp', m.el).hidden = e.target.value !== 'mcp'; });
  $('#eSave', m.el).addEventListener('click', async () => {
    const kind = $('#eKind', m.el).value;
    const def = { id: $('#eId', m.el).value.trim(), name: $('#eName', m.el).value.trim(), description: $('#eDesc', m.el).value, kind, input: { type: 'text' } };
    if (kind === 'prompt') Object.assign(def, { prompt: $('#eTpl', m.el).value, output: { type: $('#eOut', m.el).value, required: $('#eReq', m.el).value.split(',').map((x) => x.trim()).filter(Boolean) } });
    else { const t = tools[$('#eTool', m.el).value]; Object.assign(def, { mcp: { server: t.server, tool: t.tool, args: { [$('#eArg', m.el).value || 'input']: '{{input}}' } }, output: { type: 'text' } }); }
    const r = await act(() => api('/api/skills', { method: 'POST', body: JSON.stringify(def) }), 'اتحفظت المهارة');
    if (r) { m.close(); done(); }
  });
}

function tryTool(s, t) {
  const props = Object.entries(t.inputSchema?.properties || {});
  const m = modal(`${s.name} / ${t.name}`, `<p class="hint">${esc(t.description)}</p>
    ${props.map(([k, p]) => `<label dir="ltr">${esc(k)} <span class="hint">${esc([].concat(p.type || 'any').join('|'))}${(t.inputSchema.required || []).includes(k) ? ' *' : ''}</span><input data-arg="${esc(k)}" data-type="${esc([].concat(p.type || 'string')[0])}"></label>`).join('') || '<p class="hint">من غير مدخلات.</p>'}
    <div class="tools"><button class="primary" id="tGo">تشغيل</button></div><pre class="out" id="tOut" dir="auto"></pre>`);
  $('#tGo', m.el).addEventListener('click', async () => {
    const args = {};
    $$('[data-arg]', m.el).forEach((i) => { if (i.value === '') return; args[i.dataset.arg] = ['number', 'integer'].includes(i.dataset.type) ? Number(i.value) : i.dataset.type === 'boolean' ? i.value === 'true' : i.value; });
    const r = await act(() => api(`/api/mcp/${s.id}/call`, { method: 'POST', body: JSON.stringify({ tool: t.name, arguments: args }) }));
    $('#tOut', m.el).textContent = r ? r.text : '';
  });
}
