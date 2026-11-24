# Repair report — phases 0–12 (2026-11-24)

> **Merged with `main` v3.0.** `main` meanwhile added an engine manager (Remotion + legacy), its own render queue (`render.maxJobs`, default 1), ffprobe output validation and scene schema. Rendering items below that duplicated `main` (my separate queue, `/api/queue`) were **dropped**; the rest was **ported onto `main`'s architecture** and re-tested there: child/browser registry and timeouts (`server/proc.mjs`), cgroup-aware worker counts (`server/memory.mjs`, used by both engines), verified `.part` mux without `-shortest` + frame-count checks (`server/engines/ffmpeg.mjs`), crash retry with one page (engine manager), graceful shutdown, streamed uploads, credential delete, atomic voice files, a browser leak on a failed `prepare` (new bug, fixed), editor keyframes/layers/snap/tracks/crop/duplicate/ripple (renderer shared by both engines), accessibility fixes. Tests below were re-run on the merged code.

Legend: **T** = implemented and tested here · **I** = implemented, not covered by an automated test · **P** = partial · **N** = not implemented · **B** = blocked.
All tests below ran on this machine against offline mocks (no real API key or real network), 4 CPU / 16 GB, Node 22.23.5, system ffmpeg, Playwright's Chromium.

Final run on the merged code: `npm run test:all` → unit 30 · Arabic 14 · library 10 · skills/MCP 13 · vault 6 · voice 3 · engines 13 · robustness 14 · phase1 16 · e2e 38/38 · export 15 · Remotion 9 · UI 21 · XSS 3 · a11y 19 · Arabic-video 7 · templates 9 sheets · `npm audit --omit=dev`: 0 vulnerabilities. Separately (long-running, not in `test:all`): `npm run test:perf` and `npm run test:lowmem` (see `docs/PERFORMANCE.md`). (Baseline before any change: the same suites minus the new ones, all green — `docs/PHASE0-AUDIT.md`.)

## Phase 0 — audit
`docs/PHASE0-AUDIT.md`. No P0 reproduced. Not every file was read in full (listed in that document); `text`, `storyboard`, `arabic`, `fonts`, `skills`, `youtube`, `subtitles` and most of `public/render.js` / `app.js` were only exercised through their tests.

## Phase 1 — foundation
| Item | Status | Evidence |
|---|---|---|
| Graceful shutdown (SIGINT/SIGTERM: cancel jobs, kill ffmpeg + Chromium, flush projects, exit 0) | **T** | `phase1-test`: SIGTERM → exit 0, port closed |
| Timeouts + bounded retry for ElevenLabs/Deepgram (`server/net.mjs`; Retry-After; no retry on 4xx; cancel wins) | **T** | 5 tests incl. hanging server, 429→200, 401 once |
| Provider search: one retry on 5xx/network, 429 still shown to the user | **T** | `library-test` 429 case |
| Voice upload streamed to disk, `RS_MAX_UPLOAD_MB`, 413 answered before the socket is dropped, no temp leftovers | **T** | `phase1-test` upload (413/415/200 + no `.upload-*` files) |
| Atomic write of the render manifest and concat list | **T** (via render tests) | |
| Atomic write of `voice.mp3` (TTS: atomic write; upload: convert to `.part`, then rename) and `voice-timing.json` | **I** | e2e passes through both paths; a crash-in-the-middle was not simulated |
| ffmpeg/ffprobe execution timeouts (`RS_FFMPEG_TIMEOUT_MIN`, default 45 min; probe 60 s) | **T** | `phase1-test` |
| Render-input validation gate before rendering (`checkRenderInputs`) | **T** | unit (11 failure kinds) + e2e still green |
| Concurrent requests: 30 simultaneous project creations + 3 simultaneous settings writes — nothing lost, every file valid JSON, no temp files | **T** | `phase1-test` |
| Per-endpoint request schemas for **every** route | **P** | the important boundaries are validated (edit model, uploads, MCP, settings, skills); there is no central schema layer |
| CI (`.github/workflows/ci.yml`) | **I** | not run (no GitHub Actions run was observed) |

## Phase 2 — security
| Item | Status |
|---|---|
| MCP: private/loopback/link-local hosts refused unless `allowPrivate`; redirects not followed; expired session re-opened once | **T** (`skills-test` 13) |
| Stored XSS: hostile strings in project, asset, skill, MCP, example, settings values → nothing executes in any view | **T** (`xss-test`; mutation-checked: with `esc()` neutered the test fails) |
| Secrets: AES-256-GCM at rest, masked in API/UI, redacted in logs (pre-existing) | **T** (vault/library/skills tests) |
| OS credential store on macOS/Linux | **N** — decided with the owner: keep the 0600 key file + document (Windows DPAPI exists, untested here) |
| Explicit "delete this credential": `DELETE /api/settings/secrets/<section.field>` (reports when `.env` still supplies it; unknown key → 404) | **T** (`phase1-test`: sealed on disk, deleted from disk and API, others untouched) — plus a «حذف المفتاح المحفوظ» button in Settings (shown only for keys saved there; **T** in the UI test) |
| `spawn` with argument arrays, no shell | **I** — verified by reading every `spawn` in `server/`; DNS names in MCP URLs are not resolved, so a public name pointing at a private IP is not caught |
| CSRF token | **N** (loopback bind + Host/Origin checks remain the guard) |

## Phase 3 — rendering
| Item | Status | Evidence |
|---|---|---|
| Render queue (priority, FIFO, `RS_MAX_RENDERS` default 1, states pending/running/done/failed/cancelled, cancel of waiting jobs, retry of transient browser failures, `GET /api/queue`) | **T** | 6 queue tests |
| `RS_RENDER_WORKERS` validation (integer 1–4, note on rejection, RAM cap, `RS_RENDER_WORKERS_FORCE`) | **T** | table test |
| Child/browser registry + `killAllChildren` | **T** | shutdown + run() tests (no orphan registered) |
| Per-segment frame-count check; damaged reused segment re-rendered | **T** | `phase1-test` |
| `muxFinal` → `.part`, ffprobe check (codec, size, fps, frame count, video/audio/container duration, audio present), then rename; cancel leaves nothing | **T** | 3 tests |
| **Bug found by that check:** `-shortest` silently dropped 1–2 frames of every render (324 of 326 frames at 30 fps). Audio now matches the frame duration and `-shortest` is gone | **T** | e2e + export fail without the fix, pass with it |
| Chromium orphans after `kill -9` of the server | **B** — impossible to handle in-process; only graceful signals are covered |
| **Bug found by the low-memory test:** inside a memory-limited container the renderer used the HOST's free RAM and its pages were OOM-killed (1.5 GB cgroup: crash + retry; 1 GB: failure). Now cgroup-aware, per-page estimate recalibrated, crashes retried with 1 page | **T** | `tools/lowmem-test.mjs`: 1.5 GB passes (peak 1380 MB, 0 OOM kills); 1 GB still fails (documented floor) |
| Resume data atomic | **T** (manifest) |

## Phase 4 — Remotion / HyperFrames
`docs/REMOTION-EVALUATION.md`: measured, **not integrated** (4.6× slower on the same scene, +19 % RAM, +217 MB, tiered licence). HyperFrames: metadata only, not benchmarked, not integrated.

## Phase 5 — editor
| Item | Status | Evidence |
|---|---|---|
| Keyframes (x, y, scale, opacity, rotation, 5 eases) in model, renderer and inspector | **T** | unit (sampling/determinism/cleaning); export: pixel centroid moves 180 px in 2 s as specified |
| Layer order (4 buttons; array order = z-order) | **T** | export: green/magenta overlap, both orders, centre pixel measured; UI test |
| Magnet + optional grid snapping (words, scenes, clips, tracks, cuts, trim, playhead) | **T** | unit (snap maths) + UI test (snaps within 0.011 s; unchecked → does not) |
| Independent audio tracks (validated, fades, cut-aware, mixed) | **T** (export: tone present in its window, ≥ 12 dB above elsewhere) — **UI for adding a track was not driven by a test** (button presence only) |
| Live preview plays audio tracks (start/end/offset/volume/fades) | **I** — audio playback is not observable headless; `render-data` carrying the tracks is **T** (export test) |
| Crop of picture/video overlays (fractions of the source) | **T** — export test: cropping a two-colour image to its right half removes the other colour from the rendered frames |
| Duplicate overlay; ripple (delete / shorten an overlay shifts the later ones in its row) | **T** (UI test) |
| Re-ordering scenes beyond swap, inserting silence | **N** (narration remains the master clock — documented limit) |
| Undo/redo, autosave, trim, split, delete, multi-select, zoom, text/subtitle editing | pre-existing, **T** by the existing UI test |

## Phase 6 — Arabic
`tools/arabic-video-test.mjs`: **5 real renders** (Arabic only, English only, Arabic+English, Arabic+Arabic-Indic digits+Latin digits+punctuation, long Arabic) + animated mixed-language title. Frames decoded from the MP4 and checked for caption presence, 24 px margins, block height; the saved PNGs (`output/arabic-video/`) were **looked at**: letters joined, RTL word order correct, `DNA polymerase` kept LTR inside an Arabic line, `٢٠٢٤` and `100%` in the right slots, the Arabic comma on the left end of the word. Shaping also confirmed by measurement. Engine: Chromium's built-in HarfBuzz + ICU BiDi (the legacy and Remotion renders were identical); a separate HarfBuzz/ICU binding was **not** added — no defect that needs one was found. Not done: OCR (none available), pixel-reference regression images, LLM grammar/dialect quality (needs a real LLM).

## Phase 7 — media library
Provider retry added (above). Everything else (adapters, Arabic→English query translation, cache, 429 message, licence + attribution records, SSRF-safe download) was audited via its existing tests only. **B**: real Pexels/Pixabay/Unsplash keys — verified on mocks only.

## Phase 8 — voice, audio, subtitles
Retry/timeouts (above), audio tracks, clip-sound mixing with fades, frame-exact audio length. SRT/VTT + word timings (pre-existing, tested). **B**: real ElevenLabs/Deepgram (owner will test with real keys and send logs). **N**: dedicated pronunciation/normalisation changes.

## Phase 9 — AI pipeline
Added the pre-render gate (word timing monotonic, scenes strictly increasing within the script, templates, referenced assets exist, minimum duration). Stage retry/cancel/approval/recovery were already present and are covered by e2e. **N**: any check that LLM text is factually true (research notes remain flagged "unverified" — the app cannot verify facts). **B**: real LLM output quality.

## Phase 10 — UI
`tools/a11y-test.mjs` (19 tests) audits every screen incl. the editor, its inspectors and every Settings tab at 1440 px and 390 px: it found 11 unnamed controls (library/fonts/voice/settings/editor-item fields), a header that pushed the Settings button 50 px off a phone screen, a table wider than the screen, and no `:focus-visible` style on buttons/links — all fixed, then **T**. `<html lang=ar dir=rtl>` checked on every screen. Colour contrast (WCAG AA 4.5:1, 3:1 for large text, computed against the real background) is now measured on every screen, the editor and every Settings tab: one failure found (dimmed caption-preview words, 2.45:1) and fixed. **N**: screen-reader testing, and a review of RTL *visual* polish beyond the checked screens.

## Phase 11 — tests / performance
New suites listed at the top; real measurements in `docs/REMOTION-EVALUATION.md` §4 (flat RAM from 30 s to 90 s). Real-pipeline small/medium/large + queue-of-3 + low-memory cgroup runs: `docs/PERFORMANCE.md`. **N**: 4K, other OSes, an 8 GB physical machine, real (non-mock) audio longer than ~45 s.

## Phase 12 — cleanup / docs
README updated (queue, shutdown, limits, editor features, tests, keychain limitation); `package.json` scripts, `engines.node` raised to ≥ 20 (code uses `AbortSignal`/`fetch` features and CI runs 22); version strings aligned to 2.1.0. `npm audit`: 0. **N**: dead-code/unused-dependency removal — there is one runtime dependency and no file was proven dead, so nothing was deleted. `docs/AUDIT.md` still quotes older test counts in its historical sections.

## Remaining / recommended next
1. First run with real keys (LLM, ElevenLabs, Deepgram, one image provider) and send `data/logs/server.log`.
2. Accessibility + responsive + RTL pass over every screen.
3. A first listen to the live audio-track preview (audio playback cannot be observed headless).
4. Run the CI workflow once on GitHub (it has not produced a run on this branch — Actions may need enabling/approval) and fix whatever differs on a clean Ubuntu runner.
5. Real-hardware check on an 8 GB machine.
