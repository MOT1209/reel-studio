# Reel Studio — Phase 0 audit (2026-11-24)

Commit audited: `f3ee9d4` (v2.1.0). **No source file was changed.** This file is the only addition.
Environment: Node v22.23.5, ffmpeg/ffprobe from `/usr/bin`, Playwright 1.x with the preinstalled Chromium, 4 CPU, 16 GB RAM (so the 8 GB target was **not** reproduced here).

## 0. How much was inspected (honest scope)

| Read in full | Read partly / by grep only | Not yet read |
|---|---|---|
| `server/index.mjs`, `render.mjs`, `vault.mjs`, `mcp.mjs`, `providers.mjs` (search + import), `settings.mjs` (storage), `pipeline.mjs` (control, edit, upload, render stage) | `apis.mjs`, `assets.mjs`, `edit.mjs`, `public/editor.js` | `text.mjs`, `storyboard.mjs`, `arabic.mjs`, `fonts.mjs`, `skills.mjs`, `youtube.mjs`, `subtitles.mjs`, `timeline.mjs`, `public/render.js` (1083 lines), `public/app.js`, `bidi.js`, `kashida.js`, views, CSS |

Findings below marked **[code]** come from reading code only; **[run]** were observed by running something. Nothing marked [code] has been reproduced yet — each needs a failing test before it is fixed.

## 1. Baseline (all run here, all green)

| Command | Result | Wall time |
|---|---|---|
| `node tools/unit.mjs` | 15 passed | — |
| `node tools/arabic-test.mjs` | 14 passed | — |
| `node tools/library-test.mjs` | 10 passed | — |
| `node tools/skills-test.mjs` | 10 passed | — |
| `node tools/vault-test.mjs` | 6 passed | — |
| `node tools/robustness.mjs` | 14 passed | — |
| `node tools/e2e.mjs` (10 s reel, mocks) | 38/38 | 20 s |
| `node tools/export-test.mjs` | 8 passed | 33 s |
| `node tools/ui-test.mjs` | 13 passed | 20 s |
| `node tools/templates-test.mjs` | 9 sheets | 20 s |
| `npm audit --omit=dev` | 0 vulnerabilities | — |

Consequence: **no P0 (crash / data-loss / secret-leak) defect was found or reproduced.** The existing suite is strong where it exists; the gaps below are mostly *missing capability* and *missing tests*, not regressions. All external services (LLM, ElevenLabs, Deepgram, Pexels/Pixabay/Unsplash, YouTube, MCP) were only exercised against `tools/mock-apis.mjs`; no real key is available here.

## 2. Prioritised findings

### P0 — critical
None confirmed.

### P1 — major functionality / reliability

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| P1-1 | **No render queue and no global concurrency limit.** `running` is a per-project map, so N projects started together launch N Chromium instances, each with up to 4 pages (~400 MB each by the code's own estimate). On an 8 GB machine this is an OOM/swap risk. There are no priorities, retries, job list, or "pending/failed/cancelled" job states. | [code] `pipeline.mjs` `runPipeline`/`running`; `render.mjs` `workerCount()` only looks at *this* job's free RAM | A small `server/queue.mjs`: FIFO + priority, max concurrent render = 1 (configurable, validated), queued state visible in the UI/SSE, retry policy with backoff for transient failures, per-job cancel. Keep the existing per-project API. Test: start 3 projects, assert ≤ 1 Chromium at a time. |
| P1-2 | **No graceful shutdown.** No `SIGINT`/`SIGTERM` handler: Ctrl-C or a service stop kills Node while Chromium/ffmpeg children may stay alive; running stages are only repaired at next start. | [code] `grep SIGINT\|SIGTERM server/` → no match | Shutdown handler: abort running jobs, close browsers, kill ffmpeg, flush `project.json`, close the HTTP server. Test: spawn server, start render, send SIGTERM, assert no child process remains. |
| P1-3 | **Final output is not verified or written atomically.** `muxFinal` writes `video.mp4` directly (a cancel/crash mid-mux leaves a partial file at the final path); nothing checks frame count of the concatenated segments, or that video and audio durations agree, before the stage is marked done (`-shortest` can hide a mismatch). | [code] `render.mjs` `muxFinal`, `renderFrames` concat; `pipeline.mjs` render stage | Mux to `video.mp4.part`, then `ffprobe` (resolution, fps, codecs, audio present, `\|Δduration\| ≤ 1 frame`, frame count) and only then rename. Verify each segment's frame count before concat. Tests: induce a short segment and a cancel mid-mux. |
| P1-4 | **ElevenLabs and Deepgram requests have no timeout and no retry.** `listVoices`, `ttsWithTimestamps`, `transcribeWords` only honour the user's cancel signal, so a hung provider holds a stage in "running" indefinitely; a single 429/5xx fails the stage. (LLM calls and image providers do have timeouts.) | [code] `apis.mjs` lines ~160, 174, 196 | Shared `fetchWithRetry` (timeout, bounded exponential backoff on 429/5xx/network errors, honour `Retry-After`, never retry 4xx auth errors). Test with the mock server returning 429 then 200, and a hanging endpoint. |
| P1-5 | **Editor feature gaps versus the brief.** No keyframes / animation properties, no snap-to-grid, no layer ordering, no independent audio tracks beyond music, narration is the master clock (cannot reorder scenes or insert silence — already documented as a known limit). | [code] `grep keyframe\|snap\|layer public/editor.js` finds only the undo snapshot and a template named "layers" | Needs a design decision (see §4, question 3) because it touches the edit model and renderer. |

### P2 — performance, security hardening, test gaps

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| P2-1 | `RS_RENDER_WORKERS` is weakly validated: non-numeric values silently fall back to auto, `Infinity` becomes 4, a set value skips the memory check, and the cap of 4 is hard-coded. Nothing is logged about a rejected value. | [code] `render.mjs:165` | Parse as integer 1–8, log + fall back on invalid input, still reduce by free RAM unless explicitly forced. Unit test table. |
| P2-2 | Large request bodies are buffered in memory: voice upload up to 200 MB (`readBody`), then handed whole to Deepgram; font import 20 MB. On 8 GB this is avoidable. | [code] `index.mjs` upload route; `assets.mjs` already streams correctly | Stream project uploads to a temp file (reuse `streamToTemp`), validate magic bytes from the first bytes, send Deepgram from disk. |
| P2-3 | Non-atomic writes: segment `manifest.json`, `voice.mp3`, `voice-timing.json`, `upload.*`, `list.txt`. A crash mid-write can leave a truncated file next to a "done" manifest. | [code] `render.mjs` (`fs.writeFileSync(manifestFile…)`), `pipeline.mjs` lines ~270, 347–363 | Use the existing `writeFileAtomic`; verify a reused segment with ffprobe before trusting the manifest. |
| P2-4 | MCP: (a) any `http(s)` URL is accepted, including loopback/LAN, and `fetch` follows redirects with custom auth headers; (b) a cached `Mcp-Session-Id` is never invalidated, so after server-side session expiry (HTTP 404) calls fail until the owner presses Sync. | [code] `mcp.mjs` `upsertServer`, `rpc`, `callTool` | (a) Warn/confirm for private addresses, `redirect: 'manual'`; (b) on 404 drop the session, reconnect once, retry. Add tests to `skills-test.mjs`. |
| P2-5 | Secrets: encryption at rest exists (AES-256-GCM), but the master key is protected by an OS store only on Windows (DPAPI). On macOS/Linux it is a 0600 file next to the ciphertext, so it only protects a copied `settings.json`, not the data folder. No explicit "delete this credential" action was found in the API. | [code] `vault.mjs`, `index.mjs` routes | Add macOS Keychain (`security`) / libsecret (`secret-tool`) when present, via argument arrays, with the file as fallback; add per-credential delete. Document the limitation either way. |
| P2-6 | State-changing API calls without an `Origin` header are accepted. This is mitigated by the loopback bind and the `Host` allow-list (DNS-rebinding), but there is no token. | [code] `index.mjs:91-94` | Acceptable for a single-user localhost tool; consider a per-run CSRF token for non-browser-less clients. Low priority. |
| P2-7 | Frontend renders with `innerHTML` in 57 places; an escape helper is used (≈97 calls) but it has **not been verified** that every value from stock providers, MCP tool descriptions, AI output and uploaded file names is escaped. | [code] grep only | Review each `innerHTML` site; add a UI test that injects `<img onerror>` in an asset name, provider author and MCP tool description. |
| P2-8 | **Arabic verification gap:** shaping is measured in the render browser, but no test inspects pixels of the *final MP4* for Arabic+numbers, punctuation, long subtitles or animated titles, and there is no check of RTL line breaking at the caption width. | [code] `tools/arabic-test.mjs` | Render fixture videos, extract frames with ffmpeg, compare against reference images (SSIM/hash) generated and reviewed once by a human. |
| P2-9 | No CI (`.github/` absent), no lint, no single "everything" command that includes the browser suites in a fixed order with a timeout; `npm test` omits e2e/export/ui. | [run] `ls .github` | Add a workflow running `npm test` + `test:all` with Chromium + ffmpeg. |
| P2-10 | AI pipeline validation: storyboard JSON is repaired and validated; script text and "facts" are produced by the LLM and flagged as unverified research, but there is no automated check that scene timing, asset ids and template names survive every edit path before render. | [code] partly read | Read `storyboard.mjs`/`text.mjs` fully in Phase 9, then add a `validateRenderData()` gate with tests. |

### P3 — UI/UX, docs, minor

| # | Finding |
|---|---|
| P3-1 | `docs/AUDIT.md` quotes stale test counts (unit 13, Arabic 12, e2e 37, export 7, UI 11 vs 15/14/38/8/13 now) and "~4,600 lines". |
| P3-2 | Version strings disagree: `package.json` 2.1.0, console banner "Reel Studio v2", MCP `clientInfo` 2.0.0. |
| P3-3 | UI strings are hard-coded Egyptian Arabic; no i18n layer, no English UI. Accessibility (labels, focus, contrast) and responsive layout not yet inspected. |
| P3-4 | `public/render.js` (1083 lines) and `public/app.js` are large single files; refactor only if a fix needs it. |
| P3-5 | Upload size limits are constants, not configurable as requested by the brief. |

## 3. Things that already work and must be preserved

Loopback-only bind with Host/Origin guards; atomic JSON writes; AES-256-GCM secrets with masking and log redaction; MCP tools disabled until allowed with schema-checked arguments and a call log; SSRF-safe provider downloads; resumable segmented rendering; two-pass loudness normalisation; per-project run control with cancel; spawn calls use argument arrays (no shell) everywhere that was read.

## 4. Proposed repair plan

1. **Phase 1 (foundation)** — graceful shutdown (P1-2), `fetchWithRetry` for ElevenLabs/Deepgram (P1-4), streamed uploads (P2-2), atomic writes (P2-3), CI workflow (P2-9).
2. **Phase 2 (security)** — MCP hardening (P2-4), OS keychain + credential delete (P2-5), `innerHTML` review + tests (P2-7).
3. **Phase 3 (rendering)** — queue (P1-1), worker-count validation (P2-1), output verification and atomic mux (P1-3), measured memory per job at 720p/1080p.
4. **Phase 4 (Remotion)** — benchmark only. Not started; the project currently has **zero** React dependencies and one dependency (`playwright`). Licence terms, Node/React compatibility and memory must be checked against the official docs at that time; no decision is implied.
5. Phases 5–12 as in the brief, ordered by the findings above (editor gaps need the decision below).

### Questions that change the plan

1. **Queue default**: is one render at a time acceptable as the default (safest for 8 GB), configurable up to N?
2. **Keychain**: add macOS/Linux keychain integration (shell-outs to `security` / `secret-tool`), or keep file-key + documentation?
3. **Editor scope**: keyframes, snap-to-grid, layer ordering and independent audio tracks require extending the edit model (`edit.mjs`, `render.js`). Do you want all four, or a subset first?
4. **Real keys**: can you run one real LLM/ElevenLabs/Deepgram/stock-provider pass on your side? From this container those hosts are unreachable, so Phases 7–9 can only be verified against mocks here.

**Not yet done in Phase 0:** reading the unread files listed in §0 (they will be read at the start of the phase that owns them), performance runs on a constrained-memory profile, and the Remotion/HyperFrames documentation review.

Waiting for your approval before Phase 1.
