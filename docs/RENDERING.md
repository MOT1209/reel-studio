# Rendering architecture (v3)

Reel Studio turns a validated scene JSON into an MP4 through one **engine manager** and interchangeable **frame
engines**. Composition and capture belong to the engine; everything that is media processing (encoding, audio,
muxing, validation) belongs to the FFmpeg layer and is the same for every engine.

```
storyboard (AI or editor)
   │  repairStoryboard()  ─ fixes what the model got wrong
   ▼
scene JSON ── validateStoryboard() (schemas/scene.schema.json + timing rules) ── refused with exact paths if invalid
   │
   ▼  renderData(p)  ─ times in seconds, layout, typography, media URLs, fonts
engine manager (server/engines/manager.mjs)
   │  choose: settings / project → auto | remotion | legacy      queue: maxJobs (default 1)
   │  job: id, status, frames, timings, fallback, error → data/logs/render-jobs.jsonl
   ▼
frame engine ── produce(i0, i1, emit) ──▶ FFmpeg layer (server/engines/ffmpeg.mjs)
   ├─ remotion: React composition (remotion/) in Chrome Headless Shell,      encodeSegmented(): re-order, back-pressure,
   │            renderFrames + onFrameBuffer + frameRange                    10 s segments + manifest (resume after cancel/crash),
   └─ legacy:   render.html pages in Playwright, canvas.toBlob               H.264/H.265, CRF or bitrate → concat
                                                                              │
                         voice + SFX + music → mixAudio (2-pass loudnorm −14 LUFS, ducking) → muxFinal
                                                                              │
                                              validateOutput (ffprobe: size, fps, codec, audio, duration) → video.mp4
```

## Engines

| | **Remotion** (default when available) | **Legacy** (fallback, reference) |
|---|---|---|
| Composition | `remotion/Root.jsx` + `Reel.jsx` (React), size/fps/length from input props via `calculateMetadata` | `public/render.html` |
| Drawing | the shared deterministic renderer `public/render.js` (`ReelRenderer.create(canvas)`) inside the composition | the same `public/render.js`, booted by the page |
| Browser | Chrome Headless Shell (Playwright's copy, or Remotion's download) | Playwright Chromium (or system Chrome/Edge) |
| Capture | `renderFrames` → `onFrameBuffer` (JPEG 92), `frameRange` per segment | `canvas.toBlob` JPEG 0.95 (or screenshots with `RS_CAPTURE=screenshot`) |
| Parallelism | tabs: CPU-1, free RAM / 450 MB, max 4 (`RS_REMOTION_CONCURRENCY`) | pages: CPU-1, free RAM / 400 MB, max 4 (`RS_RENDER_WORKERS`) |
| Encoding | **our** ffmpeg via `encodeSegmented` (Remotion's encoder and bundled ffmpeg are not used) | same |

Both engines draw with **one** rendering core, so the editor preview, the legacy engine and Remotion produce the
same pixels: the comparison test (`npm run test:remotion`) measures **SSIM 0.995** mean / 0.992 worst frame between
the two engines on a project with a photo scene, a video background, Arabic captions and every animation preset.

The Remotion bundle is built in a **child process** (webpack stays out of the server process), into
`data/remotion-bundle/`, only when `remotion/` or `server/timeline.mjs` change; `npm run setup` builds it once. It is
served by the Reel Studio server at `/remotion/`, so render data, fonts, media and `render.js` are same-origin.

### Selection, fallback, queue, cancel

- **Choice:** project export setting (`edit.export.engine`) → settings default (`render.engine`) → `auto`.
  `auto` = Remotion when its packages and entry exist, else legacy. An unavailable explicit choice falls back with a
  logged note.
- **Fallback:** if the chosen engine fails for any reason other than a cancel, the job is retried on the legacy
  engine (`render.fallback`, on by default). The job records `fallbackFrom` and the reason; the project page shows it.
- **Queue:** at most `render.maxJobs` renders at a time (default 1, recommended for 8 GB RAM); others wait (cancellable
  while queued).
- **Cancel:** project cancel, or `POST /api/render-jobs/:id/cancel`. Remotion is stopped through `makeCancelSignal`,
  ffmpeg is killed, partial segments are removed, the slot is freed. A later render resumes from the last finished
  segment (same render data + engine + codec).
- **Progress:** per frame, in order (`job.frames / job.total`) over SSE (`progress`, `job` events) — real frames written
  to ffmpeg, never simulated.

### Engine interface (adding an engine)

```js
registerEngine({
  id: 'myengine', name: 'Human name',
  async validate() { return { ok: true } },            // cheap: no heavy imports
  async prepare(ctx) {},                               // ctx: projectId, port, url, data, timeOf(i), width, height, fps, total, signal, log
  async produce(i0, i1, emit, ctx) {},                 // emit(frameIndex, jpegBuffer) in any order; await it (back-pressure)
  async cleanup(ctx) {},
});
```

The manager, the encoder, the queue, the job log, cancel and fallback come for free. `tools/engines-test.mjs` shows a
fake engine that emits frames out of order.

## Scene JSON

`schemas/scene.schema.json` (served at `GET /api/scene-schema`) describes the storyboard every engine receives:
scene type and template enums, title/label lengths, items, values, media ids, background mode and the animation
presets. `server/scene-schema.mjs` adds what a schema cannot express: scene starts ascending from word 0, word indices
inside the script, item counts per template, chart/meter numbers, item times inside their scene.

It runs after every AI generation and repair, on every editor save, after a scene regeneration and **again at the
start of every render** — an invalid storyboard is refused with paths like `scenes/2/items/0/at: word 31 is outside its
scene (24–30)`.

**Scene regeneration:** `POST /api/projects/:id/scenes/:k/regenerate {hint}` asks the model for one new scene
(`[[TASK:SCENE]]`), keeps its start word and its media, repairs and validates the whole storyboard and resets the
render. The editor has the button and a hint field in the scene inspector.

## Animation library

Implemented once in the shared renderer (`public/render.js`), so it looks the same in the preview and both engines.

| Scene transition (`scene.transition`, project default `edit.transition`) | Title animation (`scene.titleAnim`) |
|---|---|
| `push` (default) · `fade` · `zoom` · `slide` · `wipe` (reveal from the right, the reading direction) · `rise` · `none` (hard cut). A scene's exit follows the next scene's entry, so both sides of a cut match. | `rise` (default) · `fade` · `pop` (overshoot) · `words` (word by word in reading order — whole words, so Arabic letters keep their joined forms) · `none` |

Item pop-ins, caption highlighting, Ken Burns, overlays (`fade`/`pop`/`slide`) and the end fade are unchanged.

## Formats and FFmpeg

| | Options |
|---|---|
| Aspect | 9:16 · 4:5 · 1:1 · 16:9 (platform presets set them) |
| Resolution | 720p · 1080p (short side) |
| FPS | 24 · 25 · 30 · 60 |
| Codec | H.264 (`libx264`, `avc1`) · H.265 (`libx265`, `hvc1`, when the ffmpeg build has it) |
| Rate | constant quality (draft CRF 26 / standard 20 / high 17) or a bitrate (4–20 Mbps; maxrate 1.5×, buffer 2×) |
| Audio | AAC, 2-pass loudnorm −14 LUFS, music ducked under the voice |
| Output | `data/projects/<id>/video.mp4` (+ contact sheet, SRT/VTT) and optionally a copy in `render.outputDir` |

Every final MP4 is checked with **ffprobe** (width, height, frame rate, codec, audio stream, duration ±0.15 s); a
mismatch fails the render instead of shipping a broken file.

## Benchmarks

Measured with `node tools/engine-bench.mjs 20` — a 23 s, 1080×1920, 30 fps project (692 frames, standard quality),
render job time = frames drawn, captured and encoded (warm; audio mix and mux excluded). Peak RAM = the whole process
tree (server + browser + ffmpeg), sampled every 200 ms. Machine: 4 vCPU Xeon @ 2.3 GHz, 15.7 GB RAM, Linux, Node 22.

| Engine | Parallel pages/tabs | Render | Frames/s | Peak RAM |
|---|---|---|---|---|
| Legacy | 1 | 21.6 s | 32.0 | 1,453 MB |
| Remotion | 1 | 54.7 s | 12.6 | 1,210 MB |
| Legacy | 2 | 15.6 s | 44.5 | 1,721 MB |
| Remotion | 2 | 33.0 s | 21.0 | 1,468 MB |

- **Same pixels, different speed.** Remotion is ~2.1–2.5× slower here: it takes a screenshot of the composited page
  for every frame, while the legacy engine reads the canvas directly (`toBlob`) in the same round trip as the draw.
  Changing Remotion's GL backend does not change this (10 s clip, 2 tabs: swangle 20.5 fps, swiftshader 19.8,
  angle 18.1 — `RS_REMOTION_GL`).
- **Remotion uses less memory** (~250 MB less at the same parallelism).
- **Cold start:** the first Remotion render after an install or an update of `remotion/` builds the bundle
  (≈3–15 s, in a child process); `npm run setup` does it up front. The first render of the run above, including the
  bundle build, took 58 s.
- **Recommendation:** Remotion stays the default composition engine (it is the platform for React scene layers, and
  its output is verified identical). When render speed matters more — long videos, a slow laptop — choose
  **Classic** in Settings → Render engine (or per project in the editor toolbar): about twice as fast, same video.
- On an 8 GB machine both engines fit comfortably with 2 parallel pages (< 1.8 GB peak for the whole tree).

**Legacy engine scaling** (synthetic scene, one run each; measured for v2.x audit):

| Size | Duration | Pages | Wall | Peak RAM |
|---|---|---|---|---|
| 720×1280 | 10 s | 1 | 6.9 s | 1,233 MB |
| 720×1280 | 10 s | 4 | 5.3 s | 1,749 MB |
| 1080×1920 | 30 s | 1 | 31.2 s | 1,483 MB |
| 1080×1920 | 30 s | 2 | 21.5 s | 1,765 MB |
| 1080×1920 | 30 s | 4 | 20.3 s | 2,341 MB |
| 1080×1920 | 90 s | 2 | 57.2 s | 1,762 MB |

Peak RAM does not grow with the length of the video (segments are encoded and released every 10 s); 4 pages buy ~6 %
over 2 at 1080p for +33 % RAM, which supports the conservative default.

## Memory on an 8 GB machine

- One render at a time (`render.maxJobs = 1`). Parallel tabs/pages are capped by free memory (≈450 MB per Remotion tab,
  ≈400 MB per legacy page), so a machine with ~3 GB free renders with 2 or fewer.
- The Remotion bundle is built once (child process, ~0.5 GB for a few seconds), never during a normal render.
- Frames stream through memory (≤ 48 waiting frames per segment); video clips are pre-extracted to small JPEGs on disk.
- Free RAM is logged at the start of each render; below 1 GB the log warns.

## HyperFrames (evaluated, not integrated)

Evaluated on Node 22 with `hyperframes@0.9.88` (Apache-2.0) in an isolated folder — **not** added to Reel Studio.

**Proof of concept:** an HTML composition (GSAP timeline) with an Arabic title, a mixed Arabic/English caption with
Arabic digits, and a `<canvas>` drawn by a deterministic `drawFrame(t)` driven from the timeline — the same pattern
Reel Studio's renderer uses. `hyperframes lint`: 0 errors. `hyperframes render`: 3 s, 1080×1920, exactly 90 frames
at 30 fps, H.264 (ffprobe), in 9.7 s (setup 3.6 s + capture/encode 5.9 s, 2 workers, screenshot capture because
BeginFrame did not run on this machine). Arabic shaping, RTL and mixed bidi were correct; the canvas showed the value
expected for t = 1.5 s, so seeking is deterministic.

| | HyperFrames | Remotion (integrated) |
|---|---|---|
| Licence | Apache-2.0 — no conditions | free for individuals / ≤ 3 employees (Reel Studio's case); company licence above that |
| Authoring | plain HTML/CSS + GSAP, no build step | React + webpack bundle |
| Fit with Reel Studio | good — our canvas renderer would run unchanged behind a timeline adapter | integrated, SSIM 0.995 vs legacy |
| Node | ≥ 22 | ≥ 16 (Reel Studio supports ≥ 18) |
| Maturity | 0.x, frequent releases | 4.x, stable API |
| Network | telemetry to PostHog **on by default** (`HYPERFRAMES_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` turn it off); `share`/`publish` talk to HeyGen | none during render |
| Install | 123 MB, 78 packages (+ GSAP) | 216 MB, 169 packages |

**Decision: not integrated now.** It would raise Reel Studio's Node requirement to 22, adds default-on telemetry and a
pre-1.0 API, and brings no capability the two current engines lack. It remains the natural third engine if the
Remotion licence ever becomes a constraint (a company with more than 3 employees, or selling Reel Studio): the engine
interface above is exactly what an adapter would implement (`prepare` = start its producer on our composition,
`produce` = its frame stream → `emit`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/engines[?fresh=1]` | engines with availability, codecs, selected default, recent jobs |
| GET | `/api/render-jobs` · `/api/render-jobs/:id` | job records (status, frames, engine, fallback, timings) |
| POST | `/api/render-jobs/:id/cancel` | cancel a queued or running job |
| GET | `/api/scene-schema` | the scene JSON Schema |
| POST | `/api/projects/:id/scenes/:k/regenerate` | regenerate one scene (`{ "hint": "…" }`) |

## Tests

| Command | What it proves |
|---|---|
| `npm run test:engines` | manager + encoder with fake engines: out-of-order frames end up in order (colour-checked), segment recovery, fallback, fallback off, short engine = error, cancel (no partial output, slot freed), cancel by id, queue (1 and 2), H.265 + bitrate, ffprobe validation, job log |
| `npm run test:remotion` | real server and project through **both** engines: ffprobe (size, fps, frames, codec, audio), SSIM between engines, scene regeneration, animation presets, 16:9 H.265 at a bitrate, cancel, job log |
| `npm run e2e` / `test:export` | the full product tests — they now run on the default engine (Remotion) |
| `node tools/engine-bench.mjs [seconds]` | the benchmark above |
