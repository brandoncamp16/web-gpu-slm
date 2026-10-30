// VizWiz-Captions dataset (validation split): human captions for images taken by
// people who are blind. Gurari et al., "Captioning Images Taken by People Who Are
// Blind", ECCV 2020. Licensed CC BY 4.0. https://vizwiz.org/tasks-and-datasets/image-captioning/
//
// The annotations (4.5 MB zip) are downloaded on first use. Images are downloaded one at
// a time when first requested and cached on disk, so the 3.5 GB image archive is never needed.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VIZWIZ_DIR = path.join(DATA_DIR, 'vizwiz');
const ANNOTATIONS_FILE = path.join(VIZWIZ_DIR, 'val.json');
const IMAGE_DIR = path.join(VIZWIZ_DIR, 'images-val');

const ANNOTATIONS_URL = 'https://vizwiz.cs.colorado.edu/VizWiz_final/caption/annotations.zip';
// The vizwiz_url host inside the annotations no longer responds; this host serves the same files
const IMAGE_BASE_URL = 'https://vizwiz.cs.colorado.edu/VizWiz_visualization_img/';
const FILE_NAME_PATTERN = /^VizWiz_val_\d{8}\.jpg$/;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Images need at least this many real captions (pre-canned and rejected/spam captions
// are excluded, as in the official VizWiz evaluation)
const MIN_CAPTIONS = 3;

const INFO = {
  name: 'vizwiz-captions',
  split: 'val',
  license: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
  citation: 'D. Gurari, Y. Zhao, M. Zhang, N. Bhattacharya. "Captioning Images Taken by People Who Are Blind." ECCV 2020.',
  source: 'https://vizwiz.org/tasks-and-datasets/image-captioning/',
};

let dataset = null; // { byId: Map, byFile: Map, pool: entry[], totalImages }
let loading = null;

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function downloadAnnotations() {
  const res = await fetch(ANNOTATIONS_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Annotations download failed (HTTP ${res.status})`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('val.json'));
  if (!entry) throw new Error('val.json not found in the annotations zip');
  await fsp.mkdir(VIZWIZ_DIR, { recursive: true });
  await writeAtomic(ANNOTATIONS_FILE, entry.getData());
}

function buildDataset(json) {
  const byId = new Map();
  for (const img of json.images) {
    byId.set(img.id, { imageId: img.id, fileName: img.file_name, textDetected: Boolean(img.text_detected), captions: [] });
  }
  for (const a of json.annotations) {
    const entry = byId.get(a.image_id);
    if (!entry || a.is_precanned || a.is_rejected) continue;
    const caption = String(a.caption || '').replace(/\r/g, '').trim();
    if (caption) entry.captions.push(caption);
  }
  const byFile = new Map([...byId.values()].map((e) => [e.fileName, e]));
  const pool = [...byId.values()].filter((e) => e.captions.length >= MIN_CAPTIONS).sort((a, b) => a.imageId - b.imageId);
  return { byId, byFile, pool, totalImages: byId.size };
}

// Loads the annotations, downloading them the first time. Safe to call concurrently.
async function ensureDataset() {
  if (dataset) return dataset;
  if (!loading) {
    loading = (async () => {
      if (!fs.existsSync(ANNOTATIONS_FILE)) {
        console.log('VizWiz: downloading annotations...');
        await downloadAnnotations();
      }
      dataset = buildDataset(JSON.parse(await fsp.readFile(ANNOTATIONS_FILE, 'utf8')));
      console.log(`VizWiz: ${dataset.totalImages} validation images, ${dataset.pool.length} with >= ${MIN_CAPTIONS} captions`);
      return dataset;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

async function cachedImageCount() {
  try {
    return (await fsp.readdir(IMAGE_DIR)).filter((f) => f.endsWith('.jpg')).length;
  } catch {
    return 0;
  }
}

async function status() {
  try {
    const d = await ensureDataset();
    return { ready: true, ...INFO, images: d.totalImages, usableImages: d.pool.length, minCaptions: MIN_CAPTIONS, cachedImages: await cachedImageCount() };
  } catch (err) {
    return { ready: false, ...INFO, error: err.message };
  }
}

// Small seeded random generator so a sample can be reproduced from its seed
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n random images from the usable pool, skipping excludeIds. Same seed + exclusions = same sample.
async function sample(n, seed, excludeIds = new Set()) {
  const d = await ensureDataset();
  const candidates = d.pool.filter((e) => !excludeIds.has(e.imageId));
  const random = mulberry32(seed);
  const count = Math.min(n, candidates.length);
  // Partial Fisher-Yates shuffle: only the first `count` positions are needed
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return {
    available: candidates.length,
    items: candidates.slice(0, count).map((e) => ({
      imageId: e.imageId,
      fileName: e.fileName,
      imageUrl: `/api/vizwiz/images/${e.fileName}`,
      captions: [...e.captions],
    })),
  };
}

// The usable captions for an image, or null if the image isn't in the dataset
async function getImageEntry(imageId) {
  const d = await ensureDataset();
  const entry = d.byId.get(imageId);
  return entry ? { ...entry, captions: [...entry.captions] } : null;
}

const inflight = new Map();

// Path to the cached image file, downloading it first if needed.
// Throws { status: 400 } for invalid names and { status: 404 } for unknown images.
async function imagePath(fileName) {
  if (!FILE_NAME_PATTERN.test(fileName)) {
    throw Object.assign(new Error('Invalid image name'), { status: 400 });
  }
  const d = await ensureDataset();
  if (!d.byFile.has(fileName)) throw Object.assign(new Error('Image not in the VizWiz validation set'), { status: 404 });

  const file = path.join(IMAGE_DIR, fileName);
  if (fs.existsSync(file)) return file;
  if (!inflight.has(fileName)) {
    inflight.set(fileName, (async () => {
      const res = await fetch(IMAGE_BASE_URL + fileName, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw Object.assign(new Error(`Image download failed (HTTP ${res.status})`), { status: 502 });
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        throw Object.assign(new Error('Downloaded file is not a valid JPEG'), { status: 502 });
      }
      await fsp.mkdir(IMAGE_DIR, { recursive: true });
      await writeAtomic(file, buffer);
      return file;
    })().finally(() => inflight.delete(fileName)));
  }
  return inflight.get(fileName);
}

module.exports = { INFO, MIN_CAPTIONS, ensureDataset, status, sample, getImageEntry, imagePath };
