import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/utils/diagnosticEngine.ts';
import type { SurfaceAuditResult, DeepScanResult } from '../src/utils/auditLogic.ts';

function baseSurface(overrides: Partial<SurfaceAuditResult> = {}): SurfaceAuditResult {
  return {
    url: 'https://example.myshopify.com',
    status: 'ok',
    gtmId: null,
    gtmIdsAll: [],
    ga4Id: null,
    hasMetaPixel: false,
    metaPixelId: null,
    hasTiktokPixel: false,
    tiktokPixelId: null,
    hasCmp: false,
    cmpName: null,
    sslValid: true,
    missingSignalCount: 4,
    blindSpotPct: 100,
    cards: [],
    ...overrides,
  };
}

function baseDeep(overrides: Partial<DeepScanResult> = {}): DeepScanResult {
  return {
    url: 'https://example.myshopify.com',
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

test('no tags anywhere -> critical no-measurement-layer is the earliest failure', () => {
  const report = runDiagnostics(baseSurface(), null);
  assert.equal(report.earliestFailure?.id, 'no-measurement-layer');
  assert.equal(report.earliestFailure?.severity, 'critical');
});

test('GTM/GA4 present but no dataLayer -> tags-without-datalayer beats a lower-severity finding', () => {
  const surface = baseSurface({ gtmId: 'GTM-ABC1234', gtmIdsAll: ['GTM-ABC1234'] });
  const deep = baseDeep({ dataLayerPresent: false, dataLayer: null });
  const report = runDiagnostics(surface, deep);
  assert.ok(report.findings.some((f) => f.id === 'tags-without-datalayer'));
  assert.equal(report.earliestFailure?.id, 'tags-without-datalayer');
});

test('duplicate GTM containers is measured, not inferred, and ranks as high', () => {
  const surface = baseSurface({ gtmId: 'GTM-AAA1111', gtmIdsAll: ['GTM-AAA1111', 'GTM-BBB2222'] });
  const report = runDiagnostics(surface, null);
  const dup = report.findings.find((f) => f.id === 'duplicate-gtm-containers');
  assert.ok(dup);
  assert.equal(dup?.confidence, 'measured');
  assert.equal(dup?.severity, 'high');
});

test('a second GTM container only visible via deep-scan network requests (not static HTML) is still caught', () => {
  // Regression test for a real observed case: static HTML only shows the
  // first-loaded container; a second, chain-loaded container only shows up
  // in the deep-scan network requests. The rule must union both sources.
  const surface = baseSurface({ gtmId: 'GTM-TH8KRSBJ', gtmIdsAll: ['GTM-TH8KRSBJ'] });
  const deep = baseDeep({ observedIds: { ga4: [], gtm: ['GTM-TH8KRSBJ', 'GTM-WWZFMZRX'] } });
  const report = runDiagnostics(surface, deep);
  const dup = report.findings.find((f) => f.id === 'duplicate-gtm-containers');
  assert.ok(dup, 'expected duplicate-gtm-containers to fire using deep-scan evidence even though static HTML only shows one container');
  assert.equal(dup?.requiresDeepScan, true);
});

test('GA4 ID in HTML does not match what is actually firing -> measured mismatch finding', () => {
  const surface = baseSurface({ ga4Id: 'G-DECLARED01' });
  const deep = baseDeep({ trackingSignals: { ga4Requests: 1, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, serverSideEndpointCandidates: [] }, observedIds: { ga4: ['G-DIFFERENT2'], gtm: [] } });
  const report = runDiagnostics(surface, deep);
  const mismatch = report.findings.find((f) => f.id === 'ga4-id-mismatch');
  assert.ok(mismatch, 'expected a mismatch finding when declared and observed GA4 IDs differ');
  assert.equal(mismatch?.confidence, 'measured');
});

test('never claims proof beyond page-load evidence — doesNotProve is always populated', () => {
  const report = runDiagnostics(baseSurface({ gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'] }), baseDeep());
  for (const finding of report.findings) {
    assert.ok(finding.doesNotProve.length > 10, `finding ${finding.id} must state what it does not prove`);
  }
});

test('clean evidence with no deep scan yields a hedged, non-blocking result, not a false-positive failure', () => {
  const surface = baseSurface({ gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'], ga4Id: 'G-Y', hasCmp: true, cmpName: 'OneTrust' });
  const report = runDiagnostics(surface, null);
  assert.equal(report.earliestFailure, null);
  assert.equal(report.evidenceDepth, 'surface-only');
});

// Consolidated here (was a separate, parallel check in auditLogic.ts) so
// there is exactly one place tracking-evidence findings come from,
// regardless of whether Tab 1 (no manual IDs) or Tab 2 (operator-supplied
// IDs) is asking.
test('a manually-supplied GTM ID that matches nothing in evidence is a measured mismatch, not a guess', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'] });
  const report = runDiagnostics(surface, null, { gtmId: 'GTM-WRONG002' });
  const mismatch = report.findings.find((f) => f.id === 'manual-gtm-mismatch');
  assert.ok(mismatch);
  assert.equal(mismatch?.confidence, 'measured');
  assert.match(mismatch!.observed.join(' '), /GTM-REAL0001/);
});

test('a manually-supplied GTM ID that DOES match evidence produces no mismatch finding', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'] });
  const report = runDiagnostics(surface, null, { gtmId: 'gtm-real0001' }); // case-insensitive
  assert.equal(report.findings.some((f) => f.id === 'manual-gtm-mismatch'), false);
});

test('no manual IDs supplied at all (Tab 1) never produces a manual-mismatch finding', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'] });
  const report = runDiagnostics(surface, null, null);
  assert.equal(report.findings.some((f) => f.id === 'manual-gtm-mismatch' || f.id === 'manual-ga4-mismatch'), false);
});

test('a manually-supplied GA4 ID mismatch is caught even when static HTML never declared a GA4 ID (only deep scan observed one)', () => {
  const surface = baseSurface(); // no static ga4Id at all
  const deep = baseDeep({ observedIds: { ga4: ['G-OBSERVED1'], gtm: [] } });
  const report = runDiagnostics(surface, deep, { ga4Id: 'G-SUPPLIEDWRONG' });
  const mismatch = report.findings.find((f) => f.id === 'manual-ga4-mismatch');
  assert.ok(mismatch, 'expected mismatch using deep-scan-observed GA4 ID even with no static declaration');
});

test('a manually-supplied ID with zero evidence to compare against does not fire — no-measurement-layer already covers that case', () => {
  const surface = baseSurface(); // nothing detected anywhere
  const report = runDiagnostics(surface, null, { gtmId: 'GTM-ANYTHING' });
  assert.equal(report.findings.some((f) => f.id === 'manual-gtm-mismatch'), false);
  assert.equal(report.earliestFailure?.id, 'no-measurement-layer');
});
