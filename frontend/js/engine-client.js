// Page-side access to the model engine. Prefers a background Web Worker so heavy model
// work never freezes the page; falls back to running the engine on the page when module
// workers or WebGPU-in-workers aren't available. Every call works the same either way:
//   const result = await client.call('generate', args, (event) => { ...progress... });

// Testing override in localStorage: "main-thread" forces the fallback; "worker" uses the
// worker even if its WebGPU check fails (e.g. a test browser that fakes WebGPU on the page only)
const FORCE_KEY = 'webgpu-slm:runtime';

function forcedRuntime() {
  try {
    return localStorage.getItem(FORCE_KEY) || '';
  } catch {
    return '';
  }
}

function workerClient(worker) {
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, onEvent }
  let client;
  worker.addEventListener('message', ({ data }) => {
    const job = pending.get(data.id);
    if (!job) {
      // Events after their call finished (e.g. the GPU device is lost later)
      if ('event' in data) client.onStrayEvent?.(data.event);
      return;
    }
    if ('event' in data) {
      job.onEvent?.(data.event);
      return;
    }
    pending.delete(data.id);
    if ('error' in data) job.reject(new Error(data.error));
    else job.resolve(data.result);
  });
  // A crashed worker fails every call still waiting
  worker.addEventListener('error', (e) => {
    for (const job of pending.values()) job.reject(new Error(`Inference worker error: ${e.message || 'crashed'}`));
    pending.clear();
  });
  client = {
    runtime: 'worker',
    onStrayEvent: null,
    call(cmd, args = {}, onEvent) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onEvent });
        worker.postMessage({ id, cmd, args });
      });
    },
    // Ends the worker: frees all of its memory (model weights, WebAssembly heap, GPU buffers)
    terminate() {
      worker.terminate();
      for (const job of pending.values()) job.reject(new Error('Inference worker stopped'));
      pending.clear();
    },
  };
  return client;
}

async function mainThreadClient() {
  const engine = await import('./engine.js');
  return {
    runtime: 'main-thread',
    onStrayEvent: null,
    call: (cmd, args = {}, onEvent) => engine[cmd](args, onEvent),
    terminate() {},
  };
}

/**
 * Creates the engine client. pageHasWebGPU: whether WebGPU works on the page itself;
 * if it does but not inside the worker, the engine runs on the page instead.
 */
export async function createEngineClient({ pageHasWebGPU }) {
  const forced = forcedRuntime();
  if (typeof Worker !== 'undefined' && forced !== 'main-thread') {
    let worker;
    try {
      worker = new Worker('/js/inference-worker.js', { type: 'module' });
      const client = workerClient(worker);
      const hello = await Promise.race([
        client.call('hello'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not start')), 10000)),
      ]);
      if (hello.webgpu || !pageHasWebGPU || forced === 'worker') return client;
      client.terminate(); // WebGPU only works on the page in this browser
    } catch {
      worker?.terminate();
    }
  }
  return mainThreadClient();
}
