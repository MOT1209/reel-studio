// The project video as a Remotion composition. Layer 1 (this release): the shared deterministic canvas renderer
// (public/render.js) drawn frame by frame — pixel-identical to the legacy engine, so templates, captions, Arabic
// shaping, overlays and clips stay exactly as the editor previews them. React scene layers are added on top of it
// (see remotion/layers) without touching the canvas core.
import React, { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { outToSrc } from '../server/timeline.mjs';

// the classic scripts are served by the Reel Studio server next to the bundle (same origin)
const SCRIPTS = ['/bidi.js', '/kashida.js', '/render.js'];
let scriptsReady = null;
function loadScripts() {
  if (scriptsReady) return scriptsReady;
  window.__REEL_NO_BOOT = true; // render.js must not boot its own page renderer here
  scriptsReady = SCRIPTS.reduce((p, src) => p.then(() => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = res; s.onerror = () => rej(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  })), Promise.resolve());
  return scriptsReady;
}

export const Reel = ({ projectId }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef(null);
  const [renderer, setRenderer] = useState(null);
  const [boot] = useState(() => delayRender('Reel Studio: render data, fonts, media'));

  useEffect(() => {
    let alive = true;
    (async () => {
      await loadScripts();
      const r = window.ReelRenderer.create(canvasRef.current, { host: 'remotion' });
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render-data`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`render-data ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await r.setup(await res.json());
      if (alive) setRenderer(r);
      continueRender(boot);
    })().catch((e) => cancelRender(e)); // fails the render at once with the real error (no 30 s timeout)
    return () => { alive = false; };
  }, [projectId, boot]);

  useEffect(() => {
    if (!renderer) return;
    const h = delayRender(`frame ${frame}`);
    const tau = frame / fps;
    const t = outToSrc(tau, renderer.data.segments);
    (async () => {
      await renderer.prepareFrame(t); // video clips: the frame images this time needs
      renderer.drawFrame(t, tau);
      continueRender(h);
    })().catch((e) => cancelRender(e)); // fails the render at once with the real error (no 30 s timeout)
  }, [renderer, frame, fps]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#0C1014' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </AbsoluteFill>
  );
};
