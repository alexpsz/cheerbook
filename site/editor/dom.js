// Small helpers for the web editor. Every piece of text goes in through textContent or attributes,
// never innerHTML, so nothing a file or a lyric holds can become markup.

/** An element: `h('button', { class: 'x', onclick }, 'text', child)`. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.firstChild.remove(); return node; }

/** 75.36 → "1:15.4"; negative times read as 0. */
export function formatTime(seconds) {
  const tenths = Math.max(0, Math.round((Number(seconds) || 0) * 10));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/** 241 → "4:01". */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let timer = null;
  const run = (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
  run.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  run.pending = () => timer !== null;
  return run;
}

/** Saves a file through the browser's download, from text or bytes. */
export function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Browser storage that never throws: private windows and blocked storage just remember nothing. */
export const storage = {
  get(key) { try { const text = localStorage.getItem(key); return text ? JSON.parse(text) : null; } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing stored */ } },
};

/** True while the keyboard belongs to a text field, a menu or a dialog rather than the editor. */
export function typingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog[open]')) return true;
  return target.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]), textarea, select, [contenteditable="true"]');
}
