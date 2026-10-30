// Network measurement shared by the page and the inference worker (no DOM, no transformers.js).

// Splits Resource Timing entries into crash-log posts, the app's own backend calls, and
// everything else (the traffic that counts against local inference)
export function classifyRequests(entries, here) {
  const own = (e) => {
    const url = new URL(e.name, here.href);
    return url.origin === here.origin && url.pathname.startsWith('/api/') ? url.pathname : null;
  };
  const telemetry = entries.filter((e) => own(e)?.startsWith('/api/diagnostics'));
  const app = entries.filter((e) => own(e) && !own(e).startsWith('/api/diagnostics'));
  const traffic = entries.filter((e) => !own(e));
  return {
    networkRequests: traffic.length,
    networkBytes: traffic.reduce((sum, e) => sum + (e.transferSize || e.encodedBodySize || 0), 0),
    telemetryRequests: telemetry.length,
    appRequests: app.length,
  };
}
