// Platform presets: format, resolution, frame rate, duration limits, and the "safe zone" each app covers with its
// own buttons and captions. Safe zones are approximate (apps change their UI) and expressed as fractions of the
// frame; the renderer keeps captions out of them and the editor preview can draw them as guides.
// Duration limits are the commonly documented upload limits at the time of writing — the editor shows them as
// warnings, never blocks an export.
export const PLATFORMS = {
  'youtube-shorts': { name: 'YouTube Shorts', aspect: '9:16', resolution: 1080, fps: 30, maxSec: 180, idealSec: [15, 60], safe: { top: 0.07, bottom: 0.2, left: 0.03, right: 0.13 } },
  tiktok: { name: 'TikTok', aspect: '9:16', resolution: 1080, fps: 30, maxSec: 600, idealSec: [15, 60], safe: { top: 0.08, bottom: 0.22, left: 0.03, right: 0.15 } },
  'instagram-reels': { name: 'Instagram Reels', aspect: '9:16', resolution: 1080, fps: 30, maxSec: 180, idealSec: [15, 90], safe: { top: 0.1, bottom: 0.23, left: 0.03, right: 0.13 } },
  // in-app / web uploads have no fixed length limit; the 3–90 s range applies to the Pages publishing API only,
  // which Reel Studio does not use — so no hard limit here, only the usual-length advice
  'facebook-reels': { name: 'Facebook Reels', aspect: '9:16', resolution: 1080, fps: 30, maxSec: null, idealSec: [15, 90], safe: { top: 0.1, bottom: 0.22, left: 0.03, right: 0.13 } },
  'instagram-feed': { name: 'Instagram (منشور 4:5)', aspect: '4:5', resolution: 1080, fps: 30, maxSec: 60, idealSec: [15, 60], safe: { top: 0, bottom: 0.06, left: 0, right: 0 } },
  youtube: { name: 'YouTube (عرضي)', aspect: '16:9', resolution: 1080, fps: 30, maxSec: null, idealSec: null, safe: { top: 0, bottom: 0.08, left: 0, right: 0 } },
  square: { name: 'مربع (X / LinkedIn)', aspect: '1:1', resolution: 1080, fps: 30, maxSec: 140, idealSec: [15, 90], safe: { top: 0, bottom: 0.05, left: 0, right: 0 } },
};
export const PLATFORM_IDS = Object.keys(PLATFORMS);

/** Duration check for a platform → { level: 'ok'|'hint'|'over', message }. */
export function durationCheck(id, seconds) {
  const p = PLATFORMS[id];
  if (!p) return { level: 'ok', message: '' };
  if (p.maxSec && seconds > p.maxSec) return { level: 'over', message: `${p.name}: أطول من الحد (${Math.round(seconds)} ث من ${p.maxSec} ث) — هيتقص أو يترفض` };
  if (p.idealSec && (seconds < p.idealSec[0] || seconds > p.idealSec[1])) return { level: 'hint', message: `${p.name}: المدة المعتادة ${p.idealSec[0]}–${p.idealSec[1]} ث` };
  return { level: 'ok', message: '' };
}
