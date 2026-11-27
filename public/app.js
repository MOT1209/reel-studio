// Reel Studio — UI shell (vanilla JS modules, RTL Arabic). All LLM/user text is inserted escaped.
import { $, esc, api, toast, diffHtml, act as actToast } from './ui.js';
import { mountEditor } from './editor.js';
import { mountGraph, STAGE_LABEL } from './graph.js';
import { mountLibrary } from './views/library.js';
import { mountFonts } from './views/fonts.js';
import { mountVoice } from './views/voice.js';
import { mountSkills } from './views/skills.js';
import { mountDashboard } from './views/dashboard.js';

const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
const STAGE_AR = STAGE_LABEL;
let FONTS = [];
let editor = null; // { pid, inst }

// ---------- views (hash routing) ----------
const VIEWS = { dashboard: (el) => mountDashboard(el, { openProject: (id) => { location.hash = '#/projects'; openProject(id); } }), library: (el) => mountLibrary(el), fonts: mountFonts, voice: mountVoice, skills: mountSkills };
async function route() {
  const v = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'projects';
  const name = v in VIEWS || v === 'projects' ? v : 'projects';
  if (name !== 'projects' && editor) closeEditor();
  document.querySelectorAll('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== name; });
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  if (VIEWS[name]) { const el = document.querySelector(`[data-view="${name}"]`); el.innerHTML = '<p class="hint">بيحمّل…</p>'; try { await VIEWS[name](el); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; } }
}
window.addEventListener('hashchange', route);
function closeEditor() { editor?.inst.destroy(); editor = null; document.querySelector('.layout')?.classList.remove('wide-editor'); }

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
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ topic: $('#topic').value, seconds: $('#seconds').value === 'auto' ? 'auto' : Number($('#seconds').value), approvals, voiceMode, autostart: voiceMode !== 'upload', options: { publish: !!$('#newPublish')?.checked, dialect: $('#dialect').value, research: $('#research').checked, platform: $('#newPlatform').value } }) });
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
      <div class="m">${STAGES.map((s) => `<span class="pip ${esc(p.statuses[s])}" title="${STAGE_AR[s]}"></span>`).join('')} · ${p.seconds === 'auto' ? 'أوتو' : p.seconds >= 90 ? Math.round(p.seconds / 60) + ' دقيقة' : p.seconds + ' ث'}${p.chapters ? ` · ${p.chapters} فصل` : ''} · ${esc(p.createdAt.slice(0, 10))}</div>
    </li>`).join('') : '<li class="hint">لسه مفيش مشاريع.</li>';
  document.querySelectorAll('#projects li[data-id]').forEach((li) => li.addEventListener('click', () => openProject(li.dataset.id)));
}

// ---------- project view ----------
function openProject(id) {
  if (es) es.close();
  if (editor && editor.pid !== id) closeEditor();
  live.llm = { script: '', storyboard: '' }; live.progress = null; live.preview = null;
  es = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
  es.addEventListener('state', (ev) => {
    const p = JSON.parse(ev.data);
    const first = !current || current.id !== p.id;
    current = p;
    if (first) selStage = STAGES.find((s) => ['running', 'review', 'error'].includes(p.stages[s].status)) || (p.stages.render.status === 'done' ? 'render' : 'script');
    if (p.running && selStage !== p.running && !userPicked && selStage !== 'editor') selStage = p.running;
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
    (stage === 'publish' ? (current.publish = current.publish || { log: [] }).log : current.stages[stage].log).push(line);
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
    const pg = JSON.parse(ev.data);
    if (pg.stage === 'publish') { const b = $('#pubBar'); if (b) b.style.width = pg.frame + '%'; return; }
    live.progress = pg;
    const pct = (100 * live.progress.frame) / live.progress.total;
    graph?.setProgress(pct);
    const b = $('#renderBar'); if (b) b.style.width = pct.toFixed(1) + '%';
    const t = $('#renderPct'); if (t) t.textContent = `${live.progress.frame} / ${live.progress.total} فريم`;
  });
  es.addEventListener('preview', (ev) => {
    live.preview = 'data:image/jpeg;base64,' + JSON.parse(ev.data).jpeg;
    const img = $('#livePreview'); if (img) img.src = live.preview;
  });
}
let userPicked = false;

/** A click on a canvas node selects the stage whose panel is shown below (the canvas itself writes nothing). */
function selectStage(s) {
  if (s === 'editor' && !(current && current.storyboard && current.words)) { toast('المحرر بيتفتح بعد ما الستوري بورد يخلص', 'bad'); return; }
  if (selStage === 'editor' && s !== 'editor') closeEditor();
  selStage = s; userPicked = true; render();
}
let graph = null; // the node canvas instance (kept so progress/state events patch it instead of rebuilding it)
let shellPid = null; // which project the shell (header + canvas host + body slot) was built for

/** Patch the canvas in place; rebuild it only when its shape changed (a stage or the publish node appeared). */
function refreshGraph(p) {
  const host = $('#graphHost');
  if (!host) return;
  if (graph && graph.host === host && graph.projectId === p.id && graph.update(p, selStage)) return;
  graph?.destroy();
  graph = mountGraph(host, p, { selected: selStage, onSelect: selectStage, onApproval: setApproval });
}

/** The project shell is built once per project: SSE state events patch it, they never wipe the canvas. */
function buildShell(p) {
  $('#main').innerHTML = `
    <div class="phead" id="phead">
      <div>
        <h2 id="ptitle"></h2>
        <div class="sub" id="psub"></div>
      </div>
      <div class="btns">
        <span id="runBtns"></span>
        <button class="ghost small" data-pall="auto" title="كل المراحل تكمّل لوحدها">كله تلقائي</button>
        <button class="ghost small" data-pall="wait" title="كل مرحلة تستنى موافقتك">كله بموافقتي</button>
        <button id="btnDelete" class="ghost danger">حذف</button>
      </div>
    </div>
    <div class="panel graph-card" id="graphHost"></div>
    <div id="projectBody"></div>`;
  shellPid = p.id;
  graph?.destroy(); graph = null; // the old host is gone with the old markup
  document.querySelectorAll('[data-pall]').forEach((b) => b.addEventListener('click', () =>
    act(() => api(`/api/projects/${current.id}/approvals`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(STAGES.map((s) => [s, b.dataset.pall]))) }))));
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm('تحذف المشروع ده وكل ملفاته؟')) return;
    await act(() => api(`/api/projects/${current.id}`, { method: 'DELETE' }));
    closeEditor(); if (es) es.close(); current = null; shellPid = null; graph?.destroy(); graph = null;
    $('#main').innerHTML = '<div class="empty">اتحذف.</div>'; loadProjects();
  });
}

function patchShell(p) {
  const title = $('#ptitle');
  if (title) title.textContent = p.script?.title || p.topic;
  const sub = $('#psub');
  if (sub) sub.innerHTML = `${esc(p.topic)} · ${p.seconds === 'auto' ? 'مدة أوتو' : p.seconds >= 90 ? Math.round(p.seconds / 60) + ' دقيقة' : p.seconds + ' ثانية'}${p.chapters?.length ? ` · ${p.chapters.length} فصول (${p.chapterProgress?.done || 0} خلصوا)` : ''} · ${p.voiceMode === 'upload' ? 'صوت مرفوع' : 'ElevenLabs'} · <span class="mono">${esc(p.id)}</span>`;
  const btns = $('#runBtns');
  if (btns) { btns.innerHTML = runBtns(p); bindRunBtns(p); }
}
function setApproval(stage, wait) {
  return act(() => api(`/api/projects/${current.id}/approvals`, { method: 'PUT', body: JSON.stringify({ [stage]: wait ? 'wait' : 'auto' }) }));
}

function render() {
  const p = current;
  if (!p) return;
  // the editor keeps its own state (and its preview iframe): only refresh the chrome around it
  if (selStage === 'editor' && editor?.pid === p.id && $('#editorHost')) {
    patchShell(p); refreshGraph(p);
    return;
  }
  if (shellPid !== p.id || !$('#phead')) buildShell(p);
  patchShell(p);
  refreshGraph(p);
  const layout = document.querySelector('.layout');
  if (selStage === 'editor') {
    layout?.classList.add('wide-editor'); // the editor needs the full width
    $('#projectBody').innerHTML = '<div id="editorHost"></div>';
    if (!FONTS.length) api('/api/fonts').then((r) => { FONTS = r.fonts; }).catch(() => {});
    editor = { pid: p.id, inst: mountEditor($('#editorHost'), p, { fonts: FONTS }) };
  } else {
    layout?.classList.remove('wide-editor');
    $('#projectBody').innerHTML = `<div class="work">
      <div class="panel" id="stagePanel"></div>
      <div class="panel">
        <h3>السجل — ${STAGE_AR[selStage]}</h3>
        <div class="log" id="log"></div>
      </div>
    </div>`;
    const log = $('#log'); log.textContent = p.stages[selStage].log.join('\n') + '\n'; log.scrollTop = log.scrollHeight;
    renderStagePanel();
  }
}
const runBtns = (p) => (p.running ? `<button id="btnCancel" class="danger">■ إلغاء (${STAGE_AR[p.running]})</button>` : `<button id="btnRun" class="primary">▶ كمّل</button>`);
function bindRunBtns(p) {
  $('#btnRun')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/run`, { method: 'POST' })));
  $('#btnCancel')?.addEventListener('click', () => act(() => api(`/api/projects/${p.id}/cancel`, { method: 'POST' })));
}

const act = (fn) => actToast(fn);

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
async function loadEstimate(pid) {
  const el = document.getElementById('estCard');
  if (!el) return;
  try {
    const { estimate: e } = await api(`/api/projects/${pid}/estimate`);
    // the render rate is measured, not promised: show the range (fast / slow end)
    const mins = (x) => (x < 1 ? '<1' : String(Math.round(x)));
    const lo = mins(e.renderMinutesMin ?? e.renderMinutes), hi = mins(e.renderMinutesMax ?? e.renderMinutes);
    const tokens = e.llmTokens >= 1000 ? `${Math.round(e.llmTokens / 1000)}k` : e.llmTokens;
    el.innerHTML = `تقدير قبل الرندر: <b>${lo === hi ? `~${hi}` : `${lo}–${hi}`} دقيقة</b> · ${e.words} كلمة · ${e.ttsCharacters} حرف TTS · ${tokens} توكن · ~${e.diskMB} MB`
      + (e.cost ? ` · <b>~$${e.cost.total}</b>` : '')
      + ` <span class="hint">(${esc(e.basis)})</span>`;
  } catch (err) { el.textContent = 'التقدير مش متاح: ' + err.message; }
}

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
        <div class="tools"><button id="saveScript" ${p.running ? 'disabled' : ''}>💾 حفظ التعديل</button><span class="hint">الحفظ بيعيد المراحل اللي بعده.</span></div>
        <div class="artools"><span class="hint">أدوات العربي على السكريبت:</span>
          <button class="small" data-arop="analyze">تحليل</button>
          <button class="small ai" data-arop="correct">✦ تصحيح</button><button class="small ai" data-arop="tashkeel">✦ تشكيل</button>
          <button class="small ai" data-arop="msa">✦ للفصحى</button><button class="small ai" data-arop="egyptian">✦ للمصري</button><button class="small ai" data-arop="levantine">✦ للشامي</button><button class="small ai" data-arop="gulf">✦ للخليجي</button><button class="small ai" data-arop="simplify">✦ تبسيط</button>
          <button class="small" data-arop="strip-tashkeel">شيل التشكيل</button></div>
        <div id="arProposal"></div>`;
    }
    if (p.research) {
      const C = { high: 'عالية', medium: 'متوسطة', low: 'ضعيفة' };
      html += `<details class="research" ${p.research.facts.length ? '' : 'hidden'}><summary>ملاحظات البحث — <b>غير متحقق منها</b> (${p.research.facts.length})</summary>
        <p class="warn">دي ملاحظات من الـ LLM للكاتب. اتأكد من أي معلومة من مصدر موثوق قبل النشر.</p>
        <ul>${p.research.facts.map((f) => `<li><span class="conf ${esc(f.confidence)}">${C[f.confidence] || ''}</span> <span dir="ltr">${esc(f.claim)}</span>${f.source ? ` <span class="hint">— مصدر للمراجعة: ${esc(f.source)}</span>` : ''}</li>`).join('')}</ul>
        ${p.research.misconceptions?.length ? `<p class="hint">مفاهيم غلط شائعة: ${p.research.misconceptions.map(esc).join(' · ')}</p>` : ''}</details>`;
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
        <div class="tools"><button id="saveTiming" ${p.running ? 'disabled' : ''}>💾 حفظ التوقيت</button>
          <a class="btnlink" href="/api/projects/${esc(p.id)}/subtitles.srt" download>⬇ ترجمة SRT</a><a class="btnlink" href="/api/projects/${esc(p.id)}/subtitles.vtt" download>⬇ ترجمة VTT</a></div>`;
    }
  } else if (s === 'storyboard') {
    if (st.status === 'running' || (!p.storyboard && live.llm.storyboard)) html += `<div class="stream mono" id="stream-storyboard">${esc(live.llm.storyboard)}</div>`;
    if (p.storyboard) {
      const words = p.words || [];
      html += `<div class="scenes">${p.storyboard.scenes.map((sc, i) => `<div class="scene"><b>${i + 1}. ${esc(sc.type)} / ${esc(sc.template)}</b> @ ${esc(words[sc.at]?.text || sc.at)} (${fmt(words[sc.at]?.start || 0)} ث) — ${esc(sc.title)}
        <span class="hint">${sc.items.map((it) => `${esc(it.label)}${it.icon ? ` [${esc(it.icon)}→${esc(p.iconKeys?.[it.icon] || '?')}]` : ''}`).join(' · ')}${sc.organ ? ` · organ: ${esc(sc.organ)}` : ''}${sc.value != null ? ` · ${sc.value}/${sc.max} ${esc(sc.unit)}` : ''}</span></div>`).join('')}</div>
        ${p.storyboardFixes?.length ? `<details><summary class="hint">تصليحات تلقائية (${p.storyboardFixes.length})</summary><ul class="fixes">${p.storyboardFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}
        <label>JSON (تقدر تعدّله) <textarea id="edSb" rows="12" class="mono">${esc(JSON.stringify(p.storyboard, null, 1))}</textarea></label>
        <div class="tools"><button id="saveSb" ${p.running ? 'disabled' : ''}>💾 حفظ وتحقق</button><button class="primary" data-goto="editor">✎ افتح في المحرر</button></div>
        <h4>معاينة حيّة (من غير رندر)</h4>
        <div class="preview"><iframe src="/render.html?project=${encodeURIComponent(p.id)}&play=1&v=${encodeURIComponent(p.updatedAt || '')}"></iframe></div>`;
    }
  } else if (s === 'render') {
    // before the render starts: what it will take (see /api/projects/:id/estimate)
    if (!p.render && st.status !== 'running') html += '<p class="hint" id="estCard">تقدير قبل الرندر: بنحسب…</p>';
    if (st.status === 'running') {
      html += `<div class="bar"><i id="renderBar" style="width:${live.progress ? (100 * live.progress.frame / live.progress.total).toFixed(1) : 0}%"></i></div><p class="hint" id="renderPct"></p>
        <div class="preview"><img id="livePreview" src="${live.preview || ''}" alt=""></div>`;
    } else if (p.render) {
      html += `<div class="preview"><video controls src="${file('video.mp4')}"></video></div>
        <div class="tools"><a href="${file('video.mp4')}" download="${esc(p.id)}.mp4"><button>⬇ تحميل MP4</button></a></div>
        <p class="hint">${fmt(p.render.duration)} ث · ${p.render.frames} فريم · ${p.render.width || 1080}×${p.render.height || 1920} (${esc(p.render.aspect || '9:16')}) · ${p.render.fps} fps · ${p.render.codec === 'h265' ? 'H.265' : 'H.264'}${p.render.bitrate ? ` ${p.render.bitrate / 1000} Mbps` : ''} · −14 LUFS${p.render.engine ? ` · محرك ${p.render.engine === 'remotion' ? 'Remotion' : 'كلاسيكي'}${p.render.fallbackFrom ? ` (بديل عن ${esc(p.render.fallbackFrom)})` : ''}${p.render.renderSeconds ? ` · ${p.render.renderSeconds} ث رندر` : ''}` : ''}${p.render.exported ? `<br>اتنسخ في: <span dir="ltr">${esc(p.render.exported)}</span>` : ''}</p>
        <div class="tools"><button data-goto="editor">✎ عدّل في المحرر</button><a class="btnlink" href="/api/projects/${esc(p.id)}/subtitles.srt" download>SRT</a><a class="btnlink" href="/api/projects/${esc(p.id)}/subtitles.vtt" download>VTT</a></div>
        ${p.render.credits?.length ? `<div class="sources"><h4>حقوق الصور والموسيقى (أضفها للوصف)</h4>${p.render.credits.map((c) => `<div dir="auto">${esc(c)}</div>`).join('')}</div>` : ''}
        <h4>Contact sheet</h4><div class="preview"><img src="${file('contact.jpg')}" alt="contact sheet"></div>`;
    }
  }
  if (s === 'render' && p.render) {
    const pb = p.publish || { status: 'idle', log: [] };
    html += '<div class="publish"><h4>النشر على يوتيوب</h4>';
    if (pb.status === 'done') html += '<p>✔ اتنشر (' + esc(pb.privacy) + ') على «' + esc(pb.channel?.title || '') + '»: <a href="' + esc(pb.url) + '" target="_blank" rel="noopener">' + esc(pb.url) + '</a></p>';
    if (pb.status === 'running') html += '<div class="bar"><i id="pubBar" style="width:' + Math.round((pb.progress || 0) * 100) + '%"></i></div><p class="hint">بيرفع… <button class="small danger" id="btnPubCancel">إلغاء</button></p>';
    if (pb.status === 'error') html += '<p class="err">' + esc(pb.error) + '</p>';
    if (pb.status !== 'running') html += '<div class="row2"><select id="pubPrivacy"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select>'
      + '<button id="btnPublish" class="primary">' + (pb.status === 'done' ? 'انشر نسخة تانية' : '⬆ انشر على يوتيوب') + '</button><span class="hint" id="pubHint"></span></div>';
    html += '<label class="row"><input type="checkbox" id="optPublish" ' + (p.options?.publish ? 'checked' : '') + '> انشر تلقائيًا لما الرندر يخلص</label>';
    if (pb.log?.length) html += '<div class="log">' + esc(pb.log.join('\n')) + '</div>';
    html += '</div>';
  }
  if (p.script?.sources?.length && s === 'render') html += `<div class="sources"><h4>المصادر</h4>${p.script.sources.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`;
  el.innerHTML = html;
  if (s === 'render' && !p.render && st.status !== 'running') loadEstimate(p.id);
  bindStageButtons();
  $('#btnPublish')?.addEventListener('click', async () => {
    const priv = $('#pubPrivacy').value;
    if (priv === 'public' && !confirm('هيتنشر Public على قناتك. متأكد؟')) return;
    act(() => api('/api/projects/' + p.id + '/publish', { method: 'POST', body: JSON.stringify({ privacy: priv }) }));
  });
  if ($('#pubPrivacy')) {
    api('/api/settings').then((st) => { $('#pubPrivacy').value = st.youtube?.privacy || 'private'; }).catch(() => {});
    loadYt().then((y) => { if (!y.linked && $('#btnPublish')) { $('#btnPublish').disabled = true; $('#pubHint').textContent = 'اربط قناتك الأول: الإعدادات ← يوتيوب'; } });
  }
  $('#btnPubCancel')?.addEventListener('click', () => act(() => api('/api/projects/' + p.id + '/publish/cancel', { method: 'POST' })));
  $('#optPublish')?.addEventListener('change', (e) => act(() => api('/api/projects/' + p.id + '/options', { method: 'PUT', body: JSON.stringify({ publish: e.target.checked }) })));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { selStage = b.dataset.goto; userPicked = true; render(); }));
  document.querySelectorAll('[data-arop]').forEach((b) => b.addEventListener('click', async () => {
    const op = b.dataset.arop, text = $('#edText').value, box = $('#arProposal');
    if (op === 'analyze') {
      const r = await act(() => api('/api/arabic/analyze', { method: 'POST', body: JSON.stringify({ text }) }));
      if (r) box.innerHTML = `<p class="hint">اللهجة: <b>${esc(r.label)}</b> · ${r.words} كلمة · ${r.sentences.length} جملة · ${r.latinTerms} مصطلح إنجليزي</p>`;
      return;
    }
    b.disabled = true; box.innerHTML = '<p class="hint">بيشتغل…</p>';
    const r = await act(() => api('/api/arabic/' + op, { method: 'POST', body: JSON.stringify({ text }) }));
    b.disabled = false;
    if (!r) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="proposal"><div class="diff" dir="auto">${diffHtml(r.diff)}</div>${r.warnings?.length ? `<p class="warn">${r.warnings.map(esc).join('<br>')}</p>` : ''}
      <div class="tools"><button class="primary" id="arApply">طبّق على السكريبت</button><button id="arDiscard">تجاهل</button><span class="hint">بعد التطبيق دوس «حفظ التعديل».</span></div></div>`;
    $('#arApply').addEventListener('click', () => { $('#edText').value = r.text; box.innerHTML = ''; toast('اتطبق — راجع ودوس حفظ'); });
    $('#arDiscard').addEventListener('click', () => { box.innerHTML = ''; });
  }));
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
const COLOR_AR = { bg: 'الخلفية', card: 'الكارت', elev: 'العناصر', text: 'النص', sec: 'نص ثانوي', accent: 'لون أساسي', blue: 'لون تاني', success: 'نجاح', warning: 'تحذير' };
let S = null; // last loaded public settings
const field = (name) => $(`[name="${name}"]`, dlg);
function setField(name, v) {
  const el = field(name); if (!el) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else if (el.tagName === 'SELECT') { const sv = String(v ?? ''); if (sv && ![...el.options].some((o) => o.value === sv)) el.add(new Option(sv, sv)); el.value = sv; }
  else el.value = v ?? '';
}
function showTab(name) {
  dlg.querySelectorAll('#setTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  dlg.querySelectorAll('.tab').forEach((t) => { t.hidden = t.dataset.tab !== name; });
}
dlg.querySelectorAll('#setTabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function renderColors(palette) {
  $('#colorGrid').innerHTML = Object.entries(palette).map(([k, v]) =>
    `<label><input type="color" data-color="${k}" value="${esc(v)}"> ${COLOR_AR[k] || k} <code>${esc(v)}</code></label>`).join('');
  $('#colorGrid').querySelectorAll('input').forEach((i) => i.addEventListener('input', () => { i.parentElement.querySelector('code').textContent = i.value.toUpperCase(); }));
}
$('#themeSelect').addEventListener('change', () => renderColors(S._themes[$('#themeSelect').value]));
$('#btnResetColors').addEventListener('click', () => renderColors(S._themes[$('#themeSelect').value]));
function renderDefApprovals(ap) {
  $('#defApprovals').innerHTML = STAGES.map((s) => `<label class="row"><input type="checkbox" data-defappr="${s}" ${ap[s] === 'wait' ? 'checked' : ''}> ${STAGE_AR[s]}</label>`).join('');
}
dlg.querySelectorAll('[data-defall]').forEach((b) => b.addEventListener('click', () => dlg.querySelectorAll('[data-defappr]').forEach((c) => { c.checked = b.dataset.defall === 'wait'; })));

let styleLoaded = false;
async function loadStyle() {
  const st = await api('/api/style');
  $('#styleText').value = st.style;
  styleLoaded = true;
  $('#examplesList').innerHTML = st.examples.length
    ? st.examples.map((e) => `<li><b dir="ltr">${esc(e.file)}</b><span>${esc(e.text.split('\n').slice(0, 3).join(' · '))}</span><button type="button" class="small danger" data-delex="${esc(e.file)}">حذف</button></li>`).join('')
    : '<li class="hint">لسه مفيش سكريبتات مرجعية.</li>';
  $('#examplesList').querySelectorAll('[data-delex]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('تحذف السكريبت المرجعي ده؟')) return;
    await act(() => api('/api/style/examples/' + encodeURIComponent(b.dataset.delex), { method: 'DELETE' }));
    loadStyle();
  }));
}
$('#btnAddExample').addEventListener('click', async () => {
  const text = $('#exText').value.trim();
  if (!text) return;
  await act(() => api('/api/style/examples', { method: 'POST', body: JSON.stringify({ name: $('#exName').value, text }) }));
  $('#exText').value = ''; $('#exName').value = '';
  loadStyle();
});

async function openSettings(tab = 'keys') {
  $('#settingsErr').textContent = '';
  dlg.querySelectorAll('.testres').forEach((x) => { x.textContent = ''; x.className = 'testres'; });
  S = await api('/api/settings');
  for (const sec of ['llm', 'elevenlabs', 'deepgram', 'youtube', 'pexels', 'pixabay', 'unsplash']) for (const [k, v] of Object.entries(S[sec])) {
    if (k === 'apiKey' || k === 'clientSecret' || k === 'accessKey') { const el = field(sec + '.' + k); el.value = ''; el.placeholder = v ? `${v}  (${S._source[`${sec}.${k}`]})` : 'مش متسجل';
      // explicit delete (only a key saved here can be deleted; one that comes from .env must be removed in .env)
      const key = `${sec}.${k}`; let del = el.parentElement.querySelector('[data-del-secret]');
      if (!del) { del = document.createElement('button'); del.type = 'button'; del.className = 'small danger'; del.dataset.delSecret = key; del.textContent = 'حذف المفتاح المحفوظ'; el.after(del);
        del.addEventListener('click', async () => {
          if (!confirm('تحذف المفتاح ده من الجهاز؟')) return;
          const r = await actToast(() => api(`/api/settings/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }), 'اتحذف المفتاح');
          if (r?.stillSetBy) toast('لسه موجود في ملف .env — شيله من هناك كمان', 'bad');
          openSettings(tab);
        }); }
      del.hidden = S._source[key] !== 'settings';
    }
    else setField(`${sec}.${k}`, v);
  }
  for (const [k, src] of Object.entries(S._source)) if (src === 'env (locked)') { const el = field(k); if (el) { el.disabled = true; el.title = 'محدد من متغير بيئة'; } }
  setField('fontFolder', S.fontFolder); setField('seriesTag', S.seriesTag);
  setField('look.theme', S.look.theme); setField('look.grid', S.look.grid !== false);
  renderColors(S._palette);
  setField('audio.sfxVolume', S.audio.sfxVolume); setField('audio.whoosh', S.audio.whoosh); setField('audio.tick', S.audio.tick);
  $('#sfxVal').textContent = Math.round(S.audio.sfxVolume * 100) + '%';
  setField('render.fps', S.render.fps); setField('render.aspect', S.render.aspect); setField('render.resolution', S.render.resolution); setField('render.quality', S.render.quality);
  setField('render.engine', S.render.engine || 'auto'); setField('render.maxJobs', String(S.render.maxJobs || 1)); setField('render.fallback', S.render.fallback !== false);
  setField('render.codec', S.render.codec || 'h264'); setField('render.bitrate', S.render.bitrate ? String(S.render.bitrate) : ''); setField('render.outputDir', S.render.outputDir || '');
  api('/api/engines?fresh=1').then((r) => {
    $('#engineStatus').textContent = r.engines.map((e) => `${e.available ? '✓' : '✖'} ${e.name}${e.available ? '' : ` — ${e.reason}`}`).join(' · ') + ` · H.265: ${r.codecs.h265 ? 'متاح' : 'مش في ffmpeg ده'}`;
  }).catch((e) => { $('#engineStatus').textContent = e.message; });
  setField('audio.musicVolume', S.audio.musicVolume ?? 0.25); setField('audio.duck', S.audio.duck !== false);
  renderDefApprovals(S.approvals);
  styleLoaded = false;
  showTab(tab);
  dlg.showModal();
  loadYt();
  loadStyle().catch((e) => { $('#settingsErr').textContent = e.message; });
}
field('audio.sfxVolume').addEventListener('input', (e) => { $('#sfxVal').textContent = Math.round(e.target.value * 100) + '%'; });
$('#btnSettings').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));

function collectSettings() {
  const body = { llm: {}, elevenlabs: {}, deepgram: {}, youtube: {}, pexels: {}, pixabay: {}, unsplash: {}, look: {}, audio: {}, render: {} };
  dlg.querySelectorAll('[name]').forEach((el) => {
    if (el.disabled) return;
    const [a, b] = el.name.split('.');
    const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    if (b) { if ((b === 'apiKey' || b === 'clientSecret' || b === 'accessKey') && !v) return; body[a][b] = v; } else body[a] = v;
  });
  // only colours that differ from the chosen preset are saved, so switching themes later stays clean
  const preset = S._themes[body.look.theme] || {};
  body.look.colors = {};
  dlg.querySelectorAll('[data-color]').forEach((i) => {
    if (i.value.toUpperCase() !== String(preset[i.dataset.color]).toUpperCase()) body.look.colors[i.dataset.color] = i.value;
  });
  body.approvals = Object.fromEntries([...dlg.querySelectorAll('[data-defappr]')].map((c) => [c.dataset.defappr, c.checked ? 'wait' : 'auto']));
  return body;
}
$('#btnSaveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectSettings()) });
    if (styleLoaded && $('#styleText').value.trim()) await api('/api/style', { method: 'PUT', body: JSON.stringify({ style: $('#styleText').value }) });
    dlg.close(); health(); applyDefaultApprovals();
  } catch (err) { $('#settingsErr').textContent = err.message; }
});
dlg.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
  const svc = b.dataset.test, out = $('#test-' + svc);
  out.className = 'testres wait'; out.textContent = 'بيختبر…';
  const body = {};
  dlg.querySelectorAll(`[name^="${svc}."]`).forEach((el) => { if (!el.disabled && el.value) body[el.name.split('.')[1]] = el.value; });
  try {
    const r = await api('/api/test/' + svc, { method: 'POST', body: JSON.stringify(body) });
    out.className = 'testres ' + (r.ok ? 'ok' : 'bad');
    out.textContent = (r.ok ? '✔ ' : '✖ ') + r.message;
    if (r.detail?.length) out.title = r.detail.join(', ');
  } catch (err) { out.className = 'testres bad'; out.textContent = '✖ ' + err.message; }
}));
$('#btnVoices').addEventListener('click', async () => {
  const out = $('#test-elevenlabs');
  out.className = 'testres wait'; out.textContent = 'بيحمّل…';
  try {
    const k = field('elevenlabs.apiKey').value; // save a newly typed key first so the server can use it
    if (k) await api('/api/settings', { method: 'PUT', body: JSON.stringify({ elevenlabs: { apiKey: k } }) });
    const { voices } = await api('/api/voices');
    const sel = $('#voiceSelect'), cur = sel.value;
    sel.innerHTML = voices.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.labels?.accent ? ' · ' + esc(v.labels.accent) : ''}</option>`).join('');
    if (cur && voices.some((v) => v.id === cur)) sel.value = cur;
    out.className = 'testres ok'; out.textContent = `✔ ${voices.length} صوت`;
  } catch (err) { out.className = 'testres bad'; out.textContent = '✖ ' + err.message; }
});

// ---------- youtube ----------
let YT = { linked: false };
async function loadYt() {
  try { YT = await api('/api/youtube'); } catch { YT = { linked: false }; }
  const box = $('#ytStatus');
  if (box) {
    box.innerHTML = YT.linked
      ? (YT.channel?.thumbnail ? '<img src="' + esc(YT.channel.thumbnail) + '" alt="">' : '') + '<span class="ok">✔ مربوط بقناة «' + esc(YT.channel?.title || '?') + '»</span>'
      : '<span class="bad">' + (YT.configured ? 'القناة مش مربوطة — دوس «حفظ واربط القناة»' : 'لسه مفيش Client ID و Client secret — اتبع الخطوات تحت') + '</span>';
    $('#btnYtUnlink').hidden = !YT.linked;
    $('#btnYtLink').textContent = YT.linked ? 'اربط قناة تانية' : 'حفظ واربط القناة';
    if (!YT.configured) $('#ytGuide').open = true;
  }
  const row = $('#newPublishRow');
  if (row) { $('#newPublish').disabled = !YT.linked; row.title = YT.linked ? '' : 'اربط قناتك من الإعدادات ← يوتيوب'; row.style.opacity = YT.linked ? 1 : 0.5; }
  return YT;
}
$('#btnYtLink').addEventListener('click', async () => {
  $('#settingsErr').textContent = '';
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectSettings()) });
    const st = await loadYt();
    if (!st.configured) { $('#settingsErr').textContent = 'اكتب Client ID و Client secret الأول.'; return; }
    window.open('/oauth/youtube/start', 'ytlink', 'width=520,height=720');
    const t0 = Date.now();
    const poll = setInterval(async () => {
      const s2 = await loadYt();
      if ((s2.linked && s2.channel?.id !== st.channel?.id) || Date.now() - t0 > 180000) clearInterval(poll);
    }, 2000);
  } catch (e) { $('#settingsErr').textContent = e.message; }
});
window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && 'youtube' in e.data) loadYt(); });
$('#btnYtUnlink').addEventListener('click', async () => {
  if (!confirm('تفك ربط القناة؟ مش هتقدر تنشر لحد ما تربطها تاني.')) return;
  await act(() => api('/api/youtube', { method: 'DELETE' }));
  loadYt();
});

// ---------- boot ----------
async function applyDefaultApprovals() {
  try {
    const st = await api('/api/settings');
    document.querySelectorAll('[data-appr]').forEach((c) => { c.checked = st.approvals?.[c.dataset.appr] === 'wait'; });
  } catch {}
}
document.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => document.querySelectorAll('[data-appr]').forEach((c) => { c.checked = b.dataset.all === 'wait'; })));
renderNewApprovals();
applyDefaultApprovals();
loadYt().then(async () => { try { const st = await api('/api/settings'); if (YT.linked) $('#newPublish').checked = !!st.youtube?.autoPublish; } catch {} });
health();
route();
loadProjects().then(() => {
  const id = new URLSearchParams(location.search).get('p');
  if (id) openProject(id);
});
