// Pre-render estimate: how long the render will take, how much speech/LLM/disk the project implies, and — when prices
// are configured — what it costs. A planning aid, not a promise: the render rate comes from real renders measured on
// this machine (tools/estimate-calibrate.mjs) and is shown as a range.
// Prices are per 1000 units in USD and stay unset by default (cost is null until you set them):
//   RS_PRICE_TTS_PER_1K_CHARS, RS_PRICE_LLM_PER_1K_TOKENS, RS_PRICE_RENDER_PER_MINUTE
import { effectiveEdit, layoutFor } from './edit.mjs';

const WORDS_PER_SECOND = 2.6;   // the voice's speaking rate used to plan a script
const CHARS_PER_WORD = 6.2;     // Arabic average, used when the script text is not written yet

// Measured with tools/estimate-calibrate.mjs — a real 3-chapter project at the default settings (9:16 1080p,
// standard, 30 fps, engine auto → Remotion) plus one 720p render per engine. `rate` is render seconds per video
// second at this frame; `exponent` is how the rate follows the pixel count (both probes). Re-run the tool after a
// hardware change and copy its table here.
export const MEASURED = {
  at: '2026-11-27',
  machine: '2 vCPU Xeon E-2388G, 3.8 GB, Linux',
  anchorPx: 1080 * 1920,
  anchorFps: 30,
  engine: {
    remotion: { rate: 2.172, exponent: 0.29 }, // 1.725 at 720p
    legacy: { rate: 0.783, exponent: 0.42 },   // 0.557 at 720p
  },
};
const QUALITY = { draft: 0.95, standard: 1, high: 1.1 }; // the encoder's share of the work; drawing the frames dominates
const SETUP_PER_CHAPTER = 2.1; // measured: audio mix + mux + ffprobe + contact sheet after every chapter
const JOIN_SECONDS = 5.5;      // measured: join + post-join QC + contact sheet (3 chapters)
// A 40-second probe cannot promise a 30-minute render on a loaded machine: the estimate is that rate ± this band.
const BAND = { fast: 0.85, slow: 1.25 };
const MBPS = { draft: 1.2, standard: 2.5, high: 4.5 };
const priceOf = (k) => Math.max(0, Number(process.env[k]) || 0);

/** Render seconds per video second for one export configuration, from the measured anchor. */
function rateFor(engine, width, height, fps, quality) {
  const m = MEASURED.engine[engine] || MEASURED.engine.remotion;
  return m.rate * ((width * height) / MEASURED.anchorPx) ** m.exponent * (fps / MEASURED.anchorFps) * (QUALITY[quality] ?? 1);
}

export function estimateRender(p) {
  const E = effectiveEdit(p.edit);
  const L = layoutFor(E.export.aspect, E.export.resolution);
  const planned = Number(p.seconds) > 0 ? Number(p.seconds) : null;
  const chapters = Math.max(1, p.chapters?.length
    || (p.options?.chapters ? Math.round((planned || 60) / (p.options.chapterSeconds || 300)) || 1 : 1));
  const seconds = planned || p.render?.duration || (p.script?.words ? p.script.words / WORDS_PER_SECOND : 60);
  const words = Math.round(p.script?.words
    || p.chapters?.reduce((a, ch) => a + (ch.words?.length || 0), 0)
    || seconds * WORDS_PER_SECOND);
  const ttsCharacters = p.script?.text ? p.script.text.length : Math.round(words * CHARS_PER_WORD);

  // research + script + storyboard per chapter + one review pass over the whole script
  const research = !!(p.research || p.options?.research !== false);
  const perChapter = words / chapters;
  const llmTokensIn = (research ? 2500 : 0) + Math.round(chapters * (1400 + perChapter * 4)) + Math.round(words * 3);
  const llmTokensOut = (research ? 800 : 0) + Math.round(chapters * (perChapter * 2 + 500)) + 600;

  const requested = E.export.engine;
  const engine = MEASURED.engine[requested] ? requested : 'auto';
  const used = engine === 'auto' ? 'remotion' : engine; // auto tries Remotion first (engines/manager.mjs AUTO_ORDER)
  const quality = E.export.quality in QUALITY ? E.export.quality : 'standard';
  const rate = rateFor(used, L.width, L.height, E.export.fps, quality);
  const fixed = chapters * SETUP_PER_CHAPTER + JOIN_SECONDS;
  const span = (k) => Math.max(1, Math.round(seconds * rate * k + fixed));
  const renderSeconds = span(1);
  const renderSecondsMin = span(BAND.fast);
  const renderSecondsMax = span(BAND.slow);
  // the chapter MP4s and the joined copy on disk, plus a small allowance for audio/contact sheets
  const diskMB = Math.round(2 * seconds * (MBPS[quality] + 0.192) / 8 + 20);

  const pTts = priceOf('RS_PRICE_TTS_PER_1K_CHARS');
  const pLlm = priceOf('RS_PRICE_LLM_PER_1K_TOKENS');
  const pRender = priceOf('RS_PRICE_RENDER_PER_MINUTE');
  let cost = null;
  if (pTts || pLlm || pRender) {
    const tts = ttsCharacters / 1000 * pTts;
    const llm = (llmTokensIn + llmTokensOut) / 1000 * pLlm;
    const render = renderSeconds / 60 * pRender;
    cost = { tts: +tts.toFixed(2), llm: +llm.toFixed(2), render: +render.toFixed(2), total: +(tts + llm + render).toFixed(2), currency: 'USD' };
  }

  const perSecond = +rate.toFixed(2);
  return {
    seconds: +seconds.toFixed(1),
    chapters,
    words,
    ttsCharacters,
    llmTokens: llmTokensIn + llmTokensOut,
    llmTokensIn,
    llmTokensOut,
    ratePerSecond: perSecond,
    renderSeconds,
    renderSecondsMin,
    renderSecondsMax,
    renderMinutes: +(renderSeconds / 60).toFixed(1),
    renderMinutesMin: +(renderSecondsMin / 60).toFixed(1),
    renderMinutesMax: +(renderSecondsMax / 60).toFixed(1),
    diskMB,
    engine,
    resolution: `${L.width}×${L.height}`,
    fps: E.export.fps,
    quality,
    measuredAt: MEASURED.at,
    cost,
    basis: `${perSecond} s of render per video second (measured ${used}, ${L.width}×${L.height}, ${quality}, ${E.export.fps} fps; range ${Math.round(renderSecondsMin / 60)}–${Math.round(renderSecondsMax / 60)} min) + ${chapters} × ${SETUP_PER_CHAPTER} s setup + ${JOIN_SECONDS} s join`,
  };
}
