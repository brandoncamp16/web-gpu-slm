// Test images stored with their runs, so reports (and the AI judge) can show them.
// Uploaded/camera/sample images are saved as files named after the run ID.
// VizWiz dataset runs reuse the dataset image cache instead of storing a copy.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const vizwiz = require('./vizwiz');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RUN_IMAGE_DIR = path.join(DATA_DIR, 'run-images');
const MAX_BYTES = 3 * 1024 * 1024;

// File signatures, so only real images are written to disk
const SIGNATURES = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

// Saves a data URL for a run. Returns the stored file name, or throws { status: 400 }.
async function saveRunImage(runId, dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw Object.assign(new Error('imageData must be a base64 JPEG, PNG or WEBP data URL'), { status: 400 });
  const [, type, b64] = match;
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Stored image too large (max 3 MB)'), { status: 400 });
  if (!SIGNATURES[type](buffer)) throw Object.assign(new Error('imageData is not a valid image'), { status: 400 });
  await fsp.mkdir(RUN_IMAGE_DIR, { recursive: true });
  const fileName = `${runId}.${EXT[type]}`;
  const tmp = path.join(RUN_IMAGE_DIR, `${fileName}.tmp`);
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, path.join(RUN_IMAGE_DIR, fileName));
  return fileName;
}

// Path to a run's image on disk, or null if it has none
async function runImagePath(run) {
  if (run.dataset?.fileName) {
    try {
      return await vizwiz.imagePath(run.dataset.fileName);
    } catch {
      return null;
    }
  }
  const stored = run.image?.storedFile;
  if (!stored || !/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(stored)) return null;
  const file = path.join(RUN_IMAGE_DIR, stored);
  return fs.existsSync(file) ? file : null;
}

async function deleteRunImage(run) {
  const stored = run.image?.storedFile;
  if (!stored || !/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(stored)) return;
  await fsp.unlink(path.join(RUN_IMAGE_DIR, stored)).catch(() => {});
}

// Removes every stored run image (used when the whole database is cleared)
async function deleteAllRunImages() {
  await fsp.rm(RUN_IMAGE_DIR, { recursive: true, force: true });
  await fsp.mkdir(RUN_IMAGE_DIR, { recursive: true });
}

// Data URL of a run's image (for the AI judge), or null
async function runImageDataUrl(run) {
  const file = await runImagePath(run);
  if (!file) return null;
  const ext = path.extname(file).slice(1);
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${(await fsp.readFile(file)).toString('base64')}`;
}

module.exports = { saveRunImage, runImagePath, deleteRunImage, deleteAllRunImages, runImageDataUrl };
