# Performance and memory — measured (2026-11-24)

Machine: 4 CPU, 15.7 GB RAM, Node 22.23.5, system ffmpeg, Playwright Chromium. Real pipeline (script → voice → timing → storyboard → render) against the offline mocks, so LLM/TTS time is ~0 and the numbers are **render-dominated**. Reproduce: `npm run test:perf`, `npm run test:lowmem`. Peak RSS = sum over the whole process tree (server + Chromium + ffmpeg); it double-counts shared pages, so the cgroup figure (real usage) is lower.

> Numbers in the first table were measured on the audit branch (legacy engine). After merging `main` (default engine **Remotion**, legacy as fallback) the same test measured: small 24.2 s / 1637 MB, medium 62.3 s / 1662 MB, large 80.9 s / 2130 MB, queue of 3 → max 1 running; and the 1.5 GB low-memory run still passes (peak 1310 MB, 0 OOM kills). Remotion is slower here, consistent with `docs/RENDERING.md`.

## Real projects, 1080×1920, 30 fps, "standard" quality, 3 parallel pages
| Project | Video length | Stage wall time | Peak RSS (tree) |
|---|---|---|---|
| small — 10 s script | 10.9 s | 14.4 s | 2044 MB |
| medium — 30 s script | 37.4 s | 39.4 s | 2100 MB |
| large — 60 s script + three 6000×4000 photos (14.6 MB each) + a 1080p video overlay | 44.5 s* | 56.4 s | 2713 MB |
| queue — 3 projects started at once, `RS_MAX_RENDERS=1` | 3 × ~11 s | 38.9 s total | max 1 render running (polled every 150 ms), a job seen waiting |

\* the mock LLM's "60 s" script is shorter than 60 s of speech; the video length is what the renderer actually produced. All outputs verified with ffprobe (h264 + aac, 1080×1920, frame count = duration × fps).

Memory does not grow with length (see also `docs/REMOTION-EVALUATION.md` §4: 30 s → 90 s at 2 pages, 1765 → 1762 MB).

## Low-memory behaviour (Linux memory cgroup around the whole server; `tools/lowmem-test.mjs`)
| Limit | Result |
|---|---|
| 2 GB, 3 pages (before the fix) | ok, real peak 1.8 GB |
| **1 GB**, before the fix | **failed**: Chromium `Target crashed` (kernel OOM kill), render failed |
| **1.5 GB**, before the fix | first attempt crashed, the automatic retry (1 page) finished in 96 s |
| **1.5 GB**, after the fix | **passes**: 1 attempt, peak 1380 MB real usage, 0 OOM kills, 0 browser crashes, 90 s (vs 58 s unconstrained) |
| 1 GB, after the fix | still **fails** (1 page, 6000×4000 photos at 1080p) — about 1.5 GB is the practical floor for this heavy fixture |

What was wrong and what changed:
- `os.freemem()` reports the **host's** free RAM, so inside a container/VM with a memory limit the renderer started 3 pages that the kernel then killed. `availableMemory()` now reads the process's own cgroup (v2 `memory.max`/`memory.current`, v1 `memory.limit_in_bytes`/`usage_in_bytes`, page cache excluded) and takes the smaller number.
- The per-page estimate was 400 MB with a 300 MB base; measured, it is ≈ 450 MB per page + ≈ 600 MB for server/ffmpeg/headroom. Updated (unit-tested).
- `Target crashed` / `Page crashed` now count as transient: the engine manager retries the job once **with a single page** (segments already finished are reused).

Not measured: other OSes, an 8 GB physical machine with swap, 4K output, more than one concurrent render (`RS_MAX_RENDERS` > 1).
