// The five pipeline stages. Every stage runs either on the project itself (a short video, one script, one voice,
// one storyboard, one render) or on a chapter of a long one (see chapters.mjs) — the body is the same code, so a
// chapter gets exactly the same script/voice/timing/storyboard/render checks as a single-pass project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings } from './settings.mjs';
import { chatStream, ttsWithTimestamps, ttsOpenAI, transcribeWords, applyPronunciation } from './apis.mjs';
import { estimateWords } from './estimate.mjs';
import { scriptMessages, researchMessages, parseScript, tokenize, countWords, charsToWords, wordsWithChars, alignWords, WORDS_PER_SECOND } from './text.mjs';
import { storyboardMessages, reviewMessages, extractJson, repairStoryboard, storyboardNouns } from './storyboard.mjs';
import { assertStoryboard } from './scene-schema.mjs';
import { iconsFor } from './icons.mjs';
import { run, probeDuration, writeSfx, mixAudio, muxFinal, concatAudio, concatVideos, contactSheet } from './render.mjs';
import { renderVideo } from './engines/manager.mjs';
import { effectiveEdit, layoutFor, prepareClip, checkRenderInputs } from './edit.mjs';
import { getAsset, assetFile, creditsFor } from './assets.mjs';
import * as PV from './providers.mjs';
import { srcToOut, outToSrc, isHold } from './timeline.mjs';
import { assembleProject, chapterDuration as chDuration, chapterFolder, chapterEdit } from './chapters.mjs';

const tail = (text, n = 28) => String(text || '').trim().split(/\s+/).slice(-n).join(' ');

/**
 * Builds the stage table for the pipeline. `ctx` is the project layer (log/save/bus/projectDir/renderData/port) so
 * this module never imports pipeline.mjs (no cycle).
 */
export function makeStages(ctx) {
  const { log, save, bus, projectDir, renderData, port = () => 4301 } = ctx;

  // ---- script ---------------------------------------------------------------------------------------------
  async function researchPass(p, signal) {
    const s = getSettings();
    p.research = null;
    if (p.options?.research === false) return;
    // notes for the writer, shown to the user as UNVERIFIED (a failure only skips it)
    try {
      const r = await chatStream(s, researchMessages(p.topic), { signal, temperature: 0.2, maxTokens: 1500 });
      const j = extractJson(r.text);
      const facts = (Array.isArray(j.facts) ? j.facts : []).slice(0, 10).map((f) => ({
        claim: String(f?.claim || '').slice(0, 300), confidence: ['high', 'medium', 'low'].includes(f?.confidence) ? f.confidence : 'low',
        source: typeof f?.source === 'string' && f.source.trim() ? f.source.slice(0, 200) : null,
      })).filter((f) => f.claim);
      p.research = { angle: String(j.angle || '').slice(0, 200), facts, misconceptions: (Array.isArray(j.misconceptions) ? j.misconceptions : []).map(String).slice(0, 5), verified: false };
      log(p, 'script', `research: ${facts.length} notes (unverified) · ${facts.filter((f) => f.confidence === 'high').length} high-confidence`);
    } catch (e) {
      if (signal.aborted) throw e;
      log(p, 'script', `⚠ research pass skipped (${e.message})`);
    }
  }

  /** One script request: the project itself or one chapter. */
  async function scriptScope(p, S, signal, chapter = null, prevTail = '') {
    const s = getSettings();
    const seconds = chapter ? Math.round(chapter.seconds) : p.seconds;
    const auto = seconds === 'auto';
    const target = auto ? null : Math.round(seconds * WORDS_PER_SECOND);
    const where = chapter ? `chapter ${chapter.index + 1}/${p.chapters.length} · ` : '';
    log(p, 'script', `${where}LLM ${s.llm.baseUrl} · model ${s.llm.model} · ${auto ? 'length: auto (LLM decides)' : `target ${target} words`} · ${{ msa: 'فصحى', levantine: 'شامي', gulf: 'خليجي' }[p.options?.dialect] || 'عامية مصرية'}`);
    bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', reset: true } });
    const { text, model } = await chatStream(s, scriptMessages(p.topic, seconds, {
      dialect: p.options?.dialect, research: p.research,
      chapter: chapter ? { index: chapter.index, total: p.chapters.length, seconds, prevTail } : null,
    }), { signal, onDelta: (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'script', delta: d } }) });
    const parsed = parseScript(text);
    const n = countWords(parsed.text);
    S.script = { ...parsed, words: n, model: model || s.llm.model };
    if (chapter) chapter.title = parsed.title;
    log(p, 'script', `${where}"${parsed.title}" — ${n} words ≈ ${(n / WORDS_PER_SECOND).toFixed(0)} s${target ? ` (target ${target})` : ''}${model ? ' · ' + model : ''}`);
    if (target && Math.abs(n - target) > target * 0.25) log(p, 'script', `⚠ ${where}word count is ${n > target ? 'above' : 'below'} target by ${Math.abs(n - target)} — this part will be ~${(n / WORDS_PER_SECOND).toFixed(0)} s`);
    return parsed;
  }

  async function script(p, signal) {
    await researchPass(p, signal);
    if (p.chapters?.length) {
      let prevTail = '';
      for (const ch of p.chapters) {
        if (ch.stages.script === 'done' && ch.script?.text) { prevTail = tail(ch.script.text); continue; }
        if (signal.aborted) throw new Error('cancelled');
        await scriptScope(p, ch, signal, ch, prevTail);
        ch.stages.script = 'done';
        ch.error = null;
        assembleProject(p);
        save(p);
        prevTail = tail(ch.script.text);
      }
      assembleProject(p);
      const total = p.script?.words || 0;
      const target = Math.round(p.seconds * WORDS_PER_SECOND);
      log(p, 'script', `long-form script: ${p.chapters.length} chapters · ${total} words ≈ ${(total / WORDS_PER_SECOND).toFixed(0)} s (target ${target})`);
      if (Math.abs(total - target) > target * 0.2) log(p, 'script', `⚠ total is ${total > target ? 'above' : 'below'} target by ${Math.abs(total - target)} words — the video will be ~${(total / WORDS_PER_SECOND).toFixed(0)} s`);
      if ((p.options?.dialect || 'egyptian') === 'egyptian' && !/عارف\s+ليه/.test(p.script?.text || '')) log(p, 'script', '⚠ series question «عارف ليه؟» not found');
      return;
    }
    const parsed = await scriptScope(p, p, signal);
    if ((p.options?.dialect || 'egyptian') === 'egyptian' && !/عارف\s+ليه/.test(parsed.text)) log(p, 'script', '⚠ series question «عارف ليه؟» not found');
  }

  // ---- voice ----------------------------------------------------------------------------------------------
  async function voiceScope(p, S, dir, signal) {
    if (!S.script?.text) throw new Error('no script');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'voice.mp3');
    if (p.voiceMode === 'upload') {
      if (!S.upload) throw new Error('voice mode is "upload" but no file was uploaded');
      log(p, 'voice', `converting ${S.upload.file} → voice.mp3`);
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-y', '-i', path.join(projectDir(p.id), S.upload.file), '-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', out], { signal });
      S.voice = { file: 'voice.mp3', source: 'upload', duration: await probeDuration(out) };
      log(p, 'voice', `voice-over ${S.voice.duration.toFixed(2)} s`);
      return;
    }
    const s = getSettings();
    const spoken = applyPronunciation(S.script.text, s.pronunciation);
    if (s.tts?.provider === 'openai') {
      log(p, 'voice', `OpenAI-compatible TTS ${s.openaiTts.baseUrl} · ${s.openaiTts.model} · voice ${s.openaiTts.voice} · speed ${s.openaiTts.speed}${spoken.text !== S.script.text ? ' · pronunciation fixes applied' : ''}`);
      fs.writeFileSync(out, await ttsOpenAI(s, spoken.text, { signal }));
      S.voice = { file: 'voice.mp3', source: 'openai', duration: await probeDuration(out) };
      log(p, 'voice', `voice.mp3 ${S.voice.duration.toFixed(2)} s (no timestamps — timing comes next)`);
      return;
    }
    log(p, 'voice', `ElevenLabs voice ${s.elevenlabs.voiceId || '(none)'} · ${s.elevenlabs.modelId} · speed ${s.elevenlabs.speed ?? 1}${spoken.text !== S.script.text ? ' · pronunciation fixes applied' : ''}`);
    const { audio, chars } = await ttsWithTimestamps(s, spoken.text, { signal });
    fs.writeFileSync(out, audio);
    const timed = charsToWords(chars);
    fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'elevenlabs', chars, words: timed.map(({ chars: _c, ...w }) => w) }));
    S.voice = { file: 'voice.mp3', source: 'elevenlabs', duration: await probeDuration(out), chars: chars.length, timedWords: timed.length };
    log(p, 'voice', `voice.mp3 ${S.voice.duration.toFixed(2)} s · ${chars.length} timed characters → ${timed.length} words`);
  }

  async function voice(p, signal) {
    if (p.chapters?.length) {
      if (p.voiceMode === 'upload') throw new Error('المشروع بالنظام الفصلي بياخد صوته من TTS؛ المشاريع بصوت مرفوع بتترندر كملف واحد');
      for (const ch of p.chapters) {
        const dir = chapterFolder(p.id, ch.id);
        if (ch.stages.voice === 'done' && ch.voice?.duration && fs.existsSync(path.join(dir, 'voice.mp3'))) { log(p, 'voice', `chapter ${ch.index + 1}: voice already there — resuming`); continue; }
        if (signal.aborted) throw new Error('cancelled');
        log(p, 'voice', `▶ chapter ${ch.index + 1}/${p.chapters.length} (${ch.seconds} s)`);
        await voiceScope(p, ch, dir, signal);
        ch.stages.voice = 'done';
        ch.voice.file = `chapters/${ch.id}/voice.mp3`;
        assembleProject(p);
        save(p);
      }
      assembleProject(p);
      // one joined voice-over for the editor preview, the subtitle clock and the project page's audio player
      try {
        await concatAudio({ files: p.chapters.map((ch) => path.join(chapterFolder(p.id, ch.id), 'voice.mp3')), out: path.join(projectDir(p.id), 'voice.mp3'), signal });
        log(p, 'voice', `joined voice.mp3: ${p.voice.duration.toFixed(2)} s (editor / preview audio)`);
      } catch (e) {
        if (signal.aborted) throw e;
        log(p, 'voice', `⚠ joined voice-over failed (${e.message}) — the chapters still render, but the editor preview has no audio`);
      }
      save(p);
      log(p, 'voice', `long-form: ${p.chapters.length} chapter voices · ${p.voice.duration.toFixed(2)} s total`);
      return;
    }
    await voiceScope(p, p, projectDir(p.id), signal);
  }

  // ---- timing ---------------------------------------------------------------------------------------------
  async function timingScope(p, S, dir, signal) {
    let timed, estimated = false;
    const s0 = getSettings();
    if (['upload', 'openai'].includes(S.voice?.source) && !s0.deepgram.apiKey) {
      // no speech-to-text configured: estimate from the audio's own pauses (speech clock, words ∝ letters)
      log(p, 'timing', '⚠ no Deepgram key — estimating word timing from the pauses in the audio; check it in the editor');
      const dw = await estimateWords(S.script.text, path.join(dir, 'voice.mp3'), { signal });
      fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'estimate', words: dw }));
      timed = wordsWithChars(dw);
      estimated = true;
    } else if (['upload', 'openai'].includes(S.voice?.source)) {
      const s = s0;
      log(p, 'timing', `Deepgram ${s.deepgram.model} (${s.deepgram.language}) on the ${S.voice.source === 'upload' ? 'uploaded' : 'generated'} voice`);
      const buf = fs.readFileSync(path.join(dir, 'voice.mp3'));
      const dw = await transcribeWords(s, buf, 'audio/mpeg', { signal });
      if (!dw.length) throw new Error('Deepgram returned no words');
      fs.writeFileSync(path.join(dir, 'voice-timing.json'), JSON.stringify({ source: 'deepgram', words: dw }));
      timed = wordsWithChars(dw);
      log(p, 'timing', `Deepgram heard ${dw.length} words`);
    } else {
      const vt = JSON.parse(fs.readFileSync(path.join(dir, 'voice-timing.json'), 'utf8'));
      timed = charsToWords(vt.chars);
    }
    const tokens = tokenize(S.script.text);
    const words = alignWords(tokens, timed);
    S.words = words;
    const weak = words.filter((w) => w.weak);
    const avg = words.reduce((a, w) => a + w.match, 0) / Math.max(1, words.length);
    S.timing = { weak: weak.length, matchAvg: +avg.toFixed(3), source: estimated ? 'estimate' : S.voice.source, estimated };
    log(p, 'timing', `aligned ${words.length} script words · mean char match ${(avg * 100).toFixed(0)}% · ${weak.length} weak`);
    if (weak.length) log(p, 'timing', `weak: ${weak.slice(0, 12).map((w) => `#${w.i} ${w.text}`).join(', ')}${weak.length > 12 ? '…' : ''}`);
  }

  async function timing(p, signal) {
    if (p.chapters?.length) {
      for (const ch of p.chapters) {
        const dir = chapterFolder(p.id, ch.id);
        if (ch.stages.timing === 'done' && ch.words?.length) continue;
        if (signal.aborted) throw new Error('cancelled');
        log(p, 'timing', `▶ chapter ${ch.index + 1}/${p.chapters.length}: "${ch.title || ('#' + (ch.index + 1))}"`);
        await timingScope(p, ch, dir, signal);
        ch.stages.timing = 'done';
        assembleProject(p);
        save(p);
      }
      assembleProject(p);
      save(p);
      log(p, 'timing', `long-form: ${p.words?.length || 0} words in ${p.chapters.length} chapters · ${p.timing?.weak || 0} weak`);
      return;
    }
    await timingScope(p, p, projectDir(p.id), signal);
  }

  // ---- storyboard -----------------------------------------------------------------------------------------
  /** Automatic visual selection: a photo scene without media gets the best stock result for its query. */
  async function autoVisuals(p, S, signal) {
    const status = PV.providerStatus();
    const provider = ['pexels', 'pixabay', 'unsplash'].find((k) => status[k].configured);
    const orientation = { '9:16': 'portrait', '1:1': 'square', '16:9': 'landscape' }[effectiveEdit(S.edit).export.aspect];
    for (const [k, sc] of S.storyboard.scenes.entries()) {
      if (sc.template !== 'photo' || sc.image) continue;
      if (signal?.aborted) throw new Error('cancelled');
      const q = sc.query || sc.items.map((it) => it.icon).filter(Boolean).join(' ') || sc.title;
      try {
        if (!provider) throw new Error('مفيش مكتبة صور متوصلة (الإعدادات ← المكتبات)');
        const r = await PV.search(provider, q, { kind: 'image', orientation, per: 5 });
        if (!r.items.length) throw new Error(`مفيش نتايج لـ "${r.queryUsed}"`);
        const a = await PV.importResult(provider, r.items[0], { folder: `project-${p.id}` });
        sc.image = a.id;
        log(p, 'storyboard', `visual: scene ${k + 1} ← ${status[provider].name} "${r.queryUsed}" (${a.license.name}${a.source.author ? ', ' + a.source.author : ''})`);
      } catch (e) {
        if (signal?.aborted) throw e;
        sc.template = 'cards';
        if (!sc.items.length) sc.items.push({ label: sc.title || '…', icon: sc.query?.split(' ')[0] || 'cell', value: null, at: null });
        log(p, 'storyboard', `⚠ scene ${k + 1}: photo → cards (${e.message})`);
      }
    }
  }

  async function storyboardScope(p, S, signal) {
    const s = getSettings();
    const duration = S.voice.duration;
    const sbCtx = { title: S.script.title, words: S.words, duration, forceTemplate: p.options.forceTemplate };
    const emit = (d) => bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', delta: d } });
    bus(p.id).emit('event', { type: 'llm', data: { stage: 'storyboard', reset: true } });
    const first = await chatStream(s, storyboardMessages(sbCtx), { signal, onDelta: emit, temperature: 0.6 });
    const r1 = repairStoryboard(extractJson(first.text), S.words, { forceTemplate: p.options.forceTemplate });
    log(p, 'storyboard', `draft: ${r1.storyboard.scenes.length} scenes · ${r1.fixes.length} repairs`);
    r1.fixes.forEach((f) => log(p, 'storyboard', `  fix: ${f}`));
    let final = r1;
    try {
      emit('\n\n— self-review —\n');
      const second = await chatStream(s, reviewMessages({ ...sbCtx, storyboard: r1.storyboard, notes: r1.notes }), { signal, onDelta: emit, temperature: 0.3 });
      const r2 = repairStoryboard(extractJson(second.text), S.words, { forceTemplate: p.options.forceTemplate });
      if (r2.storyboard.scenes.length >= 1) {
        final = r2;
        log(p, 'storyboard', `self-review: ${r2.storyboard.scenes.length} scenes · ${r2.fixes.length} repairs`);
        r2.fixes.forEach((f) => log(p, 'storyboard', `  fix: ${f}`));
      }
    } catch (e) {
      if (signal.aborted) throw e;
      log(p, 'storyboard', `⚠ self-review failed (${e.message}) — keeping the draft`);
    }
    assertStoryboard(final.storyboard, { words: S.words });
    log(p, 'storyboard', `scene JSON valid (schema ${final.storyboard.scenes.length} scenes)`);
    S.storyboard = final.storyboard;
    S.storyboardFixes = final.fixes;
    await autoVisuals(p, S, signal);
    S.icons = iconsFor(storyboardNouns(final.storyboard));
    log(p, 'storyboard', `templates: ${final.storyboard.scenes.map((sc) => `${sc.type}/${sc.template}@${sc.at}`).join(' · ')}`);
    log(p, 'storyboard', `icons: ${Object.entries(S.icons).map(([n, v]) => `${n}→${v.key}`).join(', ')}`);
  }

  async function storyboard(p, signal) {
    if (p.chapters?.length) {
      for (const ch of p.chapters) {
        if (ch.stages.storyboard === 'done' && ch.storyboard?.scenes?.length) continue;
        if (signal.aborted) throw new Error('cancelled');
        log(p, 'storyboard', `▶ chapter ${ch.index + 1}/${p.chapters.length}: "${ch.title || ('#' + (ch.index + 1))}" (${ch.voice.duration.toFixed(1)} s)`);
        await storyboardScope(p, ch, signal);
        ch.stages.storyboard = 'done';
        assembleProject(p);
        save(p);
      }
      assembleProject(p);
      save(p);
      log(p, 'storyboard', `long-form storyboard: ${p.storyboard.scenes.length} scenes in ${p.chapters.length} chapters`);
      return;
    }
    await storyboardScope(p, p, signal);
  }

  // ---- render ---------------------------------------------------------------------------------------------

  /** Renders one scope (project or chapter) into `dir/video.mp4` with its own audio, SFX and checks. */
  async function renderScope(p, S, dir, signal, { chapter = null } = {}) {
    assertStoryboard(S.storyboard, { words: S.words });
    const E = effectiveEdit(S.edit);
    const L = layoutFor(E.export.aspect, E.export.resolution);
    { // validation gate: never start a long render on input the renderer cannot use
      const rd = renderData(S);
      const problems = checkRenderInputs({ words: S.words, storyboard: S.storyboard, edit: E, voiceExists: fs.existsSync(path.join(dir, 'voice.mp3')), hasAsset: (id) => !!getAsset(id), duration: rd.duration });
      if (problems.length) throw new Error(`render input check failed: ${problems.join('; ')}`);
    }
    const FPS = E.export.fps;
    // video clips (scene media and overlays) → frames on disk at the output fps and size
    const clips = {};
    S.clips = clips;
    if (chapter) chapter.clips = clips; // persisted with the chapter, so render-data?chapter= keeps working after a restart
    // clip frames live under the project (one content-hashed folder shared by the chapters), so the clip route serves them
    const clipDir = chapter ? projectDir(p.id) : dir;
    const clipJobs = [];
    const full = renderData(S);
    full.scenes.forEach((sc, k) => { if (sc.image && getAsset(sc.image)?.kind === 'video') clipJobs.push([`scene-${k}`, sc.image, sc.imageOffset || 0, sc.end - sc.start + 1]); });
    for (const o of E.overlays) if (o.kind === 'video') clipJobs.push([`ov-${o.id}`, o.asset, o.offset || 0, o.end - o.start]);
    for (const [ref, asset, offset, seconds] of clipJobs) {
      const info = await prepareClip(clipDir, asset, { offset, seconds, fps: FPS, maxW: L.width, maxH: L.height, signal });
      S.clips[ref] = info;
      log(p, 'render', `clip ${ref}: ${info.count} frames from ${getAsset(asset).name}`);
    }
    save(p);
    const data = renderData(S);
    const { duration, start, segments } = data;
    const audioCfg = getSettings().audio;
    const where = chapter ? `chapter ${chapter.index + 1}/${p.chapters.length} · ` : '';
    log(p, 'render', `${where}${duration.toFixed(2)} s${E.sequence ? ` · custom order: ${segments.filter((x) => !isHold(x)).length} parts, ${segments.filter(isHold).length} pause(s)` : `${start || data.end < data.full ? ` (trim ${start.toFixed(2)}→${data.end.toFixed(2)})` : ''}${segments.length > 1 ? ` · ${segments.length - 1} cut(s)` : ''}`} · ${Math.ceil(duration * FPS)} frames @ ${FPS} fps · ${L.width}×${L.height} (${E.export.aspect}) · ${E.export.quality}`);
    if (data.platform?.check.level === 'over') log(p, 'render', `⚠ ${data.platform.check.message}`);
    const tmpVideo = path.join(dir, 'frames.mp4');
    const key = crypto.createHash('sha256').update(JSON.stringify({ data, q: E.export.quality, v: 2 })).digest('hex').slice(0, 16);
    let lastEmit = 0;
    const total = Math.ceil(duration * FPS - 1e-9);
    const job = await renderVideo({
      project: p.id, engine: E.export.engine, fallback: getSettings().render.fallback !== false,
      source: {
        projectId: p.id, chapter: chapter?.id || null, port: port(), data, url: `http://127.0.0.1:${port()}/render.html?project=${p.id}${chapter ? `&chapter=${chapter.id}` : ''}`,
        timeOf: (i) => outToSrc(i / FPS, segments),
      },
      total, out: tmpVideo, fps: FPS, width: L.width, height: L.height, quality: E.export.quality, codec: E.export.codec, bitrate: E.export.bitrate,
      segDir: path.join(dir, 'segments'), key, signal, log: (l) => log(p, 'render', l),
      onJob: (j) => bus(p.id).emit('event', { type: 'job', data: j }),
      onFrame: (i, n, jpg) => {
        const now = Date.now();
        if (now - lastEmit > 200 || i === n - 1) { lastEmit = now; bus(p.id).emit('event', { type: 'progress', data: { stage: 'render', frame: i + 1, total: n, chapter: chapter?.id || null } }); }
        if (jpg) { p.lastPreview = jpg; bus(p.id).emit('event', { type: 'preview', data: { t: i / FPS, jpeg: jpg.toString('base64') } }); }
      },
    });
    log(p, 'render', `${where}mixing voice + SFX${E.audio.music ? ' + music' : ''}, normalising to −14 LUFS`);
    // SFX live in output time: a scene change or a pop that was cut out makes no sound
    const toOut = (t) => srcToOut(t, segments);
    const cuts = data.scenes.slice(1).map((sc) => toOut(sc.start)).filter((t) => t !== null);
    const ticks = [];
    data.scenes.forEach((sc) => sc.items.forEach((it) => { if (it.at != null) { const o = toOut(S.words[it.at].start); if (o !== null) ticks.push(o); } }));
    // audio is made exactly as long as the rendered frames (frames/fps ≥ duration), so the mux never has to cut video
    const vdur = Math.ceil(duration * FPS - 1e-9) / FPS;
    writeSfx(path.join(dir, 'sfx.wav'), vdur, audioCfg.whoosh ? cuts : [], audioCfg.tick ? ticks.sort((a, b) => a - b) : [], E.audio.sfxVolume);
    const musicAsset = E.audio.music && getAsset(E.audio.music.asset);
    if (E.audio.music && !musicAsset) log(p, 'render', '⚠ music file is no longer in the library — rendering without it');
    await mixAudio({
      voice: path.join(dir, 'voice.mp3'), sfx: path.join(dir, 'sfx.wav'), out: path.join(dir, 'mix.m4a'), duration: vdur, segments, voiceVolume: E.audio.voiceVolume,
      clips: await clipSounds(E.overlays, E.audio.tracks || []),
      music: musicAsset ? { ...E.audio.music, file: assetFile(musicAsset) } : null, signal, log: (l) => log(p, 'render', l),
    });
    // mux into a temp file, prove it with ffprobe (size, fps, codec, EXACT frame count, audio, durations), then rename
    const probe = await muxFinal({ video: tmpVideo, audio: path.join(dir, 'mix.m4a'), out: path.join(dir, 'video.mp4'), signal,
      expect: { width: L.width, height: L.height, fps: FPS, frames: total, duration: vdur, codec: job.codec } });
    log(p, 'render', `${where}checked: ${probe.width}×${probe.height} · ${probe.fps} fps · ${probe.frames} frames · ${probe.video}/${probe.audio} · ${probe.duration.toFixed(2)} s`);
    await contactSheet({ video: path.join(dir, 'video.mp4'), out: path.join(dir, 'contact.jpg'), duration, aspect: E.export.aspect });
    // temporary files: segments, the silent video and the SFX track are not needed once the MP4 exists
    for (const f of [tmpVideo, path.join(dir, 'sfx.wav')]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
    const used = [...data.scenes.map((sc) => sc.image), ...E.overlays.map((o) => o.asset), ...(E.audio.tracks || []).map((x) => x.asset), musicAsset?.id].filter(Boolean);
    const info = {
      file: chapter ? `chapters/${chapter.id}/video.mp4` : 'video.mp4', contact: chapter ? `chapters/${chapter.id}/contact.jpg` : 'contact.jpg',
      duration: +duration.toFixed(3), frames: Math.ceil(duration * FPS), fps: FPS, theme: data.theme.name,
      width: L.width, height: L.height, aspect: E.export.aspect, quality: E.export.quality, credits: creditsFor(used), at: new Date().toISOString(),
      engine: job.engine, fallbackFrom: job.fallbackFrom, codec: job.codec, bitrate: E.export.bitrate, renderSeconds: job.seconds, job: job.id,
    };
    if (chapter) { chapter.render = { ...info, status: 'done' }; }
    else {
      p.render = info;
      const outDir = getSettings().render.outputDir;
      if (outDir) {
        try {
          fs.mkdirSync(outDir, { recursive: true });
          const name = `${(p.topic || p.id).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 60) || p.id} - ${p.id}.mp4`;
          fs.copyFileSync(path.join(dir, 'video.mp4'), path.join(outDir, name));
          p.render.exported = path.join(outDir, name);
          log(p, 'render', `copied to ${p.render.exported}`);
        } catch (e) { log(p, 'render', `⚠ output folder: ${e.message}`); }
      }
      log(p, 'render', `video.mp4 ready (${(fs.statSync(path.join(dir, 'video.mp4')).size / 1e6).toFixed(1)} MB) · contact sheet saved${p.render.credits.length ? ` · ${p.render.credits.length} credits` : ''}`);
    }
    return info;
  }

  /** Video overlays whose sound is turned up → mix inputs (source time). Files without an audio stream are skipped. */
  async function clipSounds(overlays, tracks = []) {
    const out = [];
    for (const x of tracks) {
      const a = getAsset(x.asset);
      if (!a || a.kind !== 'audio' || !(x.volume > 0)) continue;
      out.push({ file: assetFile(a), at: x.start, offset: x.offset || 0, length: Math.min(x.end - x.start, Math.max(0.1, (a.duration || 1e9) - (x.offset || 0))), volume: x.volume, fadeIn: x.fadeIn || 0, fadeOut: x.fadeOut || 0 });
    }
    for (const o of overlays) {
      if (o.kind !== 'video' || !(o.volume > 0)) continue;
      const a = getAsset(o.asset);
      if (!a || !(await hasAudio(a))) continue;
      out.push({ file: assetFile(a), at: o.start, offset: o.offset || 0, length: Math.min(o.end - o.start, Math.max(0.1, (a.duration || 1e9) - (o.offset || 0))), volume: o.volume });
    }
    return out;
  }
  async function hasAudio(a) {
    if (typeof a.hasAudio === 'boolean') return a.hasAudio;
    const { out } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', assetFile(a)]).catch(() => ({ out: '' }));
    return out.includes('audio');
  }

  /** Renders every chapter, then joins the chapter MP4s into the project's video.mp4. */
  async function renderChapters(p, signal) {
    const E = effectiveEdit(p.edit);
    const fps = E.export.fps;
    if (E.trim.start || E.trim.end || E.cuts.length || E.sequence) {
      log(p, 'render', '⚠ trim / cuts / custom order are single-pass edits — a chaptered render plays every chapter in order');
    }
    for (const ch of p.chapters) {
      const dir = chapterFolder(p.id, ch.id);
      if (ch.stages.render === 'done' && ch.render?.file && fs.existsSync(path.join(dir, 'video.mp4'))) {
        log(p, 'render', `chapter ${ch.index + 1}/${p.chapters.length}: already rendered — resuming`);
        continue;
      }
      if (signal.aborted) throw new Error('cancelled');
      ch.stages.render = 'running';
      ch.error = null;
      save(p);
      fs.mkdirSync(dir, { recursive: true });
      log(p, 'render', `▶ chapter ${ch.index + 1}/${p.chapters.length} "${ch.title || ''}" — ${chDuration(ch, fps).toFixed(1)} s`);
      const scope = {
        id: p.id, topic: p.topic, title: ch.title, script: ch.script, voice: ch.voice, words: ch.words, storyboard: ch.storyboard,
        icons: ch.icons, clips: ch.clips, edit: chapterEdit(p.edit, ch), options: p.options,
      };
      await renderScope(p, scope, dir, signal, { chapter: ch });
      ch.stages.render = 'done';
      assembleProject(p);
      save(p);
      log(p, 'render', `✔ chapter ${ch.index + 1}/${p.chapters.length}: ${ch.render.duration.toFixed(2)} s · ${ch.render.frames} frames`);
    }
    await joinChapters(p, signal);
  }

  async function joinChapters(p, signal) {
    const dir = projectDir(p.id);
    const E = effectiveEdit(p.edit);
    const L = layoutFor(E.export.aspect, E.export.resolution);
    const fps = E.export.fps;
    const chs = p.chapters;
    const frames = chs.reduce((a, ch) => a + (ch.render?.frames || 0), 0);
    const duration = frames / fps;
    if (!frames) throw new Error('no chapter frames to join');
    const files = chs.map((ch) => path.join(chapterFolder(p.id, ch.id), 'video.mp4'));
    const staged = path.join(dir, 'chapters.mp4');
    const out = path.join(dir, 'video.mp4');
    const expect = { width: L.width, height: L.height, fps, frames, duration, codec: chs[0].render?.codec || 'h264' };
    log(p, 'render', `joining ${chs.length} chapters · ${frames} frames · ${duration.toFixed(2)} s @ ${fps} fps`);
    await concatVideos({ files, out: staged, signal, expect });
    const musicAsset = E.audio.music && getAsset(E.audio.music.asset);
    if (musicAsset) {
      // the music is mixed once over the joined audio, so it runs across the whole video instead of restarting
      const voice = path.join(dir, 'join-audio.m4a');
      const silent = path.join(dir, 'join-silent.wav');
      const mixed = path.join(dir, 'join-mix.m4a');
      try {
        log(p, 'render', `music ${Math.round((E.audio.music.volume || 0) * 100)}% over the whole video`);
        await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-y', '-i', staged, '-vn', '-ac', '2', '-ar', '48000', '-b:a', '192k', voice], { signal });
        writeSfx(silent, frames / fps, [], [], 0);
        await mixAudio({ voice, sfx: silent, out: mixed, duration: frames / fps, voiceVolume: E.audio.voiceVolume, music: { ...E.audio.music, file: assetFile(musicAsset) }, signal, log: (l) => log(p, 'render', l) });
        await muxFinal({ video: staged, audio: mixed, out, signal, expect });
      } finally { for (const f of [voice, silent, mixed]) fs.rmSync(f, { force: true }); }
      fs.rmSync(staged, { force: true });
    } else {
      fs.renameSync(staged, out);
    }
    await contactSheet({ video: out, out: path.join(dir, 'contact.jpg'), duration, aspect: E.export.aspect });
    const credits = [...new Set(chs.flatMap((ch) => ch.render?.credits || []))];
    p.render = {
      file: 'video.mp4', contact: 'contact.jpg', duration: +duration.toFixed(3), frames, fps, width: L.width, height: L.height,
      aspect: E.export.aspect, quality: E.export.quality, theme: (p.chapters[0].render?.theme) || getSettings().look.theme,
      engine: p.chapters[0].render?.engine, codec: p.chapters[0].render?.codec, bitrate: E.export.bitrate,
      renderSeconds: +chs.reduce((a, ch) => a + (ch.render?.renderSeconds || 0), 0).toFixed(2),
      at: new Date().toISOString(), credits,
      chapters: chs.map((ch) => ({ id: ch.id, title: ch.title, duration: ch.render?.duration, frames: ch.render?.frames, file: ch.render?.file })),
    };
    const outDir = getSettings().render.outputDir;
    if (outDir) {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const name = `${(p.topic || p.id).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 60) || p.id} - ${p.id}.mp4`;
        fs.copyFileSync(out, path.join(outDir, name));
        p.render.exported = path.join(outDir, name);
        log(p, 'render', `copied to ${p.render.exported}`);
      } catch (e) { log(p, 'render', `⚠ output folder: ${e.message}`); }
    }
    log(p, 'render', `video.mp4 ready — ${chs.length} chapters · ${duration.toFixed(2)} s (${(fs.statSync(out).size / 1e6).toFixed(1)} MB) · contact sheet saved`);
  }

  async function render(p, signal) {
    if (p.chapters?.length) return renderChapters(p, signal);
    await renderScope(p, p, projectDir(p.id), signal, { chapter: null });
  }

  return { script, voice, timing, storyboard, render };
}
