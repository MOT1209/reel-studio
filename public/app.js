// Reel Studio v1 — UI (vanilla JS, RTL Arabic). All LLM/user text is inserted escaped.
const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
const STAGE_AR = { script: 'السكريبت', voice: 'الصوت', timing: 'التوقيت', storyboard: 'الستوري بورد', render: 'الرندر' };
const STATUS_AR = { idle: 'مستني', running: 'شغال…', review: 'مستني موافقتك', done: 'تمام', error: 'خطأ' };
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) && !(opts.body instanceof File) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || res.statusText);
  return body;
}

// ---------- state ----------
let current = null; // project (public)
let es = null; // EventSource
let selStage = 'script';
const live = { llm: { script: '', storyboard: '' }, progress: null, preview: null };

// ---------- health ----------
async function health() {
  try {
    const h = await api('/api/health');
    $('#health').innerHTML = `ffmpeg <span class="${h.ffmpeg ? 'ok' : 'bad'}">${h.ffmpeg ? '✔' : '✖ مش موجود'}</span> · الخط: ${esc(h.fonts.regular)}`;
  } catch (e) { $('#health').textContent = 'السيرفر مش بيرد'; }
}

// ---------- new project ----------
function renderNewApprovals() {
  $('#newApprovals').innerHTML = STAGES.map((s) => `<label class="row"><input type="checkbox" data-appr="${s}" ${s === 'script' ? 'checked' : ''}> ${STAGE_AR[s]}</label>`).join('');
}
document.querySelectorAll('input[name=voiceMode]').forEach((r) => r.addEventListener('change', () => {
  $('#voiceFile').hidden = $('input[name=voiceMode]:checked').value !== 'upload';
}));
$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#newErr').textContent = '';
  const voiceMode = $('input[name=voiceMode]:checked').value;
  const file = $('#voiceFile').files[0];
  if (voiceMode === 'upload' && !file) { $('#newErr').textContent = 'اختار ملف الصوت الأول.'; return; }
  const approvals = Object.fromEntries([...document.querySelectorAll('[data-appr]')].map((c) => [c.dataset.appr, c.checked ? 'wait' : 'auto']));
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: $('#topic').value, seconds: Number($('#seconds').value), approvals, voiceMode, autostart: voiceMode !== 'upload' }) });
    if (voiceMode === 'upload') {
      await api(`/api/projects/${p.id}/upload`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-Filename': encodeURIComponent(file.name) } });
      await api(`/api/projects/${p.id}/run`, { method: 'POST' });
    }
    $('#topic').value = '';
    await loadProjects();
    openProject(p.id);
  } catch (err) { $('#newErr').textContent = err.message; }
});

// ---------- project list ----------
async function loadProjects() {
  const { projects } = await api('/api/projects');
  $('#projects').innerHTML = projects.length ? projects.map((p) => `
    <li data-id="${esc(p.id)}" class="${current?.id === p.id ? 'active' : ''}">
      <div class="t">${esc(p.title || p.topic)}</div>
      <div class="m">${STAGES.map((s) => `<span class="pip ${esc(p.statuses[s])}" title="${STAGE_AR[s]}"></span>`).join('')} · ${p.seconds} ث · ${esc(p.createdAt.slice(0, 10))}</div>
    </li>`).join('') : '<li class="hint">لسه مفيش مشاريع.</li>';
  document.querySelectorAll('#projects li[data-id]').forEach((li) => li.addEventListener('click', () => openProject(li.dataset.id)));
}

// ---------- project view ----------
function openProject(id) {
  if (es) es.close();
  live.llm = { script: '', storyboard: '' }; live.progress = null; live.preview = null;
  es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
  es.addEventListener('state', (ev) => {
    const p = JSON.parse(ev.data);
    const first = !current || current.id !== p.id;
    current = p;
    if (first) selStage = STAGES.find((s) => ['running', 'review', 'error'].includes(p.stages[s].status)) || (p.stages.render.status === 'done' ? 'render' : 'script');
    if (p.running && selStage !== p.running && !userPicked) selStage = p.running;
    // don't wipe a field the user is typing in; re-render when they leave it
    const ae = document.activeElement;
    if (!first && ae && $('#stagePanel')?.contains(ae) && /^(TEXTAREA|INPUT)$/.test(ae.tagName) && ae.type !== 'file') {
      ae.addEventListener('blur', () => render(), { once: true });
      loadProjects();
      return;
    }
    render();
    loadProjects();
  });
  es.addEventListener('log', (ev) => {
    const { stage, line } = JSON.parse(ev.data);
    if (!current) return;
    current.stages[stage].log.push(line);
    if (stage === selStage) { const el = $('#log'); if (el) { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; } }
  });
  es.addEventListener('llm', (ev) => {
    const { stage, delta, reset } = JSON.parse(ev.data);
    if (reset) live.llm[stage] = '';
    if (delta) live.llm[stage] += delta;
    const el = $(`#stream-${stage}`);
    if (el) { el.textContent = live.llm[stage]; el.scrollTop = el.scrollHeight; }
  });
  es.addEventListener('progress', (ev) => {
    live.progress = JSON.parse(ev.data);
    const pct = (100 * live.progress.frame) / live.progress.total;
    const b = $('#renderBar'); if (b) b.style.width = pct.toFixed(1) + '%';
    const t = $('#renderPct'); if (t) t.textContent = `${live.progress.frame} / ${live.progress.total} فريم`;
  });
  es.addEventListener('preview', (ev) => {
    live.preview = 'data:image/jpeg;base64,' + JSON.parse(ev.data).jpeg;
    const img = $('#livePreview'); if (img) img.src = live.preview;
  });
}
let userPicked = false;

function render() {
  const p = current;
  if (!p) return;
  const running = p.running;
  $('#main').innerHTML = `
    <div class="phead">
      <div>
        <h2>${esc(p.script?.title || p.topic)}</h2>
        <div class="sub">${esc(p.topic)} · ${p.seconds} ثانية · ${p.voiceMode === 'upload' ? 'صوت مرفوع' : 'ElevenLabs'} · <span class="mono">${esc(p.id)}</span></div>
      </div>
      <div class="btns">
        ${running ? `<button id="btnCancel" class="danger">■ إلغاء (${STAGE_AR[running]})</button>` : `<button id="btnRun" class="primary">▶ كمّل</button>`}
        <button id="btnDelete" class="ghost danger">حذف</button>
      </div>
    </div>
    <div class="stages">
      ${STAGES.map((s, i) => {
        const st = p.stages[s];
        return `<div class="stage ${s === selStage ? 'sel' : ''}" data-stage="${s}">
          <div class="n">0${i + 1}</div>
          <div class="name">${STAGE_AR[s]}</div>
          <span class="badge ${st.status}">${STATUS_AR[st.status]}</span>
          ${s === 'render' && st.status === 'running' ? `<div class="bar"><i id="renderBar" style="width:${live.progress ? (100 * live.progress.frame / live.progress.total).toFixed(1) : 0}%"></i></div>` : ''}
          <label class="appr"><input type="checkbox" data-wait="${s}" ${p.approvals[s] === 'wait' ? 'checked' : ''}> استنى موافقتي</label>
        </div>`;
      }).join('')}
    </div>
    <div class="work">
      <div class="panel" id="stagePanel"></div>
      <div class="panel">
        <h3>السجل — ${STAGE_AR[selStage]}</h3>
        <div class="log" id="log"></div>
      </div>
    </div>`;
  const log = $('#log'); log.textContent = p.stages[selStage].log.join('\n') + '\n'; log.scrollTop = log.scrollHeight;
  $('#btnRun')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/run`, { method: 'POST' })));
  $('#btnCancel')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/cancel`, { method: 'POST' })));
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm('تحذف المشروع ده وكل ملفاته؟')) return;
    await act(() => api(`/api/projects/${p.id}`, { method: 'DELETE' }));
    if (es) es.close(); current = null; $('#main').innerHTML = '<div class="empty">اتحذف.</div>'; loadProjects();
  });
  document.querySelectorAll('.stage').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.matches('input')) return;
    selStage = el.dataset.stage; userPicked = true; render();
  }));
  document.querySelectorAll('[data-wait]').forEach((c) => c.addEventListener('change', () =>
    act(() => api(`/api/projects/${p.id}/approvals`, { method: 'PUT', body: JSON.stringify({ [c.dataset.wait]: c.checked ? 'wait' : 'auto' }) }))));
  renderStagePanel();
}

async function act(fn) {
  try { await fn(); } catch (e) { alert(e.message); }
}

function stageButtons(s) {
  const p = current, st = p.stages[s];
  const busy = p.running === s;
  return `<div class="tools">
    ${st.status === 'review' ? `<button class="primary" data-approve="${s}">✔ موافق — كمّل</button>` : ''}
    <button data-rerun="${s}" ${busy ? 'disabled' : ''}>↻ إعادة ${STAGE_AR[s]}</button>
    ${busy ? `<button class="danger" data-cancel>■ إلغاء</button>` : ''}
  </div>${st.error ? `<p class="err">${esc(st.error)}</p>` : ''}`;
}

function bindStageButtons() {
  const p = current;
  document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/stages/${b.dataset.approve}/approve`, { method: 'POST' }))));
  document.querySelectorAll('[data-rerun]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/stages/${b.dataset.rerun}/rerun`, { method: 'POST' }))));
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/cancel`, { method: 'POST' }))));
}

const fmt = (t) => Number(t).toFixed(2);
function renderStagePanel() {
  const p = current, s = selStage, st = p.stages[s], el = $('#stagePanel');
  const file = (n) => `/api/projects/${encodeURIComponent(p.id)}/files/${n}?v=${encodeURIComponent(p.updatedAt || '')}`;
  let html = `<h3>${STAGE_AR[s]}</h3>${stageButtons(s)}`;
  if (s === 'script') {
    if (st.status === 'running' || (!p.script && live.llm.script)) html += `<div class="stream" id="stream-script">${esc(live.llm.script)}</div>`;
    if (p.script) {
      html += `<label>العنوان <input id="edTitle" value="${esc(p.script.title)}"></label>
        <label>السكريبت (كل سطر = جملة كابشن) — ${p.script.words} كلمة ≈ ${(p.script.words / 2.6).toFixed(0)} ث
          <textarea id="edText" rows="10">${esc(p.script.text)}</textarea></label>
        <label>المصادر (سطر لكل مصدر) <textarea id="edSources" rows="3" dir="auto">${esc((p.script.sources || []).join('\n'))}</textarea></label>
        <div class="tools"><button id="saveScript" ${p.running ? 'disabled' : ''}>💾 حفظ التعديل</button><span class="hint">الحفظ بيعيد المراحل اللي بعده.</span></div>`;
    }
  } else if (s === 'voice') {
    html += `<fieldset><legend>مصدر الصوت</legend>
      <label class="row"><input type="radio" name="vm" value="tts" ${p.voiceMode === 'tts' ? 'checked' : ''}> ElevenLabs</label>
      <label class="row"><input type="radio" name="vm" value="upload" ${p.voiceMode === 'upload' ? 'checked' : ''}> ملف مرفوع ${p.upload ? `— ${esc(p.upload.name || p.upload.file)}` : ''}</label>
      <input type="file" id="upVoice" accept="audio/*,video/mp4"> </fieldset>`;
    if (p.voice) html += `<audio controls src="${file('voice.mp3')}" style="width:100%"></audio><p class="hint">${fmt(p.voice.duration)} ث · ${p.voice.source}</p>`;
  } else if (s === 'timing') {
    if (p.words) {
      html += `<p class="hint">${p.words.length} كلمة · متوسط التطابق ${Math.round((p.timing?.matchAvg || 0) * 100)}% · <span style="color:var(--warning)">${p.timing?.weak || 0} ضعيفة</span> (عليها إطار برتقالي). تقدر تعدّل بداية أي كلمة بالثواني.</p>
        <div class="words">${p.words.map((w) => `<span class="word ${w.weak ? 'weak' : ''}">${esc(w.text)}<input data-w="${w.i}" value="${fmt(w.start)}"></span>`).join('')}</div>
        <div class="tools"><button id="saveTiming" ${p.running ? 'disabled' : ''}>💾 حفظ التوقيت</button></div>`;
    }
  } else if (s === 'storyboard') {
    if (st.status === 'running' || (!p.storyboard && live.llm.storyboard)) html += `<div class="stream mono" id="stream-storyboard">${esc(live.llm.storyboard)}</div>`;
    if (p.storyboard) {
      const words = p.words || [];
      html += `<div class="scenes">${p.storyboard.scenes.map((sc, i) => `<div class="scene"><b>${i + 1}. ${esc(sc.type)} / ${esc(sc.template)}</b> @ ${esc(words[sc.at]?.text || sc.at)} (${fmt(words[sc.at]?.start || 0)} ث) — ${esc(sc.title)}
        <span class="hint">${sc.items.map((it) => `${esc(it.label)}${it.icon ? ` [${esc(it.icon)}→${esc(p.iconKeys?.[it.icon] || '?')}]` : ''}`).join(' · ')}${sc.organ ? ` · organ: ${esc(sc.organ)}` : ''}${sc.value != null ? ` · ${sc.value}/${sc.max} ${esc(sc.unit)}` : ''}</span></div>`).join('')}</div>
        ${p.storyboardFixes?.length ? `<details><summary class="hint">تصليحات تلقائية (${p.storyboardFixes.length})</summary><ul class="fixes">${p.storyboardFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}
        <label>JSON (تقدر تعدّله) <textarea id="edSb" rows="12" class="mono">${esc(JSON.stringify(p.storyboard, null, 1))}</textarea></label>
        <div class="tools"><button id="saveSb" ${p.running ? 'disabled' : ''}>💾 حفظ وتحقق</button></div>
        <h4>معاينة حيّة (من غير رندر)</h4>
        <div class="preview"><iframe src="/render.html?project=${encodeURIComponent(p.id)}&play=1&v=${encodeURIComponent(p.updatedAt || '')}"></iframe></div>`;
    }
  } else if (s === 'render') {
    if (st.status === 'running') {
      html += `<div class="bar"><i id="renderBar" style="width:${live.progress ? (100 * live.progress.frame / live.progress.total).toFixed(1) : 0}%"></i></div><p class="hint" id="renderPct"></p>
        <div class="preview"><img id="livePreview" src="${live.preview || ''}" alt=""></div>`;
    } else if (p.render) {
      html += `<div class="preview"><video controls src="${file('video.mp4')}"></video></div>
        <div class="tools"><a href="${file('video.mp4')}" download="${esc(p.id)}.mp4"><button>⬇ تحميل MP4</button></a></div>
        <p class="hint">${fmt(p.render.duration)} ث · ${p.render.frames} فريم · 1080×1920 · H.264 · −14 LUFS</p>
        <h4>Contact sheet</h4><div class="preview"><img src="${file('contact.jpg')}" alt="contact sheet"></div>`;
    }
  }
  if (p.script?.sources?.length && s === 'render') html += `<div class="sources"><h4>المصادر</h4>${p.script.sources.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`;
  el.innerHTML = html;
  bindStageButtons();
  $('#saveScript')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/stages/script`, { method: 'PUT', body: JSON.stringify({ title: $('#edTitle').value, text: $('#edText').value, sources: $('#edSources').value.split('\n').map((x) => x.trim()).filter(Boolean) }) })));
  $('#saveTiming')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/stages/timing`, { method: 'PUT', body: JSON.stringify({ words: p.words.map((w) => ({ start: Number($(`[data-w="${w.i}"]`).value) })) }) })));
  $('#saveSb')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/stages/storyboard`, { method: 'PUT', body: JSON.stringify({ storyboard: $('#edSb').value }) })));
  document.querySelectorAll('input[name=vm]').forEach((r) => r.addEventListener('change', () => act(() => api(`/api/projects/${p.id}/voice-mode`, { method: 'PUT', body: JSON.stringify({ mode: r.value }) }))));
  $('#upVoice')?.addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    act(() => api(`/api/projects/${p.id}/upload`, { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'audio/mpeg', 'X-Filename': encodeURIComponent(f.name) } }));
  });
}

// ---------- settings ----------
const dlg = $('#settings');
function setField(name, v) { const el = $(`[name="${name}"]`, dlg); if (!el) return; if (el.tagName === 'SELECT') { if (v && ![...el.options].some((o) => o.value === v)) el.add(new Option(v, v)); el.value = v || ''; } else el.value = v ?? ''; }
async function openSettings() {
  $('#settingsErr').textContent = '';
  const s = await api('/api/settings');
  for (const sec of ['llm', 'elevenlabs', 'deepgram']) for (const [k, v] of Object.entries(s[sec])) {
    if (k === 'apiKey') { const el = $(`[name="${sec}.apiKey"]`, dlg); el.value = ''; el.placeholder = v ? `${v}  (${s._source[`${sec}.apiKey`]})` : 'مش متسجل'; }
    else setField(`${sec}.${k}`, v);
  }
  for (const [k, src] of Object.entries(s._source)) if (src === 'env (locked)') { const el = $(`[name="${k}"]`, dlg); if (el) { el.disabled = true; el.title = 'محدد من متغير بيئة'; } }
  setField('fontFolder', s.fontFolder); setField('seriesTag', s.seriesTag);
  dlg.showModal();
}
$('#btnSettings').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));
$('#btnSaveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  const body = { llm: {}, elevenlabs: {}, deepgram: {} };
  dlg.querySelectorAll('[name]').forEach((el) => {
    if (el.disabled) return;
    const [a, b] = el.name.split('.');
    if (b) { if (b === 'apiKey' && !el.value) return; body[a][b] = el.value; } else body[a] = el.value;
  });
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) }); dlg.close(); health(); }
  catch (err) { $('#settingsErr').textContent = err.message; }
});
$('#btnVoices').addEventListener('click', async () => {
  $('#voicesMsg').textContent = 'بيحمّل…';
  try {
    // save a newly typed key first so the server can use it
    const k = $('[name="elevenlabs.apiKey"]', dlg).value;
    if (k) await api('/api/settings', { method: 'PUT', body: JSON.stringify({ elevenlabs: { apiKey: k } }) });
    const { voices } = await api('/api/voices');
    const sel = $('#voiceSelect'), cur = sel.value;
    sel.innerHTML = voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.labels?.accent ? ' · ' + esc(v.labels.accent) : ''}</option>`).join('');
    if (cur && voices.some((v) => v.id === cur)) sel.value = cur;
    $('#voicesMsg').textContent = `${voices.length} صوت`;
  } catch (e) { $('#voicesMsg').textContent = e.message; }
});

// ---------- boot ----------
renderNewApprovals();
health();
loadProjects().then(() => {
  const id = new URLSearchParams(location.search).get('p');
  if (id) openProject(id);
});
