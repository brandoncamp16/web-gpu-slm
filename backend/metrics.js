// Text-similarity scores and summary statistics.
//
// BLEU-4 and chrF follow sacreBLEU's defaults so numbers can be reported as
// sacreBLEU-compatible:
//   BLEU: 13a tokenizer, case-sensitive, 4-gram, "exp" smoothing.
//         Sentence BLEU uses effective order (as sacrebleu.sentence_bleu does).
//   chrF: character 6-grams, beta = 2, whitespace removed, no word n-grams.
// Corpus scores sum the n-gram statistics over all sentences before scoring,
// which is how sacreBLEU computes corpus_bleu / corpus_chrf.
//
// Multiple references (e.g. VizWiz's up to 5 human captions per image) follow sacreBLEU:
//   BLEU: n-gram matches are clipped by the highest count in any reference, and the
//         reference length is the closest one to the hypothesis length (ties: shorter).
//   chrF: the statistics of the single best-scoring reference are used.

const BLEU_ORDER = 4;
const CHRF_ORDER = 6;
const CHRF_BETA = 2;

// sacreBLEU's default "13a" tokenizer (mteval-v13a.pl).
function tokenize13a(line) {
  let s = String(line ?? '');
  s = s.replace(/<skipped>/g, '').replace(/-\n/g, '').replace(/\n/g, ' ');
  if (s.includes('&')) {
    s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  s = ` ${s} `;
  s = s.replace(/([\{-\~\[-\` -\&\(-\+\:-\@\/])/g, ' $1 ');
  s = s.replace(/([^0-9])([\.,])/g, '$1 $2 ');
  s = s.replace(/([\.,])([^0-9])/g, ' $1 $2');
  s = s.replace(/([0-9])(-)/g, '$1 $2 ');
  return s.split(/\s+/).filter(Boolean);
}

function countNgrams(items, n) {
  const counts = new Map();
  for (let i = 0; i + n <= items.length; i++) {
    const key = items.slice(i, i + n).join('\u0001');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

const asList = (references) => (Array.isArray(references) ? references : [references]);

// sacreBLEU's "closest" reference length: smallest difference, ties go to the shorter one
function closestRefLen(hypLen, refLens) {
  let best = null;
  for (const len of refLens) {
    const diff = Math.abs(hypLen - len);
    if (best === null || diff < best.diff || (diff === best.diff && len < best.len)) best = { diff, len };
  }
  return best ? best.len : 0;
}

function bleuStats(hypothesis, references) {
  const hyp = tokenize13a(hypothesis);
  const refs = asList(references).map(tokenize13a);
  const correct = [];
  const total = [];
  for (let n = 1; n <= BLEU_ORDER; n++) {
    const hypCounts = countNgrams(hyp, n);
    // Highest count of each n-gram in any one reference
    const maxRef = new Map();
    for (const ref of refs) {
      for (const [gram, c] of countNgrams(ref, n)) maxRef.set(gram, Math.max(maxRef.get(gram) || 0, c));
    }
    let match = 0;
    for (const [gram, c] of hypCounts) match += Math.min(c, maxRef.get(gram) || 0);
    correct.push(match);
    total.push(Math.max(0, hyp.length - n + 1));
  }
  return { correct, total, sysLen: hyp.length, refLen: closestRefLen(hyp.length, refs.map((r) => r.length)) };
}

function bleuFromStats({ correct, total, sysLen, refLen }, effectiveOrder) {
  // No matching words at all: sacreBLEU scores this as 0
  if (correct[0] === 0) return 0;
  const precisions = new Array(BLEU_ORDER).fill(0);
  let smooth = 1;
  let effOrder = BLEU_ORDER;
  for (let n = 1; n <= BLEU_ORDER; n++) {
    if (total[n - 1] === 0) break;
    if (effectiveOrder) effOrder = n;
    if (correct[n - 1] === 0) {
      smooth *= 2;
      precisions[n - 1] = 100 / (smooth * total[n - 1]);
    } else {
      precisions[n - 1] = (100 * correct[n - 1]) / total[n - 1];
    }
  }
  let bp = 1;
  if (sysLen < refLen) bp = sysLen > 0 ? Math.exp(1 - refLen / sysLen) : 0;
  const logSum = precisions
    .slice(0, effOrder)
    .reduce((sum, p) => sum + (p === 0 ? -9999999999 : Math.log(p)), 0);
  return bp * Math.exp(logSum / effOrder);
}

function charNgramCounts(text, n) {
  const chars = Array.from(String(text ?? '').split(/\s+/).join(''));
  return countNgrams(chars, n);
}

function chrfStats(hypothesis, references) {
  // Several references: keep the statistics of the one with the best chrF
  const refs = asList(references);
  if (refs.length > 1) {
    let best = null;
    let bestF = -1;
    for (const ref of refs) {
      const stats = chrfStats(hypothesis, ref);
      const f = chrfFromStats(stats);
      if (f > bestF) {
        bestF = f;
        best = stats;
      }
    }
    return best;
  }
  const reference = refs[0];
  const stats = [];
  for (let n = 1; n <= CHRF_ORDER; n++) {
    const hypCounts = charNgramCounts(hypothesis, n);
    const refCounts = charNgramCounts(reference, n);
    let hypTotal = 0;
    let refTotal = 0;
    let match = 0;
    for (const c of hypCounts.values()) hypTotal += c;
    for (const c of refCounts.values()) refTotal += c;
    for (const [gram, c] of hypCounts) match += Math.min(c, refCounts.get(gram) || 0);
    stats.push(hypTotal, refTotal, match);
  }
  return stats;
}

function chrfFromStats(stats) {
  const factor = CHRF_BETA ** 2;
  let avgPrec = 0;
  let avgRec = 0;
  let effectiveOrder = 0;
  for (let i = 0; i < CHRF_ORDER; i++) {
    const [nHyp, nRef, nMatch] = stats.slice(3 * i, 3 * i + 3);
    if (nHyp > 0 && nRef > 0) {
      avgPrec += nMatch / nHyp;
      avgRec += nMatch / nRef;
      effectiveOrder++;
    }
  }
  if (effectiveOrder === 0) return 0;
  avgPrec /= effectiveOrder;
  avgRec /= effectiveOrder;
  if (avgPrec + avgRec === 0) return 0;
  return (100 * (1 + factor) * avgPrec * avgRec) / (factor * avgPrec + avgRec);
}

function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Usable references: non-empty strings
const cleanRefs = (references) => asList(references).filter((r) => typeof r === 'string' && r.trim());

// Scores for one hypothesis against one reference or a list of references, 0-100.
function scorePair(hypothesis, references) {
  const refs = cleanRefs(references);
  if (!hypothesis?.trim() || refs.length === 0) return { bleu4: null, chrf: null };
  const reference = refs.length === 1 ? refs[0] : refs;
  return {
    bleu4: round(bleuFromStats(bleuStats(hypothesis, reference), true)),
    chrf: round(chrfFromStats(chrfStats(hypothesis, reference))),
  };
}

// Corpus-level scores over many [hypothesis, reference(s)] pairs.
function scoreCorpus(pairs) {
  const valid = pairs
    .map(([h, r]) => [h, cleanRefs(r)])
    .filter(([h, refs]) => h?.trim() && refs.length)
    .map(([h, refs]) => [h, refs.length === 1 ? refs[0] : refs]);
  if (valid.length === 0) return { bleu4: null, chrf: null };
  const bleu = { correct: [0, 0, 0, 0], total: [0, 0, 0, 0], sysLen: 0, refLen: 0 };
  const chrf = new Array(CHRF_ORDER * 3).fill(0);
  for (const [h, r] of valid) {
    const b = bleuStats(h, r);
    for (let i = 0; i < BLEU_ORDER; i++) {
      bleu.correct[i] += b.correct[i];
      bleu.total[i] += b.total[i];
    }
    bleu.sysLen += b.sysLen;
    bleu.refLen += b.refLen;
    chrfStats(h, r).forEach((v, i) => { chrf[i] += v; });
  }
  return { bleu4: round(bleuFromStats(bleu, false)), chrf: round(chrfFromStats(chrf)) };
}

// Mean, sample standard deviation, median, 95th percentile, min, max.
function summarize(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, sd: null, median: null, p95: null, min: null, max: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const quantile = (q) => {
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  };
  return {
    n,
    mean: round(mean),
    sd: round(sd),
    median: round(quantile(0.5)),
    p95: round(quantile(0.95)),
    min: round(xs[0]),
    max: round(xs[n - 1]),
  };
}

module.exports = { scorePair, scoreCorpus, summarize, tokenize13a };
