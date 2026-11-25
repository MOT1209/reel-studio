# Long-form production + production profiles (v3.2)

Phase goal (the master brief's top priority): take Reel Studio from ≤ 60 s reels to **videos of 15 s – 30 min** of any
production type, inside the **same** 5-stage pipeline — no second app, no rewritten engine.

## What a user gets

- **Production type** in the new-project form: reel/short, educational, documentary, story, cartoon, science/tech,
  cinematic, explainer, promo (`server/profiles.mjs`). A profile is data: the writer's brief, the visual direction,
  the scene pace, preferred templates, default length/platform, chapter size, recommended skills.
  `short` adds nothing to any prompt, so existing reels are generated exactly as before (tested by prompt hash).
- **Length**: the classic 10–60 s + auto, presets 2/3/5/10/15/20/30 min, or any custom length 10 s – 30 min.
  Categories: shorts ≤ 90 s · short ≤ 5 min · medium ≤ 15 min · long ≤ 30 min. A long video on a vertical platform is
  switched to 16:9 YouTube by default (both server and form).
- **From 2 minutes on, the script is chaptered**: an outline (N chapters ≈ one per profile chapter size, 2–15), then
  each chapter written separately with the outline + the end of the previous chapter for continuity.
- **Chapter management** (script stage panel and API): rename, edit text, reorder, delete, add (also by hand, with no
  LLM at all), regenerate one chapter with an optional note, approve chapters one by one (approving the last one
  approves the stage). Every operation that changes the narration invalidates voice → render, like any script edit.
- **Resume**: chapters are saved one by one; a cancel or crash resumes at the first unwritten chapter. The voice
  parts and storyboard windows are cached by content, so a resume — or an edit of one chapter — only pays for what
  changed. `↻ re-run` of the script means a new outline.
- **YouTube**: chapter timestamps are computed at render time in *output* time (trims, cuts and re-ordering applied),
  shown in the render panel, and written into the upload description when YouTube would accept them
  (first at 0:00, ≥ 3 chapters, ≥ 10 s each). Long videos no longer paste the whole narration into the description.

## How it works (what changed where)

| Stage | Short reel (unchanged) | Long-form |
|---|---|---|
| script | one LLM call | `[[TASK:OUTLINE]]` once + `[[TASK:CHAPTER]]` per chapter, checkpoint after each (`longScript`) |
| voice | one TTS request | `splitForTts` at line breaks (≤ 4500 chars ElevenLabs / 4000 OpenAI, `RS_TTS_MAX_CHARS`), each part cached in `voice-parts/<hash>.mp3`, decoded to PCM, placed back to back with exact sample offsets, one `voice.mp3`; ElevenLabs character times shifted by each part's offset (`voiceInParts`) |
| timing | exact char-level LCS | same LCS in **anchored windows** (`alignWindowed`): 1500-char windows, only the first 80 % of each committed, next window anchored after the last committed match. Deepgram timeout scales with the audio length |
| storyboard | one call + self-review | one call per ≈ 2-minute window of a chapter (≤ 16 scenes so the reply fits the token limit), cached by the window's words; every chapter starts on a scene; merged drafts go through the same `repairStoryboard` + JSON schema |
| render | segmented, resumable | unchanged engine; SFX track now **streamed** to disk; chapter marks in output time |

Files: `server/profiles.mjs`, `server/longform.mjs` (pure, offline-testable), `server/pipeline.mjs`
(`longScript`, `writeChapter`, `chapterOp`, `voiceInParts`, `longStoryboard`, `renderChapters`),
`server/text.mjs` (windowed alignment), `server/engines/ffmpeg.mjs` (`writeSfx`), `server/youtube.mjs`,
`server/index.mjs` (routes), `public/app.js` / `index.html` / `app.css` (form + chapter panel), `public/editor.js`
(zoom down to 1 px/s, long timelines open zoomed out, waveform drawn past the canvas limit, sparser ruler ticks).

API: `GET /api/profiles` · `POST /api/projects/:id/chapters` (add) · `PUT /api/projects/:id/chapters/:k` (edit) ·
`POST /api/projects/:id/chapters/:k/{rename,approve,move,delete,regenerate}`.

## Limits found and removed (each would have broken a 30-minute video)

| Limit | Effect before | Now |
|---|---|---|
| `LENGTHS` = 10…60 s | no video over 1 minute | any whole number of seconds 10–1800 |
| One TTS request for the whole script | provider per-request limit (5–10 k chars) ≈ 4–6 min max | parts, cached |
| `alignWords` threw above 4e7 cells | **timing failed beyond ≈ 2–3 min** of narration | windowed: 34.5 min aligned in ≈ 0.6 s, +20–60 MB, 100 % of words within 0.25 s on noisy synthetic TTS. A first windowed version drifted (half the words off by 6 s+) after one bad window tail — found by the test, fixed by committing 80 % per window |
| One storyboard call, ≤ 12 scenes | 30 min ⇒ 2.5-minute scenes, or a truncated JSON reply | windows of ≈ 2 min |
| Scene schema `maxItems: 60` scenes / 200 accents | **render refused** ("must NOT have more than 60 items") — found by the 30-min benchmark | 900 / 3000 |
| `writeSfx` built the whole WAV in RAM | ≈ 470 MB for 30 min | 10 s blocks, ≈ 33 MB, byte-identical output |
| Deepgram fixed 5-min timeout | uploaded/OpenAI voice > ~20 min could time out | scales with duration |
| Stock-photo search per photo scene, no limit | a documentary with ~100 photo scenes hammers a rate-limited provider | after 3 failures in a row the rest fall back to illustrated templates without requests |
| Editor zoom ≥ 20 px/s, waveform ≤ 30 000 px | 30 min ⇒ ≥ 36 000 px timeline, waveform cut at ~7 min (default zoom) | 1–240 px/s, opens fitted, waveform stretched |

## Measurements (this machine: 4 CPU, 16.9 GB, Node 22, offline mocks, legacy engine, 1280×720, 24 fps, draft)

`npm run bench:longform -- 1800 720 24 legacy` (`output/longform-bench.json`); memory = RSS of the server **and every
child** (3 Chromium pages + ffmpeg), sampled each second.

| Video | Chapters | Words | Frames | Frame render | Whole pipeline | Peak RSS server | Peak RSS server + children |
|---|---|---|---|---|---|---|---|
| 3.6 min | 2 | ~520 | 5 158 | 43 s | ~1.5 min | 326 MB | 1 809 MB |
| **35.7 min** | 9 | 4 707 | **51 401** | 472 s | ~13 min | **349 MB** | **1 985 MB** |

Ten times the length costs ~7 % more server memory and ~10 % more total memory: memory does not grow with duration;
time grows linearly (~109 fps frame capture). The finished MP4 was checked by ffprobe (exact frame count, h264/aac,
2141.71 s) and no temporary file was left. After the frames, ≈ 4 min of the 30-minute run is the audio: two
single-threaded loudnorm passes over 35 minutes — the next optimisation target (e.g. per-chapter loudness or a
one-pass mode for drafts). The mock voice speaks slower than 2.6 words/s, so the "30-minute" target produced 35.7 min.

Not measured here: the Remotion engine on a 30-minute project (expected ≈ 2× slower per `docs/RENDERING.md`), 1080p
at 30 fps for 30 minutes (≈ 2.5× the pixels of this run), real providers (keys).

## Tests

`npm run test:longform` (21 checks; `--unit` = the 11 offline ones, included in `npm test`):
profiles, unchanged short prompts, outline repair, chapter prompt, chapter ranges, TTS splitting, windowed alignment
(far above the old limit, and 34.5 min with time/memory/accuracy bounds), storyboard windows, YouTube chapter rules,
streamed SFX; then on the mocks a 3-minute educational project: outline → chapters → every chapter operation →
per-chapter approval → voice in parts (sum of parts = voice length) → timing/storyboard → rendered 16:9 MP4 with
ffprobe → editing one chapter after the render voices exactly **one** part again and reuses storyboard windows →
cancel mid-script and resume keeps written chapters → short reels still take the classic single-request path.
`npm run test:xss` now also plants a hostile chapter title/goal/text.

## Known limits of this phase

- Long-form storyboards skip the LLM self-review pass (the deterministic repair + schema still run). A review per
  window would double the LLM calls.
- Character/story continuity is prompted (outline + previous chapter's end), not checked by a separate pass.
- The editor still draws every caption word and scene as DOM nodes (~4 700 words for 30 min): usable, not virtualised.
- The live preview iframe and SSE work unchanged, but a 30-minute storyboard JSON in the script/storyboard panel is
  long to scroll.
- The phone layout of the app overflows (444 px at 390 px) — pre-existing, the same on the previous version.

---

# Master brief — coverage map

Honest status of each section of the master engineering prompt. **Existing** = already in the repository before this
phase (see `docs/PHASE-REPORT.md`, `docs/RENDERING.md`). **This phase** = implemented and tested here.
**Open** = not done.

| § | Requirement | Status |
|---|---|---|
| 3 | Preserve working features | ✔ every pre-existing suite re-run (see the commit) |
| 4 | Multi-format production profiles (12 types) | **This phase**: 9 profiles as data (educational, documentary, story, cartoon, science, cinematic, explainer, promo, short; YouTube/Shorts/Reels/TikTok are platforms). Open: user-defined custom profiles/workflows |
| 5 | Long-form engine: 15 s – 30 min, chapters, scenes, resume, bounded memory | **This phase** (above). Scene IDs = index; scene ↔ chapter by word range. Open: per-chapter preview/render jobs, per-scene asset regeneration beyond the existing single-scene regenerate |
| 5 | Research, source collection, fact verification | Existing: research notes labelled **unverified**. Open (and not claimable without a real search tool): verification |
| 6 | Remotion evaluation | Existing: benchmarked and integrated as an engine with legacy fallback (`docs/RENDERING.md`). Licence note there |
| 7 | Motion Canvas, OpenTimelineIO | Open — not evaluated this phase |
| 7 | FFmpeg/FFprobe hardening | Existing + this phase (streamed SFX, PCM-exact voice concat) |
| 7B | Stock providers, attribution, licences | Existing (Pexels/Pixabay/Unsplash, licence records). This phase: rate-limit circuit breaker. Sharp not added (no need found) |
| 8 | Arabic typography engine | Existing (HarfBuzz/ICU via Chromium, word-level bidi, kashida, 10 OFL fonts, dialects); untouched |
| 9 | Audio/voice: chapter-level voice, long narration | **This phase**: parted + cached TTS. Existing: ElevenLabs/OpenAI TTS, Deepgram, estimated timing flagged as estimated. Open: multi-speaker, Whisper backend |
| 10–11 | 38 AI skills + full Skills Manager (schemas, versions, rollback, tests) | Existing: skills with import/export, I/O schema validation, permissions, run log. Open: versioning/rollback, the 38 named skills |
| 12 | MCP | Existing: HTTP-only, deny-by-default per tool, schema-validated input, private-host guard. Open: health checks, version tracking |
| 13 | Provider manager | Existing: settings + connection tests + retries. Open: capability registry, cost tracking, fallback chain. **No Hugging Face work, as instructed** |
| 14 | Orchestrator | The pipeline runner is the orchestrator (states, approvals, cancel, resume, logs); this phase added chapter-level checkpoints. Open: skill selection per stage, cost estimates |
| 15 | Advanced editor | Existing: multi-track, keyframes, layers, audio tracks, cuts, undo/redo. This phase: long-timeline zoom/waveform. Open: ripple for overlays, speed, live audio-track preview |
| — | Rest of the brief | The prompt received was cut off at "15 … Preview: The prev"; later sections were not seen |
