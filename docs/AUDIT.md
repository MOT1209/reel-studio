# Reel Studio — Phase 0 audit and development plan

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

## 3. Remaining technical debt (not done yet — planned in the phases)
- **Structured logging**: the stage logs are text lines; the server uses `console.error`. → Phase 1b: a small JSON-lines logger, `data/logs/`, with key redaction.
- **Secret storage**: masked in the UI and 0600 on disk, but not encrypted. Windows DPAPI/Keychain need a native dependency or a PowerShell bridge. → a decision for the owner (see §5).
- **Rendering layout is fixed at 1080×1920** (`W/H` constants in render.mjs and coordinates in render.js). 16:9 and 1:1 need a layout refactor, not a flag.
- **No timeline data model**: the storyboard is a list of scenes tied to word indices. A real editor (tracks, clips, trim, undo) needs a separate "edit decision list" that render.js reads. This is the biggest architectural change in the plan.
- **Mixed Arabic/English layout**: render.js picks `direction` per word (`isArabic`), not per bidi paragraph; a line mixing English terms and numbers inside Arabic can come out in the wrong order. → Phase 2.
- **Text wrapping** is done by measuring words (`measureText`); no kashida, no proper handling of punctuation at the start of a line.
- The UI is one `app.js` file (457 lines) building strings with `innerHTML` (consistently escaped); it can't take an editor and libraries without being split into modules.

## 4. Development plan (prioritised; each phase ends with tests + a report + your review)

| Phase | Deliverable | Acceptance criteria | Main risk |
|---|---|---|---|
| **1 ✔ (this branch)** | Fix the defects above | unit 13/13, robustness 14/14, e2e 37/37, templates 9/9 | — |
| 1b | JSON logger + key redaction + one config module | a test proves no key appears in any log | small |
| 2 | Arabic engine: paragraph-level bidi (UAX #9 via the browser, or a small `bidi-js` library), line breaking that respects punctuation, MSA/dialect script modes, optional tashkeel, LLM spelling/grammar correction with diff and approval, SRT/VTT | real Arabic/English/number sentences rendered and checked by pixels + order; SRT/VTT verified | the LLM's correction quality — every correction is shown to the user, nothing is applied silently |
| 3 | Font library (Cairo, Tajawal, Amiri, Noto Sans/Naskh/Kufi Arabic, Scheherazade New, Reem Kufi, Aref Ruqaa — all **OFL**, bundled with their licences), preview + weights + subtitle presets; asset library with providers (Pexels, Pixabay, Unsplash) behind adapters, keys on the server, caching, licence and attribution stored with each asset | font embedding proved in the MP4; search with a real key (needs your keys) | the image providers' terms differ: Unsplash requires attribution and hotlinking from its API; none of them is "free for every use" |
| 4 | Production engine: a research step with **sources marked "unverified"**, scene→asset matching, background music (from a library you supply, or Pixabay Music by hand — no free music API with a clear licence) | e2e with images and music | — |
| 5 | Editor: an EDL data model (tracks: video/image/audio/text/subtitle), timeline UI, trim/split/move, undo/redo, autosave; render.js reads the EDL | every edit shows up in the rendered video (e2e test) | the biggest phase; split into 5a model+render, 5b UI |
| 6 | Export: 9:16 / 16:9 / 1:1, 720p/1080p, quality presets, resume after an interruption, temp-file cleanup | ffprobe per preset, RAM measured | the layout refactor in §3 |
| 7 | Skills/MCP: **declarative** skills (prompt + JSON schema for input and output, no code), an MCP client (stdio/HTTP) with an allow-list of tools and per-tool permissions, an execution log | no path runs arbitrary code; a test of a rejected permission | MCP is a large attack surface — stays off by default |
| 8 | Release: a single test command, docs, release checklist | everything green | — |

## 5. Decisions needed from the owner before Phase 2/3
1. **Secret encryption on Windows**: (a) leave it as is (0600 + masking), (b) DPAPI through PowerShell without new dependencies, (c) a native library.
2. **Image providers**: which ones to enable first, and the keys (Pexels and Pixabay give free keys right away; Unsplash needs app approval for production).
3. **Music**: a local library you supply, or a specific licensed provider?
4. **The editor**: start with a simple timeline on top of the current scenes (faster), or a full EDL right away (heavier, but no second rewrite)? The recommendation is the full EDL.
