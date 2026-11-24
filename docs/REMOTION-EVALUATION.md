# Remotion evaluation (Phase 4) — measured, 2026-11-24

**Decision: do not integrate Remotion. Keep Canvas + Playwright + FFmpeg.** HyperFrames: not integrated, not benchmarked (see end).

## 1. Compatibility audit
| Item | Finding |
|---|---|
| Node | Remotion 4.0.546 installed and ran on Node 22.23.5 (Reel Studio requires ≥ 20). |
| React | Needs `react` + `react-dom` (peer `>=16.8`); Reel Studio currently has **no** React and **one** dependency (`playwright`). The PoC installed React 19.3.1. |
| Install size | 169 packages, **217 MB** `node_modules` (Reel Studio today: playwright only). |
| Browser | Remotion drives Chromium too (the PoC used the same Chromium as Playwright through `browserExecutable`). |
| FFmpeg | Remotion encodes with its own bundled FFmpeg; Reel Studio's audio mixing (side-chain ducking, two-pass loudnorm) would stay in our FFmpeg code regardless. |
| **Licence** | **Not MIT.** `LICENSE.md` (read from the 4.0.546 npm package): free for individuals, for-profit organisations with **up to 3 employees**, non-profits, and evaluation; **any larger for-profit organisation needs a paid Company License.** Redistributing a derivative of Remotion is forbidden. Remotion's page says the terms change in 5.0. Whoever ships or runs Reel Studio commercially must check which tier they fall under. |

## 2. Benchmark (identical scene, `bench/`)
Scene: 720×1280, 30 fps, 10 s (300 frames) — gradient, sliding Arabic title (Cairo), mixed Arabic/English line, Arabic-Indic counter, progress bar. Same font file in both. Both engines: 2 parallel pages / `concurrency 2`, H.264 CRF 20, this machine (4 CPU, 16 GB). 3 runs each, 0 failures in either engine. Memory = **peak RSS of the whole process tree** (node + Chromium + ffmpeg) sampled every 100 ms. Outputs verified with ffprobe: h264, 720×1280, 30/1, 300 frames, both.

| | Legacy (Canvas + Playwright + FFmpeg) | Remotion 4.0.546 |
|---|---|---|
| Render time (median) | **4.9 s** | 22.7 s (+ 3.4 s bundling, 0.6 s composition select → 27 s wall) |
| Peak RAM (median) | **1407 MB** | 1668 MB |
| Failures | 0 / 3 | 0 / 3 |
| Arabic output | correct shaping + bidi (viewed) | correct shaping + bidi (viewed) — identical, as both use Chromium's HarfBuzz/ICU |

Reproduce: `cd bench/remotion-poc && npm install && cd ../.. && CHROME_PATH=<chrome binary> npm run bench -- legacy 3 2 && CHROME_PATH=<chrome binary> npm run bench -- remotion 3 2`.

**Caveats (honest):** a light synthetic scene, one machine, Remotion at default image settings (JPEG), no tuning of Remotion's `concurrency`/GL flags beyond `concurrency 2`. The 4.6× gap may shrink with tuning or heavier scenes, but nothing here suggests Remotion is faster. Not measured: CPU time, 4K, Remotion's Lambda/Cloud Run rendering.

## 3. Why no integration
- **No measured benefit**: slower (4.6×), more memory (+19 %), identical Arabic quality.
- **Cost**: +217 MB and React in a zero-dependency app, a licence tier that depends on the owner's company size, and a rewrite of the 1 000-line canvas renderer (templates, captions, bidi, kashida, keyframes) as React components — with the preview/editor contract (`window.drawFrame`) to redo.
- The benefit Remotion is known for (React component ecosystem, studio UI) is not something Reel Studio's editor needs.
- If this is revisited: build a `server/engines/remotion.mjs` adapter behind the existing `renderFrames` signature, keep the legacy engine as the default, select per project, fall back on failure. The PoC in `bench/remotion-poc` is the starting point. **Not implemented.**

## 4. Legacy engine — measured scaling (same synthetic scene, `bench/`, one run each)
| Size | Duration | Workers | Wall | Peak RAM |
|---|---|---|---|---|
| 720×1280 | 10 s | 1 | 6.9 s | 1233 MB |
| 720×1280 | 10 s | 4 | 5.3 s | 1749 MB |
| 1080×1920 | 30 s | 1 | 31.2 s | 1483 MB |
| 1080×1920 | 30 s | 2 | 21.5 s | 1765 MB |
| 1080×1920 | 30 s | 4 | 20.3 s | 2341 MB |
| 1080×1920 | 90 s | 2 | 57.2 s | 1762 MB |

30 s → 90 s at 2 workers: peak RAM 1765 → 1762 MB, i.e. **no growth with job length** (segments are encoded and released every 10 s). Everything fits in 8 GB with room to spare **for this scene**; real projects with large photos/video clips use more (images are down-scaled before drawing, clips are frame files on disk). 4 workers buy ~6 % over 2 at 1080p for +33 % RAM, which supports the conservative default. Not measured: a real memory-starved machine (no cgroup/VM available here) — `parseWorkers` reduces workers from free RAM, unit-tested, not stress-tested.

## 5. HyperFrames
`hyperframes` on npm: 0.9.88 (pre-1.0), Apache-2.0, HeyGen, "write HTML, render MP4", modified the same day as this check. It is another browser-capture-and-FFmpeg pipeline, i.e. the same architecture as the engine already here; no capability gap it would fill was identified, and nothing was installed or benchmarked. **Verdict: not integrated; revisit only with a concrete need and a benchmark.**
