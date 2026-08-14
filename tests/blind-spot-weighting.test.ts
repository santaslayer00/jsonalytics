import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveSignals } from '../src/utils/auditLogic.ts';

// Regression test for a real gap surfaced when the user asked "if my store
// isn't connected to GTM does it matter" — GTM and GA4 are alternative
// paths to the same goal (GA4 can run directly via gtag.js, no GTM
// container needed), so treating "no GTM" as an independent penalty on top
// of "no GA4" double-counted one real gap as two.

test('GA4 present without GTM is NOT penalized as if analytics were entirely missing', () => {
  const noGtmButGa4 = resolveEffectiveSignals(
    { gtmId: null, gtmIdsAll: [], ga4Id: 'G-REAL123456', hasMetaPixel: true, hasTiktokPixel: true },
    null
  );
  // Only the (legitimate) absence of GTM itself should register — not a
  // "core analytics missing" penalty, since GA4 already covers that goal.
  assert.equal(noGtmButGa4.blindSpotPct, 0, 'GA4 alone, with Meta+TikTok also present, should show a clean 0% blind spot');
});

test('missingSignalCount stays an honest literal count even though the score does not double-penalize', () => {
  const noGtmButGa4 = resolveEffectiveSignals(
    { gtmId: null, gtmIdsAll: [], ga4Id: 'G-REAL123456', hasMetaPixel: false, hasTiktokPixel: false },
    null
  );
  // GTM, Meta, TikTok are all literally absent -> 3, regardless of score weighting.
  assert.equal(noGtmButGa4.missingSignalCount, 3, 'the literal count of what is absent must stay honest');
});

test('neither GTM nor GA4 present still triggers the full core-analytics penalty', () => {
  const nothing = resolveEffectiveSignals({ gtmId: null, gtmIdsAll: [], ga4Id: null, hasMetaPixel: false, hasTiktokPixel: false }, null);
  assert.equal(nothing.blindSpotPct, 100);
});

test('GTM present without GA4 is equally not double-penalized (symmetric fix, not GA4-favoritism)', () => {
  const gtmOnly = resolveEffectiveSignals(
    { gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], ga4Id: null, hasMetaPixel: true, hasTiktokPixel: true },
    null
  );
  assert.equal(gtmOnly.blindSpotPct, 0);
});
