// Crash "flight recorder" for debugging on phones without dev tools.
//
// Every step is sent to the backend immediately (shows up in `docker compose logs backend`)
// and saved in localStorage. If the page is killed in the middle of an operation (e.g. iOS
// ends the tab for using too much memory), the next page load can report where it stopped.

const STORAGE_KEY = 'webgpu-slm:diagnostics';
const MAX_STEPS = 50;

export const sessionId =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const started = performance.now();
let record = { session: sessionId, busy: false, context: {}, steps: [] };
let previous = null;

// Read the previous page's record before this page overwrites it
try {
  previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
} catch {
  previous = null;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable (private mode, quota); the backend copy still works
  }
}

function send(name, data, t) {
  try {
    fetch('/api/diagnostics', {
      method: 'POST',
      keepalive: true, // lets the request finish even if the page is going away
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId, step: name, t, data }),
    }).catch(() => {});
  } catch {
    // Diagnostics must never break the app
  }
}

// Record one step. data should be small (a few fields).
export function step(name, data = null) {
  const t = Math.round(performance.now() - started);
  const payload = data ? { ...record.context, ...data } : { ...record.context };
  record.steps.push({ t, step: name, data: payload });
  if (record.steps.length > MAX_STEPS) record.steps.splice(0, record.steps.length - MAX_STEPS);
  save();
  send(name, payload, t);
}

// Fields attached to every following step (e.g. model and precision)
export function setContext(context) {
  record.context = { ...context };
  save();
}

// Mark whether a load or run is in progress; a page that dies while busy counts as a crash
export function setBusy(busy) {
  record.busy = busy;
  save();
}

// The previous page's record if it ended in the middle of a load or run, otherwise null
export function previousCrash() {
  if (!previous || !previous.busy || !previous.steps?.length) return null;
  return previous;
}

save();

window.addEventListener('error', (e) => {
  step('js-error', { message: String(e.message).slice(0, 300), source: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  step('unhandled-rejection', { message: String(e.reason?.message ?? e.reason).slice(0, 300) });
});
