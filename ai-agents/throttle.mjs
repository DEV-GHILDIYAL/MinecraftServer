// Preloaded into every agent process (NODE_OPTIONS=--import). Wraps global fetch so every model API call
// first asks the runner's gate for a slot, which keeps all agents together under the API key's free-tier limits.
// A 429 is never passed to the harness: it would treat Gemini's "quota ... billing" text as fatal and quit.
// Instead we tell the gate how long to pause and retry the same request.
const GATE = process.env.AI_GATE_URL;
const MODEL_HOSTS = /^https:\/\/(generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|openrouter\.ai|api\.groq\.com|api\.mistral\.ai|api\.deepseek\.com)\//;
const realFetch = globalThis.fetch;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function gate(pathname, body) {
  try {
    const r = await realFetch(GATE + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return await r.json();
  } catch {
    return { wait: 5000 }; // gate restarting: back off briefly instead of hammering the API
  }
}

// How long to pause after a 429, and whether it is the daily quota (resets at midnight Pacific).
function parse429(text, headers) {
  let daily = false;
  let waitMs = 0;
  try {
    const details = JSON.parse(text)?.error?.details ?? [];
    for (const d of details) {
      for (const v of d.violations ?? []) if (/PerDay/i.test(String(v.quotaId ?? '') + String(v.quotaMetric ?? ''))) daily = true;
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay ?? ''));
      if (m) waitMs = Math.ceil(parseFloat(m[1]) * 1000);
    }
  } catch {}
  if (!daily && /per.?day|daily/i.test(text)) daily = true;
  const ra = Number(headers.get('retry-after'));
  if (!waitMs && ra > 0) waitMs = ra * 1000;
  return { daily, waitMs: Math.min(Math.max(waitMs || 30000, 2000), 15 * 60 * 1000) };
}

if (GATE && typeof realFetch === 'function') {
  globalThis.fetch = async function throttledFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!MODEL_HOSTS.test(String(url))) return realFetch(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (;;) {
      for (;;) {
        const r = await gate('/acquire');
        if (r.ok) break;
        await sleep(Math.min(Math.max(r.wait ?? 1000, 250), 60000), signal);
      }
      const res = await realFetch(input instanceof Request ? input.clone() : input, init);
      if (res.status !== 429) return res;
      const text = await res.text().catch(() => '');
      await gate('/report', parse429(text, res.headers));
    }
  };
}
