import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';
const ease = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);
const face = `@font-face{font-family:Cairo;src:url(${staticFile('Cairo-VF.ttf')});font-weight:200 1000}`;
export const Scene = () => {
  const f = useCurrentFrame(), { fps } = useVideoConfig(), t = f / fps;
  const p = ease(t / 1.2), q = ease((t - 1) / 1.2);
  const digits = String(Math.round(ease(t / 8) * 300000)).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  const box = { position: 'absolute', width: '100%', textAlign: 'center', direction: 'rtl', fontFamily: 'Cairo' };
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(#0C1014,#1b2a3a)' }}>
      <style>{face}</style>
      <div style={{ ...box, top: 360 - 45, opacity: p, color: '#F4F3EE', fontSize: 72, fontWeight: 800, transform: `translateX(${(1 - p) * 300}px)` }}>ليه السما لونها أزرق؟</div>
      <div style={{ ...box, top: 560 - 30 + (1 - q) * 80, opacity: q, color: '#27B8C7', fontSize: 48, fontWeight: 700 }}>الـ DNA polymerase بيعمل نسخة</div>
      <div style={{ ...box, top: 860 - 75, color: '#F28A30', fontSize: 120, fontWeight: 800 }}>{digits}</div>
      <div style={{ position: 'absolute', left: 60, top: 1100, height: 14, width: 600 * ((t % 10) / 10), background: '#5978FF' }} />
    </AbsoluteFill>
  );
};
