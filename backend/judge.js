// AI judge: an LLM reviews recent runs side by side (image, local output, cloud output,
// human captions when available, and the measured numbers) and summarizes the pros and
// cons of the local model versus the cloud model for blind users.
//
// Caveat for reporting: the judge is an OpenAI model, as is the cloud baseline, so it may
// favor the cloud model's style. Treat its verdict as qualitative support for the metrics.
const { getClient } = require('./cloud');

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-4o';

const SYSTEM_PROMPT = `You are an accessibility expert evaluating automatic image descriptions written for blind and low-vision users.
For each run you get the photo, the prompt, a LOCAL model's description (a small model running on the user's device), a CLOUD model's description, sometimes human-written reference captions, and measured numbers (latency, word count).

Judge descriptions on: accuracy against the image (no hallucinated objects or text), whether the most useful information for a blind person is included (main object, readable text, colors, hazards), clarity, and appropriate length (concise but complete).
Also weigh practical factors: speed, privacy (the local model sends nothing over the network; the cloud model uploads the photo), and reliability.

Respond with JSON only, in exactly this shape:
{
  "summary": "2-3 sentences comparing local vs cloud overall",
  "verdict": "local_better" | "cloud_better" | "comparable",
  "local": { "pros": ["..."], "cons": ["..."] },
  "cloud": { "pros": ["..."], "cons": ["..."] },
  "per_run": [ { "run": 1, "better": "local" | "cloud" | "tie", "reason": "one short sentence" } ]
}
Give 2-4 specific pros and cons per side and cite run numbers as evidence (e.g. "misread the label in runs 3 and 7").`;

const words = (t) => (t && t.trim() ? t.trim().split(/\s+/).length : 0);
const ms = (v) => (typeof v === 'number' ? `${Math.round(v)} ms` : 'n/a');

/**
 * runs: run documents (newest last), imageFor(run) -> data URL or null
 * Returns { result, usage, model }
 */
async function judgeRuns(runs, imageFor) {
  const openai = getClient();
  if (!openai) throw new Error('OPENAI_API_KEY is not set');

  const content = [{ type: 'text', text: `Here are ${runs.length} runs to compare.` }];
  for (const [i, run] of runs.entries()) {
    const n = i + 1;
    const image = await imageFor(run);
    const lines = [
      `--- Run ${n} ---`,
      `Prompt: ${run.prompt}`,
      `LOCAL (${run.local.model}, ${run.local.precision || run.local.device}): "${run.local.output}" [${words(run.local.output)} words, total ${ms(run.local.totalLatencyMs)}, first token ${ms(run.local.ttftMs)}]`,
      `CLOUD (${run.cloud.model}): "${run.cloud.output}" [${words(run.cloud.output)} words, total ${ms(run.cloud.totalLatencyMs)}, first token ${ms(run.cloud.ttftMs)}]`,
    ];
    if (run.dataset?.references?.length) lines.push(`Human reference captions: ${run.dataset.references.map((c) => `"${c}"`).join('; ')}`);
    if (!image) lines.push('(Photo not available for this run.)');
    content.push({ type: 'text', text: lines.join('\n') });
    if (image) content.push({ type: 'image_url', image_url: { url: image, detail: 'low' } });
  }

  const response = await openai.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  });
  const text = response.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The judge returned invalid JSON');
  }
  const list = (v) => (Array.isArray(v) ? v.map(String).slice(0, 8) : []);
  const verdicts = new Set(['local_better', 'cloud_better', 'comparable']);
  return {
    model: response.model || JUDGE_MODEL,
    usage: { inputTokens: response.usage?.prompt_tokens ?? null, outputTokens: response.usage?.completion_tokens ?? null },
    result: {
      summary: String(parsed.summary || '').slice(0, 2000),
      verdict: verdicts.has(parsed.verdict) ? parsed.verdict : 'comparable',
      local: { pros: list(parsed.local?.pros), cons: list(parsed.local?.cons) },
      cloud: { pros: list(parsed.cloud?.pros), cons: list(parsed.cloud?.cons) },
      perRun: (Array.isArray(parsed.per_run) ? parsed.per_run : []).slice(0, runs.length).map((p) => ({
        run: Number(p.run) || null,
        better: ['local', 'cloud', 'tie'].includes(p.better) ? p.better : 'tie',
        reason: String(p.reason || '').slice(0, 300),
      })),
    },
  };
}

module.exports = { JUDGE_MODEL, judgeRuns };
