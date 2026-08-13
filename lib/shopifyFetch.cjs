// Shopify's Admin REST API rate-limits by a leaky bucket (roughly 2
// req/sec for standard apps). A store with a large order volume needs many
// pages to pull a full date range, and a plain pagination loop with no
// retry would just fail outright on the first 429 partway through — making
// the "store size shouldn't matter" promise false for exactly the stores
// where it matters most. This retries on 429 using Shopify's own
// Retry-After header instead of guessing a backoff.
async function fetchWithRateLimitRetry(url, options = {}, { maxRetries = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = fetch } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(url, options);
    if (res.status !== 429) return res;
    if (attempt === maxRetries) return res; // out of retries — let the caller surface the failure
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : 2;
    await sleep(Math.max(0.5, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 2) * 1000);
  }
}

module.exports = { fetchWithRateLimitRetry };
