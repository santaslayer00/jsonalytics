import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveSignals, buildSurfaceCards } from '../src/utils/auditLogic.ts';
import type { DeepScanResult } from '../src/utils/auditLogic.ts';

function baseDeep(overrides: Partial<DeepScanResult> = {}): DeepScanResult {
  return {
    url: 'https://example.com',
    dataLayer: [],
    dataLayerPresent: true,
    consent: { found: false, raw: null },
    trackingRequestsSeen: [],
    eventEvidence: [],
    trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] },
    observedIds: { ga4: [], gtm: [] },
    note: '',
    ...overrides,
  };
}

// Regression test using the shape of real evidence captured against a live,
// fully-instrumented public Shopify store during manual testing: static HTML
// detection alone reported 0 of GA4/Meta/TikTok while deep scan proved all
// three were actively firing, and a second GTM container only appeared in
// network requests. The whole point of resolveEffectiveSignals is that this
// must not happen.
test('static-only detection missing everything, deep scan proving it is live, produces correct effective signals', () => {
  const staticScan = { gtmId: 'GTM-TH8KRSBJ', gtmIdsAll: ['GTM-TH8KRSBJ'], ga4Id: null, hasMetaPixel: false, hasTiktokPixel: false };
  const deep = baseDeep({
    trackingSignals: { ga4Requests: 9, gtmRequests: 2, metaBrowserRequests: 1, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] },
    observedIds: { ga4: ['G-KB1068K0E6'], gtm: ['GTM-TH8KRSBJ', 'GTM-WWZFMZRX'] },
  });

  const effective = resolveEffectiveSignals(staticScan, deep);

  assert.equal(effective.ga4Detected, true, 'GA4 must be detected once deep scan proves it fired, even though static HTML missed it');
  assert.equal(effective.metaDetected, true, 'Meta Pixel must be detected once deep scan proves it fired');
  assert.equal(effective.gtmIdsAll.length, 2, 'both GTM containers must be counted (union of static + network)');
  // TikTok genuinely was not observed on this real store — 1 missing signal
  // is the correct, honest count, not 0. Evidence should never overclaim.
  assert.equal(effective.missingSignalCount, 1);
  assert.equal(effective.tiktokDetected, false);
  assert.equal(effective.usedDeepEvidence, true);
});

test('without a deep scan, effective signals fall back to static-only (no false confidence)', () => {
  const staticScan = { gtmId: null, gtmIdsAll: [], ga4Id: null, hasMetaPixel: false, hasTiktokPixel: false };
  const effective = resolveEffectiveSignals(staticScan, null);
  assert.equal(effective.usedDeepEvidence, false);
  assert.equal(effective.missingSignalCount, 4);
});

test('ROAS/CAC cards give an evidence-grounded possibility, never a fabricated number', () => {
  const noTracking = { gtmId: null, gtmIdsAll: [], ga4Id: null, hasMetaPixel: false, hasTiktokPixel: false };
  const cards = buildSurfaceCards(resolveEffectiveSignals(noTracking, null), false, null, 'US');
  const roas = cards.find((c) => c.label === 'ROAS');
  const cac = cards.find((c) => c.label === 'CAC');
  assert.match(roas!.value, /Unmeasurable/);
  assert.match(cac!.value, /Unmeasurable/);
  assert.equal(roas!.locked, false); // real evidence exists (tracking absence) — not a blind lock
  assert.doesNotMatch(roas!.value, /\d+(\.\d+)?x/); // never a fake "1.4x"-style number
});

test('RTO/COD/Settlement cards never guess from region alone on Stage 1 — a URL scan has zero public signal for them, same as revenue/margin', () => {
  // A URL-only scan cannot observe RTO/COD/settlement behavior at all —
  // guessing from region alone was the exact "injected knowledge" Stage 1
  // isn't allowed to carry (Stage 2's real, measured businessMetrics array
  // is where region legitimately sharpens interpretation of real numbers).
  const scan = { gtmId: null, gtmIdsAll: [], ga4Id: null, hasMetaPixel: false, hasTiktokPixel: false };
  const effective = resolveEffectiveSignals(scan, null);
  const inCards = buildSurfaceCards(effective, false, null, 'IN');
  const usCards = buildSurfaceCards(effective, false, null, 'US');
  for (const label of ['RTO Rate', 'COD Share', 'Settlement Lag (cash locked)']) {
    const rtoIn = inCards.find((c) => c.label === label)!;
    const rtoUs = usCards.find((c) => c.label === label)!;
    assert.equal(rtoIn.value, rtoUs.value, `${label} must read identically regardless of region on a URL-only scan`);
    assert.equal(rtoIn.value, '', `${label} should carry no status text — the explainer alone speaks for a locked card now`);
    assert.equal(rtoIn.locked, true, `${label} should stay locked — no surface signal exists for it`);
    assert.doesNotMatch(rtoIn.value, /%/); // never a fabricated percentage
  }
});

test('Gross Revenue, Gross Margin, Cash Flow Health, RTO, COD, and Settlement Lag all stay genuinely locked — no surface signal exists for any of them', () => {
  const scan = { gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'], ga4Id: 'G-Y', hasMetaPixel: true, hasTiktokPixel: true };
  const cards = buildSurfaceCards(resolveEffectiveSignals(scan, null), true, 'OneTrust', 'US');
  for (const label of ['Gross Revenue', 'Gross Margin', 'Cash Flow Health', 'RTO Rate', 'COD Share', 'Settlement Lag (cash locked)']) {
    const card = cards.find((c) => c.label === label)!;
    assert.equal(card.locked, true, `${label} should stay locked even with full tracking evidence`);
    assert.equal(card.value, '', `${label} should carry no status text — the explainer alone speaks for a locked card now`);
  }
});

test('buildSurfaceCards Attribution card discloses whether deep evidence was used', () => {
  const staticScan = { gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'], ga4Id: 'G-Y', hasMetaPixel: true, hasTiktokPixel: false };
  const withoutDeep = buildSurfaceCards(resolveEffectiveSignals(staticScan, null), false, null, 'US');
  const withDeep = buildSurfaceCards(resolveEffectiveSignals(staticScan, baseDeep()), false, null, 'US');
  const attrWithout = withoutDeep.find((c) => c.label === 'Attribution');
  const attrWith = withDeep.find((c) => c.label === 'Attribution');
  assert.match(attrWithout!.confidence!, /Public page-load signal only/);
  assert.match(attrWith!.confidence!, /deep scan/i);
});
