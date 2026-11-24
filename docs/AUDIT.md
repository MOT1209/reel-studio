# Reel Studio — audit, phase reports and release notes

Date: 2026-11-23 · Code audited: `9293977` (main) · Fixes: this branch.

## 1. What exists today (architecture map)

```
browser (public/)                          server (server/, Node ≥18, no framework, 127.0.0.1 only)
 index.html + app.js  ── REST + SSE ──▶  index.mjs      routing, Host/Origin guards, static files, range requests
 render.html + render.js ◀─ render-data ─ pipeline.mjs   projects (data/projects/<id>/project.json), 5-stage runner,
   (canvas, drawFrame(t))                                approvals, edits, cancel, YouTube publish
                                          apis.mjs       OpenAI-compatible LLM (SSE stream, <think> stripping, idle timeout),
                                                         ElevenLabs TTS with char timestamps, Deepgram STT
                                          text.mjs       script prompt/parsing, Arabic normalisation, char-level LCS alignment
                                          storyboard.mjs storyboard prompt, JSON repair/validation, self-review prompt
                                          icons.mjs      noun → icon key (hand-drawn + Health Icons CC0 + Tabler MIT)
                                          render.mjs     Playwright frame capture (N parallel pages) → ffmpeg H.264,
                                                         synthesized SFX, 2-pass loudnorm −14 LUFS, mux, contact sheet
                                          settings.mjs   settings.json + .env, masked keys, themes, fonts
                                          youtube.mjs    OAuth (loopback + PKCE + state), resumable chunked upload
```

Pipeline: `topic → script → voice → timing → storyboard → render → (publish)`. Each stage can wait for approval, be edited
(script, timing, storyboard), re-run or cancelled. Live log, LLM stream and frame previews go to the browser over SSE.

Size: ~4,600 lines of JS. Dependencies: **one** (`playwright`, Apache-2.0). `npm audit`: 0 vulnerabilities.
Bundled assets: IBM Plex Sans Arabic (OFL), icon sets (CC0 / MIT, `assets/icons/LICENSES.md`).

### What works (verified on this machine with the offline mocks)
- The full 10-second reel e2e: H.264 yuv420p 1080×1920 at 30 fps, AAC at −14 LUFS, captions ≤ 30 ms from their voice onset (median 4 ms).
- The uploaded voice-over + Deepgram path, approvals, cancel, re-run, YouTube OAuth and chunked upload.
- Arabic shaping in the video is correct, because the canvas is drawn by Chromium, which shapes text with **HarfBuzz** and
  orders it with **ICU BiDi** internally. This matters for Phase 2: there is no need to bundle HarfBuzz natively
  as long as text goes through the browser's text engine; what's missing is *our* layout logic (see §4).

## 2. Defects found and fixed in Phase 1 (each one has a regression test that fails on the old code)

| # | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| 1 | **critical** | With system Chrome/Edge (the fallback on Windows), the browser asks for `/favicon.ico` → 404 → console error → **every render failed** ("render.html error: Failed to load resource"). The existing `npm run e2e` failed here. | `<link rel="icon" href="data:,">` in both pages, and a favicon error no longer counts as a page error | e2e (now completes), robustness |
| 2 | **critical** | ffmpeg dying mid-render (bad codec, full disk) → the writer waited forever for `drain` → **render stuck on "running"** until the user cancelled | `failed` state shared by the workers and the writer; the drain wait also watches for ffmpeg exit | `render: ffmpeg dying…` |
| 3 | high | A frame that throws → `renderFrames` returned but the writer loop polled every 50 ms **forever** (leak) | the workers record the failure, and every loop stops | `render: a frame that throws…` |
| 4 | **critical** | YouTube: a 401 on an access token revoked before its expiry → `accessToken()` returned the same cached token → **endless PUT loop**. The init request didn't refresh either. | `accessToken({force:true})` after a 401, one retry, then a clear error | `YouTube: …` (2 tests) |
| 5 | medium | YouTube 308 without a `Range` header means "nothing stored", but the code jumped ahead to `offset+len` → corrupted upload | offset = 0 | covered by the YouTube test |
| 6 | high | Editing the script/timing/storyboard, uploading a voice-over or changing the voice mode **while a later stage was running** → that stage finished on the old input (timing aligned to the new script but the old voice), with no error | validate first, then stop the run, then apply the edit | `pipeline: editing…`, `invalid edit…` |
| 7 | medium | Upload accepted any bytes under an audio file name | magic-byte check (mp3/ADTS/WAV/MP4/Ogg/FLAC/WebM) → 415 | `upload: …` |
| 8 | medium | One corrupt `project.json` broke the whole project list; writes weren't atomic | skip + log; `writeFileAtomic` (temp + rename) for every JSON file | `projects: …`, `storage: …` |
| 9 | medium | `settings.json` and `youtube-token.json` (keys and refresh token) were written world-readable (0644) | 0600 on POSIX; on Windows they inherit the user-profile ACL | `storage: …` |
| 10 | low | Malformed URL encoding (`%E0%A4%A`) → 500; `Range: bytes=-N` with N > file size → negative start, crash; Range without HEAD | `safeDecode` → 400, clamped, HEAD handled | `http: …` |
| 11 | low | The connection test could point the saved key at another host even when `.env` pins the base URL | pinned URLs are ignored in the test | e2e |
| 12 | low | JSON repair stripped `//…`, so it cut `https://` URLs inside strings; empty word list → crash | comments only after JSON punctuation; clear error | `storyboard JSON…` |
| 13 | medium | `npm run templates` was broken: it called `chromium.launch()` without the Chrome/Edge fallback, and it didn't set `script: auto`, so every project waited for approval forever (10-minute timeout) | `launchBrowser` + full approvals + fails at once if another stage is waiting | templates 9/9 |

## 3. Technical debt from the audit — status
| Item | Status |
|---|---|
| Structured logging | ✔ `server/logger.mjs` — JSON lines, rotation, redaction (test: `logs: …`) |
| Secret storage | ✔ 0600 + atomic + masked + redacted. **Not encrypted at rest** (decision below) |
| Fixed 1080×1920 layout | ✔ layout engine: 9:16 / 1:1 / 16:9 at 720p/1080p |
| No timeline data model | ✔ `p.edit` (export, trim, audio, music, overlays, typography, transitions) + scenes + word timing, one validated save |
| Mixed Arabic/English in captions | ✔ word-level UAX #9 (`public/bidi.js`) |
| Text wrapping / kashida | ◐ wrapping respects logical order and keeps punctuation attached to its word; no kashida justification |
| Single-file UI | ✔ split into `ui.js`, `editor.js`, `views/*.js` |

## 4. Decisions taken (the owner asked to proceed on my judgement)
1. **Secrets:** stay plain JSON with 0600 + masking + log redaction. No native dependency; DPAPI can be added later without changing the file format.
2. **Image providers:** all three behind one adapter interface; each turns on when its key is set; automatic visuals use Pexels → Pixabay → Unsplash.
3. **Music:** the user's own library (uploaded with its licence recorded) — no provider offers a clear-licence music API.
4. **Editor:** a real edit model on top of the narration-driven scenes (not a free-form NLE): the voice drives time, scenes snap to words, everything else is tracks on top. This keeps captions in sync by construction.
5. **MCP:** Streamable HTTP only — a stdio transport would mean spawning arbitrary programs, which the brief forbids.

## 5. Phase reports

### Phase 1 — foundation and security ✔
Implemented: the 13 fixes above + JSON logger. Files: `server/{index,pipeline,render,settings,storyboard,youtube,logger}.mjs`, `public/{index,render}.html`, `tools/robustness.mjs`. Tests: robustness 14/14 (12 of them fail on the original code), e2e 37/37 (was failing).

### Phase 2 — Arabic engine ✔
Implemented: `public/bidi.js` (word-level UAX #9 used by the caption layout), `server/subtitles.mjs` (SRT/VTT matching the burned captions, RLM, BOM, trim offset, Arabic-Indic digits), `server/arabic.mjs` (dialect detection, tashkeel strip/detect, digits, sentence split, word diff; LLM rewrites correct / tashkeel / MSA / Egyptian / simplify, validated and returned as proposals), research pass + dialect option in the script stage. Evidence: `tools/arabic-test.mjs` 12/12 incl. glyph shaping measured in the render browser on real sentences (joined forms narrower than isolated, لا ligature, ZWNJ changes the shape).
Known limits: dialect detection is a marker-word heuristic (Egyptian vs MSA); correction and tashkeel quality depend on the LLM — every result is shown as a diff and needs approval; tashkeel output is checked to keep the same letters.

### Phase 3 — fonts and assets ✔
Implemented: 9 OFL families bundled (+ IBM Plex), manifest-only font serving, font import with a declared embedding right, typography model; asset library (streamed uploads, magic sniffing, ffprobe, thumbnails, folders/tags/search, licence on every asset); Pexels / Pixabay / Unsplash adapters (server-side keys, cache, 429 handling, Arabic query translation, SSRF-safe downloads, Unsplash download registration + attribution). Evidence: `tools/library-test.mjs` 10/10; `tools/export-test.mjs` proves the chosen fonts are the files loaded by the renderer.
Known limits: provider APIs were exercised against mocks built from their documented response shapes — no real key was available here. Unsplash production use needs Unsplash's app approval.

### Phase 4 — production engine ✔
Implemented: research (unverified, with confidence and "source to check"), photo/type templates, automatic visual selection with licence capture and graceful fallback, pronunciation dictionary, voice speed/stability/style, music with side-chain ducking and fades, credits collected for the description. Evidence: export test (music ducked, −14 LUFS), library test.

### Phase 5 — editor ✔
Implemented: `public/editor.js` — six tracks, drag/trim/split/merge/swap, word timing drag, overlays, music, trim handles, zoom, inspector, undo/redo, autosave with server-side validation, live preview in the real renderer. Evidence: `tools/ui-test.mjs` 11/11 (add text → saved; undo/redo; aspect → preview canvas 1920×1080; trim drag → saved; scene template → saved, render reset), `tools/export-test.mjs` (edits visible in the MP4).
Known limits: the narration is the master clock — you can trim the head/tail but not cut out the middle of the voice; no multi-select or ripple edit; video overlays are silent; music is not audible in the preview (it is in the export).

### Phase 6 — rendering and export ✔
Implemented: 9:16 / 1:1 / 16:9 × 720p / 1080p, 24/25/30/60 fps, quality presets, segmented rendering with resume after cancel/crash, temp cleanup, downscaled images and on-disk clip frames (bounded memory), concurrency-safe image scaling. Evidence: export test 7/7 (ffprobe per format, duration after trim, loudness, recovery reuses 1/2 segments), e2e 37/37. 10-second 1080p reel renders in ≈ 12 s here (2 pages).

### Phase 7 — skills and MCP ✔
Implemented: declarative skills (prompt / MCP), validation (all-or-nothing import), enable/disable, export, run log; MCP Streamable HTTP client with masked + redacted secrets, tools disabled until allowed, schema-checked arguments, result limits, call log. Evidence: `tools/skills-test.mjs` 10/10 (a "delete_everything" tool never reaches the server until allowed; revoking a tool blocks the skill using it).

### Phase 8 — testing and release ✔
`npm test` (unit 13 · Arabic 12 · library 10 · skills 10 · robustness 14), `npm run e2e` (37), `npm run test:export` (7), `npm run test:ui` (11), `npm run templates` (9) — all green on this machine. `npm audit`: 0 vulnerabilities, one runtime dependency (playwright, Apache-2.0).

## 6. Known issues and limits
- Secrets are not encrypted at rest (see decision 1).
- Real-provider integrations (Pexels / Pixabay / Unsplash / MCP servers / ElevenLabs / Deepgram / YouTube) are tested against mocks here; first real use should be watched in `data/logs/server.log`.
- Caption layout has no kashida justification; very long English-only captions use the same line rules as Arabic.
- The editor is narration-driven (see Phase 5 limits).
- Playwright's own Chromium could not be downloaded in this environment; tests ran with the system Chrome fallback — the same path Windows users get when the download fails.

## 7. Release checklist
- [x] `npm test`, `npm run e2e`, `npm run test:export`, `npm run test:ui`, `npm run templates` green
- [x] `npm audit --omit=dev` → 0 vulnerabilities
- [x] Fonts bundled only with their OFL licence files; icon licences in `assets/icons/LICENSES.md`
- [x] No secret reaches the browser (settings, MCP, providers tested) or the logs (redaction tested)
- [x] README updated (setup, sections, editor, Arabic, security, tests)
- [ ] First run with real keys on the owner's machine (LLM, ElevenLabs, one image provider) — watch `data/logs/server.log`
- [ ] Optional: DPAPI encryption of `data/*.json` on Windows
