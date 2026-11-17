import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, checkUrls, verdict } from '../src/external.js';

const ok = { body: { cancel: async () => {} } };
const stub = (handler) => async (url, init) => handler(new URL(url), init);

test('a 200 is ok and a redirect that lands is ok', () => {
  assert.equal(verdict(200).result, 'ok');
  assert.equal(verdict(301).result, 'ok');
});

test('only codes that mean "gone" are broken', () => {
  for (const s of [404, 410, 451]) assert.equal(verdict(s).result, 'broken', `${s}`);
  // 403 and 429 are a server protecting itself from a checker, not a dead page
  for (const s of [401, 403, 429]) assert.equal(verdict(s).result, 'unreachable', `${s}`);
  for (const s of [500, 502, 503]) assert.equal(verdict(s).result, 'unreachable', `${s}`);
});

test('a network failure is never reported as a broken link', () => {
  const v = verdict(0, Object.assign(new Error('boom'), { cause: { code: 'ENOTFOUND' } }));
  assert.equal(v.result, 'unreachable');
  assert.equal(v.detail, 'ENOTFOUND');
  assert.equal(verdict(0, Object.assign(new Error('x'), { name: 'TimeoutError' })).detail, 'timed out');
});

test('HEAD is preferred, GET is used when the server does not speak HEAD', async () => {
  const seen = [];
  const fetchImpl = stub((url, init) => {
    seen.push(init.method);
    if (init.method === 'HEAD') return Promise.resolve({ status: 405, body: ok.body });
    return Promise.resolve({ status: 200, body: ok.body });
  });
  const r = await checkUrl('https://example.com/x', { fetchImpl });
  assert.deepEqual(seen, ['HEAD', 'GET']);
  assert.equal(r.result, 'ok');
});

test('a 404 is not retried with GET', async () => {
  const seen = [];
  const fetchImpl = stub((url, init) => {
    seen.push(init.method);
    return Promise.resolve({ status: 404, body: ok.body });
  });
  const r = await checkUrl('https://example.com/gone', { fetchImpl });
  assert.deepEqual(seen, ['HEAD']);
  assert.equal(r.result, 'broken');
  assert.equal(r.status, 404);
});

test('a thrown request still produces a result, not a rejected run', async () => {
  const fetchImpl = stub(() => Promise.reject(Object.assign(new Error('nope'), { code: 'ECONNRESET' })));
  const r = await checkUrl('https://example.com', { fetchImpl });
  assert.equal(r.result, 'unreachable');
  assert.equal(r.detail, 'ECONNRESET');
  assert.equal(r.status, 0);
});

test('every request carries a timeout and an identifiable user agent', async () => {
  let headers, signal;
  const fetchImpl = stub((url, init) => {
    headers = init.headers;
    signal = init.signal;
    return Promise.resolve({ status: 200, body: ok.body });
  });
  await checkUrl('https://example.com', { fetchImpl, timeoutMs: 1234 });
  assert.match(headers['user-agent'], /^linkcheck-md/);
  // a request without a signal is a run that hangs until CI times out
  assert.ok(signal instanceof AbortSignal, 'expected an AbortSignal on the request');
  assert.equal(signal.aborted, false);
});

test('duplicate URLs are asked once', async () => {
  let calls = 0;
  const fetchImpl = stub(() => { calls++; return Promise.resolve({ status: 200, body: ok.body }); });
  const rs = await checkUrls(['https://a.test/', 'https://a.test/', 'https://b.test/'], { fetchImpl });
  assert.equal(calls, 2);
  // one answer per distinct URL; the caller keys the report by r.url
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map(r => r.url), ['https://a.test/', 'https://b.test/']);
});

test('results come back in input order whatever finishes first', async () => {
  const fetchImpl = stub((url) => new Promise((res) => {
    setTimeout(() => res({ status: 200, body: ok.body }), url.pathname === '/slow' ? 30 : 1);
  }));
  const rs = await checkUrls(
    ['https://t.test/slow', 'https://t.test/fast', 'https://t.test/fast2', 'https://t.test/fast3'],
    { fetchImpl, concurrency: 4 }
  );
  assert.deepEqual(rs.map(r => r.url), [
    'https://t.test/slow', 'https://t.test/fast', 'https://t.test/fast2', 'https://t.test/fast3',
  ]);
});

test('the queue stays bounded', async () => {
  let live = 0, peak = 0;
  const fetchImpl = stub(() => {
    live++; peak = Math.max(peak, live);
    return new Promise((res) => setTimeout(() => { live--; res({ status: 200, body: ok.body }); }, 5));
  });
  await checkUrls(Array.from({ length: 20 }, (_, i) => `https://t.test/${i}`), { fetchImpl, concurrency: 3 });
  assert.equal(peak, 3);
});

test('an empty list resolves to an empty list', async () => {
  assert.deepEqual(await checkUrls([], { fetchImpl: stub(() => { throw new Error('called'); }) }), []);
});
