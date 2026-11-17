/**
 * Checking URLs we do not own.
 *
 * This is the part of the tool that cannot be trusted, and pretending otherwise
 * is what makes link checkers famous for reporting that MDN is down. So the
 * vocabulary here is deliberately weaker than the one on disk:
 *
 *   broken       the server said the page is gone (404/410/451)
 *   unreachable  we could not get an answer worth believing (timeout, DNS, TLS,
 *                a 403/429/5xx from something protecting itself from a bot)
 *   ok           it answered
 *
 * Only the first is a finding people should fix. The second is reported as a
 * separate number so nobody reads "3 broken links" when two of them were
 * rate limits.
 */

const NOT_FOUND = new Set([404, 410, 451]);
const USER_AGENT = 'linkcheck-md (https://github.com/SleepyE5/linkcheck)';

/** @typedef {{url: string, status: number, result: 'ok'|'broken'|'unreachable', detail: string, ms: number}} ExternalResult */

export function verdict(status, err) {
  if (err) return { result: 'unreachable', detail: describeError(err) };
  if (NOT_FOUND.has(status)) return { result: 'broken', detail: `HTTP ${status}` };
  if (status >= 200 && status < 400) return { result: 'ok', detail: `HTTP ${status}` };
  if (status === 403 || status === 401 || status === 429) {
    // the page may well exist; the server is refusing a client it does not know
    return { result: 'unreachable', detail: `HTTP ${status} (server refused the request)` };
  }
  if (status >= 500) return { result: 'unreachable', detail: `HTTP ${status} (server error)` };
  return { result: 'broken', detail: `HTTP ${status}` };
}

function describeError(err) {
  const name = err?.name ?? 'Error';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  const cause = err?.cause?.code ?? err?.code;
  if (cause) return String(cause);
  return String(err?.message ?? name).slice(0, 120);
}

async function attempt(fetchImpl, url, method, timeoutMs) {
  const res = await fetchImpl(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });
  // a body left unread keeps the connection busy, and a slow server then looks
  // like a timeout on the next URL in the queue
  await res.body?.cancel?.().catch(() => {});
  return res;
}

/**
 * Check one URL. HEAD first, because it is cheap, then GET when the server
 * clearly does not implement it — plenty of static hosts answer 405 to HEAD for
 * a page that exists.
 */
export async function checkUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  try {
    let res = await attempt(fetchImpl, url, 'HEAD', timeoutMs);
    if (res.status === 405 || res.status === 501 || res.status === 400) {
      res = await attempt(fetchImpl, url, 'GET', timeoutMs);
    }
    const v = verdict(res.status);
    return { url, status: res.status, ...v, ms: Date.now() - started };
  } catch (err) {
    return { url, status: 0, ...verdict(0, err), ms: Date.now() - started };
  }
}

/** Run many checks with a bounded number in flight, preserving input order. */
export async function checkUrls(urls, { concurrency = 8, ...opts } = {}) {
  const list = [...new Set(urls)];
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await checkUrl(list[i], opts);
    }
  });
  await Promise.all(workers);
  return out;
}
