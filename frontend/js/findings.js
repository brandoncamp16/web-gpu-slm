// Plain-language conclusions generated from the measured stats.
// Every sentence is derived from the numbers shown elsewhere on the page.
import { isNum, wordCount, seriesStyle } from './common.js';

const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

// "1.8× faster" / "1.3× slower" / "about as fast as", comparing a to b (lower is better)
function speedPhrase(a, b) {
  if (!isNum(a) || !isNum(b) || a <= 0 || b <= 0) return null;
  const ratio = b / a;
  if (ratio >= 1.1) return `${ratio.toFixed(1)}× faster than`;
  if (ratio <= 1 / 1.1) return `${(1 / ratio).toFixed(1)}× slower than`;
  return 'about as fast as';
}

function qualityWord(pct) {
  if (pct >= 95) return 'on par with the cloud';
  if (pct >= 85) return 'close to the cloud';
  if (pct >= 70) return 'noticeably behind the cloud';
  return 'well behind the cloud';
}

const biggest = (groups) => groups.slice().sort((a, b) => b.runs - a.runs)[0];

/** Conclusions for a set of runs, from /api/stats output. */
export function statsFindings(stats) {
  const out = [];
  const local = biggest(stats.local || []);
  const cloud = biggest(stats.cloud || []);
  const localName = local ? seriesStyle(local.model, 'local', local.precision).name : '';
  const cloudName = cloud?.model;

  if (local && cloud) {
    const total = speedPhrase(local.totalLatencyMs.median, cloud.totalLatencyMs.median);
    if (total) {
      out.push(`Speed: ${localName} finishes a description in ${secs(local.totalLatencyMs.median)} (median), ${total} ${cloudName} (${secs(cloud.totalLatencyMs.median)}).`);
    }
    if (isNum(local.ttftMs.median) && isNum(cloud.ttftMs.median)) {
      out.push(`First words appear after ${secs(local.ttftMs.median)} locally vs ${secs(cloud.ttftMs.median)} from the cloud, which matters for screen-reader users waiting on speech.`);
    }
    const lt = local.tokensPerSec.mean;
    const ct = cloud.tokensPerSec.mean;
    if (isNum(lt) && isNum(ct)) {
      out.push(ct > lt * 1.1
        ? `Generation: the cloud writes faster once it starts (${ct.toFixed(0)} vs ${lt.toFixed(0)} tokens/s)${local.totalLatencyMs.median < cloud.totalLatencyMs.median ? ', but the local model still finishes first because it skips the network round trip' : ''}.`
        : `Generation: the local model writes at ${lt.toFixed(0)} tokens/s vs ${ct.toFixed(0)} for the cloud.`);
    }
    const lw = local.outputWords?.mean;
    const cw = cloud.outputWords?.mean;
    if (isNum(lw) && isNum(cw) && cw > 0) {
      const diff = Math.round((1 - lw / cw) * 100);
      out.push(`Length: local descriptions average ${Math.round(lw)} words vs ${Math.round(cw)} for the cloud` +
        (Math.abs(diff) >= 10 ? ` (${Math.abs(diff)}% ${diff > 0 ? 'shorter' : 'longer'}). Length differences also lower BLEU-4, which penalizes outputs shorter than the reference.` : ' (similar length).'));
    }
    const lCv = local.totalLatencyMs.mean ? local.totalLatencyMs.sd / local.totalLatencyMs.mean : null;
    const cCv = cloud.totalLatencyMs.mean ? cloud.totalLatencyMs.sd / cloud.totalLatencyMs.mean : null;
    if (isNum(lCv) && isNum(cCv) && local.runs > 2 && cloud.runs > 2) {
      out.push(lCv < cCv
        ? `Consistency: local latency varies less (±${secs(local.totalLatencyMs.sd)}) than the cloud's (±${secs(cloud.totalLatencyMs.sd)}).`
        : `Consistency: cloud latency varies less (±${secs(cloud.totalLatencyMs.sd)}) than the local model's (±${secs(local.totalLatencyMs.sd)}).`);
    }
    if (isNum(cloud.bandwidthBytes.mean)) {
      const measured = local.measuredRuns && isNum(local.networkRequests?.mean);
      const dest = cloud.destinations?.length ? cloud.destinations.join(', ') : 'the provider';
      out.push(`Privacy and network: ${measured
        ? `while the local model ran, the browser made ${local.networkRequests.mean === 0 ? 'no network requests' : `${local.networkRequests.mean.toFixed(1)} network requests on average`} (measured over ${local.measuredRuns} run${local.measuredRuns === 1 ? '' : 's'})`
        : 'the local model runs on the device (its network traffic is measured on runs from now on)'}; ` +
        `each cloud description needs ${Math.round(cloud.networkRequests?.mean ?? 1)} outbound request to ${dest}, sending about ${kb(cloud.bandwidthBytes.mean)} (the photo)` +
        (isNum(cloud.responseBytes?.mean) ? ` and receiving about ${kb(cloud.responseBytes.mean)}.` : '.'));
    }
  } else if (local) {
    out.push(`Speed: ${localName} finishes a description in ${secs(local.totalLatencyMs.median)} (median) with no network use.`);
  }

  // Quality against human captions (VizWiz runs)
  const human = biggest((stats.human || []).filter((h) => h.cloudModel && isNum(h.relative?.chrf))) || null;
  if (human) {
    const name = seriesStyle(human.model, 'local', human.precision).name;
    out.push(`Quality: against the VizWiz human captions, ${name} reaches ${human.relative.chrf}% of ${human.cloudModel}'s chrF` +
      (isNum(human.relative.bleu4) ? ` and ${human.relative.bleu4}% of its BLEU-4` : '') +
      ` over ${human.pairedRuns} images, ${qualityWord(human.relative.chrf)}.`);
  } else {
    const q = biggest((stats.quality || []).filter((g) => isNum(g.chrf?.mean)));
    if (q) out.push(`Similarity: local descriptions score chrF ${q.chrf.mean.toFixed(1)} against the ${q.reference} reference (0–100, higher means more overlap in wording).`);
  }

  const n = local?.runs ?? 0;
  if (n && n < 30) out.push(`Sample size: based on ${n} local run${n === 1 ? '' : 's'}. Collect at least 30 per model before drawing firm conclusions.`);
  return out;
}

/** Conclusions for one run (the run report). */
export function runFindings(run) {
  const out = [];
  const local = run.local || {};
  const cloud = run.cloud || {};
  if (local.error) out.push(`The local model failed on this run: ${local.error}`);
  if (cloud.model && !cloud.error && !local.error) {
    const total = speedPhrase(local.totalLatencyMs, cloud.totalLatencyMs);
    if (total) out.push(`The local model was ${total} ${cloud.model} on this image (${secs(local.totalLatencyMs)} vs ${secs(cloud.totalLatencyMs)}).`);
    const lw = wordCount(local.output);
    const cw = wordCount(cloud.output);
    if (lw && cw) out.push(`Its description used ${lw} words vs ${cw} for the cloud${lw < cw * 0.7 ? ', a much shorter summary' : lw > cw * 1.3 ? ', a longer description' : ''}.`);
    if (isNum(cloud.requestBytes)) {
      out.push(`Network: the cloud made ${cloud.networkRequests ?? 1} outbound request to ${cloud.destination || 'the provider'}, sending ${kb(cloud.requestBytes)}` +
        (isNum(cloud.responseBytes) ? ` and receiving ${kb(cloud.responseBytes)}` : '') +
        (isNum(local.networkRequests) ? `; the local model made ${local.networkRequests} request${local.networkRequests === 1 ? '' : 's'} while it ran.` : '; the local model uploaded nothing.'));
    }
  }
  const h = run.humanScores;
  if (h && isNum(h.local?.chrf)) {
    if (isNum(h.cloud?.chrf) && h.cloud.chrf > 0) {
      const pct = Math.round((h.local.chrf / h.cloud.chrf) * 100);
      out.push(`Against the human captions, the local description scored chrF ${h.local.chrf.toFixed(1)} vs ${h.cloud.chrf.toFixed(1)} for the cloud (${pct}% of the cloud's score).`);
    } else {
      out.push(`Against the human captions, the local description scored chrF ${h.local.chrf.toFixed(1)}.`);
    }
  } else if (isNum(run.scores?.chrf) && run.reference?.source) {
    out.push(`Word overlap with the ${run.reference.source === 'cloud' ? 'cloud description' : 'manual reference'}: chrF ${run.scores.chrf.toFixed(1)} (0–100).`);
  }
  if (local.coldStart) out.push('This was the first run after loading the model (cold start), so its timing includes one-time GPU setup.');
  return out;
}
