<div align="center">

# 🎬 Reel Studio

**A local-first AI studio for Arabic explainer videos — a topic in, a finished MP4 out, nothing leaves your machine.**

`Node ≥ 20` · `Windows · macOS · Linux` · `MIT` · `Offline test mode`

[العربية ↓](#العربية) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Long-form](#long-form-video) · [Editor](#editor) · [Tests](#tests) · [License](#license)

</div>

> Topic → research → script → voice → timing → storyboard → editor → render → MP4 / SRT / VTT → YouTube
>
> Keys are stored encrypted on your disk and **never reach the browser**.

| At a glance | |
|---|---|
| **Length** | 10 seconds to **30 minutes** |
| **Storyboard** | up to **30 scenes** per storyboard |
| **Long-form** | automatic **chapters** (up to 24) with per-chapter progress |
| **Output** | MP4 (H.264 / H.265), SRT, VTT, contact sheet |
| **Engines** | Remotion (default) · Classic Canvas + Playwright |
| **Platforms** | Shorts · TikTok · Reels · 4:5 · square · 16:9 |

---

## Quick start

| | Windows | Linux / macOS |
|---|---|---|
| 1 | [Node.js 20+](https://nodejs.org/) | `node --version` (≥ 20) |
| 2 | `winget install Gyan.FFmpeg` | `brew install ffmpeg` / `apt install ffmpeg` |
| 3 | double-click **`start.bat`** | `npm run setup && npm start` |
| 4 | open `http://127.0.0.1:4301` | open `http://127.0.0.1:4301` |

`start.bat` runs `npm run setup` on first launch (installs Playwright + Chromium; falls back to your installed
Chrome/Edge if the download fails), then starts the app.

Then open **⚙ Settings** and add the keys you need:

- **LLM** — [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) at `http://127.0.0.1:31415/v1` (the default), or any OpenAI-compatible API.
- **Voice** — either **ElevenLabs** (best captions: per-character timestamps) or an **OpenAI-compatible** `/audio/speech` endpoint.
  Uploaded voice-overs use **Deepgram** for word timing (otherwise timing is estimated from pauses).
- **Stock libraries** (optional) — Pexels, Pixabay, Unsplash. Without them, scenes are drawn with icons.
- **YouTube** (optional) — OAuth client for direct publishing.
- **Svix** (optional) — outbound webhooks for project events.

## How it works

| Stage | What it does |
|---|---|
| **Script** | Optional research notes shown as **unverified**; the writer may not invent numbers. Egyptian / Levantine / Gulf / MSA, following `references/script-style.md`. |
| **Voice** | ElevenLabs `with-timestamps` with your speed and stability, plus a pronunciation dictionary — or upload your own recording. |
| **Timing** | Character-level LCS alignment so captions keep the script's spelling; Deepgram for uploads. Exports **SRT / VTT**. |
| **Storyboard** | JSON scenes auto-repaired, then self-reviewed. Photo/video scenes pick a licensed asset from your library. |
| **Render** | The engine manager picks **Remotion** (default) or the **Classic** canvas engine; both draw with the same renderer as the preview (SSIM 0.995). H.264/H.265, −14 LUFS mix, verified with ffprobe. |

**Templates:** `zoom` · `flow` · `cycle` · `timeline` · `chart` · `layers` · `cards` · `meter` · `body` · `photo` · `type`

## Long-form video

- Durations go up to **1800 s (30 min)**; a storyboard holds up to **30 scenes**.
- TTS projects **≥ 90 s** are planned as chapters of ~120 s (2–24 chapters, each ≥ 45 s). `chapters: true` + `chapterSeconds` forces chapters at any length (5–600 s).
- Every chapter is a small project of its own: script → voice → timing → storyboard → render, with its own files and its own progress.
  A cancelled or crashed run **resumes at the first unfinished chapter**.
- Chapters are joined with the **video copied** (exact frame count) and each chapter's audio **trimmed/padded to its video
  length** before one AAC encode, so captions keep their offsets. Measured end to end: 5 chapters → 5.8 min, 8390 frames,
  **3 ms median sync / 6 ms p90, 0 ms drift**. Music is mixed once over the joined video.
- Timeline edits are distributed to the chapters; the subtitle clock follows the joined timeline.
- An **uploaded** voice-over still renders as one pass. See [`docs/LONGFORM.md`](docs/LONGFORM.md).

## Editor

A multi-track timeline: **scenes · images/video · text overlays · captions · voice (waveform) · music · independent audio tracks**.

- **Scenes:** drag an edge to change its start (snaps to word onsets), drop a scene on another to swap content, split/merge at the playhead, change template, title, items, image and background.
- **Overlays:** text, images or video with position, size, motion, opacity and a volume level; drag to move or trim.
- **Keyframes & layers:** x/y, scale, opacity and rotation keyframes with easing; layer order (front/forward/backward/back).
- **Snapping & grid:** snaps to word/scene/overlay/clip edges and the playhead; optional 0.25 / 0.5 / 1 s grid.
- **Independent audio tracks:** any library sound with level, in/out points and fades. *(Preview is silent for these; they land in the final render.)*
- **Captions:** drag any word to retime it, or edit its text.
- **Order:** drag a slice of the audio to move it earlier/later, insert a silence (picture freezes, music continues), or reset.
- **Platforms:** each platform sets size and fps, shows the app's "safe area", and warns when the video exceeds its limit.
- **Cut from text:** set I/O and cut — picture, voice, captions and subtitles are cut together; deleted slices stay visible and clickable to restore.
- **Export:** 9:16 / 4:5 / 1:1 / 16:9 · 720p / 1080p · 24/25/30/60 fps · draft/normal/high · trim in/out.
- Undo/redo, space to play, Delete to remove, autosave. **The preview is the render.**

## Arabic

- **Shaping & joining:** text is drawn by Chromium (HarfBuzz shaping, ICU BiDi). A test asserts real Arabic joins and that «لا» forms a ligature.
- **Captions:** each word lights up at its own onset; word order inside the line follows UAX #9 per word, so `DNA polymerase` and digits read correctly inside an Arabic sentence.
- **Subtitles:** SRT/VTT carry RLM marks and a BOM (correct numbering in players, works on Windows).
- **Kashida:** "justify with kashida" stretches caption lines with ـ between joinable letters, without widening spaces.
- **Dialects:** detects Egyptian / Levantine / Gulf / Maghrebi / MSA; scripts can be written in or converted between them.
- **Fonts:** Cairo · Tajawal · Amiri · Noto Sans/Naskh/Kufi Arabic · Scheherazade New · Reem Kufi · Aref Ruqaa · IBM Plex Sans Arabic — all OFL, in `assets/fonts`.

## Render engines

- **Remotion** (default): the video is a React composition; Remotion captures frames and **our ffmpeg** encodes them.
- **Classic** (Canvas + Playwright): about 2× faster on the same machine, same pixels. Pick it in Settings or the editor bar.
- If the chosen engine fails, the render **falls back** to the classic engine and records why. Renders queue (one at a time by
  default, 8 GB friendly) and every job can be cancelled.
- Scenes are validated against JSON Schema before rendering, and any scene can be regenerated with AI (with a hint) from the editor.
- Details, benchmarks and the HyperFrames evaluation: [`docs/RENDERING.md`](docs/RENDERING.md).

## Security

- The server listens on `127.0.0.1` only, with Host checks (DNS rebinding) and Origin checks (CSRF).
- Keys are masked in the UI and **encrypted at rest** (AES-256-GCM); the key is bound to your account via Windows DPAPI, `RS_VAULT_KEY`, or an owner-only file. Settings, YouTube tokens and MCP config are written atomically with mode 0600.
- `data/logs/server.log` is JSON and secrets/tokens are redacted from it.
- Uploads are validated by magic bytes (not the name), size-limited and streamed to disk; library images are downloaded only from the official stock hosts (no SSRF).
- **Skills contain no code.** MCP is HTTP-only, every tool starts disabled, and arguments are checked against the tool's schema.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RS_PORT` | `4301` | HTTP port (loopback only) |
| `RS_DATA_DIR` | `./data` | projects, library, fonts, skills, logs |
| `RS_MAX_RENDERS` | `1` | concurrent renders (integer 1–4) |
| `RS_MAX_UPLOAD_MB` | `200` | voice-over upload limit (1–2000) |
| `RS_RENDER_WORKERS` | auto | classic-engine pages (1–4, reduced to fit free RAM) |
| `RS_REMOTION_CONCURRENCY` | auto | Remotion tabs (1–8, capped at 4) |
| `RS_REMOTION_GL` | engine default | `swangle` / `swiftshader` / `angle` |
| `RS_REMOTION_BROWSER` | Playwright's | path to a Chrome Headless Shell |
| `RS_STALL_SEC` | `120` | fail a segment that writes no frame for this long |
| `RS_FFMPEG_TIMEOUT_MIN` | `45` min | hard limit for one ffmpeg run (1–720) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | binaries to use |
| `RS_VAULT_KEY` | — | base64 32-byte key instead of the on-disk key file |
| `LLM_BASE_URL` / `ELEVENLABS_BASE_URL` / `DEEPGRAM_BASE_URL` | provider defaults | point them at a local mock or gateway |
| `SVIX_API_KEY` / `SVIX_BASE_URL` | — | outbound webhooks (optional) |

## Tests

All suites run offline against local mocks (`tools/mock-apis.mjs`):

```bash
npm test                  # unit · long-form · concat · Arabic · library · skills/MCP · vault · voice · engines · robustness · phase1 · webhooks
npm run test:readme       # this file: the English and Arabic versions have the same sections, commands and links
npm run e2e               # one 10 s reel end to end: format, −14 LUFS, sync, YouTube, cancel, re-run
npm run test:longform     # chapter planning, progress, resume, edit distribution (no render)
npm run test:concat       # join drift on real chapters (ffmpeg)
npm run test:qc           # post-join QC: frames, per-chapter sync, loudness spread
npm run test:longform-e2e # 3 chapters, real render + join (E2E_CHAPTERS/E2E_CHAPTER_SECONDS for a scale run)
npm run test:export       # editor → real video: 16:9 and 1:1, cuts, music, layers, clips, fonts, resume
npm run test:remotion     # same project on both engines: ffprobe, SSIM, animations, H.265, cancel
npm run test:ui           # browser: every view + editor operations (screenshots in output/ui/)
npm run templates         # contact sheet per template in output/templates/
npm run test:xss          # hostile strings everywhere in the UI — none executes
npm run test:a11y         # WCAG checks in the browser
npm run test:arabic-video # 5 real renders (Arabic / English / mixed / digits / long) checked from the MP4
npm run test:perf         # render timings and memory
npm run test:lowmem       # constrained-memory profile
npm run test:all          # everything
```

Run the whole app on the mocks:

```bash
npm run mock
LLM_BASE_URL=http://127.0.0.1:4399/v1 ELEVENLABS_BASE_URL=http://127.0.0.1:4399 DEEPGRAM_BASE_URL=http://127.0.0.1:4399 npm start
```

## Project layout

```text
server/      pipeline, stages, chapters, engines (remotion / legacy / ffmpeg), APIs, security
public/      UI, editor, canvas renderer, bidi/kashida, fonts
remotion/    the React composition used by the Remotion engine
assets/      OFL fonts + icons (with their licences)
tools/       offline mocks, tests, benchmarks
docs/        audit, rendering, long-form, performance, phase reports
data/        projects · assets · fonts · skills · logs        (git-ignored)
```

## Docs

- [`docs/LONGFORM.md`](docs/LONGFORM.md) — chapters, per-chapter progress, joining, measured sync
- [`docs/RENDERING.md`](docs/RENDERING.md) — engines, benchmarks, encoding, licence notes
- [`docs/AUDIT.md`](docs/AUDIT.md) — review, known limits, release list
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) · [`docs/PHASE-REPORT.md`](docs/PHASE-REPORT.md) · [`docs/PHASE0-AUDIT.md`](docs/PHASE0-AUDIT.md)

## License

- **Project code:** MIT — see [`LICENSE`](LICENSE). © 2026 **Rashid (Alking.ai)**.
- **Remotion** (`remotion`, `@remotion/*`): its own licence — free for individuals and companies up to 3 employees; a company
  licence is required above that or when selling the project: <https://remotion.dev/license>. See [`docs/RENDERING.md`](docs/RENDERING.md).
- **Arabic fonts** (IBM Plex Sans Arabic and others): SIL Open Font License 1.1 — full text in [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt).
- **Icons:** Tabler Icons, Health Icons and others under their own licences — see [`assets/icons/LICENSES.md`](assets/icons/LICENSES.md).

---

<div align="center">

# العربية

**استوديو محلي لصناعة الفيديوهات التعليمية بالعربي: من فكرة إلى MP4 جاهز، وكل حاجة على جهازك.**

`Node ≥ 20` · `ويندوز · ماك · لينكس` · `رخصة MIT` · `وضع اختبار بدون إنترنت`

[English ↑](#reel-studio) · [البدء السريع](#البدء-السريع) · [كيف يعمل](#كيف-يعمل) · [الفيديو الطويل](#الفيديو-الطويل) · [المحرر](#المحرر) · [الاختبارات](#الاختبارات) · [الرخصة](#الرخصة)

</div>

> الموضوع → بحث → سكريبت → صوت → توقيت → ستوري بورد → محرر → رندر → MP4 / SRT / VTT → يوتيوب
>
> المفاتيح بتتحفظ مشفّرة على جهازك و**عمرها ما بتوصل للمتصفح**.

| في سطر | |
|---|---|
| **المدة** | من 10 ثواني لحد **30 دقيقة** |
| **الستوري بورد** | لحد **30 مشهد** في الستوري بورد الواحد |
| **الفيديو الطويل** | **فصول** تلقائية (لحد 24) مع حفظ تقدم لكل فصل |
| **الناتج** | MP4 (H.264 / H.265)، SRT، VTT، contact sheet |
| **المحركات** | Remotion (الافتراضي) · الكلاسيكي Canvas + Playwright |
| **المنصات** | Shorts · TikTok · Reels · 4:5 · مربع · 16:9 |

---

## البدء السريع

| | ويندوز | لينكس / ماك |
|---|---|---|
| 1 | [Node.js 20+](https://nodejs.org/) | `node --version` (≥ 20) |
| 2 | `winget install Gyan.FFmpeg` | `brew install ffmpeg` / `apt install ffmpeg` |
| 3 | دبل كليك على **`start.bat`** | `npm run setup && npm start` |
| 4 | افتح `http://127.0.0.1:4301` | افتح `http://127.0.0.1:4301` |

`start.bat` بيعمل `npm run setup` أول مرة (يسطّب Playwright وChromium، ولو التحميل فشل بيستخدم Chrome أو Edge اللي على
جهازك)، وبعدين بيشغّل التطبيق.

بعد كده افتح **⚙ الإعدادات** وحط المفاتيح اللي محتاجها:

- **LLM** — [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) على `http://127.0.0.1:31415/v1` (الافتراضي)، أو أي API متوافق مع OpenAI.
- **الصوت** — إما **ElevenLabs** (الأدق للكابشن لأنه بيدّي توقيت كل حرف) أو أي API متوافق (`/audio/speech`).
  الصوت المرفوع بياخد التوقيت من **Deepgram** (ولو مفيش مفتاح، التوقيت بيتقدّر من السكتات).
- **مكتبات الصور** (اختياري) — Pexels وPixabay وUnsplash. من غيرها المشاهد بتترسم بالأيقونات.
- **يوتيوب** (اختياري) — OAuth للنشر المباشر.
- **Svix** (اختياري) — webhooks لأحداث المشروع.

## كيف يعمل

| المرحلة | بتعمل إيه |
|---|---|
| **السكريبت** | بحث مبدئي اختياري بيظهر **غير متحقق منه**، والكاتب ممنوع يخترع أرقام. مصري / شامي / خليجي / فصحى حسب `references/script-style.md`. |
| **الصوت** | ElevenLabs `with-timestamps` بالسرعة والثبات اللي اخترتهم، مع قاموس نطق — أو ارفع تسجيلك. |
| **التوقيت** | محاذاة LCS على مستوى الحروف فالكابشن بيفضل بإملاء السكريبت؛ Deepgram للملف المرفوع. تصدير **SRT / VTT**. |
| **الستوري بورد** | JSON للمشاهد بيتصلّح تلقائيًا وبعدها مراجعة ذاتية؛ مشاهد الصور/الفيديو بتاخد أصلًا مرخّصًا من مكتبتك. |
| **الرندر** | مدير المحركات بيختار **Remotion** (الافتراضي) أو **الكلاسيكي**؛ الاتنين بيرسموا بنفس رسّام المعاينة (SSIM 0.995). H.264/H.265، ميكس −14 LUFS، وفحص ffprobe قبل التسليم. |

**القوالب:** `zoom` · `flow` · `cycle` · `timeline` · `chart` · `layers` · `cards` · `meter` · `body` · `photo` · `type`

## الفيديو الطويل

- المدد لحد **1800 ثانية (30 دقيقة)**، والستوري بورد لحد **30 مشهد**.
- مشاريع TTS **≥ 90 ث** بتتقسم فصول حوالي 120 ث (من 2 لـ 24 فصل، كل فصل ≥ 45 ث). `chapters: true` + `chapterSeconds` بتفرض فصول بأي مدة (5–600 ث).
- كل فصل مشروع مصغّر: سكريبت → صوت → توقيت → ستوري بورد → رندر، بملفاته وتقدمه المستقل.
  لو الرندر اتلغى أو الجهاز وقف، التشغيل اللي بعده **بيكمّل من أول فصل ما خلصش**.
- الوصل: **الفيديو بيتنسخ** (عدد فريمات دقيق)، وصوت كل فصل **بيتقص/بيتحشى على مدة فيديوه** قبل ترميز AAC واحد،
  فالكابشن بيحافظ على توقيته. القياس الفعلي: 5 فصول → 5.8 دقيقة، 8390 فريم، **وسيط تزامن 3 ms / p90 = 6 ms، وانحراف 0 ms**.
  الموسيقى بتتخلط مرة واحدة على الفيديو المجموع.
- تعديلات الخط الزمني بتتوزّع على الفصول، وساعة الترجمة بتتبع الـ timeline المجموع.
- الصوت **المرفوع** لسه بيترندر مرة واحدة. التفاصيل في [`docs/LONGFORM.md`](docs/LONGFORM.md).

## المحرر

خط زمني متعدد المسارات: **المشاهد · صور/فيديو · نصوص · الكابشن · الصوت (waveform) · الموسيقى · مسارات صوت مستقلة**.

- **المشاهد:** اسحب الحافة لتغيير البداية (بتلزق على بداية الكلمة)، وأفلت مشهد على مشهد لتبديل المحتوى، واقسم/ادمج عند المؤشر، وغيّر القالب والعنوان والعناصر والصورة والخلفية.
- **عناصر فوق الفيديو:** نص أو صورة أو فيديو بالمكان والحجم والحركة والشفافية ومستوى صوت؛ اسحب للتحريك أو للقص.
- **كي فريمات وطبقات:** إزاحة أفقية/رأسية وحجم وشفافية ودوران بسلاسة (خطي / بطيء البداية / بطيء النهاية / الاتنين / ثبات)، وترتيب الطبقات.
- **مغناطيس وشبكة:** لزق على حواف الكلمات والمشاهد والعناصر والمقاطع والمؤشر، وشبكة 0.25 / 0.5 / 1 ث اختيارية.
- **مسارات صوت مستقلة:** أي صوت من المكتبة بمستوى وبداية ونهاية وظهور/اختفاء. *(المعاينة مش بتشغّلها؛ بتظهر في الرندر النهائي.)*
- **الكابشن:** اسحب أي كلمة لتظبيط توقيتها أو عدّل نصها.
- **الترتيب:** اسحب جزءًا من الصوت لتقديمه/تأخيره، أو أضف سكوت (الصورة بتقف والموسيقى بتكمّل)، أو ارجع للترتيب الأصلي.
- **المنصات:** كل منصة بتحدد المقاس والفريمات، وبتوريك «منطقة الأمان»، وبتنبّه لو الفيديو أطول من حدها.
- **قص من النص:** حدد I/O واقص — الصورة والصوت والكابشن والترجمة بيتقصّوا مع بعض، والمقطع المحذوف بيظهر وتقدر ترجّعه.
- **التصدير:** 9:16 / 4:5 / 1:1 / 16:9 · 720p / 1080p · 24/25/30/60 fps · مسودة/عادي/عالي · قص البداية والنهاية.
- تراجع/إعادة، ومسافة للتشغيل، وDelete للحذف، وحفظ تلقائي. **المعاينة هي نفس الرندر.**

## العربية

- **التشكيل والاتصال:** الرسم في Chromium (HarfBuzz للتشكيل و ICU BiDi للاتجاه)، وفيه اختبار بيتأكد إن الحروف متوصلة وإن «لا» بتطلع ligature.
- **الكابشن:** كل كلمة بتتلوّن في لحظة نطقها، وترتيب الكلمات في السطر بـ UAX #9 على مستوى الكلمة، فـ`DNA polymerase` والأرقام بيظهروا بترتيب القراءة الصح.
- **الترجمة:** SRT/VTT فيهم RLM وBOM (ترقيم صح في المشغلات، ويشتغلوا على ويندوز).
- **الكشيدة:** محاذاة «ضبط بالكشيدة» بتمد السطر بالتطويل بين الحروف اللي بتتوصل بس، من غير توسيع المسافات.
- **اللهجات:** كشف المصري والشامي والخليجي والمغاربي والفصحى، وكتابة/تحويل بينهم.
- **الخطوط:** Cairo · Tajawal · Amiri · Noto Sans/Naskh/Kufi Arabic · Scheherazade New · Reem Kufi · Aref Ruqaa · IBM Plex Sans Arabic — كلهم OFL وفي `assets/fonts`.

## محركات الرندر

- **Remotion** (الافتراضي): الفيديو composition بـ React، وRemotion بيصوّر الفريمات، و**ffmpeg بتاعنا** هو اللي بيشفّر.
- **الكلاسيكي** (Canvas + Playwright): أسرع حوالي مرتين على نفس الجهاز، ونفس الفيديو بالظبط. اختاره من الإعدادات أو من شريط المحرر.
- لو المحرك المختار فشل، الرندر بيكمّل **بالكلاسيكي** وبيسجّل السبب. الرندرات بتقف في طابور (واحد افتراضيًا، مناسب لـ 8 GB)، وكل واحد بيتلغى.
- المشاهد بتتفحص على JSON Schema قبل الرندر، وأي مشهد بيتولّد من جديد بالذكاء الاصطناعي (بتوجيه) من المحرر.
- التفاصيل والقياسات وتقييم HyperFrames: [`docs/RENDERING.md`](docs/RENDERING.md).

## الأمان

- السيرفر بيسمع على `127.0.0.1` بس، مع فحص Host (DNS rebinding) وOrigin (CSRF).
- المفاتيح بتظهر مخفية و**متشفرة على الديسك** (AES-256-GCM)؛ مفتاح التشفير مربوط بحسابك عبر DPAPI على ويندوز، أو `RS_VAULT_KEY`، أو ملف بصلاحية المالك. `settings.json` وتوكن يوتيوب وإعداد MCP بيتكتبوا atomic بصلاحية 0600.
- `data/logs/server.log` بصيغة JSON والمفاتيح/التوكنات بتتشال منه.
- الملفات المرفوعة بتتفحص من البايتات (مش الاسم)، وليها حد أقصى، وبتتكتب على الديسك مباشرة؛ صور المكتبات بتتحمّل من دومينات المكتبة الرسمية بس (مفيش SSRF).
- **المهارات مفيهاش كود.** MCP عبر HTTP بس، وكل أداة بتبدأ ممنوعة، والمدخلات بتتراجع على الـ schema.

## الإعدادات (متغيرات البيئة)

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `RS_PORT` | `4301` | بورت HTTP (loopback بس) |
| `RS_DATA_DIR` | `./data` | المشاريع والمكتبة والخطوط والمهارات واللوجات |
| `RS_MAX_RENDERS` | `1` | عدد الرندرات المتزامنة (1–4) |
| `RS_MAX_UPLOAD_MB` | `200` | حد رفع الصوت (1–2000) |
| `RS_RENDER_WORKERS` | تلقائي | صفحات المحرك الكلاسيكي (1–4، وبتقل حسب الرام الفاضية) |
| `RS_REMOTION_CONCURRENCY` | تلقائي | تابات Remotion (1–8، بحد أقصى 4) |
| `RS_REMOTION_GL` | افتراضي المحرك | `swangle` / `swiftshader` / `angle` |
| `RS_REMOTION_BROWSER` | نسخة Playwright | مسار Chrome Headless Shell |
| `RS_STALL_SEC` | `120` | فشل المقطع لو مفيش فريم جديد للمدة دي |
| `RS_FFMPEG_TIMEOUT_MIN` | `45` دقيقة | حد أقصى لتشغيل ffmpeg واحد (1–720) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | مسار الأدوات |
| `RS_VAULT_KEY` | — | مفتاح base64 32 بايت بدل ملف المفتاح |
| `LLM_BASE_URL` / `ELEVENLABS_BASE_URL` / `DEEPGRAM_BASE_URL` | افتراضي المزود | توجيههم لموك محلي أو gateway |
| `SVIX_API_KEY` / `SVIX_BASE_URL` | — | webhooks (اختياري) |

## الاختبارات

كل الاختبارات بتشتغل بدون إنترنت على mocks محلية (`tools/mock-apis.mjs`):

```bash
npm test                  # unit · long-form · concat · Arabic · library · skills/MCP · vault · voice · engines · robustness · phase1 · webhooks
npm run test:readme       # this file: the English and Arabic versions have the same sections, commands and links
npm run e2e               # ريل 10 ث كامل: الصيغة، −14 LUFS، التزامن، يوتيوب، الإلغاء، إعادة المراحل
npm run test:longform     # تخطيط الفصول والتقدم والاستكمال وتوزيع التعديلات (بدون رندر)
npm run test:concat       # انحراف الوصل على فصول حقيقية (ffmpeg)
npm run test:qc           # فحص بعد الوصل: الفريمات وتزامن كل فصل وتشتت الجهارة
npm run test:longform-e2e # 3 فصول برندر ووصل حقيقي (E2E_CHAPTERS / E2E_CHAPTER_SECONDS لمقياس أكبر)
npm run test:export       # المحرر ← فيديو حقيقي: 16:9 و1:1، القص، الموسيقى، الطبقات، الكليبات، الخطوط، الاستكمال
npm run test:remotion     # نفس المشروع على المحركين: ffprobe وSSIM والحركات وH.265 والإلغاء
npm run test:ui           # المتصفح: كل الأقسام وعمليات المحرر (screenshots في output/ui/)
npm run templates         # contact sheet لكل قالب في output/templates/
npm run test:xss          # نصوص خبيثة في كل حاجة — ولا واحد بيتنفّذ
npm run test:a11y         # فحوص WCAG في المتصفح
npm run test:arabic-video # 5 رندرات حقيقية (عربي/إنجليزي/مختلط/أرقام/طويل) وفحص الفريمات من الـ MP4
npm run test:perf         # أزمنة الرندر والذاكرة
npm run test:lowmem       # بروفايل ذاكرة مقيّدة
npm run test:all          # كله
```

تشغيل التطبيق كله على الـ mocks:

```bash
npm run mock
LLM_BASE_URL=http://127.0.0.1:4399/v1 ELEVENLABS_BASE_URL=http://127.0.0.1:4399 DEEPGRAM_BASE_URL=http://127.0.0.1:4399 npm start
```

## بنية المشروع

```text
server/      خط الإنتاج والمراحل والفصول والمحركات (remotion / legacy / ffmpeg) والـ APIs والأمان
public/      الواجهة والمحرر ورسّام الـ canvas وbidi/kashida والخطوط
remotion/    الـ composition بتاع محرك Remotion
assets/      خطوط OFL + أيقونات (برخصها)
tools/       mocks وتests وbenchmarks
docs/        المراجعة والرندر والفيديو الطويل والأداء وتقارير المراحل
data/        المشاريع · المكتبة · الخطوط · المهارات · اللوجات   (مستثنى من git)
```

## التوثيق

- [`docs/LONGFORM.md`](docs/LONGFORM.md) — الفصول والتقدم والوصل والتزامن المقاس
- [`docs/RENDERING.md`](docs/RENDERING.md) — المحركات والقياسات والترميز وملاحظات الترخيص
- [`docs/AUDIT.md`](docs/AUDIT.md) — المراجعة والقيود المعروفة وقائمة الإصدار
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) · [`docs/PHASE-REPORT.md`](docs/PHASE-REPORT.md) · [`docs/PHASE0-AUDIT.md`](docs/PHASE0-AUDIT.md)

## الرخصة

- **كود المشروع:** MIT — النص الكامل في [`LICENSE`](LICENSE) · © 2026 **Rashid (Alking.ai)**.
- **Remotion** (`remotion` و`@remotion/*`): ترخيص مستقل — مجاني للأفراد والشركات حتى 3 موظفين، وترخيص شركة فوق ذلك أو عند
  بيع المشروع: <https://remotion.dev/license>. التفاصيل في [`docs/RENDERING.md`](docs/RENDERING.md).
- **الخطوط العربية** (IBM Plex Sans Arabic وغيرها): SIL Open Font License 1.1 — النص الكامل في [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt).
- **الأيقونات:** Tabler Icons وHealth Icons وغيرها بتراخيصها — التفاصيل في [`assets/icons/LICENSES.md`](assets/icons/LICENSES.md).
