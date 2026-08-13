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
