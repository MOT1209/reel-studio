# Repair report — phases 0–12 (2026-11-24)

Legend: **T** = implemented and tested here · **I** = implemented, not covered by an automated test · **P** = partial · **N** = not implemented · **B** = blocked.
All tests below ran on this machine against offline mocks (no real API key or real network), 4 CPU / 16 GB, Node 22.23.5, system ffmpeg, Playwright's Chromium.

Final run: `npm run test:all` → unit 20 · Arabic 14 · library 10 · skills/MCP 13 · vault 6 · robustness 14 · phase1 20 · e2e 38/38 · export 12 · UI 14 · XSS 3 · Arabic-video 7 · templates 9 sheets · `npm audit --omit=dev`: 0 vulnerabilities. (Baseline before any change: the same suites minus the new ones, all green — `docs/PHASE0-AUDIT.md`.)

## Phase 0 — audit
`docs/PHASE0-AUDIT.md`. No P0 reproduced. Not every file was read in full (listed in that document); `text`, `storyboard`, `arabic`, `fonts`, `skills`, `youtube`, `subtitles` and most of `public/render.js` / `app.js` were only exercised through their tests.

## Phase 1 — foundation
| Item | Status | Evidence |
|---|---|---|
| Graceful shutdown (SIGINT/SIGTERM: cancel jobs, kill ffmpeg + Chromium, flush projects, exit 0) | **T** | `phase1-test`: SIGTERM → exit 0, port closed |
| Timeouts + bounded retry for ElevenLabs/Deepgram (`server/net.mjs`): retried = network errors, 408/425/429/5xx (429 is the one 4xx that is retried — it means "not processed, try later"; `Retry-After` honoured, a missing header uses the backoff); never retried = other 4xx; paid requests (TTS, transcription) are only retried on 429/503 or a connection that never reached the provider; the timeout covers the body; cancel wins | **T** | 8 tests incl. hanging server, stalled body, 429→200, 401 once, paid POST sent once |
| Provider search: one retry on 5xx/network, 429 still shown to the user | **T** | `library-test` 429 case |
| Voice upload streamed to disk, `RS_MAX_UPLOAD_MB`, 413 answered before the socket is dropped, no temp leftovers | **T** | `phase1-test` upload (413/415/200 + no `.upload-*` files) |
| Atomic write of the render manifest and concat list | **T** (via render tests) | |
| Atomic write of `voice.mp3`, `voice-timing.json` | **N** | still `writeFileSync`; a crash mid-write leaves a truncated file (the stage is then marked interrupted and re-run) |
| ffmpeg/ffprobe execution timeouts (`RS_FFMPEG_TIMEOUT_MIN`, default 45 min; probe 60 s) | **T** | `phase1-test` |
| Render-input validation gate before rendering (`checkRenderInputs`) | **T** | unit (11 failure kinds) + e2e still green |
| Concurrent writers to the same project / per-endpoint request schemas for **every** route | **N** | the server is single-threaded with synchronous saves; no test for concurrent edits was written |
| CI (`.github/workflows/ci.yml`) | **I** | not run (no GitHub Actions run was observed) |

## Phase 2 — security
| Item | Status |
|---|---|
| MCP: private/loopback/link-local hosts refused unless `allowPrivate`; redirects not followed; expired session re-opened once | **T** (`skills-test` 13) |
| Stored XSS: hostile strings in project, asset, skill, MCP, example, settings values → nothing executes in any view | **T** (`xss-test`; mutation-checked: with `esc()` neutered the test fails) |
| Secrets: AES-256-GCM at rest, masked in API/UI, redacted in logs (pre-existing) | **T** (vault/library/skills tests) |
| OS credential store on macOS/Linux | **N** — decided with the owner: keep the 0600 key file + document (Windows DPAPI exists, untested here) |
| Explicit "delete this credential" action | **N** (clearing a field in Settings is the only path) |
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
| Resume data atomic | **T** (manifest) |

## Phase 4 — Remotion / HyperFrames
Superseded by v3.0: Remotion **is** integrated as an engine (default, with the legacy engine as fallback); measurements and the HyperFrames evaluation are in `docs/RENDERING.md`.

## Phase 5 — editor
| Item | Status | Evidence |
|---|---|---|
| Keyframes (x, y, scale, opacity, rotation, 5 eases) in model, renderer and inspector | **T** | unit (sampling/determinism/cleaning); export: pixel centroid moves 180 px in 2 s as specified |
| Layer order (4 buttons; array order = z-order) | **T** | export: green/magenta overlap, both orders, centre pixel measured; UI test |
| Magnet + optional grid snapping (words, scenes, clips, tracks, cuts, trim, playhead) | **T** | unit (snap maths) + UI test (snaps within 0.011 s; unchecked → does not) |
| Independent audio tracks (validated, fades, cut-aware, mixed) | **T** (export: tone present in its window, ≥ 12 dB above elsewhere) — **UI for adding a track was not driven by a test** (button presence only) |
| Live preview plays audio tracks | **N** — only visible in the exported video |
| Video cropping, clip duplication, re-ordering scenes beyond swap, inserting silence | **N** (narration remains the master clock — documented limit) |
| Ripple for overlays | **P** — cuts ripple everything; moving an overlay does not ripple others |
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
Only what the new features and the XSS test touched. **N**: an accessibility audit (labels, focus order, contrast), responsive-layout pass, and RTL review of every screen were **not** done.

## Phase 11 — tests / performance
New suites listed at the top; real measurements in `docs/RENDERING.md` → Benchmarks (flat RAM from 30 s to 90 s). **N**: low-memory stress test, high-resolution-image and long-audio fixtures through the real pipeline, medium/large real projects (the mocks only produce ~10 s scripts).

## Phase 12 — cleanup / docs
README updated (queue, shutdown, limits, editor features, tests, keychain limitation); `package.json` scripts, `engines.node` raised to ≥ 20 (code uses `AbortSignal`/`fetch` features and CI runs 22); version strings aligned to 2.1.0. `npm audit`: 0. **N**: dead-code/unused-dependency removal — there is one runtime dependency and no file was proven dead, so nothing was deleted. `docs/AUDIT.md` still quotes older test counts in its historical sections.

## Remaining / recommended next
1. First run with real keys (LLM, ElevenLabs, Deepgram, one image provider) and send `data/logs/server.log`.
2. Accessibility + responsive + RTL pass over every screen.
3. Atomic writes for voice files; per-credential delete; live preview for audio tracks.
4. Real medium/large project fixtures and a memory-constrained run (e.g. a 4–8 GB VM).
5. Run the CI workflow once on GitHub and fix whatever differs on a clean Ubuntu runner (fonts, Chromium install).


## Addendum — what this branch adds on top of `main` v3.1 (2026-11-25)
`main` already contains the first port of the audit work (PR #6/#8: shutdown, retries, MCP hardening, keyframes, audio tracks, frame-exact output, XSS and Arabic-video tests). What was still missing there and is added here, **each tested on the merged code**:

| Item | Status | Evidence |
|---|---|---|
| Memory budget from the process's **cgroup** (not the host's free RAM), ≈ 450 MB/page + 600 MB base, shared by both engines (`server/memory.mjs`) | **T** | `phase1-test` (table); `tools/lowmem-test.mjs`: 1.5 GB cgroup passes (peak 1309 MB, 0 OOM kills, 0 crashes); 1 GB still fails (documented floor) |
| Credential delete: `DELETE /api/settings/secrets/<section.field>` + «حذف المفتاح المحفوظ» button | **T** | `phase1-test` (sealed on disk → deleted; unknown key 404; `.env` value reported), UI test |
| Crop of picture/video overlays | **T** | export test (two-colour image cropped to one half) + unit |
| Duplicate overlay; ripple delete / shorten | **T** | UI test |
| Accessibility + responsive audit (`tools/a11y-test.mjs`, 19 tests: names, alt, lang/dir, focus ring, phone width, WCAG contrast) and its fixes (11 unnamed fields, header/table overflow at 390 px, focus-visible, dim caption words 2.45:1) | **T** | a11y test |
| Real-pipeline scale + queue test (`tools/perf-test.mjs`) | **T** | small 21.4 s/1630 MB · medium 53.7 s/1650 MB · large (6000×4000 photos + 1080p clip) 71.5 s/2142 MB · 3 projects → 1 at a time |
| Concurrency test (30 simultaneous creations + settings writes) | **T** | `phase1-test` |

Full suite on this tree: unit 33 · Arabic 14 · library 10 · skills/MCP 13 · vault 6 · voice 3 · engines 15 · robustness 14 · phase1 22 · e2e 38/38 · export 14 · Remotion 9 · UI 21 · XSS 3 · a11y 19 · Arabic-video 7 · templates 9 sheets; `npm audit --omit=dev`: 0.
