// Results views: the overall dashboard and the report for a single run.
import { barChart, lineChart } from './charts.js';
import { statsFindings, runFindings } from './findings.js';
import { renderBatchViewer } from './batchview.js';
import {
  $, api, el, confirmDialog, isNum, fmtMs, fmtRate, fmtScore, fmtBytes, fmtInt, wordCount, shortModel, seriesStyle, statTile,
} from './common.js';

const statsLabelFilter = $('stats-label-filter');
const deviceFilter = $('stats-device-filter');
const runsSort = $('runs-sort');
const includeColdInput = $('include-cold');

const fmtStat = (s, digits = 0) =>
  s && isNum(s.mean) ? `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)} (${s.median.toFixed(digits)})` : '–';
const fmtMeanSd = (s, digits = 1) => (s && isNum(s.mean) ? `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)}` : '–');
const fmtWords = (v) => (isNum(v) ? `${Math.round(v)} words` : '–');

function statsQuery(extra = {}) {
  const params = new URLSearchParams(extra);
  if (statsLabelFilter.value) params.set('label', statsLabelFilter.value);
  if (deviceFilter.value) params.set('device', deviceFilter.value);
  return params.toString();
}

function cell(text, className) {
  return el('td', { text: text ?? '–', className });
}

// Column names for the stacked phone layout: the first text of each header cell
function headerLabels(tbody) {
  return [...(tbody.closest('table')?.querySelectorAll('thead th') || [])]
    .map((th) => (th.childNodes[0]?.textContent || th.textContent).trim());
}

function fillTable(tbody, rows, emptyText, columns) {
  if (rows.length === 0) {
    const td = cell(emptyText, 'hint');
    td.colSpan = columns;
    tbody.replaceChildren(el('tr', {}, [td]));
  } else {
    const labels = headerLabels(tbody);
    for (const tr of rows) [...tr.children].forEach((td, i) => td.setAttribute('data-label', labels[i] || ''));
    tbody.replaceChildren(...rows);
  }
}

// Precision label; older runs (before presets existed) fall back to their dtype values
const precisionOf = (run) =>
  run.local?.precision || (run.local?.dtype ? Object.values(run.local.dtype).join('/') : '');

// Swatch background matching the chart texture for a series
const swatchBg = (s) => (s.textured ? `repeating-linear-gradient(45deg, ${s.color} 0 2px, transparent 2px 4px)` : s.color);

async function refreshLabels() {
  const labels = await api('/api/labels');
  const selected = statsLabelFilter.value;
  statsLabelFilter.replaceChildren(new Option('All Runs', ''));
  for (const label of labels) statsLabelFilter.append(new Option(label, label));
  // A batch summary's "View batch results" link asks for its label
  let wanted = selected;
  try {
    wanted = sessionStorage.getItem('webgpu-slm:results-label') || selected;
    sessionStorage.removeItem('webgpu-slm:results-label');
  } catch {
    // storage unavailable
  }
  statsLabelFilter.value = labels.includes(wanted) ? wanted : '';
}

async function refreshDevices() {
  const devices = await api('/api/devices');
  const selected = deviceFilter.value;
  deviceFilter.replaceChildren(new Option('All Devices', ''));
  for (const d of devices) deviceFilter.append(new Option(d, d));
  deviceFilter.value = devices.includes(selected) ? selected : '';
}

// When the selected runs are exactly one dataset batch, show the batch viewer at the top
async function renderBatchSection(runs) {
  const section = $('batch-viewer-section');
  const batchIds = new Set(runs.map((r) => r.batchId).filter(Boolean));
  if (!statsLabelFilter.value || batchIds.size !== 1 || runs.some((r) => !r.batchId)) {
    section.hidden = true;
    return;
  }
  const [batchId] = batchIds;
  const batchRuns = await api(`/api/runs?batchId=${encodeURIComponent(batchId)}&order=asc&limit=200`);
  section.hidden = batchRuns.length === 0;
  if (batchRuns.length) renderBatchViewer(section, batchRuns, { title: `Batch "${statsLabelFilter.value}": review each image` });
}

// Docker Desktop hides real client addresses behind its internal gateway (172.16.0.0/12);
// only show an IP when it's a real address
const realIp = (ip) => (ip && !/^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? ip : '');

// ---------- Overall dashboard ----------

export async function renderResults() {
  const view = $('view-results');
  // Dim the previous render only if a refresh is slow, so normal loads don't flicker
  const dimTimer = setTimeout(() => view.classList.add('loading'), 300);
  try {
    await Promise.all([refreshLabels(), refreshDevices()]);
    const includeCold = includeColdInput.checked;
    const [stats, runs] = await Promise.all([
      api(`/api/stats?${statsQuery({ includeCold })}`),
      api(`/api/runs?${statsQuery({ limit: 500, sort: runsSort.value === 'device' ? 'device' : 'newest' })}`),
    ]);
    await renderBatchSection(runs);
    $('stats-summary').textContent = stats.totalRuns
      ? `${stats.totalRuns} stored run${stats.totalRuns === 1 ? '' : 's'}` +
        (stats.coldStartsExcluded ? ` · ${stats.coldStartsExcluded} cold start(s) excluded from local timing` : '')
      : 'No runs stored yet. Run a benchmark to see results here.';

    const models = [
      ...stats.local.map((s) => ({ ...s, kind: 'local' })),
      ...stats.cloud.map((s) => ({ ...s, kind: 'cloud' })),
    ].map((s) => ({ ...s, ...seriesStyle(s.model, s.kind, s.precision) }));

    renderKpis(stats, models);
    renderCharts(stats, models, runs.slice().reverse(), includeCold);
    renderTables(stats, models, runs);
    renderHuman(stats.human || []);
    renderFindings(stats);
    renderJudge();
  } catch (err) {
    $('stats-summary').textContent = `Could not load stored results: ${err.message}`;
  } finally {
    clearTimeout(dimTimer);
    view.classList.remove('loading');
  }
}

function renderKpis(stats, models) {
  // Stored Runs only for "All Runs": a selected label/batch already shows its image count
  const tiles = statsLabelFilter.value
    ? []
    : [statTile('Stored Runs', fmtInt(stats.totalRuns), stats.coldStartsExcluded ? `${stats.coldStartsExcluded} cold start(s) excluded` : 'all runs included')];

  for (const m of models) {
    tiles.push(statTile(
      `${m.name} Median Latency`,
      fmtMs(m.totalLatencyMs.median),
      `TTFT ${fmtMs(m.ttftMs.median)} · ${m.runs} run${m.runs === 1 ? '' : 's'}`,
      { swatch: swatchBg(m), better: 'lower' },
    ));
  }

  // Overall quality, weighted by the number of runs in each comparison
  const scored = stats.quality.reduce((n, q) => n + q.runs, 0);
  const weighted = (key) =>
    scored ? stats.quality.reduce((sum, q) => sum + (q[key].mean ?? 0) * q[key].n, 0) / stats.quality.reduce((n, q) => n + q[key].n, 0) : null;
  tiles.push(statTile('Mean chrF', fmtScore(weighted('chrf')), `${scored} scored run${scored === 1 ? '' : 's'}`, { better: 'higher' }));
  tiles.push(statTile('Mean BLEU-4', fmtScore(weighted('bleu4')), 'local output vs. reference', { better: 'higher' }));

  const cloudUpload = models.filter((m) => m.kind === 'cloud').map((m) => m.bandwidthBytes.mean).filter(isNum);
  if (cloudUpload.length) {
    tiles.push(statTile('Cloud Upload per Image', fmtBytes(Math.max(...cloudUpload)), 'local inference uploads 0 B', { better: 'lower' }));
  }
  // Cloud network footprint per description (local inference is measured at 0 requests, so only the cloud is shown)
  const cloudNet = models.find((m) => m.kind === 'cloud');
  if (cloudNet) {
    const localNet = models.find((m) => m.kind === 'local' && m.measuredRuns);
    // OpenAI is the only cloud provider here; runs saved before destinations were recorded fall back to it
    const dest = cloudNet.destinations?.length ? cloudNet.destinations.join(', ') : 'api.openai.com';
    tiles.push(statTile('Cloud Network Requests', fmtInt(cloudNet.networkRequests.mean ?? 1),
      `outbound to ${dest} per description` +
        (localNet && localNet.networkRequests.max === 0 ? ' · local inference made none (measured)' : ''),
      { better: 'lower' }));
  }
  $('kpi-row').replaceChildren(...tiles);
}

function renderCharts(stats, models, runsOldestFirst, includeCold) {
  const legendItems = models.map((m) => ({ name: m.name, color: m.color, textured: m.textured }));
  const bar = (m, value) => ({ name: m.name, color: m.color, textured: m.textured, value });

  barChart($('chart-latency'), {
    ariaLabel: 'Median latency by model in milliseconds',
    groups: [
      { label: 'Time to First Token', bars: models.map((m) => bar(m, m.ttftMs.median)) },
      { label: 'Total Latency', bars: models.map((m) => bar(m, m.totalLatencyMs.median)) },
      { label: 'p95 Total Latency', bars: models.map((m) => bar(m, m.totalLatencyMs.p95)) },
    ],
    legendItems,
    format: fmtMs,
  });

  barChart($('chart-speed'), {
    ariaLabel: 'Mean generation speed by model in tokens per second',
    groups: models.map((m) => ({ label: m.name, bars: [bar(m, m.tokensPerSec.mean)] })),
    format: fmtRate,
  });

  barChart($('chart-words'), {
    ariaLabel: 'Mean output length by model in words',
    groups: models.map((m) => ({ label: m.name, bars: [bar(m, m.outputWords?.mean ?? null)] })),
    format: fmtWords,
  });

  // One row per comparison, colored by the local model being scored
  barChart($('chart-quality'), {
    ariaLabel: 'Mean chrF and BLEU-4 of each local model against each reference',
    groups: stats.quality.map((q) => {
      const style = seriesStyle(q.model, 'local', q.precision);
      return {
        label: `${style.name} vs ${q.reference}`,
        bars: [
          { ...style, name: 'chrF', prefix: 'chrF', value: q.chrf.mean },
          { ...style, name: 'BLEU-4', prefix: 'BLEU-4', value: q.bleu4.mean },
        ],
      };
    }),
    format: (v) => v.toFixed(1),
    emptyMessage: 'No scored runs yet.',
  });

  // Total latency per run, oldest first; one line per model
  const usable = runsOldestFirst.filter((r) => r.local?.model || r.cloud?.model);
  const lineSeries = models.map((m) => ({
    name: m.name,
    color: m.color,
    textured: m.textured,
    values: usable.map((r) => {
      const side = m.kind === 'local' ? r.local : r.cloud;
      if (!side || side.model !== m.model || side.error) return null;
      if (m.kind === 'local' && precisionOf(r) !== m.precision) return null;
      if (m.kind === 'local' && side.coldStart && !includeCold) return null;
      return isNum(side.totalLatencyMs) ? side.totalLatencyMs : null;
    }),
  }));
  lineChart($('chart-runs'), {
    ariaLabel: 'Total latency per run in milliseconds',
    xLabels: usable.map((r) => new Date(r.createdAt).toLocaleString()),
    series: lineSeries,
    format: fmtMs,
  });
}

// On phones the runs table becomes stacked cards; each cell shows its column name
const RUN_COLUMNS = ['Select', 'Time', 'Device', 'Label', 'Image', 'Local TTFT / Total', 'Cloud', 'Cloud TTFT / Total', 'BLEU-4', 'chrF'];
function labelCells(tr, labels) {
  [...tr.children].forEach((td, i) => td.setAttribute('data-label', labels[i]));
  return tr;
}

function renderTables(stats, models, runs) {
  fillTable(
    $('perf-body'),
    models.map((m) => el('tr', {}, [
      cell(m.name),
      cell(String(m.runs)),
      cell(fmtStat(m.ttftMs)),
      cell(fmtStat(m.totalLatencyMs)),
      cell(isNum(m.totalLatencyMs.p95) ? Math.round(m.totalLatencyMs.p95).toLocaleString() : '–'),
      cell(fmtMeanSd(m.tokensPerSec)),
      cell(fmtMeanSd(m.outputWords, 0)),
      cell(m.kind === 'cloud' ? fmtInt(m.networkRequests.mean ?? 1) : isNum(m.networkRequests?.mean) ? m.networkRequests.mean.toFixed(m.networkRequests.mean % 1 ? 1 : 0) : 'not measured'),
      cell(fmtBytes(m.bandwidthBytes.mean)),
      cell(m.kind === 'cloud' ? fmtBytes(m.responseBytes?.mean) : fmtBytes(m.networkBytes?.mean ?? (m.measuredRuns ? 0 : null))),
    ])),
    'No runs yet.',
    10,
  );

  fillTable(
    $('quality-body'),
    stats.quality.map((q) => el('tr', {}, [
      cell(seriesStyle(q.model, 'local', q.precision).name),
      cell(q.reference),
      cell(String(q.runs)),
      cell(fmtMeanSd(q.bleu4, 2)),
      cell(fmtMeanSd(q.chrf, 2)),
      cell(fmtScore(q.corpus.bleu4)),
      cell(fmtScore(q.corpus.chrf)),
    ])),
    'No scored runs yet.',
    7,
  );

  fillTable(
    $('runs-body'),
    runs.map((r) => {
      const localTiming = r.local?.error
        ? cell(`Error: ${r.local.error}`, 'error')
        : cell(`${fmtMs(r.local?.ttftMs)} / ${fmtMs(r.local?.totalLatencyMs)}${r.local?.coldStart ? ' (cold)' : ''}`);
      const cloudTiming = r.cloud?.error
        ? cell(`Error: ${r.cloud.error}`, 'error')
        : cell(r.cloud?.model ? `${fmtMs(r.cloud.ttftMs)} / ${fmtMs(r.cloud.totalLatencyMs)}` : '–');
      const link = el('a', { text: new Date(r.createdAt).toLocaleString(), attrs: { href: `#/run/${r._id}` } });
      const select = el('input', { className: 'run-select', attrs: { type: 'checkbox', value: r._id, 'aria-label': `Select run from ${new Date(r.createdAt).toLocaleString()}` } });
      return labelCells(el('tr', { className: 'clickable' }, [
        el('td', { className: 'select-col' }, [select]),
        el('td', {}, [link]),
        cell(r.environment?.deviceName || '–'),
        cell(r.label || '–'),
        cell(r.image?.name || '–'),
        localTiming,
        cell(r.cloud?.model || (r.reference?.source === 'manual' ? 'manual ref' : '–')),
        cloudTiming,
        cell(fmtScore(r.scores?.bleu4)),
        cell(fmtScore(r.scores?.chrf)),
      ]), RUN_COLUMNS);
    }),
    'No runs yet.',
    10,
  );
  updateSelection();
}

// ---------- Key findings ----------
function renderFindings(stats) {
  const findings = stats.totalRuns ? statsFindings(stats) : [];
  $('findings-card').hidden = findings.length === 0;
  $('findings-list').replaceChildren(...findings.map((f) => el('li', { text: f })));
}

// ---------- AI judge ----------
const VERDICTS = {
  local_better: 'Verdict: The Local Model Did Better Overall',
  cloud_better: 'Verdict: The Cloud Model Did Better Overall',
  comparable: 'Verdict: The Two Models Were Comparable Overall',
};

function judgeSide(title, style, side) {
  const list = (items) => (items?.length ? el('ul', {}, items.map((t) => el('li', { text: t }))) : el('p', { className: 'hint', text: 'None noted.' }));
  return el('div', { className: 'judge-side' }, [
    el('h4', {}, [
      el('span', { className: 'swatch', attrs: { style: `background:${style.color}`, 'aria-hidden': 'true' } }),
      document.createTextNode(title),
    ]),
    el('div', { className: 'pro-con', text: 'Pros' }),
    list(side?.pros),
    el('div', { className: 'pro-con', text: 'Cons' }),
    list(side?.cons),
  ]);
}

function judgementView(j) {
  if (j.error) {
    return el('p', { className: 'status-box error', text: `Review on ${new Date(j.createdAt).toLocaleString()} failed: ${j.error}` });
  }
  const runLinks = el('ol', { className: 'findings-list' }, (j.perRun || []).map((p) => el('li', {}, [
    p.runId ? el('a', { text: `Run ${p.run}`, attrs: { href: `#/run/${p.runId}` } }) : document.createTextNode(`Run ${p.run}`),
    document.createTextNode(`: ${p.better === 'tie' ? 'tie' : `${p.better} better`}. ${p.reason}`),
  ])));
  return el('div', {}, [
    el('p', { className: 'judge-verdict', text: VERDICTS[j.verdict] || VERDICTS.comparable }),
    el('p', { text: j.summary }),
    el('div', { className: 'judge-columns' }, [
      judgeSide('Local Model', { color: 'var(--series-1)' }, j.local),
      judgeSide('Cloud Model', { color: 'var(--series-2)' }, j.cloud),
    ]),
    el('details', { className: 'judge-runs' }, [el('summary', { text: `Per-Run Notes (${(j.perRun || []).length})` }), runLinks]),
  ]);
}

// Reviews newest first; ‹ goes to older reviews, › to newer ones
let judgeIndex = 0;
async function renderJudge() {
  const meta = $('judge-meta');
  const content = $('judge-content');
  try {
    const data = await api('/api/judgements?limit=30');
    const reviews = data.judgements;
    const next = data.inProgress ? 'A review is running now.' : `Next automatic review after ${data.nextInRuns} more run${data.nextInRuns === 1 ? '' : 's'} with both descriptions.`;
    $('judge-now-btn').disabled = !data.configured || data.inProgress;
    meta.textContent = next;
    if (!reviews.length) {
      meta.textContent = `No reviews yet. ${next}`;
      content.replaceChildren();
      return;
    }
    judgeIndex = Math.min(judgeIndex, reviews.length - 1);
    const show = () => {
      const j = reviews[judgeIndex];
      const older = el('button', { className: 'secondary inline bv-arrow', text: '‹', attrs: { 'aria-label': 'Older review' } });
      const newer = el('button', { className: 'secondary inline bv-arrow', text: '›', attrs: { 'aria-label': 'Newer review' } });
      older.disabled = judgeIndex >= reviews.length - 1;
      newer.disabled = judgeIndex === 0;
      const step = (delta) => {
        judgeIndex += delta;
        content.classList.remove('judge-swap');
        void content.offsetWidth;
        content.classList.add('judge-swap');
        show();
      };
      older.addEventListener('click', () => step(1));
      newer.addEventListener('click', () => step(-1));
      const position = el('span', {
        className: 'bv-position',
        text: `Review ${reviews.length - judgeIndex} of ${reviews.length}${judgeIndex === 0 ? ' (Latest)' : ''} · ${new Date(j.createdAt).toLocaleString()} · ${j.judgeModel} · ${j.runIds.length} runs (${j.trigger})`,
      });
      content.replaceChildren(el('div', { className: 'bv-nav' }, [older, newer]), position, judgementView(j));
    };
    show();
  } catch (err) {
    meta.textContent = `Could not load AI judge reviews: ${err.message}`;
  }
}

$('judge-now-btn').addEventListener('click', async () => {
  const btn = $('judge-now-btn');
  btn.disabled = true;
  $('judge-meta').textContent = 'Reviewing the latest runs (this takes about 10–30 seconds)...';
  try {
    await api('/api/judgements', { method: 'POST' });
  } catch (err) {
    $('judge-meta').textContent = `Review failed: ${err.message}`;
    btn.disabled = false;
    return;
  }
  judgeIndex = 0; // show the new review
  await renderJudge();
});

// ---------- Agreement with human captions (VizWiz dataset runs) ----------
const fmtPair = (p) => (p && (isNum(p.bleu4) || isNum(p.chrf)) ? `${isNum(p.bleu4) ? p.bleu4.toFixed(1) : '–'} / ${isNum(p.chrf) ? p.chrf.toFixed(1) : '–'}` : '–');
const fmtPct = (v) => (isNum(v) ? `${v}%` : '–');

function renderHuman(groups) {
  const section = $('human-section');
  section.hidden = groups.length === 0;
  if (!groups.length) return;

  const tiles = [];
  for (const g of groups) {
    const local = seriesStyle(g.model, 'local', g.precision);
    if (g.cloudModel) {
      tiles.push(statTile(`${local.name} Reaches (chrF)`, fmtPct(g.relative.chrf), `of ${g.cloudModel} vs human captions · ${g.pairedRuns} images`, { swatch: swatchBg(local), better: 'higher' }));
      tiles.push(statTile(`${local.name} Reaches (BLEU-4)`, fmtPct(g.relative.bleu4), `of ${g.cloudModel} vs human captions`, { swatch: swatchBg(local), better: 'higher' }));
    } else {
      tiles.push(statTile(`${local.name} vs Human (chrF)`, isNum(g.local.corpus.chrf) ? g.local.corpus.chrf.toFixed(1) : '–', `${g.runs} images · no cloud baseline`, { swatch: swatchBg(local), better: 'higher' }));
    }
  }
  $('human-kpis').replaceChildren(...tiles);

  // Bars: each local model and its cloud baseline, scored against the human captions
  const series = [];
  for (const g of groups) {
    const local = seriesStyle(g.model, 'local', g.precision);
    series.push({ ...local, name: `${local.name} vs human`, corpus: g.local.corpus });
    if (g.cloudModel) {
      const cloud = seriesStyle(g.cloudModel, 'cloud');
      series.push({ ...cloud, name: `${cloud.name} vs human${groups.length > 1 ? ` (with ${local.name})` : ''}`, corpus: g.cloud.corpus });
    }
  }
  barChart($('chart-human'), {
    ariaLabel: 'Corpus BLEU-4 and chrF against the VizWiz human captions, local model vs cloud baseline',
    groups: ['bleu4', 'chrf'].map((metric) => ({
      label: metric === 'bleu4' ? 'BLEU-4' : 'chrF',
      bars: series.map((s) => ({ name: s.name, color: s.color, textured: s.textured, value: s.corpus?.[metric] ?? null })),
    })),
    legendItems: series.map((s) => ({ name: s.name, color: s.color, textured: s.textured })),
    format: (v) => v.toFixed(1),
  });

  fillTable($('human-body'), groups.map((g) => el('tr', {}, [
    cell(seriesStyle(g.model, 'local', g.precision).name),
    cell(g.cloudModel || 'none'),
    cell(g.cloudModel ? `${g.pairedRuns} of ${g.runs}` : String(g.runs)),
    cell(fmtPair(g.local.corpus)),
    cell(fmtPair(g.cloud.corpus)),
    cell(g.cloudModel ? `${fmtPct(g.relative.bleu4)} / ${fmtPct(g.relative.chrf)}` : '–'),
    cell(fmtPair(g.localVsCloud)),
  ])), 'No dataset runs.', 7);
}

// Clicking anywhere on a run row opens its report (except the select checkbox)
$('runs-body').addEventListener('click', (e) => {
  if (e.target.closest('a, .select-col')) return;
  const link = e.target.closest('tr')?.querySelector('a[href^="#/run/"]');
  if (link) location.hash = link.getAttribute('href');
});

// ---------- Deleting runs ----------
const selectAll = $('select-all-runs');
const deleteSelectedBtn = $('delete-selected-btn');
const deleteFilteredBtn = $('delete-filtered-btn');
const selectedIds = () => [...document.querySelectorAll('#runs-body .run-select:checked')].map((c) => c.value);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function updateSelection() {
  const boxes = document.querySelectorAll('#runs-body .run-select');
  const n = selectedIds().length;
  deleteSelectedBtn.disabled = n === 0;
  deleteSelectedBtn.textContent = n ? `Delete Selected (${n})` : 'Delete Selected';
  selectAll.checked = boxes.length > 0 && n === boxes.length;
  selectAll.indeterminate = n > 0 && n < boxes.length;

  const filterText = [statsLabelFilter.value && `label "${statsLabelFilter.value}"`, deviceFilter.value && `device "${deviceFilter.value}"`].filter(Boolean).join(' and ');
  deleteFilteredBtn.disabled = !filterText;
  $('delete-filtered-hint').textContent = filterText
    ? `Deletes every run with ${filterText}.`
    : 'Pick a label or device above to delete just those runs.';
}

async function deleteRuns(body, done) {
  let message = '';
  try {
    const { deletedRuns } = await api('/api/runs/delete', { method: 'POST', body: JSON.stringify(body) });
    message = done(deletedRuns);
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
  await renderResults();
  if (message) $('stats-summary').textContent = message;
}

$('runs-body').addEventListener('change', (e) => {
  if (e.target.classList.contains('run-select')) updateSelection();
});
selectAll.addEventListener('change', () => {
  document.querySelectorAll('#runs-body .run-select').forEach((c) => { c.checked = selectAll.checked; });
  updateSelection();
});

deleteSelectedBtn.addEventListener('click', async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: `Delete ${plural(ids.length, 'run')}?`,
    message: ids.length === 1
      ? 'The selected run and its stored test image will be permanently deleted.'
      : `The ${ids.length} selected runs and their stored test images will be permanently deleted.`,
  });
  if (ok) await deleteRuns({ ids }, (n) => `Deleted ${plural(n, 'run')}.`);
});

deleteFilteredBtn.addEventListener('click', async () => {
  const label = statsLabelFilter.value;
  const device = deviceFilter.value;
  if (!label && !device) return;
  const stats = await api(`/api/stats?${statsQuery({ includeCold: true })}`).catch(() => null);
  const count = stats?.totalRuns;
  const what = [label && `label "${label}"`, device && `device "${device}"`].filter(Boolean).join(' and ');
  const ok = await confirmDialog({
    title: `Delete ${isNum(count) ? plural(count, 'run') : 'these runs'}?`,
    message: `Every run with ${what} and its stored test image will be permanently deleted. Other runs are not affected.`,
  });
  if (!ok) return;
  if (label) statsLabelFilter.value = '';
  if (device) deviceFilter.value = '';
  await deleteRuns({ label, device }, (n) => `Deleted ${plural(n, 'run')} with ${what}.`);
});

$('clear-db-btn').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Clear the entire database?',
    message: 'This permanently deletes every stored run, test image, AI judge review and diagnostics log, for all labels and devices.',
    confirmText: 'Clear Everything',
    typeToConfirm: 'DELETE',
  });
  if (!ok) return;
  statsLabelFilter.value = '';
  deviceFilter.value = '';
  try {
    const r = await api('/api/runs/delete', { method: 'POST', body: JSON.stringify({ everything: true, confirm: 'DELETE' }) });
    await renderResults();
    $('stats-summary').textContent = `Database cleared: ${plural(r.deletedRuns, 'run')} and ${plural(r.deletedJudgements, 'AI judge review')} deleted.`;
  } catch (err) {
    alert(`Clearing failed: ${err.message}`);
  }
});

function download(format) {
  const a = document.createElement('a');
  a.href = `/api/export?${statsQuery({ format })}`;
  a.click();
}

$('refresh-stats-btn').addEventListener('click', renderResults);
$('export-csv-btn').addEventListener('click', () => download('csv'));
$('export-json-btn').addEventListener('click', () => download('json'));
statsLabelFilter.addEventListener('change', renderResults);
deviceFilter.addEventListener('change', renderResults);
runsSort.addEventListener('change', renderResults);
includeColdInput.addEventListener('change', renderResults);

// ---------- Single run report ----------

// "Local 1.8× faster" style comparison (lower is better)
function speedComparison(localMs, cloudMs) {
  if (!isNum(localMs) || !isNum(cloudMs) || localMs <= 0 || cloudMs <= 0) return '–';
  const ratio = Math.max(localMs, cloudMs) / Math.min(localMs, cloudMs);
  if (ratio < 1.05) return 'About the same';
  return `${localMs < cloudMs ? 'Local' : 'Cloud'} ${ratio.toFixed(1)}× faster`;
}

function sideCard(title, style, tiles) {
  return el('div', { className: 'model-card' }, [
    el('h3', { className: 'model-card-title' }, [
      el('span', { className: 'swatch', attrs: { style: `background:${swatchBg(style)}`, 'aria-hidden': 'true' } }),
      document.createTextNode(title),
    ]),
    el('div', { className: 'tile-grid' }, tiles),
  ]);
}

function detailList(pairs) {
  const dl = el('dl', { className: 'detail-list' });
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    dl.append(el('dt', { text: k }), el('dd', { text: String(v) }));
  }
  return dl;
}

export async function renderReport(id) {
  const content = $('report-content');
  content.replaceChildren(el('p', { className: 'hint', text: 'Loading run...' }));
  let run;
  try {
    run = await api(`/api/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    content.replaceChildren(el('p', { className: 'status-box error', text: `Could not load run: ${err.message}` }));
    return;
  }

  const local = run.local || {};
  const cloud = run.cloud || {};
  const hasCloud = Boolean(cloud.model);
  const localStyle = seriesStyle(local.model, 'local', precisionOf(run));
  const cloudStyle = seriesStyle(cloud.model, 'cloud');
  const localName = localStyle.name;
  const cloudName = cloudStyle.name;
  const localWords = wordCount(local.output);
  const cloudWords = wordCount(cloud.output);

  const meta = [
    new Date(run.createdAt).toLocaleString(),
    run.environment?.deviceName && `Device: ${run.environment.deviceName}${realIp(run.environment.clientIp) ? ` (${realIp(run.environment.clientIp)})` : ''}`,
    run.label && `Label: ${run.label}`,
    run.image?.name,
    run.image?.width && `${run.image.width}×${run.image.height}`,
    isNum(run.image?.bytes) && fmtBytes(run.image.bytes),
  ].filter(Boolean).join(' · ');

  // Headline comparison tiles
  const headline = el('div', { className: 'kpi-row' }, [
    statTile('Total Latency', speedComparison(local.totalLatencyMs, cloud.totalLatencyMs),
      hasCloud ? `${fmtMs(local.totalLatencyMs)} local vs ${fmtMs(cloud.totalLatencyMs)} cloud` : 'no cloud run', { better: 'lower' }),
    statTile('Time to First Token', speedComparison(local.ttftMs, cloud.ttftMs),
      hasCloud ? `${fmtMs(local.ttftMs)} local vs ${fmtMs(cloud.ttftMs)} cloud` : 'no cloud run', { better: 'lower' }),
    statTile('chrF', fmtScore(run.scores?.chrf), run.reference?.source ? `vs ${run.reference.source === 'cloud' ? cloud.model : 'manual reference'}` : 'no reference', { better: 'higher' }),
    statTile('BLEU-4', fmtScore(run.scores?.bleu4), 'sacreBLEU-compatible, 0–100', { better: 'higher' }),
    statTile('Output Length', `${localWords ?? '–'} vs ${cloudWords ?? '–'} words`, 'local vs cloud', { better: 'context' }),
    statTile('Network Requests', `Local ${isNum(local.networkRequests) ? local.networkRequests : '–'} · Cloud ${hasCloud ? cloud.networkRequests ?? 1 : '–'}`,
      isNum(local.networkRequests) ? 'local measured during inference' : 'local not measured (older run)', { better: 'lower' }),
  ]);

  const cards = el('div', { className: 'model-cards' }, [
    sideCard(localName, localStyle, local.error ? [statTile('Error', 'Failed', local.error)] : [
      statTile('Time to First Token', fmtMs(local.ttftMs), `includes ${fmtMs(local.preprocessMs)} preprocessing`, { better: 'lower' }),
      statTile('Total Latency', fmtMs(local.totalLatencyMs), local.coldStart ? 'cold start (first run after load)' : 'warm run', { better: 'lower' }),
      statTile('Generation Speed', fmtRate(local.tokensPerSec), null, { better: 'higher' }),
      statTile('Output', `${fmtInt(local.outputTokens)} tokens`, `${localWords ?? '–'} words`, { better: 'context' }),
      statTile('Network Requests', isNum(local.networkRequests) ? String(local.networkRequests) : 'Not measured',
        isNum(local.networkRequests)
          ? `measured while the model ran${[
            local.telemetryRequests && `${local.telemetryRequests} crash-log post${local.telemetryRequests === 1 ? '' : 's'} (no image data)`,
            local.appRequests && `${local.appRequests} call${local.appRequests === 1 ? '' : 's'} to this app's server (e.g. fetching the next test image)`,
          ].filter(Boolean).map((t, i) => (i ? ' and ' : ' (not counted: ') + t).join('')}${local.telemetryRequests || local.appRequests ? ')' : ''}`
          : 'older run, before requests were measured', { better: 'lower' }),
      statTile('Data Sent', local.networkRequests === 0 || !isNum(local.networkRequests) ? fmtBytes(local.bandwidthBytes ?? 0) : '–', 'runs entirely on device', { better: 'lower' }),
      statTile('Data Received', fmtBytes(local.networkBytes ?? 0), isNum(local.networkBytes) ? 'during inference' : 'not measured', { better: 'lower' }),
    ]),
    hasCloud
      ? sideCard(cloudName, cloudStyle, cloud.error ? [statTile('Error', 'Failed', cloud.error)] : [
        statTile('Time to First Token', fmtMs(cloud.ttftMs), 'measured on the backend', { better: 'lower' }),
        statTile('Total Latency', fmtMs(cloud.totalLatencyMs), `browser round trip ${fmtMs(cloud.roundTripMs)}`, { better: 'lower' }),
        statTile('Generation Speed', fmtRate(cloud.tokensPerSec), null, { better: 'higher' }),
        statTile('Output', `${fmtInt(cloud.outputTokens)} tokens`, `${cloudWords ?? '–'} words · ${fmtInt(cloud.inputTokens)} input tokens`, { better: 'context' }),
        statTile('Network Requests', String(cloud.networkRequests ?? 1), `outbound to ${cloud.destination || 'api.openai.com'} (third party)`, { better: 'lower' }),
        statTile('Data Sent', fmtBytes(cloud.requestBytes), 'image + prompt sent to the provider', { better: 'lower' }),
        statTile('Data Received', fmtBytes(cloud.responseBytes), isNum(cloud.responseBytes) ? 'streamed response (uncompressed)' : 'not measured (older run)', { better: 'lower' }),
      ])
      : null,
  ]);

  const chart = el('div', { className: 'chart', attrs: { id: 'chart-report' } });
  const chartCard = el('div', { className: 'chart-card' }, [
    el('h3', { text: 'Latency Comparison' }),
    el('p', { className: 'chart-sub', text: 'Milliseconds, lower is faster' }),
    chart,
  ]);

  const outputs = el('div', { className: 'two-col' }, [
    el('div', { className: 'output-card' }, [
      el('h3', { text: `${localName} output` }),
      el('p', { className: 'output-text', text: local.output || local.error || '–' }),
    ]),
    el('div', { className: 'output-card' }, [
      el('h3', { text: run.reference?.source === 'manual' ? 'Manual reference' : `${hasCloud ? cloudName : 'Reference'} output` }),
      el('p', { className: 'output-text', text: run.reference?.text || cloud.output || cloud.error || '–' }),
    ]),
  ]);

  // Dataset runs: the human captions and all three score views
  const datasetCard = run.dataset?.references?.length
    ? el('div', { className: 'output-card' }, [
      el('h3', { text: `VizWiz Human Captions · ${run.dataset.fileName}` }),
      el('ol', { className: 'human-captions' }, run.dataset.references.map((c) => el('li', { text: c }))),
      el('table', { className: 'data-table' }, [el('tbody', {}, [
        el('tr', {}, [el('th', { text: 'Local vs Human Captions (BLEU-4 / chrF)', attrs: { scope: 'row' } }), cell(fmtPair(run.humanScores?.local))]),
        el('tr', {}, [el('th', { text: 'Cloud vs Human Captions', attrs: { scope: 'row' } }), cell(hasCloud ? fmtPair(run.humanScores?.cloud) : 'no cloud baseline')]),
        el('tr', {}, [el('th', { text: 'Local vs Cloud (cloud = baseline)', attrs: { scope: 'row' } }), cell(hasCloud ? fmtPair(run.scores) : '–')]),
      ])]),
    ])
    : null;

  const details = el('details', { className: 'run-details' }, [
    el('summary', { text: 'Run Details' }),
    detailList([
      ['Prompt', run.prompt],
      ['Max new tokens', run.config?.maxNewTokens],
      ['Image splitting', run.config?.imageSplitting ? 'on' : 'off'],
      ['Sampling', run.config?.sampling],
      ['Local model', local.model],
      ['Local precision', precisionOf(run)],
      ['Local file types', local.dtype ? JSON.stringify(local.dtype) : ''],
      ['Local device', local.device],
      ['Ran in', local.runtime === 'worker' ? 'background worker (page stayed responsive)' : local.runtime === 'main-thread' ? 'page main thread (fallback)' : ''],
      ['Low-memory mode', local.lowMemory ? 'on (phone)' : 'off'],
      ['Cloud model (resolved)', cloud.resolvedModel],
      ['Cloud image detail', cloud.detail],
      ['Image source', run.image?.source],
      ['Dataset', run.dataset?.name ? `${run.dataset.name} (${run.dataset.split}) · image ${run.dataset.imageId}` : ''],
      ['Batch ID', run.batchId],
      ['Image SHA-256', run.image?.sha256],
      ['GPU', [run.environment?.gpuVendor, run.environment?.gpuArchitecture, run.environment?.gpuDescription].filter(Boolean).join(' ')],
      ['GPU features', run.environment?.gpuFeatures],
      ['Device name', run.environment?.deviceName],
      ['Client IP', realIp(run.environment?.clientIp) || (run.environment?.clientIp ? 'not available (hidden by Docker networking)' : '')],
      ['Browser', run.environment?.userAgent],
      ['Run ID', run._id],
    ]),
  ]);

  const del = el('button', { className: 'danger-link', text: 'Delete This Run' });
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this run?',
      message: 'This run and its stored test image will be permanently deleted.',
    });
    if (!ok) return;
    try {
      await api(`/api/runs/${run._id}`, { method: 'DELETE' });
      location.hash = '#/results';
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  });

  // The tested image (stored with the run, or the cached VizWiz image)
  const imageCard = el('div', { className: 'output-card report-image-card' }, [
    el('img', { className: 'report-image', attrs: { src: `/api/runs/${run._id}/image`, alt: run.dataset?.references?.[0] ? `Test image. Human caption: ${run.dataset.references[0]}` : 'Test image used for this run', loading: 'lazy' } }),
  ]);
  const img = imageCard.querySelector('img');
  img.addEventListener('error', () => imageCard.replaceChildren(el('p', { className: 'hint', text: 'No image stored for this run (runs saved before images were kept have none).' })));

  const findings = runFindings(run);
  const findingsCard = findings.length
    ? el('div', { className: 'chart-card' }, [el('h3', { text: 'Key Findings' }), el('ul', { className: 'findings-list' }, findings.map((f) => el('li', { text: f })))])
    : null;

  // Batch runs: ‹ › to the other images of the same batch
  let batchNav = null;
  if (run.batchId) {
    batchNav = el('div', { className: 'bv-nav report-batch-nav' });
    api(`/api/runs?batchId=${encodeURIComponent(run.batchId)}&order=asc&limit=200`).then((siblings) => {
      const i = siblings.findIndex((r) => r._id === run._id);
      if (i < 0 || siblings.length < 2) return;
      const go = (j) => { location.hash = `#/run/${siblings[(j + siblings.length) % siblings.length]._id}`; };
      const prev = el('button', { className: 'secondary inline bv-arrow', text: '‹', attrs: { 'aria-label': 'Previous image in this batch' } });
      const next = el('button', { className: 'secondary inline bv-arrow', text: '›', attrs: { 'aria-label': 'Next image in this batch' } });
      prev.addEventListener('click', () => go(i - 1));
      next.addEventListener('click', () => go(i + 1));
      const batchLink = el('a', { className: 'button-link secondary', text: 'Whole Batch', attrs: { href: '#/results' } });
      batchLink.addEventListener('click', () => sessionStorage.setItem('webgpu-slm:results-label', run.label));
      batchNav.replaceChildren(prev, el('span', { className: 'bv-position', text: `Image ${i + 1} of ${siblings.length} in batch "${run.label}"` }), next, batchLink);
    }).catch(() => {});
  }

  content.replaceChildren(
    ...(batchNav ? [batchNav] : []),
    el('p', { className: 'report-meta', text: meta }),
    el('p', { className: 'report-prompt', text: `Prompt: “${run.prompt}”` }),
    imageCard,
    headline,
    ...(findingsCard ? [findingsCard] : []),
    cards,
    chartCard,
    outputs,
    ...(datasetCard ? [datasetCard] : []),
    details,
    del,
  );

  if (hasCloud && !local.error && !cloud.error) {
    barChart(chart, {
      ariaLabel: 'Latency of the local model and the cloud model for this run',
      groups: [
        { label: 'Time to First Token', bars: [
          { ...localStyle, value: local.ttftMs },
          { ...cloudStyle, value: cloud.ttftMs },
        ] },
        { label: 'Total Latency', bars: [
          { ...localStyle, value: local.totalLatencyMs },
          { ...cloudStyle, value: cloud.totalLatencyMs },
        ] },
      ],
      legendItems: [localStyle, cloudStyle],
      format: fmtMs,
    });
  } else {
    barChart(chart, {
      ariaLabel: 'Latency of the local model for this run',
      groups: [
        { label: 'Time to First Token', bars: [{ ...localStyle, value: local.ttftMs ?? null }] },
        { label: 'Total Latency', bars: [{ ...localStyle, value: local.totalLatencyMs ?? null }] },
      ],
      format: fmtMs,
      emptyMessage: 'No timing data for this run.',
    });
  }
}
