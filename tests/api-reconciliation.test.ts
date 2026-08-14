import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLiveApiEvidence } from '../src/utils/auditLogic.ts';
import type { DeepScanResult } from '../src/utils/auditLogic.ts';

function baseDeep(overrides: Partial<DeepScanResult> = {}): DeepScanResult {
  return {
    url: 'https://example.com',
    dataLayer: [],
    dataLayerPresent: true,
    consent: { found: false, raw: null },
    trackingRequestsSeen: [],
    eventEvidence: [],
    trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, serverSideEndpointCandidates: [] },
    observedIds: { ga4: [], gtm: [] },
    note: '',
    ...overrides,
  };
}

const okResult = { metrics: { ga4Active: true } } as any;

test('GTM connected but not found in the operator account is flagged, not silently ignored', () => {
  const findings = reconcileLiveApiEvidence(okResult, null, { matched: false }, null);
  assert.ok(findings.some((f) => f.tone === 'warn' && /not found among the containers/i.test(f.text)));
});

test('GA4 reports conversions with no ecommerce dataLayer evidence -> hedged warning, not an accusation', () => {
  const deep = baseDeep({ eventEvidence: [] }); // no ecommerce fields observed
  const findings = reconcileLiveApiEvidence(okResult, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 250 }, null, deep);
  const f = findings.find((x) => /conversions/.test(x.text));
  assert.ok(f);
  assert.equal(f!.tone, 'warn');
  assert.match(f!.text, /isn't a contradiction by itself/i, 'must not overclaim from homepage-only evidence');
});

test('GA4 reports conversions and storefront evidence backs it up -> good tone, still recommends cross-checking', () => {
  const deep = baseDeep({ eventEvidence: [{ event: 'dl_user_data', ecommerceFields: ['currencyCode', 'cart_contents'], evidence: 'observed-on-page-load' }] });
  const findings = reconcileLiveApiEvidence(okResult, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 250 }, null, deep);
  const f = findings.find((x) => /conversions/.test(x.text));
  assert.equal(f!.tone, 'good');
});

test('0 GA4 sessions with a tag detected is hedged for a dev/test store, not asserted as broken', () => {
  const findings = reconcileLiveApiEvidence(okResult, { sessions: 0, totalUsers: 0, conversions: 0, purchaseRevenue: 0 }, null, null);
  const f = findings.find((x) => /0 sessions/.test(x.text));
  assert.ok(f);
  assert.match(f!.text, /dev\/test store/i);
});

test('no live data at all -> no findings, not fabricated ones', () => {
  const findings = reconcileLiveApiEvidence(okResult, null, null, null);
  assert.equal(findings.length, 0);
});

// Was previously just a suggestion ("cross-check this yourself") — both
// numbers are already in scope, so it should be a real computed comparison.
test('GA4 revenue is actually compared against confirmed Shopify revenue, not just suggested as a manual step', () => {
  const resultWithRevenue = { metrics: { ga4Active: true, grossRevenue: 10_000 } } as any;
  const deep = baseDeep({ eventEvidence: [{ event: 'purchase', ecommerceFields: ['value'], evidence: 'observed-on-page-load' }] });
  const findings = reconcileLiveApiEvidence(resultWithRevenue, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 12_000 }, null, deep);
  const comparison = findings.find((f) => /vs\. confirmed Shopify revenue/.test(f.text));
  assert.ok(comparison, 'expected an explicit GA4-vs-Shopify comparison finding');
  assert.match(comparison!.text, /\+20%/, 'should compute the actual percentage difference, not just flag that one exists');
});

test('the revenue comparison never asserts a pass/fail threshold — always hedged, always "warn"', () => {
  // Even a near-perfect match should not be silently upgraded to "good" —
  // no invented threshold for what counts as "close enough."
  const resultWithRevenue = { metrics: { ga4Active: true, grossRevenue: 10_000 } } as any;
  const findings = reconcileLiveApiEvidence(resultWithRevenue, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 10_010 }, null, null);
  const comparison = findings.find((f) => /vs\. confirmed Shopify revenue/.test(f.text));
  assert.equal(comparison!.tone, 'warn');
  assert.match(comparison!.text, /same date range/i);
});

test('formatCurrency/region actually flows through this function — not hard-coded to $', () => {
  const resultWithRevenue = { metrics: { ga4Active: true, grossRevenue: 10_000 } } as any;
  const findings = reconcileLiveApiEvidence(resultWithRevenue, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 12_000 }, null, null, 'IN');
  const comparison = findings.find((f) => /vs\. confirmed Shopify revenue/.test(f.text));
  assert.match(comparison!.text, /₹/, 'IN region should render rupee symbol, not a hard-coded $');
});

test('no comparison is fabricated when either revenue figure is zero/missing', () => {
  const resultNoRevenue = { metrics: { ga4Active: true, grossRevenue: 0 } } as any;
  const findings = reconcileLiveApiEvidence(resultNoRevenue, { sessions: 10, totalUsers: 8, conversions: 3, purchaseRevenue: 5000 }, null, null);
  assert.equal(findings.some((f) => /vs\. confirmed Shopify revenue/.test(f.text)), false);
});
