// Crash recovery for phones: remembers what was running (model, single run or batch
// position) so that after the browser kills and reloads the tab, the app can load the
// model again and retry. Gives up after MAX_CRASHES crashes in a row.

const KEY = 'webgpu-slm:recovery';
const IMAGE_CACHE = 'webgpu-slm-recovery';
const IMAGE_KEY = '/__recovery/image';
const FALLBACK_KEY = 'webgpu-slm:recovery-image'; // smaller copy in case the cache isn't kept
export const MAX_CRASHES = 3;

// { model, precision, warmup, crashes, task: null | { kind: 'single', settings, image } | { kind: 'batch', settings, batch } }
export function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or unavailable: recovery just won't happen
  }
}

export function update(changes) {
  const state = read();
  if (state) save({ ...state, ...changes });
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(FALLBACK_KEY);
  } catch {
    // ignore
  }
}

// The single-run image is kept in the Cache API (full size), plus a smaller JPEG data URL
// in localStorage as a fallback in case the browser doesn't keep the cache entry.
export async function saveImage(blob, fallbackDataUrl = null) {
  let saved = false;
  try {
    const cache = await caches.open(IMAGE_CACHE);
    await cache.put(IMAGE_KEY, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }));
    saved = true;
  } catch {
    // fall back below
  }
  try {
    if (fallbackDataUrl && fallbackDataUrl.length < 2_000_000) {
      localStorage.setItem(FALLBACK_KEY, fallbackDataUrl);
      saved = true;
    } else {
      localStorage.removeItem(FALLBACK_KEY);
    }
  } catch {
    // storage full
  }
  return saved;
}

// Returns { blob, fallback } (fallback = the smaller copy was used), or null
export async function loadImage() {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    const res = await cache.match(IMAGE_KEY);
    if (res) return { blob: await res.blob(), fallback: false };
  } catch {
    // try the fallback
  }
  try {
    const dataUrl = localStorage.getItem(FALLBACK_KEY);
    if (dataUrl) return { blob: await (await fetch(dataUrl)).blob(), fallback: true };
  } catch {
    // nothing left
  }
  return null;
}

// Uploaded-image batches: each image is cached by its position so a crashed batch can resume
export async function saveUploadImages(blobs) {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    await Promise.all(blobs.map((b, i) => cache.put(`/__recovery/upload/${i}`, new Response(b, { headers: { 'Content-Type': b.type || 'image/jpeg' } }))));
    return true;
  } catch {
    return false;
  }
}

export async function loadUploadImage(index) {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    const res = await cache.match(`/__recovery/upload/${index}`);
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}
