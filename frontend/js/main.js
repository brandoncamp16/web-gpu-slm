import { $, api, isNum, fmtMs, fmtRate, fmtScore, fmtBytes, wordCount } from './common.js';
import { LOCAL_MODELS, PRECISION_LABELS, NEEDS_F16, findModel } from './models.js';
import { createEngineClient } from './engine-client.js';
import { classifyRequests } from './network.js';
import * as diag from './diagnostics.js';
import { initBatch } from './batch.js';
import * as recovery from './recovery.js';
import { renderResults, renderReport } from './results.js';

// ---------- Settings shared by local and cloud runs ----------
const MAX_NEW_TOKENS = 128;
// The first VizWiz image for seed 1 (a garden scene), served by the backend so the sample never disappears
const SAMPLE_IMAGE_URL = '/api/vizwiz/images/VizWiz_val_00004791.jpg';
const CLOUD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// ---------- State ----------
let local = null; // loaded model: { entry, precision, lowMemory } (the model itself lives in the engine)
let engine = null; // engine client: runs the model in a background worker (or on the page as a fallback)
let nextRunIsColdStart = false; // first run after loading includes WebGPU shader compilation
let supportsF16 = false; // GPU "shader-f16" feature: needed for the fast precision preset
let gpuReady = false; // WebGPU adapter found on a secure page
let gpuTitle = 'WebGPU Ready'; // e.g. "WebGPU Ready: NVIDIA Ampere", kept after a model loads
let precisionChosenByUser = false; // keep the user's precision choice when the model changes
let recoveringTask = null; // task being retried after a crash (phones)
let modelLoadedThisPage = false; // phones reload before loading another model (frees memory)
const AUTOLOAD_KEY = 'webgpu-slm:autoload';
let settleTimer = null; // keeps crash detection on for a while after a model finishes loading
const SETTLE_MS = 15000;
let currentImage = null; // { url, blob, name, source }
// Images queued in "Upload Images" mode: one runs as a single benchmark, several as a batch
let uploads = []; // [{ blob, name, source, url, original }]
let cameraStream = null;
let gpuInfo = { gpuVendor: '', gpuArchitecture: '', gpuDescription: '', gpuFeatures: '' };
let isRunning = false;
let lastRun = null; // last saved run from the backend
let rescoreTimer = null;

const webgpuStatus = $('webgpu-status');
const backendStatus = $('backend-status');
const loadModelBtn = $('load-model-btn');
const loadProgress = $('load-progress');
const modelSelect = $('model-select');
const precisionSelect = $('precision-select');
const warmupInput = $('warmup-input');
const modelHint = $('model-hint');
const imageInput = $('image-input');
const dropZone = $('drop-zone');
const imagePreview = $('image-preview');
const cameraPreview = $('camera-preview');
const placeholderText = $('placeholder-text');
const sampleBtn = $('sample-btn');
const camBtn = $('cam-btn');
const promptInput = $('prompt-input');
const cloudModelSelect = $('cloud-model-select');
const runLabelInput = $('run-label');
const runBtn = $('run-btn');
const runStatus = $('run-status');
const localOutput = $('local-output');
const cloudReference = $('cloud-reference');
const referenceLabel = $('reference-label');
const bleuScoreEl = $('bleu-score');
const chrfScoreEl = $('chrf-score');
const updateRefBtn = $('update-ref-btn');
const viewReportLink = $('view-report-link');

// ---------- Activity log and load progress (panel 1) ----------
const consoleLog = $('console-log');
const loadBar = $('load-bar');

function logLine(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `[${time}] ${message}`;
  consoleLog.append(line);
  while (consoleLog.childElementCount > 200) consoleLog.firstElementChild.remove();
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

// Overall model-load progress, 0..1
function setLoadBar(fraction) {
  loadBar.hidden = false;
  loadBar.value = Math.min(Math.max(fraction, 0), 1);
}

// "nvidia"/"ampere" -> "NVIDIA Ampere"; "apple"/"apple" -> "Apple"
const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', microsoft: 'Microsoft', google: 'Google', mesa: 'Mesa', samsung: 'Samsung', imagination: 'Imagination' };
function gpuName(info) {
  const nice = (w) => (w ? VENDOR_NAMES[w.toLowerCase()] || w.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
  const vendor = nice(info.vendor);
  const arch = nice(info.architecture);
  return [vendor, arch && arch.toLowerCase() !== vendor.toLowerCase() ? arch : ''].filter(Boolean).join(' ');
}

async function checkBackend() {
  try {
    const health = await api('/api/health');
    if (health.database !== 'connected') {
      backendStatus.className = 'status-box error';
      backendStatus.textContent = 'Backend Connected: the database is not connected yet, so results cannot be saved.';
    } else if (!health.openaiConfigured) {
      backendStatus.className = 'status-box error';
      backendStatus.textContent = 'Backend Connected: OPENAI_API_KEY is not set. Add it to secrets.env, or choose "None" for the cloud baseline.';
    } else {
      backendStatus.className = 'status-box success';
      backendStatus.textContent = 'Backend Connected: OpenAI baseline and results storage are ready.';
    }
    logLine(backendStatus.textContent, backendStatus.className.includes('error') ? 'warn' : 'info');
  } catch (err) {
    backendStatus.className = 'status-box error';
    backendStatus.textContent = `Backend Unreachable: ${err.message}`;
    logLine(backendStatus.textContent, 'error');
  }
}

// ---------- Device name ----------
// Saved with every run so results can be filtered and sorted by device
const DEVICE_KEY = 'webgpu-slm:device-name';
function defaultDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows PC'
          : /Macintosh/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux PC' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}
const deviceInput = $('device-name');
deviceInput.placeholder = defaultDeviceName();
try {
  deviceInput.value = localStorage.getItem(DEVICE_KEY) || '';
} catch {
  // storage unavailable
}
deviceInput.addEventListener('change', () => {
  try {
    localStorage.setItem(DEVICE_KEY, deviceInput.value.trim());
  } catch {
    // storage unavailable
  }
});
const deviceName = () => deviceInput.value.trim() || defaultDeviceName();

// ---------- WebGPU ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/.test(navigator.userAgent);
const isFirefox = /Firefox\//.test(navigator.userAgent);
// Safari's engine: every iOS browser, plus desktop Safari
const isWebKit = isIOS || (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(navigator.userAgent));

function webgpuError(message) {
  gpuReady = false;
  webgpuStatus.className = 'status-box error';
  webgpuStatus.textContent = message;
  logLine(message, 'error');
  updateModelOptions(); // CPU-only mode still works without WebGPU
}

async function checkWebGPU() {
  // WebGPU (and the camera) only exist on https:// pages or localhost
  if (!window.isSecureContext) {
    webgpuError(`WebGPU and the camera need a secure (https) connection, but this page was opened over plain http (${location.host}).`);
    // Point phones to the https site and the one-time certificate install (prod mode serves both)
    const httpsUrl = `https://${location.host}/`;
    const certUrl = `http://${location.host}/ca.crt`;
    const steps = document.createElement('ul');
    steps.className = 'status-steps';
    const step = (text, href, linkText) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.textContent = linkText;
      li.append(text, a);
      steps.append(li);
    };
    step('Open the secure site: ', httpsUrl, httpsUrl);
    step('First time on this device? Install the certificate (one time): ', certUrl, certUrl);
    webgpuStatus.append(steps);
    return;
  }
  if (!navigator.gpu) {
    webgpuError(isIOS
      ? 'WebGPU is not available. It needs iOS / Safari 26 or later.'
      : 'WebGPU is not supported in this browser. Use a recent Chrome, Edge or Safari, or a Firefox version with WebGPU enabled.');
    return;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      webgpuError('No WebGPU adapter found. Check that hardware acceleration is enabled.');
      return;
    }
    supportsF16 = adapter.features.has('shader-f16');
    gpuReady = true;
    // Record the GPU for the results (adapter.info in newer browsers, requestAdapterInfo in older)
    const info = adapter.info || (await adapter.requestAdapterInfo?.()) || {};
    const features = ['shader-f16', 'subgroups', 'timestamp-query'].filter((f) => adapter.features.has(f));
    gpuInfo = {
      gpuVendor: info.vendor || '',
      gpuArchitecture: info.architecture || '',
      gpuDescription: info.description || '',
      gpuFeatures: features.join(','),
    };
    diag.step('page-load', {
      gpu: [info.vendor, info.architecture].filter(Boolean).join(' '),
      features: gpuInfo.gpuFeatures,
      maxBufferSize: adapter.limits?.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize,
    });
    const name = gpuName(info);
    const notes = [];
    if (!supportsF16) notes.push('This GPU/browser has no fp16 shader support, so only the slower "Compatible" precision is available.');
    if (isFirefox) notes.push('Firefox\'s WebGPU is newer than Chrome\'s and usually runs these models more slowly.');
    webgpuStatus.className = notes.length ? 'status-box info' : 'status-box success';
    gpuTitle = `WebGPU Ready${name ? `: ${name}` : ''}`;
    webgpuStatus.textContent = `${gpuTitle}${notes.length ? `. ${notes.join(' ')}` : ''}`;
    logLine(`WebGPU Ready${name ? `: ${name}` : ''} (features: ${gpuInfo.gpuFeatures || 'none'})`);
  } catch (err) {
    webgpuError('WebGPU initialization error: ' + err.message);
    return;
  }
  updateModelOptions();
}

// ---------- Model selection ----------
for (const m of LOCAL_MODELS) modelSelect.append(new Option(m.label, m.id));

function updateModelOptions() {
  const entry = findModel(modelSelect.value);
  const previous = precisionSelect.value;
  precisionSelect.replaceChildren();
  for (const key of Object.keys(entry.precisions)) {
    const option = new Option(PRECISION_LABELS[key], key);
    option.disabled = (NEEDS_F16.has(key) && !supportsF16) || (key !== 'cpu' && !gpuReady);
    precisionSelect.append(option);
  }
  const usable = [...precisionSelect.options].filter((o) => !o.disabled).map((o) => o.value);
  // Balanced is the default everywhere: it fits iPhone memory and avoids the fp16 math
  // that produced empty output in Safari. Fallbacks when it isn't available (no shader-f16 / no WebGPU).
  const preferred = ['balanced', 'compatible', 'cpu', 'fast'];
  precisionSelect.value =
    precisionChosenByUser && usable.includes(previous) ? previous
      : preferred.find((p) => usable.includes(p)) ?? usable[0] ?? '';
  updateModelHint();
}

function updateModelHint() {
  const entry = findModel(modelSelect.value);
  const preset = entry.precisions[precisionSelect.value];
  if (!preset) {
    modelHint.className = 'hint warning';
    modelHint.textContent = gpuReady
      ? `${entry.label} needs fp16 shader support, which this GPU/browser doesn't have.`
      : `${entry.label} needs WebGPU, which isn't available here.`;
    loadModelBtn.disabled = true;
    return;
  }
  const size = preset.downloadMB >= 1000 ? `${(preset.downloadMB / 1000).toFixed(1)} GB` : `${preset.downloadMB} MB`;
  // iPhone Safari testing: GPU presets up to ~210 MB fit; 265 MB and larger crashed the tab
  const tooBig = isMobile && preset.device !== 'wasm' && preset.downloadMB > 220;
  modelHint.className = tooBig ? 'hint warning' : 'hint';
  modelHint.textContent = `${entry.id} · download ≈ ${size} (cached after the first load).` +
    (tooBig ? ' Larger than what fit in iPhone Safari testing (about 210 MB); likely to crash the tab. CPU only is slower but uses no GPU memory.' : '') +
    (isWebKit && precisionSelect.value === 'fast' ? ' Fast produced empty output once in Safari testing; if that happens, use Balanced.' : '') +
    (preset.device === 'wasm' ? ' Runs on the CPU only: slower, but uses no GPU memory.' : '');
  loadModelBtn.disabled = preset.device === 'wasm' ? false : !gpuReady;
}

modelSelect.addEventListener('change', updateModelOptions);
precisionSelect.addEventListener('change', () => {
  precisionChosenByUser = true;
  updateModelHint();
});
updateModelOptions();

const datasetMode = () => document.querySelector('input[name="test-mode"]:checked')?.value === 'dataset';

function updateRunButton() {
  const queued = uploads.length;
  runBtn.disabled = isRunning || !local || (!datasetMode() && !currentImage && queued < 2);
  runBtn.textContent = datasetMode() ? 'Run Dataset Batch' : queued > 1 ? `Run Benchmark (${queued} Images)` : 'Run Benchmark';
}

// GPU device events from the engine (they can arrive any time after loading)
function onGpuEvent(e) {
  if (e.reason === 'destroyed') {
    diag.step('gpu-device-released', { note: 'expected when a model is unloaded' });
  } else {
    diag.step('gpu-device-lost', { reason: e.reason, message: e.message });
    logLine(`GPU problem: ${e.reason}${e.message ? ` (${e.message})` : ''}`, 'error');
  }
}

// The engine client is created on first use; it starts the inference worker
async function getEngine() {
  if (!engine) {
    engine = await createEngineClient({ pageHasWebGPU: gpuReady });
    engine.onStrayEvent = (e) => { if (e.type === 'gpu') onGpuEvent(e); };
    logLine(engine.runtime === 'worker'
      ? 'Model engine: running in a background worker (the page stays responsive)'
      : 'Model engine: running on the page (this browser cannot use WebGPU in a worker)', engine.runtime === 'worker' ? 'info' : 'warn');
  }
  return engine;
}

// Phones: while a model loads or runs, hide the setup controls so the screen shows only
// what's happening (log, progress, image, outputs). Settings can't change mid-run anyway.
let loadingModel = false;
function updatePhoneFocus() {
  const busy = isMobile && (loadingModel || isRunning);
  document.body.classList.toggle('phone-busy', busy);
  const summary = $('setup-summary');
  summary.hidden = !busy;
  if (busy) {
    const entry = findModel(modelSelect.value);
    summary.textContent = `${entry?.label || 'Model'} · ${PRECISION_LABELS[precisionSelect.value]?.split(':')[0] || precisionSelect.value} · ${loadingModel ? 'loading' : 'running'}. Setup is hidden until it finishes.`;
  }
}

// Loads the selected model. Resolves true when the model is ready.
async function loadModel() {
  loadingModel = true;
  updatePhoneFocus();
  try {
    return await loadModelInner();
  } finally {
    loadingModel = false;
    updatePhoneFocus();
  }
}

async function loadModelInner() {
  const entry = findModel(modelSelect.value);
  const precision = precisionSelect.value;
  loadModelBtn.disabled = true;
  modelSelect.disabled = true;
  precisionSelect.disabled = true;
  const preset = entry.precisions[precision];

  // Phones: memory from a previous model is never fully released within a page,
  // so reload first and load the new model into a clean page
  if (isMobile && modelLoadedThisPage) {
    try {
      sessionStorage.setItem(AUTOLOAD_KEY, JSON.stringify({ model: entry.id, precision, warmup: warmupInput.checked }));
      diag.step('reload-for-clean-memory', { next: entry.id, nextPrecision: precision });
      loadProgress.textContent = 'Reloading the page to free memory before loading...';
      recovery.update({ task: null }); // a deliberate reload, not a crash
      location.reload();
      return false;
    } catch {
      // sessionStorage unavailable: fall through and load in this page
    }
  }
  modelLoadedThisPage = true;

  const lowMemory = isMobile; // phones: no pre-reserved onnxruntime memory pools
  const onCpu = preset.device === 'wasm';
  clearTimeout(settleTimer);
  diag.setContext({ model: entry.id, precision });
  diag.setBusy(true);
  diag.step('load-start', { warmup: warmupInput.checked, lowMemory, device: onCpu ? 'wasm' : 'webgpu', downloadMB: preset.downloadMB });
  // Phones: remember the model (and any task being recovered) in case the tab crashes
  if (isMobile) {
    const prev = recovery.read();
    recovery.save({ model: entry.id, precision, warmup: warmupInput.checked, crashes: prev?.crashes ?? 0, task: recoveringTask });
  }

  let ready = false;
  const totalBytes = preset.downloadMB * 1e6;
  let doneBytes = 0;
  setLoadBar(0);
  logLine(`Loading ${entry.label} (${precision}, ${onCpu ? 'CPU' : 'WebGPU'}${lowMemory ? ', low-memory mode' : ''})...`);
  try {
    // Free the previous model's memory before loading another. A worker is simply ended,
    // which releases everything it held (weights, WebAssembly heap, GPU buffers).
    if (local) {
      loadProgress.textContent = 'Unloading the previous model...';
      local = null;
      updateRunButton();
      if (engine?.runtime === 'worker') {
        engine.terminate();
        engine = null;
      } else {
        await engine?.call('dispose');
      }
    }
    const client = await getEngine();
    // Download weight files one at a time into the cache first (keeps memory low on phones)
    let fileName = '';
    const onFile = ({ file, status, bytes, error }) => {
        fileName = file.split('/').pop();
        if (status === 'downloading') loadProgress.textContent = `Downloading ${fileName}...`;
        if (status !== 'downloading') diag.step(`precache-${status}`, { file, bytes, error });
        if (status === 'cached') logLine(`${fileName}: already downloaded`);
        if (status === 'done') {
          doneBytes += bytes || 0;
          logLine(`${fileName}: downloaded ${fmtBytes(bytes)}`);
        }
        if (status === 'failed') logLine(`${fileName}: download failed (${error})`, 'warn');
    };
    const onBytes = (loaded, total) => {
      loadProgress.textContent = `Downloading ${fileName}: ${fmtBytes(loaded)}${total ? ` of ${fmtBytes(total)} (${Math.floor((loaded / total) * 100)}%)` : ''}`;
      setLoadBar(0.7 * Math.min((doneBytes + loaded) / totalBytes, 1)); // downloads: first 70%
    };
    const cached = await client.call('precache', { modelId: entry.id, precision }, (e) => {
      if (e.type === 'file') onFile(e);
      if (e.type === 'bytes') onBytes(e.loaded, e.total);
    });
    if (!cached.ok) diag.step('precache-skipped', { reason: cached.reason });

    loadProgress.textContent = `Loading ${entry.label} ${onCpu ? 'on the CPU' : 'into the GPU'}...`;
    setLoadBar(0.7);
    logLine(`Creating ${onCpu ? 'CPU' : 'GPU'} sessions...`);
    diag.step('model-load-start');
    const loadStart = performance.now();
    await client.call('load', { modelId: entry.id, precision, lowMemory }, (e) => {
      // Library downloads, when the pre-download was skipped
      if (e.type === 'download') loadProgress.textContent = `Downloading weights: ${fmtBytes(e.loaded)} of ${fmtBytes(e.total)} (${Math.floor((e.loaded / e.total) * 100)}%)`;
      if (e.type === 'gpu') onGpuEvent(e);
    });
    diag.step('model-loaded', { ms: Math.round(performance.now() - loadStart) });
    setLoadBar(0.85);
    logLine(`Model loaded in ${fmtMs(performance.now() - loadStart)}`);

    if (warmupInput.checked) {
      loadProgress.textContent = onCpu ? 'Warming up...' : 'Warming up (compiling GPU shaders)...';
      diag.step('warmup-start');
      logLine('Warming up (compiling shaders)...');
      const warmStart = performance.now();
      await client.call('warmUp');
      diag.step('warmup-done');
      logLine(`Warm-up done in ${fmtMs(performance.now() - warmStart)}`);
    }
    local = { entry, precision, lowMemory };
    nextRunIsColdStart = !warmupInput.checked;

    loadProgress.textContent = `${entry.label} (${precision}) loaded.` +
      (nextRunIsColdStart ? ' The first run will be marked as a cold start.' : ' Warm-up done, so the first run is a normal (warm) run.');
    webgpuStatus.className = 'status-box success';
    webgpuStatus.textContent = onCpu
      ? `${gpuReady ? `${gpuTitle} · ` : ''}Model loaded on the CPU (WebAssembly), no network needed for local inference.`
      : `${gpuTitle} · Model loaded in GPU memory, no network needed for local inference.`;
    diag.step('model-ready');
    setLoadBar(1);
    logLine(`${entry.label} (${precision}) ready`, 'success');
    ready = true;
    // Keep crash detection on for a while: phones can kill the tab shortly after loading
    settleTimer = setTimeout(() => {
      if (isRunning) return; // the run clears the busy flag when it ends
      diag.step('settled');
      diag.setBusy(false);
    }, SETTLE_MS);
  } catch (err) {
    console.error(err);
    loadProgress.textContent = `Error loading ${entry.label}: ${err.message}`;
    diag.step('load-failed', { message: String(err.message).slice(0, 300) });
    logLine(`Load failed: ${err.message}`, 'error');
    diag.setBusy(false);
  } finally {
    loadModelBtn.disabled = false;
    modelSelect.disabled = false;
    precisionSelect.disabled = false;
    updateRunButton();
  }
  return ready;
}
loadModelBtn.addEventListener('click', () => loadModel());

// ---------- Images ----------
// The image currently being run (shown large in the preview)
function setImage({ blob, name, source, original = null }) {
  if (currentImage?.url && !uploads.some((u) => u.url === currentImage.url)) URL.revokeObjectURL(currentImage.url);
  const url = uploads.find((u) => u.blob === blob)?.url || URL.createObjectURL(blob);
  currentImage = { url, blob, name, source, original };
  imagePreview.src = url;
  imagePreview.hidden = false;
  uploadGrid.hidden = true;
  cameraPreview.hidden = true;
  placeholderText.hidden = true;
  updateRunButton();
}

const uploadGrid = $('upload-grid');
const uploadToolbar = $('upload-toolbar');

// Photos larger than this (long side) are scaled down once when added. Neither model loses
// detail: the local models work at 512 px or less, and OpenAI fits images within 2048 px anyway.
// A 24 MP phone photo otherwise decodes to ~100 MB, several times over (preview, thumbnails, model).
const MAX_IMAGE_SIDE = 2048;

// Returns { blob, original }: the working copy and facts about the original file
async function prepareImage(blob) {
  const original = { sha256: await sha256Hex(blob), bytes: blob.size, width: null, height: null, resized: false };
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { blob, original }; // a format this browser can't decode here: use the file as-is
  }
  original.width = bitmap.width;
  original.height = bitmap.height;
  const scale = MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return { blob, original };
  }
  const canvas = $('capture-canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const resized = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  releaseCanvas(canvas);
  if (!resized) return { blob, original };
  original.resized = true;
  return { blob: resized, original };
}

// A canvas keeps its full-size pixel buffer until it's resized; free it after each use
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

async function addUploads(items) {
  const count = $('upload-count');
  for (const [i, item] of items.entries()) {
    if (items.length > 1) count.textContent = `Preparing image ${i + 1} of ${items.length}...`;
    // The sample is a small dataset image: keep it byte-for-byte
    const prepared = item.source === 'sample' ? { blob: item.blob, original: null } : await prepareImage(item.blob);
    uploads.push({ ...item, ...prepared, url: URL.createObjectURL(prepared.blob) });
  }
  renderUploads();
}

function removeUpload(index) {
  const [removed] = uploads.splice(index, 1);
  if (removed && currentImage?.url !== removed.url) URL.revokeObjectURL(removed.url);
  renderUploads();
}

function clearUploads() {
  for (const u of uploads) if (currentImage?.url !== u.url) URL.revokeObjectURL(u.url);
  uploads = [];
  renderUploads();
}

// One image: large preview. Several: a grid of thumbnails, each removable.
function renderUploads() {
  uploadToolbar.hidden = uploads.length === 0;
  $('upload-count').textContent = `${uploads.length} image${uploads.length === 1 ? '' : 's'} queued`;
  if (uploads.length === 0) {
    currentImage = null;
    imagePreview.hidden = true;
    uploadGrid.hidden = true;
    placeholderText.hidden = false;
  } else if (uploads.length === 1) {
    setImage(uploads[0]);
  } else {
    currentImage = null;
    imagePreview.hidden = true;
    placeholderText.hidden = true;
    uploadGrid.hidden = false;
    uploadGrid.replaceChildren(...uploads.map((u, i) => {
      const remove = document.createElement('button');
      remove.className = 'thumb-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${u.name}`);
      remove.addEventListener('click', () => removeUpload(i));
      const img = document.createElement('img');
      img.src = u.url;
      img.alt = u.name;
      const caption = document.createElement('span');
      caption.className = 'thumb-name';
      caption.textContent = u.name;
      const fig = document.createElement('figure');
      fig.className = 'thumb';
      fig.append(img, caption, remove);
      return fig;
    }));
  }
  updateRunButton();
}

$('clear-uploads-btn').addEventListener('click', clearUploads);

imageInput.addEventListener('change', (e) => {
  const files = [...e.target.files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  addUploads(files.map((f) => ({ blob: f, name: f.name, source: 'upload' })));
  imageInput.value = ''; // allow picking the same files again
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (datasetMode()) return;
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  addUploads(files.map((f) => ({ blob: f, name: f.name, source: 'upload' })));
});

sampleBtn.addEventListener('click', async () => {
  try {
    const res = await fetch(SAMPLE_IMAGE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    addUploads([{ blob: await res.blob(), name: 'VizWiz_val_00004791.jpg', source: 'sample' }]);
  } catch (err) {
    runStatus.textContent = `Could not load the sample image: ${err.message}`;
  }
});

// Camera (smart-glasses simulation): first click starts it, second click captures a frame
function stopCamera() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
  camBtn.textContent = 'Start Camera';
  if (uploads.length) renderUploads();
}

camBtn.addEventListener('click', async () => {
  if (!cameraStream) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      cameraPreview.srcObject = cameraStream;
      cameraPreview.hidden = false;
      imagePreview.hidden = true;
      uploadGrid.hidden = true;
      placeholderText.hidden = true;
      camBtn.textContent = 'Capture Frame';
    } catch (err) {
      runStatus.textContent = `Camera unavailable: ${err.message}`;
    }
    return;
  }
  const canvas = $('capture-canvas');
  canvas.width = cameraPreview.videoWidth;
  canvas.height = cameraPreview.videoHeight;
  canvas.getContext('2d').drawImage(cameraPreview, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  releaseCanvas(canvas);
  stopCamera();
  if (blob) addUploads([{ blob, name: `camera-${Date.now()}.jpg`, source: 'camera' }]);
});

async function sha256Hex(blob) {
  if (!crypto.subtle) return ''; // only available on https or localhost
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Width, height and bytes describe the image both models received; sha256 identifies the
// original file, and the original* fields are set when a large photo was scaled down
async function imageMetadata() {
  await imagePreview.decode().catch(() => {});
  const o = currentImage.original;
  return {
    name: currentImage.name,
    source: currentImage.source,
    mimeType: currentImage.blob.type,
    sha256: o?.sha256 || (await sha256Hex(currentImage.blob)),
    width: imagePreview.naturalWidth || null,
    height: imagePreview.naturalHeight || null,
    bytes: currentImage.blob.size,
    ...(o?.resized ? { resized: true, originalWidth: o.width, originalHeight: o.height, originalBytes: o.bytes } : {}),
  };
}

// A smaller JPEG copy of the current image, stored with the run for reports and the AI judge
async function imageForStorage() {
  try {
    await imagePreview.decode().catch(() => {});
    const w = imagePreview.naturalWidth;
    const h = imagePreview.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 1024 / Math.max(w, h));
    const canvas = $('capture-canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(imagePreview, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    releaseCanvas(canvas);
    return dataUrl;
  } catch {
    return null; // e.g. a cross-origin image that can't be read back
  }
}

// The cloud API accepts PNG/JPEG/WEBP/GIF; convert anything else to JPEG
async function imageAsDataUrl() {
  let blob = currentImage.blob;
  if (!CLOUD_IMAGE_TYPES.includes(blob.type)) {
    await imagePreview.decode().catch(() => {});
    const canvas = $('capture-canvas');
    canvas.width = imagePreview.naturalWidth;
    canvas.height = imagePreview.naturalHeight;
    canvas.getContext('2d').drawImage(imagePreview, 0, 0);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    releaseCanvas(canvas);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Network capture ----------
// Requests the page makes during a time window, from the Resource Timing API.
// Used to show (measure, not assume) that local inference sends nothing over the network.
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
    // The app's own backend calls (crash-log posts, next-image prefetch, rescoring) are counted separately
    return classifyRequests(entries, location);
  };
}

// ---------- Local inference ----------
// The engine runs the model (normally in the worker) and measures its timings next to it;
// the page shows live progress from its events.
async function runLocal(promptText) {
  const coldStart = nextRunIsColdStart;
  nextRunIsColdStart = false;
  const { entry, precision } = local;
  const preset = entry.precisions[precision];
  const base = {
    model: entry.id,
    precision,
    dtype: preset.dtype,
    device: typeof preset.device === 'string' ? preset.device : 'webgpu+wasm',
    runtime: engine.runtime,
    lowMemory: Boolean(local.lowMemory),
    coldStart,
    bandwidthBytes: 0,
  };

  // With a worker, the page's own requests are measured here and added to the worker's
  const stopPageCapture = engine.runtime === 'worker' ? startNetworkCapture() : () => ({});
  let streamed = '';
  setLoadBar(0);
  logLine('Preprocessing image...');
  try {
    const result = await engine.call('generate', { blob: currentImage.blob, prompt: promptText, maxNewTokens: MAX_NEW_TOKENS }, (e) => {
      switch (e.type) {
        case 'preprocess-done':
          diag.step('preprocess-done', { ms: Math.round(e.ms), image: e.image });
          logLine(`Image preprocessed in ${fmtMs(e.ms)} (${e.image})`);
          break;
        case 'generate-start':
          diag.step('generate-start');
          logLine('Generating...');
          runStatus.textContent = 'Generating...';
          break;
        case 'first-token':
          diag.step('first-token');
          logLine(`First token after ${fmtMs(e.ms)}`);
          break;
        case 'token':
          // Live heartbeat: the progress bar tracks tokens against the maximum
          setLoadBar(e.count / MAX_NEW_TOKENS);
          runStatus.textContent = `Generating... ${e.count} token${e.count === 1 ? '' : 's'} · ${(e.elapsedMs / 1000).toFixed(1)} s`;
          if (e.count % 16 === 0) {
            diag.step('tokens', { count: e.count });
            logLine(`${e.count} tokens generated`);
          }
          break;
        case 'text':
          streamed += e.text;
          localOutput.value = streamed;
          break;
        case 'empty-output':
          diag.step('empty-output', { tokens: e.tokens, firstIds: e.firstIds });
          break;
        case 'gpu':
          onGpuEvent(e);
          break;
        default:
      }
    });
    setLoadBar(1);
    const page = stopPageCapture();
    diag.step('generate-done', { tokens: result.outputTokens, chars: result.output.length });
    return {
      ...base,
      ...result,
      networkRequests: (result.networkRequests ?? 0) + (page.networkRequests ?? 0),
      networkBytes: (result.networkBytes ?? 0) + (page.networkBytes ?? 0),
      telemetryRequests: (result.telemetryRequests ?? 0) + (page.telemetryRequests ?? 0),
      appRequests: (result.appRequests ?? 0) + (page.appRequests ?? 0),
    };
  } catch (err) {
    console.error(err);
    diag.step('generate-failed', { message: String(err.message).slice(0, 300) });
    return { ...base, ...stopPageCapture(), output: '', error: err.message };
  }
}

// ---------- Cloud baseline ----------
async function runCloud(promptText, cloudModel) {
  try {
    const image = await imageAsDataUrl();
    const start = performance.now();
    const result = await api('/api/cloud/describe', {
      method: 'POST',
      body: JSON.stringify({ image, prompt: promptText, model: cloudModel, maxTokens: MAX_NEW_TOKENS }),
    });
    return { ...result, roundTripMs: performance.now() - start };
  } catch (err) {
    console.error(err);
    return { provider: 'openai', model: cloudModel, output: '', error: err.message };
  }
}

// ---------- Display ----------
function sideSummary(side) {
  if (!side) return '–';
  if (side.error) return `failed (${side.error})`;
  const words = wordCount(side.output);
  return [
    `TTFT ${fmtMs(side.ttftMs)}`,
    `total ${fmtMs(side.totalLatencyMs)}`,
    fmtRate(side.tokensPerSec),
    words != null ? `${words} words` : null,
    `upload ${fmtBytes(side.kind === 'local' ? 0 : side.requestBytes)}`,
  ].filter(Boolean).join(' · ');
}

function showLastRunMetrics(local, cloud) {
  $('m-local-summary').textContent = sideSummary(local && { ...local, kind: 'local' });
  $('m-cloud-summary').textContent = cloud ? `${cloud.model}: ${sideSummary(cloud)}` : 'not run';
}

function showScores(scores) {
  bleuScoreEl.textContent = fmtScore(scores?.bleu4);
  chrfScoreEl.textContent = fmtScore(scores?.chrf);
}

// The reference box is filled by the cloud model; it's only editable when no cloud baseline is used
function applyReferenceMode() {
  const manual = !cloudModelSelect.value;
  referenceLabel.textContent = manual ? 'Manual Reference (e.g. human-written caption)' : 'Cloud Baseline (Reference)';
  cloudReference.readOnly = !manual;
  cloudReference.placeholder = manual
    ? 'Type or paste a human-written reference to score the local output against.'
    : 'The cloud model\'s description appears here. Choose "None" as the cloud baseline to type your own reference.';
}
cloudModelSelect.addEventListener('change', applyReferenceMode);
applyReferenceMode();

// ---------- Full benchmark run ----------
// Each result stays on screen at least this long before the next run clears it,
// so it's clear the local model and the cloud request actually finished (matters in batches)
const RESULT_HOLD_MS = 1200;
let resultShownAt = 0;

function flashDone(box) {
  box.classList.remove('just-done');
  void box.offsetWidth; // restart the animation
  box.classList.add('just-done');
}

// One benchmark on the current image: local model, then cloud, then save.
// Returns the saved run. Used by the single-image button and by dataset batches.
async function runBenchmark({ promptText, cloudModel, manualReference = '', label = '', dataset = null, batchId = '' }) {
  // Let the previous results finish showing (before any timing starts)
  const hold = RESULT_HOLD_MS - (performance.now() - resultShownAt);
  if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  localOutput.classList.remove('just-done');
  cloudReference.classList.remove('just-done');
  updateRefBtn.hidden = true;
  viewReportLink.hidden = true;
  localOutput.value = '';
  if (cloudModel) cloudReference.value = '';
  showScores(null);

  runStatus.textContent = 'Running local inference...';
  logLine(`Running local inference on ${currentImage?.name || 'image'}...`);
  const local = await runLocal(promptText);
  logLine(local.error
    ? `Local error: ${local.error}`
    : `Local: ${local.outputTokens} tokens in ${fmtMs(local.totalLatencyMs)} (first word ${fmtMs(local.ttftMs)})`, local.error ? 'error' : 'info');
  if (local.error) {
    localOutput.value = `Inference error: ${local.error}`;
    runStatus.textContent = local.error;
  } else {
    localOutput.value = local.output;
    resultShownAt = performance.now();
    flashDone(localOutput);
  }

  // Cloud runs after local so the two never compete for the browser
  let cloud = null;
  if (cloudModel) {
    runStatus.textContent = `Requesting cloud baseline from ${cloudModel}...`;
    logLine(`Requesting ${cloudModel}...`);
    cloud = await runCloud(promptText, cloudModel);
    logLine(cloud.error
      ? `Cloud error: ${cloud.error}`
      : `Cloud: ${cloud.outputTokens ?? '?'} tokens in ${fmtMs(cloud.totalLatencyMs)} (first word ${fmtMs(cloud.ttftMs)})`, cloud.error ? 'error' : 'info');
    cloudReference.value = cloud.error ? '' : cloud.output;
    if (!cloud.error) {
      resultShownAt = performance.now();
      flashDone(cloudReference);
    }
    if (cloud.error) runStatus.textContent = `Cloud baseline failed: ${cloud.error}`;
  }
  showLastRunMetrics(local, cloud);

  runStatus.textContent = 'Saving run...';
  const referenceText = cloud && !cloud.error ? cloud.output : manualReference;
  lastRun = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      label,
      prompt: promptText,
      config: { maxNewTokens: MAX_NEW_TOKENS, imageSplitting: false, sampling: 'greedy' },
      image: await imageMetadata(),
      local,
      cloud,
      reference: { source: cloud && !cloud.error ? 'cloud' : manualReference ? 'manual' : '', text: referenceText },
      environment: { userAgent: navigator.userAgent, ...gpuInfo, deviceName: deviceName() },
      // The server looks up the human captions for this image itself;
      // other runs send a copy of the image to show in reports
      ...(dataset ? { dataset: { imageId: dataset.imageId } } : { imageData: await imageForStorage() }),
      ...(batchId ? { batchId } : {}),
    }),
  });
  showScores(lastRun.scores);
  viewReportLink.href = `#/run/${lastRun._id}`;
  // Batch runs: the batch viewer has its own "Open run report" for each image
  viewReportLink.hidden = Boolean(dataset);

  const problems = [local.error && 'local inference failed', cloud?.error && 'cloud baseline failed'].filter(Boolean);
  runStatus.textContent = problems.length
    ? `Run saved with errors (${problems.join(', ')}).`
    : `Run saved${local.coldStart ? ' (cold start: excluded from timing stats by default)' : ''}.`;
  diag.step('run-saved', { localError: local.error || undefined, cloudError: cloud?.error || undefined });
  logLine(`Run saved${isNum(lastRun.scores?.chrf) ? ` (chrF ${lastRun.scores.chrf.toFixed(1)} vs reference)` : ''}`, 'success');
  return lastRun;
}

function setRunning(running) {
  isRunning = running;
  updatePhoneFocus();
  loadModelBtn.disabled = running || !gpuReadyFor(precisionSelect.value);
  document.querySelectorAll('input[name="test-mode"]').forEach((r) => { r.disabled = running; });
  updateRunButton();
}

// The Load button works on the CPU preset even without WebGPU
function gpuReadyFor(precision) {
  const preset = findModel(modelSelect.value)?.precisions[precision];
  return Boolean(preset) && (preset.device === 'wasm' || gpuReady);
}

const batch = initBatch({
  api,
  diag,
  runBenchmark,
  setImage,
  setRunning,
  isModelLoaded: () => Boolean(local),
  localModel: () => (local ? { id: local.entry.id, precision: local.precision } : null),
  // Phones: track batch progress so a crash resumes at the image that was running
  onBatchStart: (info) => {
    if (isMobile) recovery.update({ task: { kind: 'batch', settings: info.settings, batch: info } });
  },
  onBatchItemDone: (nextIndex) => {
    const state = recovery.read();
    if (state?.task?.kind === 'batch') recovery.update({ crashes: 0, task: { ...state.task, batch: { ...state.task.batch, nextIndex } } });
  },
  onBatchEnd: () => recovery.update({ task: null }),
  saveUploadImages: (blobs) => (isMobile ? recovery.saveUploadImages(blobs) : Promise.resolve(false)),
  loadUploadImage: (index) => recovery.loadUploadImage(index),
  log: (message) => logLine(message),
  readRunSettings: () => ({
    promptText: promptInput.value.trim() || 'Describe this image.',
    cloudModel: cloudModelSelect.value,
    label: runLabelInput.value.trim(),
  }),
});

// One single-image benchmark (from the Run button or a crash recovery)
async function runSingle(settings) {
  if (isRunning || !local || !currentImage) return;
  setRunning(true);
  const { promptText, cloudModel, label, manualReference = '' } = settings;
  diag.setBusy(true);
  diag.step('run-start', { cloud: cloudModel || 'none', imageBytes: currentImage.blob.size });
  // Phones: keep the image and settings so the run can be retried after a crash
  if (isMobile && (await recovery.saveImage(currentImage.blob, await imageForStorage()))) {
    recovery.update({ task: { kind: 'single', settings, image: { name: currentImage.name, source: currentImage.source } } });
  }
  try {
    await runBenchmark({ promptText, cloudModel, manualReference, label });
    recovery.update({ task: null, crashes: 0 }); // finished: the crash streak is over
  } catch (err) {
    runStatus.textContent = `Run failed: ${err.message}`;
    diag.step('run-failed', { message: String(err.message).slice(0, 300) });
    recovery.update({ task: null });
  } finally {
    diag.setBusy(false);
    setRunning(false);
  }
}

runBtn.addEventListener('click', async () => {
  if (isRunning || !local) return;
  if (datasetMode()) {
    await batch.start();
    return;
  }
  if (uploads.length > 1) {
    // Several uploaded images: run them one after another as a batch
    await batch.start({ uploads: uploads.map(({ blob, name, source, original }) => ({ blob, name, source, original })) });
    renderUploads(); // show the queued collection again
    return;
  }
  const cloudModel = cloudModelSelect.value;
  await runSingle({
    promptText: promptInput.value.trim() || 'Describe this image.',
    cloudModel,
    label: runLabelInput.value.trim(),
    manualReference: cloudModel ? '' : cloudReference.value.trim(),
  });
});

// ---------- Test mode: single image or VizWiz dataset ----------
function applyMode() {
  const dataset = datasetMode();
  $('upload-group').hidden = dataset;
  $('single-buttons').hidden = dataset;
  $('dataset-controls').hidden = !dataset;
  placeholderText.textContent = dataset
    ? 'Dataset images appear here while a batch runs'
    : 'Drop images here, choose files, load the sample, or use the camera';
  if (dataset) {
    if (cameraStream) stopCamera();
    batch.showDatasetStatus();
  }
  updateRunButton();
}
document.querySelectorAll('input[name="test-mode"]').forEach((r) => r.addEventListener('change', applyMode));

// Live rescoring when the reference is edited; offer to save it to the last run
cloudReference.addEventListener('input', () => {
  clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(async () => {
    try {
      showScores(await api('/api/score', {
        method: 'POST',
        body: JSON.stringify({ hypothesis: localOutput.value, reference: cloudReference.value }),
      }));
    } catch {
      showScores(null);
    }
  }, 300);
  updateRefBtn.hidden = !lastRun || cloudReference.value === lastRun.reference?.text;
});

updateRefBtn.addEventListener('click', async () => {
  if (!lastRun) return;
  try {
    lastRun = await api(`/api/runs/${lastRun._id}`, {
      method: 'PATCH',
      body: JSON.stringify({ referenceText: cloudReference.value }),
    });
    showScores(lastRun.scores);
    updateRefBtn.hidden = true;
    runStatus.textContent = 'Reference updated and run rescored.';
  } catch (err) {
    runStatus.textContent = `Could not update reference: ${err.message}`;
  }
});

// ---------- Views ----------
// #/benchmark (default), #/results, #/run/<id>
const views = { benchmark: $('view-benchmark'), results: $('view-results'), report: $('view-report') };
const headings = { benchmark: 'setup-heading', results: 'results-heading', report: 'report-heading' };
let currentView = null;

function route() {
  const hash = location.hash || '#/benchmark';
  const runMatch = hash.match(/^#\/run\/([\w-]+)$/);
  const view = runMatch ? 'report' : hash === '#/results' ? 'results' : 'benchmark';

  for (const [name, node] of Object.entries(views)) node.hidden = name !== view;
  // Replay the entrance animation, also when the same view re-renders (e.g. report to report)
  const shown = views[view];
  shown.classList.remove('view-enter');
  void shown.offsetWidth;
  shown.classList.add('view-enter');
  document.querySelectorAll('.tabs a').forEach((a) => {
    const isCurrent = a.dataset.view === view || (view === 'report' && a.dataset.view === 'results');
    if (isCurrent) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  if (view === 'results') renderResults();
  if (view === 'report') renderReport(runMatch[1]);
  // Move focus to the new view's heading so screen readers announce the change
  if (currentView !== null && currentView !== view) $(headings[view]).focus();
  if (view !== 'benchmark') window.scrollTo(0, 0);
  currentView = view;
}
window.addEventListener('hashchange', route);

// ---------- Start ----------
// If the previous page died in the middle of a load or run, say where
// Steps during or right after loading a model
const LOAD_STEPS = new Set(['load-start', 'precache-done', 'precache-cached', 'precache-failed', 'precache-skipped',
  'model-load-start', 'model-loaded', 'warmup-start', 'warmup-done', 'model-ready']);

// Phones: after a crash, plan to load the model again and retry, up to MAX_CRASHES in a row
function planRecovery() {
  const state = recovery.read();
  if (!isMobile || !state) return null;
  if (!diag.previousCrash()) {
    // Normal reload or navigation: nothing to resume
    recovery.update({ task: null, crashes: 0 });
    return null;
  }
  const crashes = (state.crashes || 0) + 1;
  if (crashes >= recovery.MAX_CRASHES) {
    recovery.clear();
    return { giveUp: true, crashes, state };
  }
  recovery.update({ crashes });
  return { giveUp: false, crashes, state };
}
const recoveryPlan = planRecovery();

function showPreviousCrash() {
  const prev = diag.previousCrash();
  if (!prev) return;
  const last = prev.steps[prev.steps.length - 1];
  const ctx = prev.context || {};
  const banner = $('crash-banner');
  banner.textContent = `The last attempt stopped unexpectedly during "${last.step}"` +
    (ctx.model ? ` (${ctx.model.split('/').pop()}, ${ctx.precision})` : '') +
    '. On phones this usually means the browser ran out of memory. Details were sent to the backend log.' +
    (recoveryPlan?.giveUp
      ? ` It crashed ${recoveryPlan.crashes} times in a row, so it won't retry automatically.`
      : recoveryPlan
        ? ` Retrying automatically (retry ${recoveryPlan.crashes} of ${recovery.MAX_CRASHES - 1})...`
        : '') +
    (LOAD_STEPS.has(last.step) && (!recoveryPlan || recoveryPlan.giveUp)
      ? ` Try ${ctx.precision === 'balanced' ? 'the "CPU only"' : 'the "Balanced" or "CPU only"'} precision, and close other Safari tabs.`
      : '');
  banner.hidden = false;
  logLine(banner.textContent, 'warn');
  diag.step('previous-session-crashed', { previousSession: prev.session, previousContext: ctx, lastSteps: prev.steps.slice(-6) });
}

// Select a model/precision/warm-up and load it. Resolves true when ready.
async function autoLoad({ model, precision, warmup }) {
  if (!findModel(model)) return false;
  modelSelect.value = model;
  updateModelOptions();
  if ([...precisionSelect.options].some((o) => o.value === precision && !o.disabled)) {
    precisionSelect.value = precision;
    precisionChosenByUser = true;
  }
  warmupInput.checked = warmup !== false;
  updateModelHint();
  if (loadModelBtn.disabled) return false;
  return loadModel();
}

// Continue the run or batch that was interrupted by a crash
async function continueTask(task) {
  if (task.kind === 'single') {
    const restored = await recovery.loadImage();
    if (!restored) {
      recovery.update({ task: null });
      runStatus.textContent = "Couldn't restore the image from the interrupted run; choose it again and press Run.";
      return;
    }
    document.querySelector('input[name="test-mode"][value="single"]').checked = true;
    applyMode();
    setImage({ blob: restored.blob, name: task.image?.name || 'recovered-image.jpg', source: task.image?.source || 'upload' });
    diag.step('recovery-retry', { kind: 'single', smallerCopy: restored.fallback });
    runStatus.textContent = 'Retrying the run that was interrupted...';
    await runSingle(task.settings);
  } else if (task.kind === 'batch') {
    document.querySelector('input[name="test-mode"][value="dataset"]').checked = true;
    applyMode();
    diag.step('recovery-retry', { kind: 'batch', from: (task.batch?.nextIndex ?? 0) + 1 });
    await batch.start({ resume: task.batch, settings: task.settings });
  }
}

async function afterStartup() {
  // 1. Crash recovery (phones): load the same model again and retry the interrupted task
  if (recoveryPlan && !recoveryPlan.giveUp) {
    const { state } = recoveryPlan;
    recoveringTask = state.task || null;
    const ready = await autoLoad(state);
    recoveringTask = null;
    if (ready && state.task) await continueTask(state.task);
    return;
  }
  // 2. After a reload-for-clean-memory, load the model chosen before the reload
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(AUTOLOAD_KEY) || 'null');
    sessionStorage.removeItem(AUTOLOAD_KEY);
  } catch {
    return;
  }
  if (saved) await autoLoad(saved);
}

applyMode(); // browsers can restore the radio choice on reload
showPreviousCrash();
checkWebGPU().then(afterStartup);
checkBackend();
route();
