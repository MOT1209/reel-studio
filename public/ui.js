// Shared UI helpers. All user / LLM text goes through esc() before it is put in HTML.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts = {}) {
  const isBin = opts.body instanceof Blob || opts.body instanceof File || opts.body instanceof ArrayBuffer;
  const res = await fetch(path, { ...opts, headers: { ...(opts.body && !isBin ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || res.statusText);
  return body;
}

let toastT = null;
export function toast(msg, kind = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
  el.className = `toast ${kind}`; el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 6000 : 2600);
}
export async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'bad'); return undefined; }
}

/** Word diff from the server ([{op,text}]) → HTML. */
export function diffHtml(ops) {
  return ops.map((d) => d.op === 'eq' ? esc(d.text) : d.op === 'del' ? `<del>${esc(d.text)}</del>` : d.op === 'ins' ? `<ins>${esc(d.text)}</ins>` : `<mark title="تعديل إملائي">${esc(d.text)}</mark>`).join(' ');
}

export const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const fmtTime = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`; };

/** Modal dialog; returns { el, close }. content is trusted HTML built with esc(). */
export function modal(title, content, { wide = false, onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'modal' + (wide ? ' wide' : '');
  d.innerHTML = `<div class="mhead"><h3>${esc(title)}</h3><button class="ghost small" data-x>✕</button></div><div class="mbody">${content}</div>`;
  document.body.append(d);
  const close = () => { d.close(); d.remove(); onClose?.(); };
  d.querySelector('[data-x]').addEventListener('click', close);
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.showModal();
  return { el: d, close };
}

/** Uploads one file to the asset library with licence info. */
export function uploadAsset(file, { folder = '', tags = '', licenseName = '', commercial = '', attribution = '' } = {}) {
  const h = { 'X-Filename': encodeURIComponent(file.name), 'X-Folder': encodeURIComponent(folder), 'X-Tags': encodeURIComponent(tags) };
  if (licenseName) h['X-License-Name'] = encodeURIComponent(licenseName);
  if (commercial) h['X-License-Commercial'] = commercial;
  if (attribution) h['X-License-Attribution'] = encodeURIComponent(attribution);
  return api('/api/assets', { method: 'POST', body: file, headers: h });
}

const loadedFaces = new Set();
/** Loads a font family from the library into the page (for previews) under the name `rs-<id>`. */
export async function loadFamily(f) {
  const name = `rs-${f.id}`;
  if (loadedFaces.has(name)) return name;
  loadedFaces.add(name);
  await Promise.all(f.faces.map((face) => new FontFace(name, `url(${face.url})`, { weight: face.weight }).load().then((ff) => document.fonts.add(ff)).catch(() => {})));
  return name;
}
