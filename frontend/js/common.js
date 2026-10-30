// Shared helpers: DOM lookup, backend API calls, number formatting, series colors.

export const $ = (id) => document.getElementById(id);

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const fmtMs = (v) => (isNum(v) ? `${Math.round(v).toLocaleString()} ms` : '–');
export const fmtRate = (v) => (isNum(v) ? `${v.toFixed(1)} tok/s` : '–');
export const fmtScore = (v) => (isNum(v) ? v.toFixed(2) : 'N/A');
export const fmtInt = (v) => (isNum(v) ? Math.round(v).toLocaleString() : '–');

export function fmtBytes(v) {
  if (!isNum(v)) return '–';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

// Word count: a tokenizer-independent measure of how verbose an output is
export const wordCount = (text) => (text && text.trim() ? text.trim().split(/\s+/).length : null);

// Short display names for charts and tables; unknown models fall back to the repo name
const DISPLAY_NAMES = {
  'HuggingFaceTB/SmolVLM2-256M-Video-Instruct': 'SmolVLM2 256M',
  'HuggingFaceTB/SmolVLM2-500M-Video-Instruct': 'SmolVLM2 500M',
  'onnx-community/nanoLLaVA-1.5': 'nanoLLaVA 1.5',
  'onnx-community/Qwen2-VL-2B-Instruct': 'Qwen2-VL 2B',
  'onnx-community/Qwen3.5-2B-ONNX-OPT': 'Qwen3.5 2B',
  'onnx-community/Janus-Pro-1B-ONNX': 'Janus-Pro 1B',
};
export const shortModel = (name) => (name ? DISPLAY_NAMES[name] || name.split('/').pop() : '');

// Colors follow the entity, never its rank: every model keeps its own slot.
// Precision is shown with texture (hatched bars / dashed lines), not a new color.
const SLOTS = {
  'HuggingFaceTB/SmolVLM2-256M-Video-Instruct': 1,
  'gpt-4o-mini': 2,
  'gpt-4o': 3,
  'manual reference': 4,
  'HuggingFaceTB/SmolVLM2-500M-Video-Instruct': 5,
  'onnx-community/nanoLLaVA-1.5': 6,
  'onnx-community/Qwen2-VL-2B-Instruct': 7,
  'onnx-community/Qwen3.5-2B-ONNX-OPT': 7,
  'onnx-community/Janus-Pro-1B-ONNX': 8,
};
export function seriesColor(model) {
  return `var(--series-${SLOTS[model] || 1})`;
}

// Display name and style for a model + precision ("compatible" gets a texture)
export function seriesStyle(model, kind, precision) {
  // Preset names in Title Case; older runs' raw file types (e.g. "fp16/q4/q4") stay as they are
  const PRESETS = { fast: 'Fast', balanced: 'Balanced', compatible: 'Compatible', cpu: 'CPU' };
  const tag = kind === 'cloud' ? 'Cloud' : precision ? `Local, ${PRESETS[precision] || precision}` : 'Local';
  return {
    name: `${shortModel(model)} (${tag})`,
    color: seriesColor(model),
    textured: kind === 'local' && precision === 'compatible',
  };
}

export function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.filter(Boolean));
  return node;
}

// A stat tile: label, value, and an optional supporting line
// Marker for which direction of a metric is better
export const BETTER = {
  lower: '↓ Lower is better',
  higher: '↑ Higher is better',
  context: 'Context only: neither is better',
};

// A stat tile: label, value, an optional supporting line and an optional "better" marker
export function statTile(label, value, sub, { swatch, better } = {}) {
  const labelEl = el('div', { className: 'tile-label' }, [
    swatch ? el('span', { className: 'swatch', attrs: { style: `background:${swatch}`, 'aria-hidden': 'true' } }) : null,
    document.createTextNode(label),
  ]);
  return el('div', { className: 'stat-tile' }, [
    labelEl,
    el('div', { className: 'tile-value', text: value }),
    sub ? el('div', { className: 'tile-sub', text: sub }) : null,
    better ? el('div', { className: `tile-better better-${better}`, text: BETTER[better] }) : null,
  ]);
}

/**
 * Confirmation dialog. Resolves true only if the user confirms.
 * typeToConfirm: the user must type this word first (for the most destructive actions).
 */
export function confirmDialog({ title, message, confirmText = 'Delete', typeToConfirm = '' }) {
  return new Promise((resolve) => {
    const input = typeToConfirm
      ? el('input', { attrs: { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': `Type ${typeToConfirm} to confirm` } })
      : null;
    const ok = el('button', { className: 'danger inline', text: confirmText, attrs: { type: 'button' } });
    const cancel = el('button', { className: 'secondary inline', text: 'Cancel', attrs: { type: 'button' } });
    const dialog = el('dialog', { className: 'confirm-dialog', attrs: { 'aria-labelledby': 'confirm-title' } }, [
      el('h3', { text: title, attrs: { id: 'confirm-title' } }),
      el('p', { text: message }),
      input ? el('label', { className: 'confirm-type' }, [document.createTextNode(`Type ${typeToConfirm} to confirm`), input]) : null,
      el('div', { className: 'confirm-buttons' }, [cancel, ok]),
    ]);
    if (input) {
      ok.disabled = true;
      input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== typeToConfirm; });
    }
    let result = false;
    ok.addEventListener('click', () => { result = true; dialog.close(); });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    (input || cancel).focus();
  });
}
