// VizWiz dataset batches: run the loaded model (and the cloud baseline) on a random
// sample of VizWiz-Captions images, scored against each image's human captions.
import { $, isNum, fmtMs, el, statTile } from './common.js';
import { statsFindings } from './findings.js';
import { renderBatchViewer } from './batchview.js';

const fmtPair = (s) => (s && (isNum(s.bleu4) || isNum(s.chrf)) ? `${isNum(s.bleu4) ? s.bleu4.toFixed(1) : '–'} / ${isNum(s.chrf) ? s.chrf.toFixed(1) : '–'}` : '–');
const mean = (xs) => {
  const v = xs.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * ctx: { api, diag, runBenchmark, setImage, setRunning, isModelLoaded, localModel, readRunSettings }
 * (passed in from main.js to avoid circular imports)
 */
export function initBatch(ctx) {
  const sizeInput = $('batch-size');
  const seedInput = $('batch-seed');
  const skipTestedInput = $('batch-skip-tested');
  const costNote = $('batch-cost');
  const statusText = $('dataset-status');
  const panel = $('batch-panel');
  const bar = $('batch-progress-bar');
  const progressText = $('batch-progress-text');
  const stopBtn = $('batch-stop-btn');
  const captionsList = $('human-captions');
  const runningText = $('batch-running');
  const summary = $('batch-summary');
  const viewer = $('batch-viewer');
  const batchLink = $('view-batch-link');
  let lastBatchLabel = '';
  // "View Batch Results" (next to View Run Report) opens Results filtered to the last batch
  batchLink.addEventListener('click', () => sessionStorage.setItem('webgpu-slm:results-label', lastBatchLabel));

  let stopRequested = false;
  let wakeLock = null;
  let running = false;

  const batchSize = () => Math.min(Math.max(parseInt(sizeInput.value, 10) || 1, 1), 200);

  function updateCostNote() {
    const { cloudModel } = ctx.readRunSettings();
    const n = batchSize();
    costNote.textContent = cloudModel
      ? `This batch makes ${n} OpenAI request${n === 1 ? '' : 's'} to ${cloudModel} (one per image).`
      : 'No cloud baseline selected: only the local model is scored against the human captions.';
  }
  sizeInput.addEventListener('input', updateCostNote);

  // With a seed, the sample must be repeatable, so "skip already tested" doesn't apply
  function updateSeedState() {
    const hasSeed = seedInput.value.trim() !== '';
    skipTestedInput.disabled = hasSeed;
    skipTestedInput.closest('label').title = hasSeed ? 'Off while a seed is set: a seed always gives the same images' : '';
    $('batch-seed-note').hidden = !hasSeed;
  }
  seedInput.addEventListener('input', updateSeedState);
  $('cloud-model-select').addEventListener('change', updateCostNote);

  async function showDatasetStatus() {
    updateCostNote();
    updateSeedState();
    statusText.textContent = 'Loading dataset info (the first time downloads the 4.5 MB caption file)...';
    try {
      const s = await ctx.api('/api/vizwiz/status');
      statusText.textContent = s.ready
        ? `${s.usableImages.toLocaleString()} usable images (of ${s.images.toLocaleString()} validation images with at least ${s.minCaptions} human captions) · ${s.cachedImages.toLocaleString()} cached on the server.`
        : `Dataset unavailable: ${s.error}`;
    } catch (err) {
      statusText.textContent = `Dataset unavailable: ${err.message}`;
    }
  }

  // Keep the phone screen on during a batch (Screen Wake Lock API, where supported)
  async function holdWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (running && document.visibilityState === 'visible') holdWakeLock();
  });

  // Uploaded images carry their blob; after a crash they come back from the recovery cache;
  // dataset images are downloaded from the backend
  const fetchImage = (item) => {
    if (item.blob) return Promise.resolve(item.blob);
    if (Number.isInteger(item.uploadIndex)) {
      return ctx.loadUploadImage(item.uploadIndex).then((b) => b || new Error('the uploaded image could not be restored'));
    }
    return fetch(item.imageUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`image download failed (HTTP ${r.status})`);
        return r.blob();
      })
      .catch((err) => err); // resolved as an Error so a failed prefetch never goes unhandled
  };

  // Uploaded images have no human captions: hide that column
  function showCaptions(captions = []) {
    $('batch-captions-col').hidden = captions.length === 0;
    captionsList.replaceChildren(...captions.map((c) => el('li', { text: c })));
  }

  function showImageScores(run) {
    $('img-local-human').textContent = fmtPair(run?.humanScores?.local);
    $('img-cloud-human').textContent = run?.cloud?.model ? fmtPair(run?.humanScores?.cloud) : 'no cloud baseline';
    $('img-local-cloud').textContent = run?.cloud?.model ? fmtPair(run?.scores) : '–';
  }

  async function showSummary({ batchId, label, done, total, failed, stopped }) {
    summary.hidden = false;
    summary.replaceChildren(el('p', { className: 'hint', text: 'Calculating batch results...' }));
    try {
      const stats = await ctx.api(`/api/stats?batchId=${encodeURIComponent(batchId)}&includeCold=true`);
      const h = stats.human[0];
      const localPerf = stats.local[0];
      const cloudPerf = stats.cloud[0];
      const tiles = [statTile('Images Tested', `${done} of ${total}`, [stopped && 'stopped early', failed && `${failed} failed`].filter(Boolean).join(' · ') || 'complete')];
      if (h?.relative?.chrf != null) tiles.push(statTile('Local Reaches (chrF)', `${h.relative.chrf}%`, 'of the cloud score vs human captions', { better: 'higher' }));
      if (h?.relative?.bleu4 != null) tiles.push(statTile('Local Reaches (BLEU-4)', `${h.relative.bleu4}%`, 'of the cloud score vs human captions', { better: 'higher' }));
      if (h) tiles.push(statTile('Local vs Human (Corpus)', fmtPair(h.local.corpus), 'BLEU-4 / chrF', { better: 'higher' }));
      if (h?.cloudModel) tiles.push(statTile('Cloud vs Human (Corpus)', fmtPair(h.cloud.corpus), 'BLEU-4 / chrF', { better: 'higher' }));
      if (localPerf) tiles.push(statTile('Local Median Latency', fmtMs(localPerf.totalLatencyMs.median), `TTFT ${fmtMs(localPerf.ttftMs.median)}`, { better: 'lower' }));
      if (cloudPerf) tiles.push(statTile('Cloud Median Latency', fmtMs(cloudPerf.totalLatencyMs.median), `TTFT ${fmtMs(cloudPerf.ttftMs.median)}`, { better: 'lower' }));

      const findings = statsFindings(stats);
      summary.replaceChildren(
        el('h3', { className: 'subheading', text: `Batch results · label "${label}"` }),
        el('div', { className: 'kpi-row' }, tiles),
        ...(findings.length ? [el('ul', { className: 'findings-list' }, findings.map((f) => el('li', { text: f })))] : []),
      );
      lastBatchLabel = label;
      batchLink.hidden = false;

      // Step through every image of this batch
      const runs = await ctx.api(`/api/runs?batchId=${encodeURIComponent(batchId)}&order=asc&limit=200`);
      if (runs.length) {
        $('batch-live').hidden = true; // the viewer below shows every image, including the last
        viewer.hidden = false;
        renderBatchViewer(viewer, runs, { title: 'Review each image', index: runs.length - 1 });
      }
    } catch (err) {
      summary.replaceChildren(el('p', { className: 'hint', text: `Could not load batch results: ${err.message}` }));
    }
  }

  // options.uploads: [{ blob, name, source, original }] runs uploaded images instead of a dataset sample
  // options.resume: { kind, batchId, label, seed, items, nextIndex } to continue a batch after a crash
  async function start(options = {}) {
    if (running || !ctx.isModelLoaded()) return;
    const resume = options.resume || null;
    const kind = resume?.kind || (options.uploads ? 'upload' : 'dataset');
    const settings = resume ? options.settings : ctx.readRunSettings();
    const model = ctx.localModel();
    const n = resume ? resume.items.length : options.uploads ? options.uploads.length : batchSize();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const label = resume ? resume.label : settings.label || `${kind === 'upload' ? 'upload' : 'vizwiz'}-${stamp}-n${n}`;

    running = true;
    stopRequested = false;
    ctx.setRunning(true);
    ctx.diag.setBusy(true);
    panel.hidden = false;
    summary.hidden = true;
    viewer.hidden = true;
    batchLink.hidden = true;
    $('batch-live').hidden = false;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    bar.value = 0;
    progressText.textContent = kind === 'upload' ? 'Starting...' : 'Picking random images...';
    showCaptions([]);
    await holdWakeLock();

    let done = 0;
    let failed = 0;
    let total = 0;
    const batchId = resume?.batchId ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const localHuman = { bleu4: [], chrf: [] };
    const cloudHuman = { bleu4: [], chrf: [] };

    try {
      let sample;
      let startIndex = 0;
      if (resume) {
        sample = { seed: resume.seed, items: resume.items };
        startIndex = resume.nextIndex || 0;
      } else if (kind === 'upload') {
        sample = { seed: null, items: options.uploads.map((u) => ({ blob: u.blob, fileName: u.name, source: u.source, original: u.original || null })) };
        // Phones: keep the images so the batch can resume after a crash
        await ctx.saveUploadImages?.(options.uploads.map((u) => u.blob));
      } else {
        const params = new URLSearchParams({ n: String(n) });
        const seed = seedInput.value.trim();
        if (seed) params.set('seed', seed);
        // An explicit seed always means the same images, so skipping only applies to random samples
        if (!seed && skipTestedInput.checked && model) {
          params.set('skipTestedModel', model.id);
          params.set('skipTestedPrecision', model.precision);
        }
        sample = await ctx.api(`/api/vizwiz/sample?${params}`);
        seedInput.placeholder = `Random (last: ${sample.seed})`;
      }
      total = sample.items.length;
      if (!total) {
        progressText.textContent = 'No untested images left for this model (turn off "Skip images already tested").';
        return;
      }
      ctx.diag.step(resume ? 'batch-resume' : 'batch-start', { kind, n: total, seed: sample.seed, from: startIndex + 1, cloud: settings.cloudModel || 'none', label });
      // Saved for crash recovery: uploaded images are referenced by index (their blobs are cached separately)
      const storedItems = sample.items.map(({ blob, ...rest }, i) => (kind === 'upload' ? { ...rest, uploadIndex: i } : rest));
      ctx.onBatchStart?.({ kind, batchId, label, seed: sample.seed, items: storedItems, nextIndex: startIndex, total, settings });
      bar.max = total;
      bar.value = startIndex;
      done = startIndex; // images finished before a crash count as done

      let next = startIndex < total ? fetchImage(sample.items[startIndex]) : null;
      for (let i = startIndex; i < total; i++) {
        if (stopRequested) break;
        const item = sample.items[i];
        const blob = await next;
        next = i + 1 < total ? fetchImage(sample.items[i + 1]) : null; // prefetch while this one runs
        progressText.textContent = `Image ${i + 1} of ${total} · ${item.fileName}${sample.seed != null ? ` · seed ${sample.seed}` : ''}`;
        showCaptions(item.captions);
        showImageScores(null);
        try {
          if (blob instanceof Error) throw blob;
          ctx.setImage({ blob, name: item.fileName, source: item.source || 'vizwiz', original: item.original || null });
          ctx.diag.step('batch-item', { index: i + 1, of: total, imageId: item.imageId });
          ctx.log?.(`Image ${i + 1} of ${total}: ${item.fileName}`);
          const run = await ctx.runBenchmark({
            promptText: settings.promptText,
            cloudModel: settings.cloudModel,
            label,
            dataset: kind === 'dataset' ? { imageId: item.imageId } : null,
            batchId,
          });
          showImageScores(run);
          localHuman.bleu4.push(run.humanScores?.local?.bleu4);
          localHuman.chrf.push(run.humanScores?.local?.chrf);
          cloudHuman.bleu4.push(run.humanScores?.cloud?.bleu4);
          cloudHuman.chrf.push(run.humanScores?.cloud?.chrf);
          if (run.local?.error) failed++;
          done++;
          ctx.onBatchItemDone?.(i + 1);
        } catch (err) {
          failed++;
          ctx.diag.step('batch-item-failed', { index: i + 1, imageId: item.imageId, message: String(err.message).slice(0, 200) });
          ctx.onBatchItemDone?.(i + 1); // a normal failure (not a crash): move on
          progressText.textContent = `Image ${i + 1} failed (${err.message}); continuing...`;
        }
        bar.value = i + 1;
        const avg = (xs) => (mean(xs) == null ? '–' : mean(xs).toFixed(1));
        runningText.textContent = kind === 'dataset'
          ? `Running mean so far: local vs human ${avg(localHuman.bleu4)} / ${avg(localHuman.chrf)}` +
            (settings.cloudModel ? ` · cloud vs human ${avg(cloudHuman.bleu4)} / ${avg(cloudHuman.chrf)}` : '') + ' (BLEU-4 / chrF)'
          : '';
      }
      progressText.textContent = stopRequested ? `Stopped after ${done} of ${total} images.` : `Finished ${done} of ${total} images.`;
      ctx.diag.step('batch-done', { done, total, failed, stopped: stopRequested });
      ctx.onBatchEnd?.();
      if (done) await showSummary({ batchId, label, done, total, failed, stopped: stopRequested });
    } catch (err) {
      ctx.onBatchEnd?.();
      progressText.textContent = `Batch failed: ${err.message}`;
      ctx.diag.step('batch-failed', { message: String(err.message).slice(0, 300) });
    } finally {
      running = false;
      stopBtn.hidden = true;
      ctx.diag.setBusy(false);
      ctx.setRunning(false);
      try {
        await wakeLock?.release();
      } catch {
        // already released
      }
      wakeLock = null;
    }
  }

  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    stopBtn.disabled = true;
    progressText.textContent += ' · stopping after this image...';
  });

  return { start, showDatasetStatus, isRunning: () => running };
}
