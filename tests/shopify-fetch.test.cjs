const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithRateLimitRetry } = require('../lib/shopifyFetch.cjs');

function fakeResponse(status, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null } };
}

test('passes through immediately on a non-429 response, no retry needed', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return fakeResponse(200); };
  const res = await fetchWithRateLimitRetry('https://example.com', {}, { fetchImpl, sleep: async () => {} });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test('retries a 429 using the Retry-After header, then succeeds', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return fakeResponse(429, { 'retry-after': '1' });
    return fakeResponse(200);
  };
  const res = await fetchWithRateLimitRetry('https://example.com', {}, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('gives up after maxRetries and returns the last 429 rather than retrying forever', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return fakeResponse(429, { 'retry-after': '0.1' }); };
  const res = await fetchWithRateLimitRetry('https://example.com', {}, { fetchImpl, sleep: async () => {}, maxRetries: 2 });
  assert.equal(res.status, 429);
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test('a missing Retry-After header still backs off with a sane default, not 0', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => { calls++; return calls === 1 ? fakeResponse(429, {}) : fakeResponse(200); };
  await fetchWithRateLimitRetry('https://example.com', {}, { fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.ok(sleeps[0] >= 500, 'must not hammer the API with a 0ms retry when Retry-After is absent');
});
