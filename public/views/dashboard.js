// Dashboard: health of every connection, library counts, recent projects and quick actions.
import { esc, api } from '../ui.js';

const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
export async function mountDashboard(el, { openProject }) {
  const [health, { projects }, assets, fonts, { skills }, prov, S, yt] = await Promise.all([
    api('/api/health'), api('/api/projects'), api('/api/assets?per=1'), api('/api/fonts'), api('/api/skills'), api('/api/providers'), api('/api/settings'), api('/api/youtube'),
  ]);
  const done = projects.filter((p) => p.statuses.render === 'done').length;
  const conn = [
    ['ffmpeg', !!health.ffmpeg, health.ffmpeg ? 'موجود' : 'مش موجود — الرندر مش هيشتغل'],
    ['LLM', !!S.llm.baseUrl, S.llm.baseUrl],
    ['ElevenLabs', S._source['elevenlabs.apiKey'] !== 'none' && !!S.elevenlabs.voiceId, S.elevenlabs.voiceId ? 'صوت متحدد' : 'مفيش صوت متحدد'],
    ['Deepgram', S._source['deepgram.apiKey'] !== 'none', 'للملفات الصوتية المرفوعة'],
    ...Object.values(prov).map((p) => [p.name, p.configured, p.configured ? 'متوصل' : 'مفيش مفتاح']),
    ['YouTube', yt.linked, yt.linked ? `«${yt.channel?.title || ''}»` : 'مش مربوط'],
  ];
  el.innerHTML = `
    <div class="stats">
      <a class="stat" href="#/projects"><b>${projects.length}</b><span>مشروع</span><small>${done} فيديو جاهز</small></a>
      <a class="stat" href="#/library"><b>${assets.total}</b><span>ملف في المكتبة</span><small>${assets.folders.length} فولدر</small></a>
      <a class="stat" href="#/fonts"><b>${fonts.fonts.length}</b><span>خط عربي</span><small>كلها مرخّصة للتضمين</small></a>
      <a class="stat" href="#/skills"><b>${skills.filter((s) => s.enabled).length}</b><span>مهارة مفعّلة</span><small>من ${skills.length}</small></a>
    </div>
    <div class="cols2">
      <div class="panel"><div class="phead"><h3>آخر المشاريع</h3><div class="btns"><a class="btnlink" href="#/projects">＋ ريل جديد</a></div></div>
        <ul class="projects">${projects.slice(0, 8).map((p) => `<li data-id="${esc(p.id)}"><div class="t">${esc(p.title || p.topic)}</div>
          <div class="m">${STAGES.map((s) => `<span class="pip ${esc(p.statuses[s])}"></span>`).join('')} · ${esc(p.createdAt.slice(0, 10))}</div></li>`).join('') || '<li class="hint">لسه مفيش مشاريع.</li>'}</ul></div>
      <div class="panel"><h3>الاتصالات</h3>
        <ul class="conn">${conn.map(([n, ok, d]) => `<li><span class="${ok ? 'ok' : 'bad'}">${ok ? '●' : '○'}</span> <b>${esc(n)}</b> <span class="hint">${esc(d)}</span></li>`).join('')}</ul>
        <p class="hint">الخط الافتراضي: ${esc(health.fonts.regular)} · كل حاجة بتشتغل على جهازك؛ المفاتيح عمرها ما بتوصل للمتصفح.</p></div>
    </div>`;
  el.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => openProject(li.dataset.id)));
}
