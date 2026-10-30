// Batch viewer: step through the runs of one dataset batch with ‹ › arrows.
// Shows the photo, human captions, both descriptions and the three score views.
import { el, isNum, fmtMs, shortModel, wordCount } from './common.js';

const pair = (s) => (s && (isNum(s.bleu4) || isNum(s.chrf)) ? `${isNum(s.bleu4) ? s.bleu4.toFixed(1) : '–'} / ${isNum(s.chrf) ? s.chrf.toFixed(1) : '–'}` : '–');

function scoreRow(label, value) {
  return el('tr', {}, [el('th', { text: label, attrs: { scope: 'row' } }), el('td', { text: value })]);
}

function outputBlock(title, output, meta) {
  return el('div', { className: 'bv-output' }, [
    el('h4', { text: title }),
    el('p', { className: 'output-text', text: output || '–' }),
    el('p', { className: 'hint', text: meta }),
  ]);
}

/**
 * runs: batch runs, oldest first. Returns { show(index) }.
 * options.title: heading text; options.onChange(index): called when the shown run changes
 */
export function renderBatchViewer(container, runs, { index = 0, title = 'Batch viewer', onChange } = {}) {
  let current = Math.min(Math.max(index, 0), runs.length - 1);
  const prev = el('button', { className: 'secondary inline bv-arrow', text: '‹', attrs: { 'aria-label': 'Previous image' } });
  const next = el('button', { className: 'secondary inline bv-arrow', text: '›', attrs: { 'aria-label': 'Next image' } });
  const position = el('span', { className: 'bv-position', attrs: { 'aria-live': 'polite' } });
  const reportLink = el('a', { className: 'button-link secondary', text: 'Open Run Report' });
  const body = el('div', { className: 'bv-body' });

  function show(i) {
    current = (i + runs.length) % runs.length; // wrap around at both ends
    const run = runs[current];
    const local = run.local || {};
    const cloud = run.cloud || {};
    position.textContent = `Image ${current + 1} of ${runs.length} · ${run.dataset?.fileName || run.image?.name || ''}`;
    reportLink.href = `#/run/${run._id}`;

    const image = el('img', { className: 'bv-image', attrs: { src: `/api/runs/${run._id}/image`, alt: run.dataset?.references?.[0] ? `Test image. Human caption: ${run.dataset.references[0]}` : 'Test image', loading: 'lazy' } });
    image.addEventListener('error', () => image.replaceWith(el('p', { className: 'hint', text: 'No image stored for this run.' })));

    const hasCloud = Boolean(cloud.model);
    body.replaceChildren(
      el('div', { className: 'bv-left' }, [
        image,
        ...(run.dataset?.references?.length
          ? [el('h4', { text: 'Human Captions' }), el('ol', { className: 'human-captions' }, run.dataset.references.map((c) => el('li', { text: c })))]
          : []),
      ]),
      el('div', { className: 'bv-right' }, [
        // The exact prompt both models received for this image
        el('div', { className: 'bv-prompt' }, [el('h4', { text: 'Prompt' }), el('p', { text: run.prompt || '–' })]),
        outputBlock(`${shortModel(local.model)} (Local)`, local.error ? `Error: ${local.error}` : local.output,
          `${fmtMs(local.totalLatencyMs)} total · first word ${fmtMs(local.ttftMs)} · ${wordCount(local.output) ?? 0} words`),
        hasCloud
          ? outputBlock(`${cloud.model} (Cloud)`, cloud.error ? `Error: ${cloud.error}` : cloud.output,
            `${fmtMs(cloud.totalLatencyMs)} total · first word ${fmtMs(cloud.ttftMs)} · ${wordCount(cloud.output) ?? 0} words`)
          : null,
        el('table', { className: 'data-table' }, [el('tbody', {}, [
          // Uploaded images have no human captions: only the local-vs-cloud comparison applies
          ...(run.dataset?.references?.length
            ? [
              scoreRow('Local vs Human Captions (BLEU-4 / chrF)', pair(run.humanScores?.local)),
              scoreRow('Cloud vs Human Captions', hasCloud ? pair(run.humanScores?.cloud) : 'no cloud baseline'),
            ]
            : []),
          scoreRow('Local vs Cloud (BLEU-4 / chrF, cloud = baseline)', hasCloud ? pair(run.scores) : 'no cloud baseline'),
        ])]),
      ]),
    );
    // Crossfade to the new image
    body.classList.remove('bv-swap');
    void body.offsetWidth;
    body.classList.add('bv-swap');
    onChange?.(current, run);
  }

  prev.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => show(current + 1));
  // Arrows on the left, report button on the right; the position line sits below them
  const nav = el('div', { className: 'bv-nav' }, [prev, next, reportLink]);
  nav.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(current - 1);
    if (e.key === 'ArrowRight') show(current + 1);
  });
  prev.disabled = next.disabled = runs.length < 2;

  container.setAttribute('aria-label', title);
  container.replaceChildren(nav, position, body);
  show(current);
  return { show };
}
