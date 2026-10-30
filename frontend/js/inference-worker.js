// Runs the model engine in a background thread so the page stays responsive
// (console log, progress bar and streamed text keep updating while the model works).
// Protocol: page -> { id, cmd, args }; worker -> { id, event } while working, then { id, result } or { id, error }.
import * as engine from './engine.js';

const commands = {
  precache: engine.precache,
  load: engine.load,
  warmUp: engine.warmUp,
  generate: engine.generate,
  dispose: engine.dispose,
};

self.addEventListener('message', async ({ data }) => {
  const { id, cmd, args } = data || {};
  if (cmd === 'hello') {
    // Can this worker use WebGPU? (Some browsers only offer it on the page)
    let webgpu = false;
    try {
      webgpu = Boolean(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
    } catch {
      webgpu = false;
    }
    self.postMessage({ id, result: { webgpu } });
    return;
  }
  const run = commands[cmd];
  if (!run) {
    self.postMessage({ id, error: `Unknown command: ${cmd}` });
    return;
  }
  try {
    const result = await run(args || {}, (event) => self.postMessage({ id, event }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
});
