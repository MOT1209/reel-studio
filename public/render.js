/* Reel Studio renderer — window.drawFrame(t) draws frame t (seconds) on a 720×1280 design canvas scaled ×1.5.
 * Deterministic: every pixel depends only on t and the project data (no Date.now, no Math.random). */
(() => {
  'use strict';
  const C = {
    bg: '#0C1014', card: '#161C22', elev: '#202830', text: '#F4F3EE', sec: '#9AA5AE',
    accent: '#27B8C7', blue: '#5978FF', success: '#36C98F', warning: '#F28A30',
  };
  const DW = 720, DH = 1280, S = 1.5;
  const CARD = { x: 36, y: 232, w: 648, h: 684, r: 30 };
  const BAR = 56; // card top bar (chip + counter)
  const SW = CARD.w, SH = CARD.h - BAR; // stage size inside the card
  const TRANS = 0.42; // scene transition length
  const FONT = 'ReelFont';
  const TYPE_LABEL = { intro: 'البداية', question: 'السؤال', concept: 'الفكرة', process: 'إزاي بيحصل', compare: 'مقارنة', stat: 'بالأرقام', recap: 'الخلاصة' };
  let TONE = {};
  let LIGHT = false, GRID = true; // set from the project's theme at boot
  function applyTheme(theme) {
    if (theme?.colors) for (const k of Object.keys(C)) if (/^#[0-9a-f]{6}$/i.test(theme.colors[k] || '')) C[k] = theme.colors[k];
    GRID = theme?.grid !== false;
    const n = parseInt(C.bg.slice(1), 16);
    LIGHT = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.5;
    TONE = { accent: C.accent, blue: C.blue, success: C.success, warning: C.warning, underline: C.text };
  }

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let D = null; // render data

  // ---------- math ----------
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const prog = (t, t0, d) => clamp((t - t0) / d);
  const eOut = (k) => 1 - Math.pow(1 - k, 3);
  const eInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const eBack = (k) => { const c1 = 1.9, c3 = c1 + 1; return k <= 0 ? 0 : k >= 1 ? 1 : 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
  const frac = (x) => x - Math.floor(x);
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const isArabic = (s) => /[؀-ۿ]/.test(s);
  const toArDigits = (s) => String(s);

  // ---------- text ----------
  function font(size, weight = 700) { ctx.font = `${weight} ${size}px ${FONT}`; }
  function text(str, x, y, { size = 28, weight = 700, color = C.text, align = 'center', alpha = 1, base = 'middle' } = {}) {
    if (!str) return;
    font(size, weight);
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.direction = isArabic(str) ? 'rtl' : 'ltr';
    ctx.fillText(str, x, y);
    ctx.globalAlpha /= alpha || 1;
  }
  const wrapCache = new Map();
  function wrap(str, maxW, size, weight = 700) {
    const key = `${str}|${maxW}|${size}|${weight}`;
    if (wrapCache.has(key)) return wrapCache.get(key);
    font(size, weight);
    const words = String(str || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    wrapCache.set(key, lines);
    return lines;
  }
  function textBlock(str, x, y, maxW, { size = 26, weight = 700, color = C.text, alpha = 1, lh = 1.25, maxLines = 2 } = {}) {
    let s = size, lines = wrap(str, maxW, s, weight);
    while (lines.length > maxLines && s > 16) { s -= 2; lines = wrap(str, maxW, s, weight); }
    lines.forEach((l, i) => text(l, x, y + i * s * lh, { size: s, weight, color, alpha }));
    return lines.length * s * lh;
  }

  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : (ctx.rect(x, y, w, h));
  }

  // ---------- icons ----------
  const iconCache = new Map();
  function iconPaths(noun) {
    if (iconCache.has(noun)) return iconCache.get(noun);
    const ic = D.icons[noun] || D.icons.__fallback;
    const v = ic ? { v: ic.v, m: ic.m, p: ic.p.map((d) => (Array.isArray(d) ? [new Path2D(d[0]), d[1]] : [new Path2D(d), 'nonzero'])) } : null;
    iconCache.set(noun, v);
    return v;
  }
  function icon(noun, x, y, size, color, alpha = 1) {
    const ic = iconPaths(noun);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / (ic ? ic.v : 24), size / (ic ? ic.v : 24));
    if (!ic) { ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(12, 12, 8, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); return; }
    if (ic.m === 'stroke') {
      ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [p] of ic.p) ctx.stroke(p);
    } else {
      ctx.fillStyle = color;
      for (const [p, rule] of ic.p) ctx.fill(p, rule);
    }
    ctx.restore();
  }

  // ---------- element timing ----------
  /** Reveal times of a scene's items: their word onset, or spread across the scene. */
  function itemTimes(sc) {
    if (sc._rt) return sc._rt;
    const n = sc.items.length;
    const dur = sc.end - sc.start;
    const step = Math.max(0.18, Math.min(0.75, (dur - 0.6) / Math.max(1, n)));
    let last = sc.start;
    sc._rt = sc.items.map((it, k) => {
      const r = it.t != null ? Math.max(it.t, sc.start) : Math.max(last + (k ? 0.18 : 0), sc.start + 0.2 + k * step);
      last = r;
      return r;
    });
    return sc._rt;
  }
  /** State of an element revealed at rt: ghost (faint layout) before, pop with overshoot after. */
  function el(t, rt) {
    const on = t >= rt;
    return { on, k: on ? eBack(prog(t, rt, 0.5)) : 0, e: on ? eOut(prog(t, rt, 0.45)) : 0, a: on ? lerp(0.16, 1, prog(t, rt, 0.18)) : 0.16 };
  }

  // ---------- shared drawing ----------
  function node(x, y, r, noun, st, { color = C.accent, ring = C.accent, label, labelY, labelW = 170, labelSize = 24, check = false } = {}) {
    const s = st.on ? lerp(0.5, 1, st.k) : 1;
    ctx.save();
    ctx.globalAlpha *= st.a;
    ctx.translate(x, y); ctx.scale(s, s);
    // glow
    if (st.on) {
      const g = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 1.7);
      g.addColorStop(0, hexA(ring, 0.18 * st.e)); g.addColorStop(1, hexA(ring, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 1.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = st.on ? C.elev : 'rgba(0,0,0,0)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = st.on ? hexA(ring, 0.9) : hexA(C.sec, 0.9);
    if (!st.on) ctx.setLineDash([8, 8]);
    ctx.stroke(); ctx.setLineDash([]);
    icon(noun, 0, 0, r * 1.05, st.on ? color : C.sec);
    if (check && st.on) {
      ctx.beginPath(); ctx.arc(r * 0.72, -r * 0.72, r * 0.3, 0, Math.PI * 2); ctx.fillStyle = C.success; ctx.fill();
      ctx.strokeStyle = C.bg; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.6, -r * 0.72); ctx.lineTo(r * 0.69, -r * 0.62); ctx.lineTo(r * 0.86, -r * 0.82); ctx.stroke();
    }
    ctx.restore();
    if (label) {
      ctx.save(); ctx.globalAlpha *= st.on ? clamp(st.a * 1.0) : 0.3;
      const dy = st.on ? (1 - st.e) * 14 : 0;
      textBlock(label, x, (labelY ?? y + r + 30) + dy, labelW, { size: labelSize, color: st.on ? C.text : C.sec });
      ctx.restore();
    }
  }
  /** Straight arrow that draws on (k: 0..1), with a head once complete enough. */
  function arrow(x1, y1, x2, y2, k, { color = C.accent, w = 4, head = 14, ghost = true } = {}) {
    if (ghost) {
      ctx.save(); ctx.strokeStyle = hexA(C.sec, 0.22); ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    }
    if (k <= 0) return;
    const xe = lerp(x1, x2, k), ye = lerp(y1, y2, k);
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(xe, ye); ctx.stroke();
    if (k > 0.35) {
      const a = Math.atan2(y2 - y1, x2 - x1), hk = eOut(prog(k, 0.35, 0.65)) * head;
      ctx.beginPath(); ctx.moveTo(xe - Math.cos(a - 0.55) * hk, ye - Math.sin(a - 0.55) * hk); ctx.lineTo(xe, ye);
      ctx.lineTo(xe - Math.cos(a + 0.55) * hk, ye - Math.sin(a + 0.55) * hk); ctx.stroke();
    }
    ctx.restore();
  }
  function pulseDot(x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, hexA(color, 0.9)); g.addColorStop(0.35, hexA(color, 0.35)); g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- templates (stage coords: SW × SH, title band at top) ----------
  const TOP = 92; // content starts below the scene title
  const T = {};

  T.flow = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const m = n <= 2 ? 150 : n === 3 ? 110 : 88;
    const gap = n > 1 ? (SW - 2 * m) / (n - 1) : 0;
    const r = n <= 2 ? 92 : n === 3 ? 80 : 60;
    const cy = TOP + (SH - TOP) * 0.46;
    const xs = sc.items.map((_, k) => (n === 1 ? SW / 2 : SW - m - k * gap)); // RTL: first item on the right
    for (let k = 0; k < n - 1; k++) {
      const x1 = xs[k] - r - 14, x2 = xs[k + 1] + r + 14;
      const ka = eInOut(prog(t, rt[k + 1] - 0.3, 0.4));
      arrow(x1, cy, x2, cy, ka);
      if (ka >= 1) { const f = frac((t - rt[k + 1]) / 1.4); pulseDot(lerp(x1, x2, f), cy, 4, C.accent, Math.sin(Math.PI * f)); }
    }
    sc.items.forEach((it, k) => node(xs[k], cy, r, it.icon, el(t, rt[k]), { label: it.label, labelW: Math.min(210, gap || 300) - 12, labelSize: n === 4 ? 22 : 27, check: sc.type === 'recap', ring: k === n - 1 ? C.blue : C.accent }));
  };

  T.cycle = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const cx = SW / 2, cy = TOP + (SH - TOP) * 0.47, R = Math.min(205, (SH - TOP) * 0.38), r = n >= 5 ? 50 : 58;
    const ang = (k) => -Math.PI / 2 + (k / n) * Math.PI * 2;
    // faint ring + travelling glow
    ctx.save(); ctx.strokeStyle = hexA(C.sec, 0.18); ctx.lineWidth = 2; ctx.setLineDash([4, 10]);
    ctx.lineDashOffset = -t * 18;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    const gap = (r + 12) / R;
    for (let k = 0; k < n; k++) {
      const a0 = ang(k) + gap, a1 = ang(k + 1) - gap;
      const ka = eInOut(prog(t, rt[(k + 1) % n] - (k + 1 === n ? -0.2 : 0.3), 0.45));
      if (ka <= 0) continue;
      const ae = lerp(a0, a1, ka);
      ctx.save(); ctx.strokeStyle = C.accent; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, ae); ctx.stroke();
      if (ka > 0.4) {
        const hx = cx + Math.cos(ae) * R, hy = cy + Math.sin(ae) * R, dir = ae + Math.PI / 2, h = 13 * eOut(prog(ka, 0.4, 0.6));
        ctx.beginPath(); ctx.moveTo(hx - Math.cos(dir - 0.55) * h, hy - Math.sin(dir - 0.55) * h); ctx.lineTo(hx, hy);
        ctx.lineTo(hx - Math.cos(dir + 0.55) * h, hy - Math.sin(dir + 0.55) * h); ctx.stroke();
      }
      ctx.restore();
    }
    const allOn = t >= rt[n - 1] + 0.4;
    if (allOn) { const a = -Math.PI / 2 + (t - rt[n - 1]) * 1.6; pulseDot(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 5, C.blue); }
    // centre label
    const cst = el(t, rt[0]);
    ctx.save(); ctx.globalAlpha *= cst.a;
    ctx.beginPath(); ctx.arc(cx, cy, R - r - 26, 0, Math.PI * 2); ctx.fillStyle = hexA(C.elev, 0.55); ctx.fill();
    textBlock(sc.title || '', cx, cy - 12, (R - r - 30) * 1.7, { size: 26, color: C.sec, maxLines: 2 });
    ctx.restore();
    sc.items.forEach((it, k) => {
      const a = ang(k), x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      const below = Math.sin(a) > 0.3;
      node(x, y, r, it.icon, el(t, rt[k]), { label: it.label, labelY: below ? y + r + 26 : y + r + 26, labelW: 150, labelSize: 21, check: sc.type === 'recap' });
    });
  };

  T.timeline = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const x = SW - 150, y0 = TOP + 30, y1 = SH - 50;
    const ys = sc.items.map((_, k) => (n === 1 ? (y0 + y1) / 2 : lerp(y0 + 30, y1 - 30, k / (n - 1))));
    ctx.save(); ctx.strokeStyle = hexA(C.sec, 0.22); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    // drawn-on progress line to the latest revealed item
    let yEnd = y0;
    sc.items.forEach((_, k) => { const p = eInOut(prog(t, rt[k] - 0.35, 0.4)); if (p > 0) yEnd = lerp(k ? ys[k - 1] : y0, ys[k], p); });
    ctx.strokeStyle = C.accent; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, yEnd); ctx.stroke(); ctx.restore();
    sc.items.forEach((it, k) => {
      const st = el(t, rt[k]), y = ys[k];
      ctx.save(); ctx.globalAlpha *= st.a;
      const s = st.on ? lerp(0.3, 1, st.k) : 1;
      ctx.beginPath(); ctx.arc(x, y, 14 * s, 0, Math.PI * 2); ctx.fillStyle = st.on ? C.accent : C.card; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = st.on ? C.text : C.sec; ctx.stroke();
      const dx = st.on ? (1 - st.e) * 40 : 0;
      // value chip (right of the line)
      const val = it.value != null ? String(it.value) : '';
      if (val) text(val, x + 36 - dx * 0, y, { size: 30, color: st.on ? C.accent : C.sec, align: 'left' });
      // icon + label (left of the line, RTL)
      icon(it.icon, x - 58 - dx, y, 46, st.on ? C.text : C.sec);
      font(27, 700);
      const lines = wrap(it.label, x - 140, 27);
      lines.slice(0, 2).forEach((l, i) => text(l, x - 96 - dx, y + (i - (Math.min(2, lines.length) - 1) / 2) * 32, { size: 27, align: 'right', color: st.on ? C.text : C.sec }));
      ctx.restore();
    });
  };

  T.chart = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const base = SH - 92, top = TOP + 60, maxH = base - top;
    const vmax = Math.max(...sc.items.map((it) => Math.abs(it.value || 0)), 1);
    const slot = (SW - 100) / n, bw = Math.min(96, slot * 0.58);
    const best = sc.items.reduce((b, it, k) => ((it.value || 0) > (sc.items[b].value || 0) ? k : b), 0);
    // grid
    ctx.save(); ctx.strokeStyle = hexA(C.sec, 0.12); ctx.lineWidth = 1.5;
    for (let g = 1; g <= 4; g++) { const y = base - (maxH * g) / 4; ctx.beginPath(); ctx.moveTo(50, y); ctx.lineTo(SW - 50, y); ctx.stroke(); }
    const bk = eInOut(prog(t, sc.start, 0.5));
    ctx.strokeStyle = hexA(C.text, 0.6); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(SW - 50, base); ctx.lineTo(lerp(SW - 50, 50, bk), base); ctx.stroke();
    ctx.restore();
    if (sc.unit) text(sc.unit, 54, top - 34, { size: 22, color: C.sec, align: 'left', weight: 400 });
    sc.items.forEach((it, k) => {
      const st = el(t, rt[k]);
      const cx = SW - 50 - slot * (k + 0.5); // RTL
      const h = (Math.abs(it.value || 0) / vmax) * maxH;
      const col = k === best ? C.accent : C.blue;
      const grow = st.on ? eOut(prog(t, rt[k], 0.7)) : 0;
      ctx.save();
      // ghost outline
      ctx.strokeStyle = hexA(C.sec, 0.28); ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
      rrect(cx - bw / 2, base - h, bw, h, 10); ctx.stroke(); ctx.setLineDash([]);
      if (grow > 0) {
        const hh = h * grow;
        const g = ctx.createLinearGradient(0, base - hh, 0, base);
        g.addColorStop(0, col); g.addColorStop(1, hexA(col, 0.35));
        ctx.fillStyle = g; rrect(cx - bw / 2, base - hh, bw, hh, 10); ctx.fill();
        const shown = (it.value || 0) * grow;
        const dec = Math.abs(it.value) < 10 && it.value % 1 ? 1 : 0;
        text(shown.toFixed(dec), cx, base - hh - 26, { size: 30, color: k === best ? C.accent : C.text });
      }
      ctx.restore();
      ctx.save(); ctx.globalAlpha *= st.on ? 1 : 0.4;
      textBlock(it.label, cx, base + 32, slot - 8, { size: n >= 5 ? 19 : 22, color: st.on ? C.text : C.sec });
      ctx.restore();
    });
  };

  T.layers = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const x0 = 46, x1 = SW - 46, y0 = TOP + 20, y1 = SH - 40;
    const bh = (y1 - y0) / n;
    sc.items.forEach((it, k) => {
      const st = el(t, rt[k]);
      const yt = y0 + k * bh, slide = st.on ? (1 - st.e) * 140 : 0;
      const tint = [C.accent, C.blue, C.success, C.accent, C.blue][k % 5];
      ctx.save(); ctx.globalAlpha *= st.a; ctx.translate(slide, 0);
      ctx.beginPath();
      const amp = 7, ph = t * 0.8 + k;
      ctx.moveTo(x0, yt + 8);
      for (let x = x0; x <= x1; x += 12) ctx.lineTo(x, yt + 8 + Math.sin(x / 46 + ph) * amp * (k ? 1 : 0.4));
      ctx.lineTo(x1, yt + bh - 4); ctx.lineTo(x0, yt + bh - 4); ctx.closePath();
      ctx.fillStyle = st.on ? hexA(tint, 0.1 + 0.05 * (n - k)) : 'rgba(0,0,0,0)'; ctx.fill();
      ctx.strokeStyle = st.on ? hexA(tint, 0.85) : hexA(C.sec, 0.4); ctx.lineWidth = 2.5; if (!st.on) ctx.setLineDash([7, 7]); ctx.stroke(); ctx.setLineDash([]);
      const cy = yt + bh / 2 + 4;
      icon(it.icon, x0 + 56, cy, Math.min(56, bh * 0.5), st.on ? tint : C.sec);
      text(it.label, x1 - 30, cy, { size: Math.min(32, bh * 0.3), align: 'right', color: st.on ? C.text : C.sec });
      text(String(k + 1).padStart(2, '0'), x0 + 110, cy, { size: 20, align: 'left', color: hexA(C.sec, 0.7), weight: 400 });
      ctx.restore();
    });
  };

  T.cards = (sc, t) => {
    const n = sc.items.length, rt = itemTimes(sc);
    const gap = 22, cw = n === 1 ? 380 : (SW - 60 - gap * (n - 1)) / n, ch = n === 1 ? 400 : 380;
    const y = TOP + (SH - TOP - ch) / 2 - 10;
    sc.items.forEach((it, k) => {
      const st = el(t, rt[k]);
      const x = n === 1 ? (SW - cw) / 2 : SW - 30 - cw - k * (cw + gap); // RTL
      const s = st.on ? lerp(0.82, 1, st.k) : 1, lift = st.on ? (1 - st.e) * 30 : 0;
      const col = sc.type === 'compare' ? (k === 0 ? C.accent : C.blue) : [C.accent, C.blue, C.success][k % 3];
      ctx.save(); ctx.globalAlpha *= st.a;
      ctx.translate(x + cw / 2, y + ch / 2 + lift); ctx.scale(s, s); ctx.translate(-cw / 2, -ch / 2);
      rrect(0, 0, cw, ch, 22); ctx.fillStyle = st.on ? C.elev : 'rgba(0,0,0,0)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = st.on ? hexA(col, 0.5) : hexA(C.sec, 0.35); if (!st.on) ctx.setLineDash([8, 8]); ctx.stroke(); ctx.setLineDash([]);
      if (st.on) { ctx.fillStyle = col; rrect(cw * 0.3, 0, cw * 0.4, 5, 3); ctx.fill(); }
      const ir = Math.min(cw * 0.32, 78);
      ctx.beginPath(); ctx.arc(cw / 2, ch * 0.36, ir, 0, Math.PI * 2); ctx.fillStyle = st.on ? hexA(col, 0.12) : 'rgba(0,0,0,0)'; ctx.fill();
      icon(it.icon, cw / 2, ch * 0.36, ir * 1.15, st.on ? col : C.sec);
      if (it.value != null) text(String(it.value), cw / 2, ch * 0.64, { size: 40, color: col });
      textBlock(it.label, cw / 2, it.value != null ? ch * 0.78 : ch * 0.7, cw - 24, { size: n === 3 ? 24 : 28, color: st.on ? C.text : C.sec });
      if (sc.type === 'recap' && st.on) {
        ctx.beginPath(); ctx.arc(cw - 26, 26, 15, 0, Math.PI * 2); ctx.fillStyle = C.success; ctx.fill();
        ctx.strokeStyle = C.bg; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cw - 33, 26); ctx.lineTo(cw - 28, 31); ctx.lineTo(cw - 19, 21); ctx.stroke();
      }
      ctx.restore();
    });
    if (n === 2 && sc.type === 'compare') {
      const st = el(t, rt[1]);
      ctx.save(); ctx.globalAlpha *= st.a;
      const cx = SW / 2, cy = y + ch / 2, s = st.on ? st.k : 1;
      ctx.translate(cx, cy); ctx.scale(s, s);
      ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = hexA(C.sec, 0.4); ctx.lineWidth = 2; ctx.stroke();
      text('vs', 0, 2, { size: 26, color: C.text });
      ctx.restore();
    }
  };

  T.meter = (sc, t) => {
    const cx = SW / 2, cy = TOP + (SH - TOP) * 0.6, R = 230, th = 28;
    const max = sc.max || 100, v = clamp((sc.value || 0) / max);
    const st = el(t, itemTimes(sc)[0] ?? sc.start + 0.2);
    const a0 = Math.PI, a1 = Math.PI * 2;
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = C.elev; ctx.lineWidth = th; ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = lerp(a0, a1, i / 10), r1 = R - th / 2 - 12, r2 = r1 - (i % 5 === 0 ? 22 : 11);
      ctx.strokeStyle = hexA(C.sec, i % 5 === 0 ? 0.7 : 0.35); ctx.lineWidth = i % 5 === 0 ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.stroke();
    }
    const k = st.on ? eBack(prog(t, st.on ? itemTimes(sc)[0] ?? sc.start + 0.2 : 0, 1.1)) : 0;
    const vk = v * k;
    const col = sc.tone === 'warning' ? C.warning : C.accent;
    if (vk > 0.001) {
      const g = ctx.createLinearGradient(cx - R, cy, cx + R, cy); g.addColorStop(0, C.blue); g.addColorStop(1, col);
      ctx.strokeStyle = g; ctx.lineWidth = th; ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + Math.PI * Math.min(1, vk)); ctx.stroke();
    }
    // needle
    const na = a0 + Math.PI * (st.on ? vk : 0.02);
    ctx.globalAlpha *= st.on ? 1 : 0.3;
    ctx.strokeStyle = C.text; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(na) * (R - 50), cy + Math.sin(na) * (R - 50)); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.restore();
    const shown = (sc.value || 0) * clamp(k);
    const dec = (sc.value || 0) % 1 && Math.abs(sc.value) < 100 ? 1 : 0;
    text(`${shown.toFixed(dec)}`, cx, cy + 74, { size: 72, color: st.on ? C.text : C.sec, alpha: st.a });
    if (sc.unit) text(sc.unit, cx, cy + 128, { size: 28, color: col, alpha: st.a });
    text('0', cx - R, cy + 40, { size: 20, color: C.sec, weight: 400 });
    text(String(max), cx + R, cy + 40, { size: 20, color: C.sec, weight: 400 });
    const lab = sc.items[0]?.label;
    if (lab) textBlock(lab, cx, TOP + 40, SW - 120, { size: 28, color: C.sec, alpha: st.a });
  };

  T.zoom = (sc, t) => {
    const rt = itemTimes(sc);
    const [A, B] = sc.items;
    const sa = el(t, rt[0]), sb = el(t, rt[1]);
    const mr = 96, lr = 104;
    const mx = SW * 0.62, my = TOP + 18 + mr; // macro: upper right (RTL reading start)
    const lx = SW * 0.38, ly = SH - 58 - lr; // micro lens: lower left
    // focus square on the macro icon
    const fx = mx + mr * 0.28, fy = my + mr * 0.12, fs = 34;
    node(mx, my, mr, A.icon, sa, { label: A.label, labelY: my + mr + 32, labelW: 280 });
    // connector lines draw on when B is revealed
    const kc = eInOut(prog(t, rt[1] - 0.35, 0.45));
    ctx.save();
    ctx.globalAlpha *= sb.on ? 1 : 0.25;
    ctx.strokeStyle = sb.on ? C.accent : C.sec; ctx.lineWidth = 2.5; ctx.setLineDash(sb.on ? [] : [6, 6]);
    rrect(fx - fs / 2, fy - fs / 2, fs, fs, 6); ctx.stroke();
    const dl = Math.hypot(lx - fx, ly - fy), px = -(ly - fy) / dl, py = (lx - fx) / dl; // perpendicular → tangent cone
    const pairs = [1, -1].map((sg) => [fx + sg * px * fs * 0.7, fy + sg * py * fs * 0.7, lx + sg * px * lr, ly + sg * py * lr]);
    for (const [x1, y1, x2, y2] of pairs) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(lerp(x1, x2, sb.on ? kc : 1), lerp(y1, y2, sb.on ? kc : 1)); ctx.stroke();
    }
    ctx.restore();
    // lens
    const s = sb.on ? lerp(0.3, 1, sb.k) : 1;
    ctx.save(); ctx.globalAlpha *= sb.a; ctx.translate(lx, ly); ctx.scale(s, s);
    const g = ctx.createRadialGradient(0, 0, lr * 0.2, 0, 0, lr * 1.6);
    g.addColorStop(0, hexA(C.blue, sb.on ? 0.22 : 0)); g.addColorStop(1, hexA(C.blue, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, lr * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, lr, 0, Math.PI * 2); ctx.fillStyle = sb.on ? C.elev : 'rgba(0,0,0,0)'; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = sb.on ? C.blue : C.sec; if (!sb.on) ctx.setLineDash([8, 8]); ctx.stroke(); ctx.setLineDash([]);
    // inner rotating dashed ring = "microscope" feel
    ctx.save(); ctx.rotate(t * 0.4); ctx.strokeStyle = hexA(C.blue, 0.35); ctx.lineWidth = 2; ctx.setLineDash([3, 9]);
    ctx.beginPath(); ctx.arc(0, 0, lr - 14, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    const micro = sb.on ? lerp(0.6, 1, sb.e) : 1;
    icon(B.icon, 0, 0, lr * 1.1 * micro, sb.on ? C.text : C.sec);
    ctx.restore();
    ctx.save(); ctx.globalAlpha *= sb.on ? 1 : 0.3;
    textBlock(B.label, SW * 0.79, ly + 10, 220, { size: 28, color: sb.on ? C.blue : C.sec, maxLines: 2 });
    ctx.restore();
    // magnification badge
    if (sb.on) text('×1000', SW * 0.79, ly - 40, { size: 22, color: C.sec, weight: 400, alpha: sb.e });
  };

  // body outline: normalised (x: ±, y: 0 head-top → 1 feet); left half, mirrored for the right.
  const BODY_HALF = 'M -0.028 0.142 L -0.028 0.168 C -0.07 0.176 -0.115 0.178 -0.135 0.2 C -0.155 0.225 -0.16 0.3 -0.165 0.36 L -0.178 0.5 C -0.18 0.535 -0.158 0.545 -0.155 0.52 L -0.14 0.37 C -0.135 0.33 -0.13 0.29 -0.122 0.27 C -0.118 0.34 -0.1 0.4 -0.102 0.48 C -0.104 0.6 -0.09 0.8 -0.085 0.965 C -0.084 0.99 -0.045 0.992 -0.04 0.975 C -0.03 0.85 -0.02 0.7 -0.012 0.585 Q -0.004 0.566 0 0.566';
  const ORGANS = {
    brain: [0, 0.058], head: [0, 0.07], eye: [0.022, 0.07], ear: [0.058, 0.078], nose: [0, 0.088], mouth: [0, 0.112], tooth: [0, 0.112], teeth: [0, 0.112],
    throat: [0, 0.155], thyroid: [0, 0.158], neck: [0, 0.155], lung: [0, 0.27], lungs: [0, 0.27], heart: [0.026, 0.285], chest: [0, 0.27],
    liver: [-0.042, 0.355], stomach: [0.042, 0.365], pancreas: [0.01, 0.398], kidney: [0, 0.41], kidneys: [0, 0.41], spleen: [0.06, 0.36],
    intestine: [0, 0.455], gut: [0, 0.455], colon: [0, 0.46], bladder: [0, 0.525], spine: [0, 0.34], blood: [0.026, 0.285], 'blood vessel': [-0.15, 0.4],
    vein: [-0.15, 0.4], artery: [-0.15, 0.4], arm: [-0.15, 0.35], muscle: [-0.148, 0.32], hand: [-0.165, 0.52], skin: [0.152, 0.34],
    bone: [0.07, 0.74], leg: [0.07, 0.74], knee: [0.066, 0.73], foot: [0.062, 0.975], nerve: [-0.15, 0.42], fat: [0.08, 0.45], hair: [0, 0.01],
  };
  T.body = (sc, t) => {
    const rt = itemTimes(sc);
    const Hb = SH - TOP - 40, top = TOP + 10, bx = SW * 0.36;
    const P = (nx, ny) => [bx + nx * Hb, top + ny * Hb];
    // body draws on top → bottom
    const kb = eInOut(prog(t, sc.start, 0.9));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, SW, top + Hb * (0.08 + kb * 0.95)); ctx.clip();
    ctx.lineWidth = 3; ctx.strokeStyle = hexA(C.sec, 0.75); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const half = new Path2D(BODY_HALF);
    for (const side of [1, -1]) {
      ctx.save(); ctx.translate(bx, top); ctx.scale(Hb * side, Hb); ctx.lineWidth = 3 / Hb; ctx.stroke(half); ctx.restore();
    }
    ctx.beginPath(); ctx.ellipse(bx, top + 0.072 * Hb, 0.058 * Hb, 0.07 * Hb, 0, 0, Math.PI * 2); ctx.stroke();
    // inner soft fill
    ctx.globalAlpha = 0.05; ctx.fillStyle = C.accent;
    for (const side of [1, -1]) { ctx.save(); ctx.translate(bx, top); ctx.scale(Hb * side, Hb); ctx.fill(half); ctx.restore(); }
    ctx.restore();
    // organ
    const organ = (sc.organ || sc.items[0]?.icon || 'heart').toLowerCase();
    const pos = ORGANS[organ] || ORGANS[organ.replace(/s$/, '')] || [0, 0.33];
    const [ox, oy] = P(pos[0], pos[1]);
    const st = el(t, rt[0]);
    const pulse = st.on ? 1 + 0.05 * Math.sin((t - rt[0]) * 6) : 1;
    ctx.save(); ctx.globalAlpha *= st.a;
    if (st.on) {
      for (let i = 0; i < 2; i++) {
        const f = frac((t - rt[0]) / 1.6 + i * 0.5);
        ctx.beginPath(); ctx.arc(ox, oy, 44 + f * 60, 0, Math.PI * 2); ctx.strokeStyle = hexA(C.accent, 0.5 * (1 - f)); ctx.lineWidth = 2; ctx.stroke();
      }
    }
    const s = (st.on ? lerp(0.4, 1, st.k) : 1) * pulse;
    ctx.translate(ox, oy); ctx.scale(s, s);
    ctx.beginPath(); ctx.arc(0, 0, 44, 0, Math.PI * 2); ctx.fillStyle = st.on ? hexA(C.bg, 0.85) : 'rgba(0,0,0,0)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = st.on ? C.accent : C.sec; if (!st.on) ctx.setLineDash([5, 6]); ctx.stroke(); ctx.setLineDash([]);
    icon(organ in (D.icons || {}) ? organ : sc.items[0]?.icon, 0, 0, 60, st.on ? C.accent : C.sec);
    ctx.restore();
    // callout to label
    const lx = SW - 40, ly = Math.max(TOP + 60, Math.min(SH - 120, oy - 40));
    const kc = eInOut(prog(t, rt[0] + 0.15, 0.45));
    const ex = ox + 50, mxx = SW * 0.62;
    ctx.save(); ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5; ctx.globalAlpha *= st.on ? 1 : 0.2;
    ctx.beginPath(); ctx.moveTo(ex, oy);
    const k1 = clamp(kc * 2), k2 = clamp(kc * 2 - 1);
    ctx.lineTo(lerp(ex, mxx, k1), lerp(oy, ly, k1));
    if (k2 > 0) ctx.lineTo(lerp(mxx, mxx + 24, k2), ly);
    ctx.stroke(); ctx.restore();
    const lab = sc.items[0]?.label || organ;
    ctx.save(); ctx.globalAlpha *= st.on ? eOut(prog(t, rt[0] + 0.45, 0.3)) : 0.25;
    const bw = SW - mxx - 60, bh = 104;
    rrect(mxx + 24, ly - bh / 2, bw, bh, 16); ctx.fillStyle = C.elev; ctx.fill(); ctx.strokeStyle = hexA(C.accent, 0.4); ctx.lineWidth = 2; ctx.stroke();
    textBlock(lab, mxx + 24 + bw / 2, ly - (wrap(lab, bw - 24, 28).length > 1 ? 16 : 0), bw - 24, { size: 28 });
    ctx.restore();
    void lx;
  };

  // ---------- captions ----------
  let CH = null; // caption chunks
  function buildChunks() {
    const W = D.words, out = [];
    let cur = [];
    const flush = () => { if (cur.length) out.push(cur); cur = []; };
    W.forEach((w, i) => {
      if (cur.length && W[cur[cur.length - 1]].line !== w.line) flush();
      cur.push(i);
      const endsSentence = /[.!؟?…،,:]$/.test(w.text);
      if (cur.length >= 6 || (cur.length >= 3 && endsSentence && i + 1 < W.length && W[i + 1].line === w.line && lineLen(w.line) - posInLine(i) > 2)) flush();
    });
    flush();
    function lineLen(l) { return W.filter((w) => w.line === l).length; }
    function posInLine(i) { return W.slice(0, i + 1).filter((w) => w.line === W[i].line).length; }
    const acc = new Map((D.accents || []).map(([i, tone]) => [i, tone]));
    CH = out.map((idx, k) => ({ idx, start: W[idx[0]].start, layout: null, acc }));
    CH.forEach((c, k) => { c.end = k + 1 < CH.length ? CH[k + 1].start : D.duration + 1; });
  }
  function layoutChunk(c) {
    if (c.layout) return c.layout;
    const maxW = 620;
    let size = 52, lines;
    for (;;) {
      font(size, 700);
      const sp = size * 0.3;
      lines = [[]]; let lw = 0;
      for (const i of c.idx) {
        const w = ctx.measureText(D.words[i].text).width;
        if (lw && lw + sp + w > maxW) { lines.push([]); lw = 0; }
        lines[lines.length - 1].push({ i, w });
        lw += (lw ? sp : 0) + w;
      }
      if (lines.length <= 2 || size <= 36) break;
      size -= 4;
    }
    const sp = size * 0.3, lh = size * 1.42;
    const placed = [];
    const y0 = 1036 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, li) => {
      const total = ln.reduce((a, x) => a + x.w, 0) + sp * (ln.length - 1);
      let x = DW / 2 + total / 2; // RTL: start at the right edge
      for (const it of ln) { placed.push({ i: it.i, x: x - it.w, w: it.w, y: y0 + li * lh }); x -= it.w + sp; }
    });
    c.layout = { size, placed };
    return c.layout;
  }
  function chunkAt(t) {
    let k = 0;
    for (let j = 0; j < CH.length; j++) if (t >= CH[j].start - 0.12) k = j;
    return k;
  }
  function drawCaptions(t) {
    if (!CH.length) return;
    const k = chunkAt(t), c = CH[k];
    const { size, placed } = layoutChunk(c);
    const appear = k === 0 ? 1 : eOut(prog(t, c.start - 0.12, 0.18));
    ctx.save();
    ctx.globalAlpha = appear;
    ctx.translate(0, (1 - appear) * 14);
    font(size, 700);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const p of placed) {
      const w = D.words[p.i];
      const lit = t >= w.start; // lights exactly at its spoken onset
      const next = D.words[p.i + 1];
      const active = lit && t < (next ? next.start : w.end + 0.3);
      const tone = c.acc.get(p.i);
      const col = !lit ? hexA(C.sec, 0.42) : tone && tone !== 'underline' ? TONE[tone] : C.text;
      const pop = lit ? 1 + 0.1 * (1 - eOut(prog(t, w.start, 0.22))) : 1;
      if (active) {
        const a = eOut(prog(t, w.start, 0.08));
        ctx.save(); ctx.globalAlpha *= a;
        rrect(p.x - 10, p.y - size * 0.62, p.w + 20, size * 1.24, 14); ctx.fillStyle = hexA(C.elev, 0.95); ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y); ctx.scale(pop, pop);
      ctx.direction = isArabic(w.text) ? 'rtl' : 'ltr';
      ctx.textAlign = 'center';
      ctx.fillStyle = col; ctx.fillText(w.text, 0, 0);
      ctx.restore();
      if (tone && lit) {
        const ku = eOut(prog(t, w.start, 0.3));
        ctx.save(); ctx.strokeStyle = tone === 'underline' ? C.accent : TONE[tone]; ctx.lineWidth = 5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x + p.w, p.y + size * 0.56); ctx.lineTo(p.x + p.w - p.w * ku, p.y + size * 0.56); ctx.stroke(); ctx.restore();
      }
    }
    ctx.restore();
  }
  window.captionState = (t) => {
    const k = chunkAt(t), c = CH[k];
    return { chunk: k, words: c.idx, lit: c.idx.filter((i) => t >= D.words[i].start) };
  };

  // ---------- frame chrome ----------
  // Static layers are rasterised once (big gradients and shadow blur are expensive per frame).
  let LAYERS = null;
  function layer(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); draw(g); return c;
  }
  function buildLayers() {
    const bg = layer(DW * S, DH * S, (g) => {
      g.setTransform(S, 0, 0, S, 0, 0);
      g.fillStyle = C.bg; g.fillRect(0, 0, DW, DH);
      g.strokeStyle = hexA(C.text, LIGHT ? 0.06 : 0.035); g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= DW; x += 40) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, DH); }
      for (let y = 0; y <= DH; y += 40) { g.moveTo(0, y + 0.5); g.lineTo(DW, y + 0.5); }
      if (GRID) g.stroke();
      g.fillStyle = hexA(C.text, LIGHT ? 0.12 : 0.07);
      if (GRID) for (let x = 0; x <= DW; x += 160) for (let y = 0; y <= DH; y += 160) g.fillRect(x - 1.5, y - 1.5, 3, 3);
      const v = g.createRadialGradient(DW / 2, DH / 2, DH * 0.3, DW / 2, DH / 2, DH * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, LIGHT ? 'rgba(60,40,10,0.10)' : 'rgba(0,0,0,0.45)');
      g.fillStyle = v; g.fillRect(0, 0, DW, DH);
    });
    const glow = layer(256, 256, (g) => {
      const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      r.addColorStop(0, hexA(C.accent, 0.09)); r.addColorStop(0.5, hexA(C.accent, 0.035)); r.addColorStop(1, hexA(C.accent, 0));
      g.fillStyle = r; g.fillRect(0, 0, 256, 256);
    });
    const card = layer(DW * S, DH * S, (g) => {
      g.drawImage(bg, 0, 0); // one merged static layer: background + glow + card
      g.setTransform(S, 0, 0, S, 0, 0);
      g.drawImage(glow, 260 - 620, 380 - 620, 1240, 1240);
      g.drawImage(glow, 560 - 500, 1100 - 500, 1000, 1000);
      g.save(); g.shadowColor = LIGHT ? 'rgba(60,40,10,0.16)' : 'rgba(0,0,0,0.5)'; g.shadowBlur = 40; g.shadowOffsetY = 16;
      g.beginPath(); g.roundRect(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r); g.fillStyle = C.card; g.fill(); g.restore();
      g.save(); g.beginPath(); g.roundRect(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r); g.clip();
      g.strokeStyle = hexA(C.text, LIGHT ? 0.05 : 0.03); g.lineWidth = 1; g.beginPath();
      for (let x = CARD.x + 24; x < CARD.x + CARD.w; x += 24) { g.moveTo(x, CARD.y + BAR); g.lineTo(x, CARD.y + CARD.h); }
      for (let y = CARD.y + BAR + 24; y < CARD.y + CARD.h; y += 24) { g.moveTo(CARD.x, y); g.lineTo(CARD.x + CARD.w, y); }
      if (GRID) g.stroke(); g.restore();
    });
    LAYERS = { bg, glow, card };
  }
  function blit(img) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(img, 0, 0); ctx.restore(); }
  function drawBackground(t) {
    blit(LAYERS.card); // background + glow + card (pre-rendered once; per-frame blends are too costly)
  }
  function drawHeader(t) {
    // progress
    ctx.fillStyle = hexA(C.text, 0.08); rrect(36, 30, DW - 72, 5, 3); ctx.fill();
    ctx.fillStyle = C.accent; const pw = (DW - 72) * clamp(t / D.duration);
    rrect(36 + (DW - 72) - pw, 30, pw, 5, 3); ctx.fill(); // fills right → left (RTL)
    // series tag
    font(22, 700);
    const tag = D.seriesTag || '';
    const tw = ctx.measureText(tag).width + 56;
    rrect(DW - 36 - tw, 56, tw, 44, 22); ctx.fillStyle = C.card; ctx.fill(); ctx.strokeStyle = hexA(C.text, 0.08); ctx.lineWidth = 1.5; ctx.stroke();
    const pa = 0.6 + 0.4 * Math.sin(t * 4);
    ctx.beginPath(); ctx.arc(DW - 36 - 24, 78, 6, 0, Math.PI * 2); ctx.fillStyle = hexA(C.accent, pa); ctx.fill();
    text(tag, DW - 36 - 40, 79, { size: 22, align: 'right', color: C.text });
    // title
    const ta = eOut(prog(t, 0, 0.5));
    ctx.save(); ctx.globalAlpha = ta; ctx.translate(0, (1 - ta) * 12);
    let size = 40, lines = wrap(D.title, DW - 72, size);
    while (lines.length > 2 && size > 26) { size -= 4; lines = wrap(D.title, DW - 72, size); }
    lines.slice(0, 2).forEach((l, i) => text(l, DW - 36, 150 + i * size * 1.25 - (lines.length > 1 ? size * 0.6 : 0), { size, align: 'right' }));
    ctx.restore();
  }
  function sceneIndexAt(t) { let k = 0; D.scenes.forEach((s, i) => { if (t >= s.start) k = i; }); return k; }
  function drawCard(t) {
    // illustration (card fill, shadow and blueprint grid come from the static layer)
    ctx.save();
    rrect(CARD.x, CARD.y + BAR, CARD.w, CARD.h - BAR, [0, 0, CARD.r, CARD.r]); ctx.clip();
    D.scenes.forEach((sc, i) => {
      if (t < sc.start || t > sc.end + TRANS) return;
      // staggered cross-fade: the old scene leaves quickly, the new one settles in just after (no double titles)
      const kin = i === 0 ? 1 : eOut(prog(t, sc.start + TRANS * 0.3, TRANS * 0.7));
      const kout = t > sc.end ? eInOut(prog(t, sc.end, TRANS * 0.55)) : 0;
      const alpha = kin * (1 - kout);
      if (alpha <= 0.001) return;
      const push = 1 + 0.045 * eInOut(prog(t, sc.start, Math.max(1, sc.end - sc.start)));
      const scl = push * lerp(0.94, 1, kin) * lerp(1, 1.08, kout);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(CARD.x + SW / 2, CARD.y + BAR + SH / 2);
      ctx.scale(scl, scl);
      ctx.translate(-SW / 2 + (1 - kin) * 50 - kout * 50, -SH / 2); // RTL: enter from the right, exit to the left
      if (sc.type === 'question') text('؟', SW / 2, SH / 2 + 20, { size: 460, color: hexA(C.accent, 0.06) });
      if (sc.title) {
        const ta = eOut(prog(t, sc.start + 0.05, 0.35));
        text(sc.title, SW / 2, 40 + (1 - ta) * 10, { size: 32, color: C.text, alpha: ta });
        ctx.save(); ctx.globalAlpha *= ta; ctx.fillStyle = C.accent; rrect(SW / 2 - 24 * ta, 68, 48 * ta, 4, 2); ctx.fill(); ctx.restore();
      }
      (T[sc.template] || T.cards)(sc, t);
      ctx.restore();
    });
    ctx.restore();
    // chrome: top bar, film perforations, registration marks
    ctx.save();
    ctx.strokeStyle = hexA(C.text, LIGHT ? 0.1 : 0.07); ctx.lineWidth = 1.5;
    rrect(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CARD.x, CARD.y + BAR); ctx.lineTo(CARD.x + CARD.w, CARD.y + BAR); ctx.stroke();
    const k = sceneIndexAt(t), sc = D.scenes[k];
    const chip = TYPE_LABEL[sc.type] || '';
    font(20, 700);
    const cw = ctx.measureText(chip).width + 40;
    const ca = k === 0 ? 1 : eOut(prog(t, sc.start, 0.3));
    ctx.globalAlpha = ca;
    rrect(CARD.x + CARD.w - 18 - cw, CARD.y + 12, cw, 32, 16); ctx.fillStyle = hexA(C.accent, 0.14); ctx.fill();
    text(chip, CARD.x + CARD.w - 18 - cw / 2, CARD.y + 29, { size: 20, color: C.accent });
    ctx.globalAlpha = 1;
    text(`${String(k + 1).padStart(2, '0')} / ${String(D.scenes.length).padStart(2, '0')}`, CARD.x + 22, CARD.y + 29, { size: 18, color: C.sec, align: 'left', weight: 400 });
    // perforations (film)
    ctx.fillStyle = hexA(C.text, LIGHT ? 0.08 : 0.05);
    const off = (t * 22) % 36;
    for (let x = CARD.x + 30 - off; x < CARD.x + CARD.w - 20; x += 36) if (x > CARD.x + 14) { rrect(x, CARD.y + CARD.h - 20, 16, 8, 2); ctx.fill(); }
    // registration marks
    ctx.strokeStyle = hexA(C.accent, 0.35); ctx.lineWidth = 2;
    const m = 14, L = 16;
    [[CARD.x + m, CARD.y + BAR + m, 1, 1], [CARD.x + CARD.w - m, CARD.y + BAR + m, -1, 1], [CARD.x + m, CARD.y + CARD.h - m - 16, 1, -1], [CARD.x + CARD.w - m, CARD.y + CARD.h - m - 16, -1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    });
    ctx.restore();
  }

  function drawFrame(t) {
    t = Math.max(0, Number(t) || 0);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.globalAlpha = 1;
    const prof = window.__prof ? (window.__profData = window.__profData || {}) : null;
    const step = (name, fn) => { if (!prof) return fn(t); const a = performance.now(); fn(t); prof[name] = (prof[name] || 0) + performance.now() - a; };
    step('background', drawBackground);
    step('header', drawHeader);
    step('card', drawCard);
    step('captions', drawCaptions);
    // end fade
    const fo = prog(t, D.duration - 0.35, 0.35);
    if (fo > 0) { ctx.fillStyle = hexA(C.bg, fo * 0.6); ctx.fillRect(0, 0, DW, DH); }
  }

  // ---------- boot ----------
  async function boot() {
    const q = new URLSearchParams(location.search);
    const id = q.get('project');
    if (!id) throw new Error('missing ?project=');
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/render-data`);
    if (!res.ok) throw new Error(`render-data ${res.status}: ${(await res.text()).slice(0, 200)}`);
    D = await res.json();
    applyTheme(D.theme);
    const faces = [new FontFace(FONT, `url(${D.fonts.regular})`, { weight: '400' }), new FontFace(FONT, `url(${D.fonts.bold})`, { weight: '700' })];
    for (const f of faces) { await f.load(); document.fonts.add(f); }
    await document.fonts.ready;
    buildChunks();
    buildLayers();
    window.drawFrame = drawFrame;
    window.renderData = D;
    drawFrame(Number(q.get('t')) || 0);
    if (q.get('play') === '1') setupPlayer(id);
    window.__ready = true;
  }
  function setupPlayer(id) {
    document.body.classList.add('fit');
    const audio = new Audio(`/api/projects/${encodeURIComponent(id)}/files/voice.mp3`);
    const btn = document.getElementById('play'), seek = document.getElementById('seek'), tm = document.getElementById('time');
    let playing = false, t = 0;
    const loop = () => {
      if (playing) { t = audio.currentTime; if (t >= D.duration - 0.05 || audio.ended) { playing = false; btn.textContent = '▶'; } }
      drawFrame(t); seek.value = String(Math.round((t / D.duration) * 1000)); tm.textContent = t.toFixed(2);
      requestAnimationFrame(loop);
    };
    btn.onclick = () => { playing = !playing; btn.textContent = playing ? '❚❚' : '▶'; if (playing) { audio.currentTime = t; audio.play().catch(() => {}); } else audio.pause(); };
    seek.oninput = () => { t = (Number(seek.value) / 1000) * D.duration; audio.currentTime = t; };
    requestAnimationFrame(loop);
  }
  boot().catch((e) => { window.__error = e.message; console.error(e); });
})();
