import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGa4Properties } from '../src/utils/auditLogic.ts';

// Real bug, caught via live use (2026-08-15): every server error response
// ships both a short `error` label and a real `detail: err.message` (see
// server.cjs), but every fetch helper was only surfacing `error` — turning
// an actionable Google API error ("Analytics Admin API is disabled...")
// into a dead-end generic message with no next step. Fixed via a shared
// errorFromResponseBody() helper; this locks in the fix on one real call
// site so it can't silently regress.
function withMockedFetch(status: number, body: any, fn: () => Promise<void>) {
  const original = global.fetch;
  global.fetch = (async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as any;
  return fn().finally(() => { global.fetch = original; });
}

test('a server error with both error and detail surfaces both to the caller, not just the generic label', async () => {
  await withMockedFetch(500, {
    error: 'Could not list GA4 properties',
    detail: 'Google Analytics Admin API has not been used in project 12345 before or it is disabled.',
  }, async () => {
    await assert.rejects(
      () => fetchGa4Properties(),
      (err: Error) => {
        assert.match(err.message, /Could not list GA4 properties/);
        assert.match(err.message, /Admin API has not been used/);
        return true;
      }
    );
  });
});

test('a server error with only error (no detail) still surfaces cleanly, no "undefined" leaking in', async () => {
  await withMockedFetch(401, { error: 'GA4 not connected yet — visit /api/ga4/auth first' }, async () => {
    await assert.rejects(
      () => fetchGa4Properties(),
      (err: Error) => {
        assert.equal(err.message, 'GA4 not connected yet — visit /api/ga4/auth first');
        assert.doesNotMatch(err.message, /undefined/);
        return true;
      }
    );
  });
});
