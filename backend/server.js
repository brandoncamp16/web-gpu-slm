require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { scorePair, scoreCorpus, summarize } = require('./metrics');
const { CLOUD_MODELS, describeImage, isConfigured } = require('./cloud');
const vizwiz = require('./vizwiz');
const images = require('./images');
const { JUDGE_MODEL, judgeRuns } = require('./judge');

const app = express();
// Requests arrive through nginx (private Docker network): use its X-Forwarded-For for the client IP
app.set('trust proxy', 'loopback, uniquelocal');
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : undefined));
// Images are sent as base64 data URLs for the cloud baseline, so allow large bodies
app.use(express.json({ limit: '25mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Database ----------

const num = { type: Number, default: null };
const str = { type: String, default: '' };

const runSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true, maxlength: 200, index: true },
    prompt: str,
    config: {
      maxNewTokens: num,
      imageSplitting: { type: Boolean, default: false },
      sampling: { type: String, default: 'greedy' },
    },
    image: {
      name: str,
      source: str, // upload | sample | camera
      mimeType: str,
      sha256: str,
      width: num,
      height: num,
      bytes: num,
      // Large photos are scaled down to 2048 px (long side) before either model sees them;
      // width/height/bytes above describe the image used, these the original file
      resized: { type: Boolean, default: false },
      originalWidth: num,
      originalHeight: num,
      originalBytes: num,
      storedFile: str, // copy of the test image kept for reports (non-dataset runs)
    },
    local: {
      model: str,
      precision: str, // preset name: fast | balanced | compatible | cpu
      lowMemory: { type: Boolean, default: false }, // onnxruntime memory pools off (phones)
      runtime: str, // where the model ran: worker (background thread) | main-thread (fallback)
      dtype: { type: mongoose.Schema.Types.Mixed, default: null },
      device: str,
      output: str,
      coldStart: { type: Boolean, default: false }, // first run after model load
      preprocessMs: num, // image decode + processor
      ttftMs: num,
      totalLatencyMs: num,
      outputTokens: num,
      tokensPerSec: num,
      bandwidthBytes: { type: Number, default: 0 },
      // Measured in the browser during local inference (Resource Timing API)
      networkRequests: num, // requests made while the model ran (excludes the app's crash log)
      networkBytes: num, // bytes received by those requests
      telemetryRequests: num, // the app's own crash-log posts during the same window
      appRequests: num, // other calls to this app's backend in that window (next-image prefetch, rescoring)
      error: str,
    },
    cloud: {
      provider: str,
      model: str,
      resolvedModel: str,
      detail: str,
      output: str,
      ttftMs: num, // measured on the backend
      totalLatencyMs: num, // measured on the backend
      roundTripMs: num, // measured in the browser (includes upload)
      inputTokens: num,
      outputTokens: num,
      tokensPerSec: num,
      requestBytes: num, // sent to the provider (image + prompt)
      responseBytes: num, // received from the provider (streamed events, uncompressed)
      networkRequests: num, // outbound requests to the provider per description
      destination: str, // provider host, e.g. api.openai.com
      error: str,
    },
    reference: {
      source: str, // cloud | manual
      text: str,
    },
    scores: { bleu4: num, chrf: num }, // local output vs reference text (in dataset mode: the cloud output)
    // Dataset mode (VizWiz-Captions): the human captions, filled in by the server
    dataset: {
      name: str,
      split: str,
      imageId: { type: Number, default: null, index: true },
      fileName: str,
      references: { type: [String], default: undefined },
    },
    batchId: { type: String, default: '', index: true }, // groups the images of one dataset batch
    // Multi-reference scores against the human captions
    humanScores: {
      local: { bleu4: num, chrf: num },
      cloud: { bleu4: num, chrf: num },
    },
    environment: {
      userAgent: str,
      gpuVendor: str,
      gpuArchitecture: str,
      gpuDescription: str,
      gpuFeatures: str, // e.g. "shader-f16,subgroups"
      deviceName: { type: String, default: '', index: true }, // set in the app (default: OS + browser)
      clientIp: str, // address the run was saved from, as seen by the server
    },
  },
  { timestamps: true }
);
const BenchmarkRun = mongoose.model('BenchmarkRun', runSchema, 'benchmarkRuns');

// Browser diagnostics ("flight recorder"): step-by-step events sent while a model
// loads and runs, so a crash on a phone can be located afterwards. Capped at ~5 MB;
// the oldest events are dropped automatically.
const clientEventSchema = new mongoose.Schema(
  {
    session: str,
    step: str,
    t: num, // ms since the page loaded
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    userAgent: str,
    at: { type: Date, default: Date.now },
  },
  { capped: { size: 5 * 1024 * 1024, max: 20000 }, versionKey: false }
);
const ClientEvent = mongoose.model('ClientEvent', clientEventSchema, 'clientEvents');

// AI judge reviews: an LLM's pros/cons of local vs cloud over a set of recent runs
const judgementSchema = new mongoose.Schema(
  {
    judgeModel: str,
    runIds: [mongoose.Schema.Types.ObjectId],
    newestRunAt: { type: Date, default: null }, // the next review counts runs after this
    trigger: str, // auto | manual
    summary: str,
    verdict: str, // local_better | cloud_better | comparable
    local: { pros: [String], cons: [String] },
    cloud: { pros: [String], cons: [String] },
    perRun: [{ _id: false, run: Number, runId: mongoose.Schema.Types.ObjectId, better: String, reason: String }],
    usage: { inputTokens: num, outputTokens: num },
    error: str,
  },
  { timestamps: true }
);
const Judgement = mongoose.model('Judgement', judgementSchema, 'judgements');

// Same naming rule as the browser's default device name ("iPhone · Safari")
function deviceNameFromUserAgent(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
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

// Runs saved before device names existed get one from their stored user agent
async function backfillDeviceNames() {
  const old = await BenchmarkRun.find({ 'environment.deviceName': { $in: ['', null] } }, { 'environment.userAgent': 1 }).lean();
  if (!old.length) return;
  await BenchmarkRun.bulkWrite(old.map((r) => ({
    updateOne: { filter: { _id: r._id }, update: { $set: { 'environment.deviceName': deviceNameFromUserAgent(r.environment?.userAgent) } } },
  })));
  console.log(`Backfilled device names for ${old.length} older runs`);
}

async function connectWithRetry() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected to MongoDB');
    backfillDeviceNames().catch((err) => console.warn('Device name backfill failed:', err.message));
  } catch (err) {
    console.error('MongoDB connection error:', err.message, '- retrying in 5s');
    setTimeout(connectWithRetry, 5000);
  }
}

// ---------- Helpers ----------

const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toStr = (v, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

// Build a clean run document from the request body (ignores unknown fields)
function runFromBody(b = {}) {
  const l = b.local || {};
  const c = b.cloud || {};
  const i = b.image || {};
  const e = b.environment || {};
  const ref = b.reference || {};
  return {
    label: toStr(b.label, 200).trim(),
    prompt: toStr(b.prompt),
    config: {
      maxNewTokens: toNum(b.config?.maxNewTokens),
      imageSplitting: Boolean(b.config?.imageSplitting),
      sampling: toStr(b.config?.sampling, 50) || 'greedy',
    },
    image: {
      name: toStr(i.name, 500),
      source: toStr(i.source, 50),
      mimeType: toStr(i.mimeType, 100),
      sha256: toStr(i.sha256, 64),
      width: toNum(i.width),
      height: toNum(i.height),
      bytes: toNum(i.bytes),
      resized: Boolean(i.resized),
      originalWidth: toNum(i.originalWidth),
      originalHeight: toNum(i.originalHeight),
      originalBytes: toNum(i.originalBytes),
    },
    local: {
      model: toStr(l.model, 300),
      precision: toStr(l.precision, 50),
      lowMemory: Boolean(l.lowMemory),
      runtime: ['worker', 'main-thread'].includes(l.runtime) ? l.runtime : '',
      dtype: l.dtype && typeof l.dtype === 'object' ? l.dtype : null,
      device: toStr(l.device, 50),
      output: toStr(l.output),
      coldStart: Boolean(l.coldStart),
      preprocessMs: toNum(l.preprocessMs),
      ttftMs: toNum(l.ttftMs),
      totalLatencyMs: toNum(l.totalLatencyMs),
      outputTokens: toNum(l.outputTokens),
      tokensPerSec: toNum(l.tokensPerSec),
      bandwidthBytes: toNum(l.bandwidthBytes) ?? 0,
      networkRequests: toNum(l.networkRequests),
      networkBytes: toNum(l.networkBytes),
      telemetryRequests: toNum(l.telemetryRequests),
      appRequests: toNum(l.appRequests),
      error: toStr(l.error, 2000),
    },
    cloud: {
      provider: toStr(c.provider, 50),
      model: toStr(c.model, 100),
      resolvedModel: toStr(c.resolvedModel, 100),
      detail: toStr(c.detail, 20),
      output: toStr(c.output),
      ttftMs: toNum(c.ttftMs),
      totalLatencyMs: toNum(c.totalLatencyMs),
      roundTripMs: toNum(c.roundTripMs),
      inputTokens: toNum(c.inputTokens),
      outputTokens: toNum(c.outputTokens),
      tokensPerSec: toNum(c.tokensPerSec),
      requestBytes: toNum(c.requestBytes),
      responseBytes: toNum(c.responseBytes),
      networkRequests: toNum(c.networkRequests),
      destination: toStr(c.destination, 200),
      error: toStr(c.error, 2000),
    },
    reference: {
      source: ref.source === 'manual' ? 'manual' : ref.source === 'cloud' ? 'cloud' : '',
      text: toStr(ref.text),
    },
    environment: {
      userAgent: toStr(e.userAgent, 500),
      gpuVendor: toStr(e.gpuVendor, 200),
      gpuArchitecture: toStr(e.gpuArchitecture, 200),
      gpuDescription: toStr(e.gpuDescription, 500),
      gpuFeatures: toStr(e.gpuFeatures, 500),
      deviceName: toStr(e.deviceName, 100).trim(),
    },
  };
}

// Mongo filter from query string: ?label=...
function filterFromQuery(q) {
  const filter = {};
  if (typeof q.label === 'string' && q.label !== '') filter.label = q.label;
  if (typeof q.batchId === 'string' && q.batchId !== '') filter.batchId = q.batchId.slice(0, 64);
  if (typeof q.device === 'string' && q.device !== '') filter['environment.deviceName'] = q.device.slice(0, 100);
  return filter;
}

// Word count: a tokenizer-independent measure of how verbose an output is
const wordCount = (text) => (text && text.trim() ? text.trim().split(/\s+/).length : null);

// Precision label; older runs (before presets existed) fall back to their dtype values
const precisionOf = (run) =>
  run.local?.precision || (run.local?.dtype ? Object.values(run.local.dtype).join('/') : '');

const referenceName = (run) =>
  run.reference?.source === 'cloud' ? run.cloud?.model || 'cloud' : 'manual reference';

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function buildStats(runs, includeCold) {
  // Local timing stats: skip failed runs, and cold starts unless asked
  const localRuns = runs.filter(
    (r) => r.local?.model && !r.local.error && r.local.totalLatencyMs != null && (includeCold || !r.local.coldStart)
  );
  // Group by model and precision: different precisions are different setups
  const local = [...groupBy(localRuns, (r) => `${r.local.model}\u0000${precisionOf(r)}`)].map(([key, rs]) => ({
    model: key.split('\u0000')[0],
    precision: key.split('\u0000')[1],
    runs: rs.length,
    ttftMs: summarize(rs.map((r) => r.local.ttftMs)),
    totalLatencyMs: summarize(rs.map((r) => r.local.totalLatencyMs)),
    preprocessMs: summarize(rs.map((r) => r.local.preprocessMs)),
    tokensPerSec: summarize(rs.map((r) => r.local.tokensPerSec)),
    outputTokens: summarize(rs.map((r) => r.local.outputTokens)),
    outputWords: summarize(rs.map((r) => wordCount(r.local.output))),
    bandwidthBytes: summarize(rs.map((r) => r.local.bandwidthBytes ?? 0)),
    networkRequests: summarize(rs.map((r) => r.local.networkRequests)),
    networkBytes: summarize(rs.map((r) => r.local.networkBytes)),
    measuredRuns: rs.filter((r) => isNumber(r.local.networkRequests)).length,
  }));

  const cloudRuns = runs.filter((r) => r.cloud?.model && !r.cloud.error && r.cloud.totalLatencyMs != null);
  const cloud = [...groupBy(cloudRuns, (r) => r.cloud.model)].map(([model, rs]) => ({
    model,
    runs: rs.length,
    ttftMs: summarize(rs.map((r) => r.cloud.ttftMs)),
    totalLatencyMs: summarize(rs.map((r) => r.cloud.totalLatencyMs)),
    roundTripMs: summarize(rs.map((r) => r.cloud.roundTripMs)),
    tokensPerSec: summarize(rs.map((r) => r.cloud.tokensPerSec)),
    outputTokens: summarize(rs.map((r) => r.cloud.outputTokens)),
    outputWords: summarize(rs.map((r) => wordCount(r.cloud.output))),
    bandwidthBytes: summarize(rs.map((r) => r.cloud.requestBytes)),
    responseBytes: summarize(rs.map((r) => r.cloud.responseBytes)),
    networkRequests: summarize(rs.map((r) => r.cloud.networkRequests ?? 1)),
    destinations: [...new Set(rs.map((r) => r.cloud.destination).filter(Boolean))],
  }));

  // Quality: local output vs. reference, grouped by local model + reference type
  const scored = runs.filter((r) => r.local?.output && r.reference?.text);
  const quality = [...groupBy(scored, (r) => `${r.local.model}\u0000${precisionOf(r)}\u0000${referenceName(r)}`)].map(([key, rs]) => {
    const [model, precision, reference] = key.split('\u0000');
    return {
      model,
      precision,
      reference,
      runs: rs.length,
      bleu4: summarize(rs.map((r) => r.scores?.bleu4)),
      chrf: summarize(rs.map((r) => r.scores?.chrf)),
      corpus: scoreCorpus(rs.map((r) => [r.local.output, r.reference.text])),
    };
  });

  // Dataset mode: local and cloud vs the human captions, grouped by local model + precision + cloud model
  const datasetRuns = runs.filter((r) => r.dataset?.references?.length && r.local?.output && !r.local.error);
  const human = [...groupBy(datasetRuns, (r) => `${r.local.model}\u0000${precisionOf(r)}\u0000${r.cloud?.model || ''}`)].map(([key, rs]) => {
    const [model, precision, cloudModel] = key.split('\u0000');
    // Compare on the same images: only runs where the cloud also produced an output
    const paired = rs.filter((r) => r.cloud?.output && !r.cloud.error);
    const localCorpus = scoreCorpus((cloudModel ? paired : rs).map((r) => [r.local.output, r.dataset.references]));
    const cloudCorpus = cloudModel ? scoreCorpus(paired.map((r) => [r.cloud.output, r.dataset.references])) : { bleu4: null, chrf: null };
    const pct = (a, b) => (a != null && b ? Math.round((a / b) * 1000) / 10 : null);
    return {
      model,
      precision,
      cloudModel: cloudModel || null,
      runs: rs.length,
      pairedRuns: paired.length,
      local: {
        corpus: localCorpus,
        bleu4: summarize(rs.map((r) => r.humanScores?.local?.bleu4)),
        chrf: summarize(rs.map((r) => r.humanScores?.local?.chrf)),
      },
      cloud: {
        corpus: cloudCorpus,
        bleu4: summarize(paired.map((r) => r.humanScores?.cloud?.bleu4)),
        chrf: summarize(paired.map((r) => r.humanScores?.cloud?.chrf)),
      },
      // Local corpus score as a percentage of the cloud's, on the same images
      relative: { bleu4: pct(localCorpus.bleu4, cloudCorpus.bleu4), chrf: pct(localCorpus.chrf, cloudCorpus.chrf) },
      localVsCloud: cloudModel ? scoreCorpus(paired.map((r) => [r.local.output, r.cloud.output])) : { bleu4: null, chrf: null },
    };
  });

  return {
    totalRuns: runs.length,
    coldStartsExcluded: includeCold ? 0 : runs.filter((r) => r.local?.coldStart).length,
    local,
    cloud,
    quality,
    human,
  };
}

const CSV_COLUMNS = [
  ['id', (r) => r._id],
  ['created_at', (r) => r.createdAt?.toISOString()],
  ['label', (r) => r.label],
  ['prompt', (r) => r.prompt],
  ['max_new_tokens', (r) => r.config?.maxNewTokens],
  ['image_splitting', (r) => r.config?.imageSplitting],
  ['sampling', (r) => r.config?.sampling],
  ['image_name', (r) => r.image?.name],
  ['image_source', (r) => r.image?.source],
  ['image_sha256', (r) => r.image?.sha256],
  ['image_width', (r) => r.image?.width],
  ['image_height', (r) => r.image?.height],
  ['image_bytes', (r) => r.image?.bytes],
  ['image_resized', (r) => r.image?.resized],
  ['image_original_width', (r) => r.image?.originalWidth],
  ['image_original_height', (r) => r.image?.originalHeight],
  ['image_original_bytes', (r) => r.image?.originalBytes],
  ['local_model', (r) => r.local?.model],
  ['local_precision', (r) => precisionOf(r)],
  ['local_dtype', (r) => (r.local?.dtype ? JSON.stringify(r.local.dtype) : '')],
  ['local_device', (r) => r.local?.device],
  ['local_low_memory', (r) => r.local?.lowMemory],
  ['local_runtime', (r) => r.local?.runtime],
  ['local_cold_start', (r) => r.local?.coldStart],
  ['local_preprocess_ms', (r) => r.local?.preprocessMs],
  ['local_ttft_ms', (r) => r.local?.ttftMs],
  ['local_total_latency_ms', (r) => r.local?.totalLatencyMs],
  ['local_output_tokens', (r) => r.local?.outputTokens],
  ['local_tokens_per_sec', (r) => r.local?.tokensPerSec],
  ['local_bandwidth_bytes', (r) => r.local?.bandwidthBytes],
  ['local_network_requests', (r) => r.local?.networkRequests],
  ['local_network_bytes', (r) => r.local?.networkBytes],
  ['local_telemetry_requests', (r) => r.local?.telemetryRequests],
  ['local_app_requests', (r) => r.local?.appRequests],
  ['local_output_words', (r) => wordCount(r.local?.output)],
  ['local_output', (r) => r.local?.output],
  ['local_error', (r) => r.local?.error],
  ['cloud_provider', (r) => r.cloud?.provider],
  ['cloud_model', (r) => r.cloud?.model],
  ['cloud_resolved_model', (r) => r.cloud?.resolvedModel],
  ['cloud_detail', (r) => r.cloud?.detail],
  ['cloud_ttft_ms', (r) => r.cloud?.ttftMs],
  ['cloud_total_latency_ms', (r) => r.cloud?.totalLatencyMs],
  ['cloud_round_trip_ms', (r) => r.cloud?.roundTripMs],
  ['cloud_input_tokens', (r) => r.cloud?.inputTokens],
  ['cloud_output_tokens', (r) => r.cloud?.outputTokens],
  ['cloud_tokens_per_sec', (r) => r.cloud?.tokensPerSec],
  ['cloud_request_bytes', (r) => r.cloud?.requestBytes],
  ['cloud_response_bytes', (r) => r.cloud?.responseBytes],
  ['cloud_network_requests', (r) => r.cloud?.networkRequests],
  ['cloud_destination', (r) => r.cloud?.destination],
  ['cloud_output_words', (r) => wordCount(r.cloud?.output)],
  ['cloud_output', (r) => r.cloud?.output],
  ['cloud_error', (r) => r.cloud?.error],
  ['reference_source', (r) => r.reference?.source],
  ['reference_text', (r) => r.reference?.text],
  ['bleu4', (r) => r.scores?.bleu4],
  ['chrf', (r) => r.scores?.chrf],
  ['dataset_name', (r) => r.dataset?.name],
  ['dataset_split', (r) => r.dataset?.split],
  ['dataset_image_id', (r) => r.dataset?.imageId],
  ['dataset_file', (r) => r.dataset?.fileName],
  ['batch_id', (r) => r.batchId],
  ['human_ref_count', (r) => r.dataset?.references?.length],
  ['local_vs_human_bleu4', (r) => r.humanScores?.local?.bleu4],
  ['local_vs_human_chrf', (r) => r.humanScores?.local?.chrf],
  ['cloud_vs_human_bleu4', (r) => r.humanScores?.cloud?.bleu4],
  ['cloud_vs_human_chrf', (r) => r.humanScores?.cloud?.chrf],
  ['gpu_vendor', (r) => r.environment?.gpuVendor],
  ['gpu_architecture', (r) => r.environment?.gpuArchitecture],
  ['gpu_description', (r) => r.environment?.gpuDescription],
  ['gpu_features', (r) => r.environment?.gpuFeatures],
  ['user_agent', (r) => r.environment?.userAgent],
  ['device_name', (r) => r.environment?.deviceName],
  ['client_ip', (r) => r.environment?.clientIp],
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Wrap async route handlers so errors reach the error middleware
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Routes ----------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    openaiConfigured: isConfigured(),
  });
});

app.get('/api/cloud/models', (req, res) => {
  res.json({ models: CLOUD_MODELS, configured: isConfigured() });
});

// Get a cloud baseline description for one image
app.post('/api/cloud/describe', wrap(async (req, res) => {
  const { image, prompt, model, maxTokens, detail } = req.body || {};
  if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) {
    return res.status(400).json({ message: 'image must be a base64 PNG, JPEG, WEBP or GIF data URL' });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ message: 'prompt is required' });
  }
  if (!CLOUD_MODELS.includes(model)) {
    return res.status(400).json({ message: `model must be one of: ${CLOUD_MODELS.join(', ')}` });
  }
  const tokens = Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 1024 ? maxTokens : 128;
  const imageDetail = ['low', 'high', 'auto'].includes(detail) ? detail : 'auto';
  const result = await describeImage({ imageDataUrl: image, prompt, model, maxTokens: tokens, detail: imageDetail });
  res.json(result);
}));

// Score a hypothesis against a reference (BLEU-4 and chrF, 0-100)
app.post('/api/score', (req, res) => {
  const { hypothesis, reference } = req.body || {};
  res.json(scorePair(toStr(hypothesis), toStr(reference)));
});

// Save a benchmark run (scores are computed here so they are always consistent)
// Client IP as seen through nginx, without the IPv4-mapped IPv6 prefix
const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/, '');

app.post('/api/runs', wrap(async (req, res) => {
  const data = runFromBody(req.body);
  data.environment.clientIp = clientIp(req);
  if (!data.environment.deviceName) data.environment.deviceName = data.environment.clientIp || 'unknown device';
  data.scores = scorePair(data.local.output, data.reference.text);
  data.batchId = toStr(req.body?.batchId, 64); // dataset batches and multi-image upload batches

  // Dataset mode: look up the human captions here (never trust captions sent by the client)
  const imageId = toNum(req.body?.dataset?.imageId);
  if (imageId !== null) {
    const entry = await vizwiz.getImageEntry(imageId);
    if (!entry) return res.status(400).json({ message: `VizWiz image ${imageId} not found` });
    data.dataset = { name: vizwiz.INFO.name, split: vizwiz.INFO.split, imageId, fileName: entry.fileName, references: entry.captions };
    data.humanScores = {
      local: data.local.error ? { bleu4: null, chrf: null } : scorePair(data.local.output, entry.captions),
      cloud: data.cloud.error ? { bleu4: null, chrf: null } : scorePair(data.cloud.output, entry.captions),
    };
  }
  const run = await BenchmarkRun.create(data);

  // Keep a copy of the test image for reports (dataset runs reuse the dataset image cache)
  if (!run.dataset?.fileName && typeof req.body?.imageData === 'string') {
    try {
      run.image.storedFile = await images.saveRunImage(String(run._id), req.body.imageData);
      await run.save();
    } catch (err) {
      console.warn(`Run ${run._id}: image not stored (${err.message})`);
    }
  }
  res.status(201).json(run);
  maybeJudge(); // review the latest runs once enough new ones have been saved
}));

// The test image of a run
app.get('/api/runs/:id/image', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
  const run = await BenchmarkRun.findById(req.params.id).lean();
  if (!run) return res.status(404).json({ message: 'Run not found' });
  const file = await images.runImagePath(run);
  if (!file) return res.status(404).json({ message: 'No image stored for this run' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
}));

app.get('/api/runs', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
  // ?sort=device groups runs by device (newest first within each); ?order=asc is oldest first
  const sort = req.query.sort === 'device'
    ? { 'environment.deviceName': 1, createdAt: -1 }
    : { createdAt: req.query.order === 'asc' ? 1 : -1 };
  const runs = await BenchmarkRun.find(filterFromQuery(req.query)).sort(sort).limit(limit).lean();
  res.json(runs);
}));

app.get('/api/runs/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
  const run = await BenchmarkRun.findById(req.params.id).lean();
  if (!run) return res.status(404).json({ message: 'Run not found' });
  res.json(run);
}));

// Replace the reference text of a saved run (e.g. a human-written caption) and rescore
app.patch('/api/runs/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
  const run = await BenchmarkRun.findById(req.params.id);
  if (!run) return res.status(404).json({ message: 'Run not found' });
  if (typeof req.body?.referenceText !== 'string') {
    return res.status(400).json({ message: 'referenceText is required' });
  }
  if (typeof req.body.label === 'string') run.label = req.body.label.trim().slice(0, 200);
  run.reference = { source: 'manual', text: toStr(req.body.referenceText) };
  run.scores = scorePair(run.local.output, run.reference.text);
  await run.save();
  res.json(run);
}));

app.delete('/api/runs/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
  const run = await BenchmarkRun.findById(req.params.id).lean();
  if (!run) return res.status(404).json({ message: 'Run not found' });
  await BenchmarkRun.deleteOne({ _id: req.params.id });
  await images.deleteRunImage(run);
  res.status(204).end();
}));

// Bulk delete. The body picks one scope:
//   { ids: [...] }                         the selected runs
//   { label?, device? } (at least one)     every run matching the Results filter
//   { everything: true, confirm: 'DELETE' } all runs, AI judge reviews and diagnostics
// The VizWiz dataset cache is kept (it's downloaded data, not results).
app.post('/api/runs/delete', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.everything === true) {
    if (body.confirm !== 'DELETE') return res.status(400).json({ message: 'Type DELETE to confirm clearing everything' });
    const runs = await BenchmarkRun.deleteMany({});
    const judgements = await Judgement.deleteMany({});
    // Capped collections don't allow deletes, so drop and recreate it
    await ClientEvent.collection.drop().catch(() => {});
    await ClientEvent.createCollection();
    await images.deleteAllRunImages();
    console.log(`Cleared database: ${runs.deletedCount} runs, ${judgements.deletedCount} AI judge reviews, diagnostics`);
    return res.json({ deletedRuns: runs.deletedCount, deletedJudgements: judgements.deletedCount });
  }

  let filter;
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((id) => mongoose.isValidObjectId(id)).slice(0, 1000);
    if (ids.length === 0) return res.status(400).json({ message: 'No valid run ids' });
    filter = { _id: { $in: ids } };
  } else {
    filter = filterFromQuery({ label: body.label, device: body.device });
    if (Object.keys(filter).length === 0) {
      return res.status(400).json({ message: 'Pick a label or device, or use everything: true' });
    }
  }
  const runs = await BenchmarkRun.find(filter, { image: 1 }).lean();
  const result = await BenchmarkRun.deleteMany({ _id: { $in: runs.map((r) => r._id) } });
  await Promise.all(runs.map((r) => images.deleteRunImage(r)));
  console.log(`Deleted ${result.deletedCount} run(s)`);
  res.json({ deletedRuns: result.deletedCount });
}));

app.get('/api/devices', wrap(async (req, res) => {
  const devices = await BenchmarkRun.distinct('environment.deviceName');
  res.json(devices.filter(Boolean).sort());
}));

app.get('/api/labels', wrap(async (req, res) => {
  const labels = await BenchmarkRun.distinct('label');
  res.json(labels.filter(Boolean).sort());
}));

// Aggregate stats. ?label=...&includeCold=true
app.get('/api/stats', wrap(async (req, res) => {
  const runs = await BenchmarkRun.find(filterFromQuery(req.query)).lean();
  res.json(buildStats(runs, req.query.includeCold === 'true'));
}));

// Export all runs. ?format=csv|json&label=...
app.get('/api/export', wrap(async (req, res) => {
  const filter = filterFromQuery(req.query);
  const runs = await BenchmarkRun.find(filter).sort({ createdAt: 1 }).lean();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = filter.label ? `-${filter.label.replace(/[^\w-]+/g, '_')}` : '';

  if (req.query.format === 'csv') {
    const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
    for (const run of runs) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(run))).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="benchmark-runs${suffix}-${stamp}.csv"`);
    return res.send(lines.join('\r\n'));
  }

  res.setHeader('Content-Disposition', `attachment; filename="benchmark-runs${suffix}-${stamp}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    filter,
    metricNotes: {
      bleu4: 'sacreBLEU-compatible sentence BLEU (13a tokenizer, exp smoothing, effective order), 0-100',
      chrf: 'sacreBLEU-compatible chrF (char 6-grams, beta=2), 0-100',
      corpusScores: 'Corpus scores in stats sum n-gram statistics across runs (sacreBLEU corpus_bleu / corpus_chrf)',
      tokensPerSec: '(output tokens - 1) / time from first token to last token',
      localTiming: 'Measured in the browser, inside the Web Worker that runs the model (local_runtime = worker) or on the page as a fallback (main-thread); ttft and total latency include image preprocessing',
      cloudTiming: 'ttft/total measured on the backend (OpenAI API time); roundTripMs measured in the browser',
      bandwidth: 'local = 0 (on-device); cloud = size of the JSON request sent to OpenAI',
      networkRequests: 'local_network_requests = requests the browser made while the local model ran, measured with the Resource Timing API (requests to this app\'s own backend are counted separately: crash-log posts as local_telemetry_requests, and next-image prefetches / live rescoring as local_app_requests; runs saved before local_app_requests existed may include those in local_network_requests); cloud_network_requests = outbound requests to the provider per description (cloud_destination); cloud_response_bytes = streamed response size, uncompressed',
      outputWords: 'whitespace-separated word count of the output (tokenizer-independent verbosity)',
      precision: 'fast = 4-bit weights with fp16 math (needs WebGPU shader-f16); balanced = 4-bit weights, fp16 embeddings, fp32 math; compatible = 4-bit weights with fp32 math; cpu = compatible files on the WebAssembly CPU backend (no GPU). Local stats are grouped by model + precision',
      lowMemory: 'true when onnxruntime CPU memory pools were disabled (enableCpuMemArena/enableMemPattern = false), used on phones',
      humanScores: 'Dataset mode: local and cloud outputs scored against all usable VizWiz human captions (multi-reference sacreBLEU: max n-gram clipping, closest reference length; chrF uses the best reference). Pre-canned and rejected captions are excluded, as in the official VizWiz evaluation',
      bleu4AndChrfInDatasetMode: 'bleu4/chrf (no prefix) compare the local output to the cloud output (cloud as the baseline)',
      relative: 'stats.human[].relative = local corpus score / cloud corpus score x 100, on the images where both produced output',
      dataset: `${vizwiz.INFO.citation} ${vizwiz.INFO.license}. ${vizwiz.INFO.source}`,
      promptParity: 'Both models receive the same user message (image, then prompt text), no system prompt, same max tokens, greedy/temperature 0',
    },
    stats: buildStats(runs, false),
    runs,
  });
}));

// ---------- AI judge ----------
const JUDGE_EVERY = 10;
// Runs the judge can compare: both models produced a description
const JUDGEABLE = {
  'local.output': { $nin: ['', null] },
  'local.error': { $in: ['', null] },
  'cloud.output': { $nin: ['', null] },
  'cloud.error': { $in: ['', null] },
};
let judging = null;

async function judgeableSinceLastReview() {
  const last = await Judgement.findOne({ error: { $in: ['', null] } }).sort({ createdAt: -1 }).lean();
  const filter = { ...JUDGEABLE };
  if (last?.newestRunAt) filter.createdAt = { $gt: last.newestRunAt };
  return BenchmarkRun.countDocuments(filter);
}

// Reviews the latest 10 judgeable runs. Only one review runs at a time.
function runJudgement(trigger) {
  if (judging) return judging;
  judging = (async () => {
    const runs = (await BenchmarkRun.find(JUDGEABLE).sort({ createdAt: -1 }).limit(JUDGE_EVERY).lean()).reverse();
    if (runs.length < 3) throw Object.assign(new Error('Need at least 3 runs with both a local and a cloud description'), { status: 400 });
    const base = { judgeModel: JUDGE_MODEL, runIds: runs.map((r) => r._id), newestRunAt: runs[runs.length - 1].createdAt, trigger };
    try {
      const { result, usage, model } = await judgeRuns(runs, images.runImageDataUrl);
      result.perRun = result.perRun.map((p) => ({ ...p, runId: runs[p.run - 1]?._id ?? null }));
      const saved = await Judgement.create({ ...base, judgeModel: model, ...result, usage });
      console.log(`AI judge (${trigger}): ${result.verdict} over ${runs.length} runs`);
      return saved;
    } catch (err) {
      console.error('AI judge failed:', err.message);
      await Judgement.create({ ...base, error: String(err.message).slice(0, 500) });
      throw err;
    }
  })().finally(() => {
    judging = null;
  });
  return judging;
}

async function maybeJudge() {
  try {
    if (!isConfigured() || judging) return;
    if ((await judgeableSinceLastReview()) >= JUDGE_EVERY) await runJudgement('auto');
  } catch {
    // logged in runJudgement; a run save never fails because of the judge
  }
}

app.get('/api/judgements', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
  const list = await Judgement.find().sort({ createdAt: -1 }).limit(limit).lean();
  const sinceLast = await judgeableSinceLastReview();
  res.json({
    judgeModel: JUDGE_MODEL,
    every: JUDGE_EVERY,
    configured: isConfigured(),
    inProgress: Boolean(judging),
    nextInRuns: Math.max(JUDGE_EVERY - sinceLast, 0),
    judgements: list,
  });
}));

// Review the latest runs now (the automatic review still happens every 10 new runs)
app.post('/api/judgements', wrap(async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'OPENAI_API_KEY is not set' });
  try {
    res.status(201).json(await runJudgement('manual'));
  } catch (err) {
    res.status(err.status || 502).json({ message: err.message });
  }
}));

// ---------- VizWiz-Captions dataset ----------

app.get('/api/vizwiz/status', wrap(async (req, res) => {
  res.json(await vizwiz.status());
}));

// Random sample. ?n=20&seed=123&skipTestedModel=<id>&skipTestedPrecision=<preset>
app.get('/api/vizwiz/sample', wrap(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 20, 1), 200);
  const seedParam = String(req.query.seed ?? '').trim();
  const seed = /^\d{1,10}$/.test(seedParam) && Number(seedParam) <= 0xffffffff
    ? Number(seedParam)
    : Math.floor(Math.random() * 0xffffffff);

  // Optionally skip images this local model (+ precision) was already tested on
  let exclude = new Set();
  const model = typeof req.query.skipTestedModel === 'string' ? req.query.skipTestedModel : '';
  if (model) {
    const filter = { 'local.model': model, 'dataset.imageId': { $ne: null } };
    if (typeof req.query.skipTestedPrecision === 'string' && req.query.skipTestedPrecision) {
      filter['local.precision'] = req.query.skipTestedPrecision;
    }
    exclude = new Set(await BenchmarkRun.distinct('dataset.imageId', filter));
  }
  const result = await vizwiz.sample(n, seed, exclude);
  res.json({ seed, skipped: exclude.size, ...result });
}));

app.get('/api/vizwiz/images/:file', wrap(async (req, res) => {
  try {
    const file = await vizwiz.imagePath(req.params.file);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/jpeg').sendFile(file);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}));

// ---------- Browser diagnostics ----------

// Keep event data small: anything over 4 KB is stored as a truncated string
function smallData(data) {
  if (data === undefined || data === null) return null;
  let json;
  try {
    json = JSON.stringify(data);
  } catch {
    return { unserializable: true };
  }
  return json.length <= 4000 ? JSON.parse(json) : { truncated: json.slice(0, 4000) };
}

app.post('/api/diagnostics', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.session !== 'string' || typeof b.step !== 'string' || !b.session || !b.step) {
    return res.status(400).json({ message: 'session and step are required' });
  }
  const event = {
    session: b.session.slice(0, 64),
    step: b.step.slice(0, 100),
    t: toNum(b.t),
    data: smallData(b.data),
    userAgent: toStr(req.get('User-Agent'), 300),
  };
  // One line per event so `docker compose logs backend` shows the timeline
  console.log(`[client ${event.session}] +${Math.round(event.t ?? 0)}ms ${event.step} ${event.data ? JSON.stringify(event.data).slice(0, 500) : ''}`);
  await ClientEvent.create(event);
  res.status(204).end();
}));

// Recent diagnostics events. ?session=...&limit=...
app.get('/api/diagnostics', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
  const filter = typeof req.query.session === 'string' && req.query.session ? { session: req.query.session } : {};
  const events = await ClientEvent.find(filter).sort({ $natural: -1 }).limit(limit).lean();
  res.json(events.reverse());
}));

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ message: err.message || 'Something went wrong' });
});

const PORT = process.env.PORT || 1616;
connectWithRetry();
app.listen(PORT, () => {
  console.log(`Benchmark API running on port ${PORT} (OpenAI ${isConfigured() ? 'configured' : 'NOT configured'})`);
});
