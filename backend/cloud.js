// Cloud baseline: sends the image + prompt to OpenAI and times the response.
const OpenAI = require('openai');

const CLOUD_MODELS = ['gpt-4o-mini', 'gpt-4o'];

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// imageDataUrl: "data:image/...;base64,..."
// Timings are measured on the server, so they cover OpenAI's processing plus
// the server <-> OpenAI network, but not the browser <-> server upload.
async function describeImage({ imageDataUrl, prompt, model, maxTokens, detail }) {
  const openai = getClient();
  if (!openai) {
    const err = new Error('OPENAI_API_KEY is not set on the backend. Add it to secrets.env and restart.');
    err.status = 503;
    throw err;
  }

  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      {
        role: 'user',
        // Same order as the local SmolVLM chat template: image first, then the prompt
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl, detail } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
  // Approximate upload size of the request (dominated by the base64 image)
  const requestBytes = Buffer.byteLength(JSON.stringify(body));

  const start = performance.now();
  let firstTokenTime = null;
  let output = '';
  let usage = null;
  let resolvedModel = model;
  // Approximate bytes received: each streamed event is "data: <json>\n\n" (uncompressed)
  let responseBytes = 0;

  const stream = await openai.chat.completions.create(body);
  for await (const chunk of stream) {
    responseBytes += Buffer.byteLength(JSON.stringify(chunk)) + 8;
    if (chunk.model) resolvedModel = chunk.model;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      if (firstTokenTime === null) firstTokenTime = performance.now();
      output += delta;
    }
    if (chunk.usage) usage = chunk.usage;
  }
  const end = performance.now();

  const outputTokens = usage?.completion_tokens ?? null;
  const decodeSeconds = firstTokenTime !== null ? (end - firstTokenTime) / 1000 : 0;
  const tokensPerSec = outputTokens > 1 && decodeSeconds > 0 ? (outputTokens - 1) / decodeSeconds : null;

  return {
    provider: 'openai',
    model,
    resolvedModel,
    detail,
    output: output.trim(),
    ttftMs: firstTokenTime !== null ? firstTokenTime - start : null,
    totalLatencyMs: end - start,
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens,
    tokensPerSec,
    requestBytes,
    responseBytes,
    // Network footprint of one cloud description: one outbound request to a third party
    networkRequests: 1,
    destination: new URL(openai.baseURL).hostname,
  };
}

module.exports = { CLOUD_MODELS, describeImage, isConfigured, getClient };
