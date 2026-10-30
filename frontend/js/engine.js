// The model engine: everything that touches transformers.js.
// Runs inside the inference Web Worker (inference-worker.js) so heavy CPU work between
// GPU steps never blocks the page; it can also run on the main thread as a fallback.
// All progress is reported through one callback: emit({ type, ...details }).
import {
  AutoProcessor,
  AutoModelForVision2Seq,
  Qwen3_5ForConditionalGeneration,
  MultiModalityCausalLM,
  RawImage,
  TextStreamer,
  env,
} from './vendor/transformers-4.3.1.min.js'; // pinned copy, see scripts/vendor-transformers.sh
import { findModel, modelFiles } from './models.js';
import { classifyRequests } from './network.js';

// ---------- Model families: how each one loads and builds its inputs ----------
const families = {
  // SmolVLM / SmolVLM2 (Idefics3-style chat template)
  smolvlm: {
    async load(id, { dtype, device, progress_callback, session_options }) {
      const processor = await AutoProcessor.from_pretrained(id, { progress_callback });
      const model = await AutoModelForVision2Seq.from_pretrained(id, { dtype, device, progress_callback, session_options });
      return { processor, tokenizer: processor.tokenizer, model };
    },
    async prepare({ processor }, image, prompt) {
      const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      // No image splitting: one 512px tile keeps these models fast
      const inputs = await processor(text, [image], { do_image_splitting: false });
      return { inputs, promptLength: inputs.input_ids.dims.at(-1) };
    },
  },

  // Qwen3.5 (dynamic resolution: images are scaled so the long side is 448px).
  // Its chat template answers directly; "thinking" mode is off unless enable_thinking is set.
  qwen: {
    async load(id, { dtype, device, progress_callback, session_options }) {
      const processor = await AutoProcessor.from_pretrained(id, { progress_callback });
      const model = await Qwen3_5ForConditionalGeneration.from_pretrained(id, { dtype, device, progress_callback, session_options });
      return { processor, tokenizer: processor.tokenizer, model };
    },
    async prepare({ processor }, image, prompt) {
      const scale = 448 / Math.max(image.width, image.height);
      const resized = scale < 1 ? await image.resize(Math.round(image.width * scale), Math.round(image.height * scale)) : image;
      const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await processor(text, resized);
      return { inputs, promptLength: inputs.input_ids.dims.at(-1) };
    },
  },

  // Janus-Pro (DeepSeek chat format with an <image_placeholder> tag)
  janus: {
    async load(id, { dtype, device, progress_callback, session_options }) {
      const processor = await AutoProcessor.from_pretrained(id, { progress_callback });
      const model = await MultiModalityCausalLM.from_pretrained(id, { dtype, device, progress_callback, session_options });
      return { processor, tokenizer: processor.tokenizer, model };
    },
    async prepare({ processor }, image, prompt) {
      const conversation = [{ role: '<|User|>', content: `<image_placeholder>\n${prompt}` }];
      const inputs = await processor(conversation, { images: [image] });
      return { inputs, promptLength: inputs.input_ids.dims.at(-1) };
    },
  },
};


// Lower-memory onnxruntime settings for phones: no pre-reserved CPU memory pools
const LOW_MEMORY_SESSION_OPTIONS = { enableCpuMemArena: false, enableMemPattern: false };

let loaded = null; // { entry, precision, processor, tokenizer, model, prepare }

// ---------- Pre-download (lower memory on first load) ----------
// On a first load, transformers.js downloads every model file at once, keeps each in
// memory and copies it again into the browser cache. On phones that spike can get the
// tab killed. Downloading the files here first, one at a time and streamed straight into
// the same cache, means the library then loads from cache, like a normal repeat visit.

// The cache key transformers.js uses for a remote file (its download URL)
function cacheKeyFor(modelId, file) {
  const path = env.remotePathTemplate.replaceAll('{model}', modelId).replaceAll('{revision}', 'main');
  return `${env.remoteHost.replace(/\/+$/, '')}/${path.replace(/^\/+|\/+$/g, '')}/${file}`;
}

/**
 * Downloads the model's ONNX files into the browser cache, one at a time.
 * Events: { type: 'file', file, status: 'cached'|'downloading'|'done'|'failed', bytes, error }
 *         { type: 'bytes', loaded, total } for the file currently downloading.
 * Returns { ok: true } or { ok: false, reason } (then the normal loader downloads instead).
 */
export async function precache({ modelId, precision }, emit = () => {}) {
  const entry = findModel(modelId);
  if (typeof caches === 'undefined' || !env.useBrowserCache) return { ok: false, reason: 'browser cache unavailable' };
  let cache;
  try {
    cache = await caches.open(env.cacheKey);
  } catch (err) {
    return { ok: false, reason: `cannot open cache: ${err.message}` };
  }
  for (const file of modelFiles(entry, precision)) {
    const url = cacheKeyFor(entry.id, file);
    try {
      if (await cache.match(url)) {
        emit({ type: 'file', file, status: 'cached' });
        continue;
      }
      emit({ type: 'file', file, status: 'downloading' });
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      // Count bytes as they stream into the cache, without holding the file in memory
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      let lastEmit = 0;
      const counter = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          const now = performance.now();
          if (now - lastEmit > 100) { // at most ~10 progress messages per second
            lastEmit = now;
            emit({ type: 'bytes', loaded: received, total });
          }
          controller.enqueue(chunk);
        },
      });
      await cache.put(url, new Response(response.body.pipeThrough(counter), { status: 200, headers: new Headers(response.headers) }));
      emit({ type: 'file', file, status: 'done', bytes: received });
    } catch (err) {
      emit({ type: 'file', file, status: 'failed', error: err.message });
      return { ok: false, reason: `${file}: ${err.message}` };
    }
  }
  return { ok: true };
}

// ---------- Load / warm up / dispose ----------

// Report GPU device loss (e.g. the browser reclaimed GPU memory)
let watchedDevice = null;
async function watchGpuDevice(emit) {
  try {
    const device = await env.backends?.onnx?.webgpu?.device;
    if (!device || device === watchedDevice) return;
    watchedDevice = device;
    device.lost?.then((info) => emit({ type: 'gpu', reason: info.reason, message: String(info.message).slice(0, 300) }));
    device.addEventListener?.('uncapturederror', (e) => emit({ type: 'gpu', reason: 'error', message: String(e.error?.message).slice(0, 300) }));
  } catch {
    // not available in every onnxruntime version
  }
}

export async function load({ modelId, precision, lowMemory = false }, emit = () => {}) {
  const entry = findModel(modelId);
  const family = families[entry.family];
  const { dtype, device } = entry.precisions[precision];
  const session_options = lowMemory ? { ...LOW_MEMORY_SESSION_OPTIONS } : undefined;

  // Library download progress (only when files weren't pre-downloaded), summed across files
  const files = new Map();
  let lastEmit = 0;
  const progress_callback = (event) => {
    if (event.status !== 'progress' || !event.total) return;
    files.set(event.file, { loaded: event.loaded, total: event.total });
    const now = performance.now();
    if (now - lastEmit < 100) return;
    lastEmit = now;
    let done = 0;
    let total = 0;
    for (const f of files.values()) { done += f.loaded; total += f.total; }
    emit({ type: 'download', loaded: done, total });
  };

  const start = performance.now();
  const ctx = await family.load(entry.id, { dtype, device, progress_callback, session_options });
  loaded = { ...ctx, entry, precision, prepare: (image, prompt) => family.prepare(ctx, image, prompt) };
  if (device !== 'wasm') watchGpuDevice(emit);
  return { ms: performance.now() - start };
}

// A tiny generation so WebGPU compiles its shaders before the first measured run
export async function warmUp() {
  const start = performance.now();
  // A plain gray 448x448 RGB image, built directly (no canvas needed)
  const image = new RawImage(new Uint8ClampedArray(448 * 448 * 3).fill(128), 448, 448, 3);
  const { inputs } = await loaded.prepare(image, 'Describe this image.');
  await loaded.model.generate({ ...inputs, max_new_tokens: 4, do_sample: false });
  return { ms: performance.now() - start };
}

export async function dispose() {
  const model = loaded?.model;
  loaded = null;
  await model?.dispose?.();
  return {};
}

// ---------- Network capture ----------
// Requests made in this context (worker or page) during a run, from the Resource Timing API.
// The app's own requests to its backend are counted separately: crash-log posts (timing steps,
// never the image) and other app traffic (prefetching the next test image, live rescoring).
function startNetworkCapture() {
  const entries = [];
  let observer;
  try {
    observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
    observer.observe({ type: 'resource', buffered: false });
  } catch {
    return () => ({});
  }
  return () => {
    entries.push(...(observer.takeRecords?.() || []));
    observer.disconnect();
    return classifyRequests(entries, self.location);
  };
}

// ---------- Generate ----------
/**
 * Describes one image. Timings are measured here, next to the model.
 * Events: preprocess-done, generate-start, first-token, token (every token), text (readable chunks),
 *         empty-output.
 */
export async function generate({ blob, prompt, maxNewTokens }, emit = () => {}) {
  if (!loaded) throw new Error('No model loaded');
  const { tokenizer, model, precision } = loaded;
  const stopNetworkCapture = startNetworkCapture();
  const startTime = performance.now();
  let firstTokenTime = null;
  let tokenCount = 0;

  const image = await RawImage.fromBlob(blob);
  // Each model's own chat format around the same prompt text
  const { inputs, promptLength } = await loaded.prepare(image, prompt);
  const preprocessMs = performance.now() - startTime;
  emit({ type: 'preprocess-done', ms: preprocessMs, image: `${image.width}x${image.height}` });

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    // Fires once per generated token: used for TTFT and tok/s
    token_callback_function: () => {
      if (firstTokenTime === null) {
        firstTokenTime = performance.now();
        emit({ type: 'first-token', ms: firstTokenTime - startTime });
      }
      tokenCount++;
      emit({ type: 'token', count: tokenCount, elapsedMs: performance.now() - startTime });
    },
    // Fires when a readable chunk of text is ready: shows output live
    callback_function: (text) => emit({ type: 'text', text }),
  });

  emit({ type: 'generate-start' });
  const outputIds = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    do_sample: false, // deterministic output for repeatable benchmarks
    streamer,
  });
  const endTime = performance.now();

  // Decode only the newly generated tokens (drop the prompt)
  const newTokens = outputIds.slice(null, [promptLength, null]);
  const [text] = tokenizer.batch_decode(newTokens, { skip_special_tokens: true });

  // Only special tokens (e.g. end-of-text) came out: usually broken fp16 math on this GPU
  let error;
  if (!text.trim()) {
    const firstIds = (newTokens.tolist?.()[0] ?? []).slice(0, 10).map(Number);
    emit({ type: 'empty-output', tokens: tokenCount, firstIds });
    error = `The model produced no text (${tokenCount} special token${tokenCount === 1 ? '' : 's'} only).` +
      (precision === 'fast' ? ' fp16 math may not work on this GPU; try Compatible precision.' : '');
  }

  // Decode speed: tokens after the first one, over the time spent generating them
  const decodeSeconds = firstTokenTime !== null ? (endTime - firstTokenTime) / 1000 : 0;
  return {
    ...stopNetworkCapture(),
    ...(error ? { error } : {}),
    output: text.trim(),
    preprocessMs,
    ttftMs: firstTokenTime !== null ? firstTokenTime - startTime : null,
    totalLatencyMs: endTime - startTime,
    outputTokens: tokenCount,
    tokensPerSec: tokenCount > 1 && decodeSeconds > 0 ? (tokenCount - 1) / decodeSeconds : null,
  };
}
