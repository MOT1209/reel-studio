# Long-form: durations, scenes and chapters

## What changed

- **Durations** (`server/text.mjs`): `LENGTHS` now accepts 90, 120, 180, 300, 600, 900 and 1800 seconds.
  1800 s (30 minutes) is the hard cap (`MAX_SECONDS`). `auto` stays a short-form mode (20–120 s).
- **Scenes** (`server/storyboard.mjs`): the 12-scene cap is gone. `sceneTarget(duration)` = one scene per ~3.2 s,
  clamped to 2–`MAX_SCENES` (30) per storyboard.
- **Chapters** (`server/chapters.mjs`): a TTS project at or above `LONG_FORM_SECONDS` (90 s) is split into
  ~120-second chapters (at least two, each ≥ 45 s by default, at most 24). `chapters: false` in the create options
  keeps a long project single-pass; `chapters: true` + `chapterSeconds` (5–600 s) forces chapters at any length
  (used by the 3×10 s end-to-end test). An uploaded voice-over stays single-pass.

## How a chaptered project runs

Each chapter carries its own `script`, `voice` (`chapters/<id>/voice.mp3`), `words`, `storyboard`, `icons`,
`clips` and `render`. The five stages (`server/stage-run.mjs`) run the same code on a chapter as on a short
project — same prompts, same validation, same render checks.

1. `script` — one LLM request per chapter, each told "Chapter X of N" and how the previous chapter ended.
2. `voice` — one TTS/pronunciation pass per chapter.
3. `timing` — alignment against that chapter's own voice (ElevenLabs chars → words, Deepgram, or the pause estimate).
4. `storyboard` — one board per chapter (≤ 30 scenes), stock visuals per chapter.
5. `render` — each chapter renders its own `video.mp4` (own audio, SFX, frame-count check), then the chapters are
   joined with the ffmpeg concat demuxer and the joined file is probed for the summed frame count and duration.
   Background music is mixed once over the joined audio, so it runs across the whole video.

### Why the join re-encodes the audio (and copies the video)

AAC frames are 1024 samples and every chapter's MP4 carries encoder priming/padding. `-c:a copy` leaves that
un-trimmed audio at each join, so the sound drifts later and later against the picture. Measured on three 2 s
chapters (tone at 0.5 s): `-c:a copy` → 16 / 42 / 70 ms, one AAC re-encode → 16 / 22 / 26 ms. A 15-chapter video
would end ~350 ms out of sync with copy. `concatVideos` therefore copies the video (`-c:v copy`, exact frame count)
and re-encodes the audio once (`aac 48 kHz stereo 192k`), which removes the accumulating offset. This is covered by
`tools/concat-test.mjs` (drift must stay within one AAC frame and must not grow).

## Progress and resume

- Chapter progress (`stages`, `render`, `error`) lives in `project.json`; `save()` runs after every chapter and
  every stage. `getProject` turns a `running` chapter stage left by a restart back to `idle`.
- Rerunning a stage resets that stage (and later ones) for every chapter; a cancelled run resumes at the first
  unfinished chapter and skips chapters whose files are already on disk.
- `chapterProgress()` and the `chapterProgress` field of `publicProject` drive the chapter strip in the UI.

## The joined timeline

`assembleProject()` rebuilds the project-level `script`, `words`, `storyboard`, `icons` and `voice` from the
chapters: word times become project-global, scene and accent word indices are shifted by each chapter's first
word. That keeps the editor, subtitles (`subtitles.srt/vtt`), the preview (`/render.html?project=…`) and publish
metadata working on long videos.

## Rendering one chapter

`GET /api/projects/:id/render-data?chapter=ch-02` returns that chapter's data with local times. Both engines fetch
it: the legacy page reads `?chapter=` from its URL, Remotion gets it as an input prop. Chapter edits
(`chapterEdit`) drop trim/cuts/custom order (they describe the joined timeline), shift and clip overlays and audio
tracks to the chapter, and leave music to the join step.

## Limits / not covered

- Editing a long project in the editor edits the joined timeline; `distributeEdits()` maps words back by position
  and scenes by word index, and repairs each chapter's storyboard. Per-chapter scene regeneration is not exposed.
- A chaptered project cannot switch to an uploaded voice-over (the staged audio would have to be cut per chapter).
- Chapter renders need ffmpeg/ffprobe and a browser engine exactly like short renders.

## Verified end to end

`npm run test:longform-e2e` (3 chapters × 10 s, 720×1280 @ 24 fps, legacy engine, offline mocks): render of all
three chapters finished in 26 s; 261 + 261 + 261 = 783 frames, the joined file has exactly 783 frames and AAC
48 kHz stereo audio of the same length; Σ chapter durations vs joined duration Δ 26 ms; caption ↔ voice sync on
the joined video median 28 ms / p90 35 ms, and 30 ms for the words in the two seconds after each join; subtitles
end at the last word. `npm run e2e` (single 10 s project, 1080×1920) still passes 38/38 with −14 LUFS audio and
4 ms median caption sync.

## Tests

- `tools/longform-test.mjs` (`npm run test:longform`) — planning, aggregation, progress/resume, editing, the script
  stage against a local SSE LLM. No ffmpeg/browser needed.
- `tools/concat-test.mjs` (`npm run test:concat`) — joins three real chapters and measures audio drift at each join
  (needs ffmpeg).
- `tools/longform-e2e.mjs` (`npm run test:longform-e2e`) — a real 3-chapter project (3 × 10 s, 720×1280/24, legacy
  engine + offline mocks): every stage per chapter, chapter and joined frame counts, joined audio, caption/voice
  sync across the joins and the subtitle clock. Needs ffmpeg and a Playwright browser; writes
  `output/test-reel-longform-3ch.mp4`.
