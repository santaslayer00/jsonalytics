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
    hasNativeCmpScript: false,
    sslValid: true,
    missingSignalCount: 4,
    blindSpotPct: 100,
    cards: [],
    hasLegacyUa: false,
    legacyUaId: null,
    hasPinterestTag: false,
    pinterestTagId: null,
    hasSnapchatPixel: false,
    snapchatPixelId: null,
    hasMicrosoftUet: false,
    contactSignals: { socialLinks: [], contactEmail: null, aboutOrContactPageUrl: null },
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
    trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] },
    observedIds: { ga4: [], gtm: [] },
    note: '',
    ...overrides,
  };
}

// Regression test for real user feedback: a static-only scan (deep scan not
// run yet) showing nothing is genuinely weak evidence -- presenting it with
// the same CRITICAL alarm as a thorough check that also confirmed zero
// network requests overclaims what a single shallow pass actually supports.
test('no tags anywhere, deep scan NOT run yet -> a hedged, lower-severity "incomplete" finding, not a false-alarm CRITICAL', () => {
  const report = runDiagnostics(baseSurface(), null);
  assert.equal(report.earliestFailure?.id, 'static-scan-only-inconclusive');
  assert.equal(report.earliestFailure?.severity, 'medium');
  assert.match(report.earliestFailure!.firstCheck, /run the read-only deep scan/i);
});

test('no tags anywhere, deep scan run AND also confirms nothing -> genuinely critical, this is the only case that earns it', () => {
  const deep = baseDeep({ trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] } });
  const report = runDiagnostics(baseSurface(), deep);
  assert.equal(report.earliestFailure?.id, 'no-measurement-layer');
  assert.equal(report.earliestFailure?.severity, 'critical');
  assert.equal(report.earliestFailure?.confidence, 'high');
});

test('"nothing detected" lists multiple possible causes to check, including the Shopify Custom Pixels sandbox blind spot — never picks just one', () => {
  const deep = baseDeep({ trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] } });
  const report = runDiagnostics(baseSurface(), deep);
  const reasons = report.earliestFailure?.possibleReasons;
  assert.ok(reasons && reasons.length >= 3, 'expected multiple candidate causes, not a single guess');
  assert.ok(reasons!.some((r) => /consent/i.test(r.cause)));
  assert.ok(reasons!.some((r) => /Custom Pixels/i.test(r.cause) && /sandbox/i.test(r.cause)));
  // every cause pairs with its own concrete action — Locate+Point isn't enough without a Guide per cause
  for (const r of reasons!) {
    assert.ok(r.howToCheck.length > 10, `cause "${r.cause}" is missing a concrete howToCheck`);
  }
});

test('GTM/GA4 present but no dataLayer -> tags-without-datalayer beats a lower-severity finding', () => {
  const surface = baseSurface({ gtmId: 'GTM-ABC1234', gtmIdsAll: ['GTM-ABC1234'], ga4Id: 'G-ABC1234' });
  const deep = baseDeep({ dataLayerPresent: false, dataLayer: null });
  const report = runDiagnostics(surface, deep);
  assert.ok(report.findings.some((f) => f.id === 'tags-without-datalayer'));
  assert.equal(report.earliestFailure?.id, 'tags-without-datalayer');
  const finding = report.findings.find((f) => f.id === 'tags-without-datalayer')!;
  assert.ok(finding.possibleReasons!.length >= 3);
  assert.ok(finding.possibleReasons!.some((r) => /app/i.test(r.cause))); // app-injected dataLayer is guided externally, not diagnosed
  assert.ok(finding.possibleReasons!.some((r) => /sandbox/i.test(r.cause)));
});

test('GTM declared but not observed firing -> possible reasons include timing, consent, and unpublished container, each with its own check', () => {
  const surface = baseSurface({ gtmId: 'GTM-ABC1234', gtmIdsAll: ['GTM-ABC1234'] });
  const deep = baseDeep();
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'gtm-declared-not-observed')!;
  assert.ok(finding, 'expected gtm-declared-not-observed to fire');
  assert.equal(finding.possibleReasons!.length, 3);
  for (const r of finding.possibleReasons!) {
    assert.ok(r.howToCheck.length > 10);
  }
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
  const deep = baseDeep({ trackingSignals: { ga4Requests: 1, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] }, observedIds: { ga4: ['G-DIFFERENT2'], gtm: [] } });
  const report = runDiagnostics(surface, deep);
  const mismatch = report.findings.find((f) => f.id === 'ga4-id-mismatch');
  assert.ok(mismatch, 'expected a mismatch finding when declared and observed GA4 IDs differ');
  assert.equal(mismatch?.confidence, 'measured');
});

test('a legacy Universal Analytics snippet is flagged as clutter, not a tracking failure — info severity, never blocks', () => {
  const surface = baseSurface({ gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'], ga4Id: 'G-Y', hasCmp: true, cmpName: 'OneTrust', hasLegacyUa: true, legacyUaId: 'UA-12345678-1' });
  const report = runDiagnostics(surface, null);
  const uaFinding = report.findings.find((f) => f.id === 'legacy-ua-present');
  assert.ok(uaFinding, 'expected a legacy-ua-present finding when hasLegacyUa is true');
  assert.equal(uaFinding?.severity, 'info');
  assert.match(uaFinding!.observed.join(' '), /UA-12345678-1/);
  assert.match(uaFinding!.doesNotProve, /July 2023/);
  assert.notEqual(report.earliestFailure?.id, 'legacy-ua-present'); // info-level, never the "point to first"
});

test('no legacy UA snippet present produces no such finding', () => {
  const surface = baseSurface({ gtmId: 'GTM-X', gtmIdsAll: ['GTM-X'], hasLegacyUa: false });
  const report = runDiagnostics(surface, null);
  assert.equal(report.findings.some((f) => f.id === 'legacy-ua-present'), false);
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

test('a manually-supplied ID with zero evidence to compare against does not fire — the no-evidence-at-all finding already covers that case', () => {
  const surface = baseSurface(); // nothing detected anywhere
  const report = runDiagnostics(surface, null, { gtmId: 'GTM-ANYTHING' });
  assert.equal(report.findings.some((f) => f.id === 'manual-gtm-mismatch'), false);
  assert.equal(report.earliestFailure?.id, 'static-scan-only-inconclusive');
});

// Stage 1 (URL-only, no access) must never inject region-based "knowledge" —
// calling runDiagnostics without a region (its default) has to produce the
// same generic compliance language regardless of what region would apply.
test('no-cmp-with-active-tags stays region-blind by default — Stage 1 never names a specific privacy law', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false });
  const report = runDiagnostics(surface, null);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.ok(finding, 'expected the finding to fire');
  assert.doesNotMatch(finding.dependency, /GDPR|CCPA|CPRA|PIPEDA|DPDP|Privacy Act/);
  assert.match(finding.dependency, /Most privacy rules require consent/);
});

// Stage 2 (with access) passes the confirmed region, and only there should
// the finding name the actual applicable law — same observation, sharper
// language, since Stage 2 has a real region to ground it in.
test('no-cmp-with-active-tags names the actual privacy law once a confirmed region is passed in (Stage 2 only)', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false });
  const inReport = runDiagnostics(surface, null, null, 'IN');
  const usReport = runDiagnostics(surface, null, null, 'US');
  const inFinding = inReport.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  const usFinding = usReport.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.match(inFinding.dependency, /DPDP/);
  assert.match(usFinding.dependency, /CCPA\/CPRA/);
  assert.notEqual(inFinding.dependency, usFinding.dependency);
});

// Real gap found live (2026-08-15) scanning magicspoon.com: every tag
// loaded dynamically (nothing in static HTML), deep scan confirmed
// GTM/GA4/Meta/TikTok all firing, no CMP detected — but no-cmp-with-active-
// tags never fired because it only ever checked static evidence for "is
// anything active." Fixed to also count deep-scan-observed requests.
test('no-cmp-with-active-tags fires from deep-scan-observed activity alone — a store with zero static tags but real firing tags is not exempt', () => {
  const surface = baseSurface({ hasCmp: false }); // nothing in static HTML at all
  const deep = baseDeep({ trackingSignals: { ...baseDeep().trackingSignals, ga4Requests: 3, gtmRequests: 1 } });
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags');
  assert.ok(finding, 'expected the finding to fire from deep-scan evidence alone, matching the real magicspoon.com case');
  assert.equal(finding!.requiresDeepScan, true, 'this specific case only exists because of deep-scan evidence, so it should say so');
  assert.match(finding!.observed[0], /deep scan/i);
});

test('no-cmp-with-active-tags still fires normally from static evidence — requiresDeepScan stays false there, unchanged from before', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false });
  const report = runDiagnostics(surface, null);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags');
  assert.ok(finding);
  assert.equal(finding!.requiresDeepScan, false);
});

// Real gap found live (2026-08-29): wilsondorset.com and ripplimpactgear.com
// were both flagged no-cmp-with-active-tags, but their raw HTML actually
// loads Shopify's own consent-tracking-api/Customer Privacy API script —
// a real, checkable signature this rule was blind to, silently treating
// "no third-party CMP" as "no consent handling at all."
test('no-cmp-with-active-tags reorders possibleReasons and softens language when Shopify\'s native consent script is detected', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false, hasNativeCmpScript: true });
  const report = runDiagnostics(surface, null);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.ok(finding, 'expected the finding to still fire — script presence alone does not flip hasCmp');
  assert.match(finding.doesNotProve, /native consent-tracking script/);
  assert.match(finding.possibleReasons[0].cause, /Shopify's own built-in consent banner is enabled/);
  assert.match(finding.observed.join(' '), /consent-tracking-api/);
});

// window.Shopify.customerPrivacy.shouldShowBanner() is a real, documented
// Shopify API — confirmed measured evidence should resolve the ambiguity
// this finding otherwise has to hedge on.
test('no-cmp-with-active-tags resolves the ambiguity with measured confidence when shouldShowBanner() returns true', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false, hasNativeCmpScript: true });
  const deep = baseDeep({ nativeBannerShouldShow: true });
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.match(finding.observed.join(' '), /Measured, not inferred.*shouldShowBanner\(\) returned true/);
  assert.match(finding.doesNotProve, /Shopify's own API confirms the native banner is configured/);
  assert.match(finding.possibleReasons[0].cause, /confirmed configured for this region/);
});

test('no-cmp-with-active-tags keeps the hedged version when shouldShowBanner() returns false or is unavailable', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false, hasNativeCmpScript: true });
  const deepFalse = baseDeep({ nativeBannerShouldShow: false });
  const findingFalse = runDiagnostics(surface, deepFalse).findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.doesNotMatch(findingFalse.observed.join(' '), /Measured, not inferred/);

  const deepNull = baseDeep({ nativeBannerShouldShow: null });
  const findingNull = runDiagnostics(surface, deepNull).findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.doesNotMatch(findingNull.observed.join(' '), /Measured, not inferred/);
});

test('no-cmp-with-active-tags keeps the original generic possibleReasons order when no native script is detected', () => {
  const surface = baseSurface({ gtmId: 'GTM-REAL0001', gtmIdsAll: ['GTM-REAL0001'], hasCmp: false, hasNativeCmpScript: false });
  const report = runDiagnostics(surface, null);
  const finding = report.findings.find((f) => f.id === 'no-cmp-with-active-tags')!;
  assert.match(finding.possibleReasons[0].cause, /Genuinely no consent tool configured anywhere/);
  assert.doesNotMatch(finding.observed.join(' '), /consent-tracking-api/);
});

// Same class of gap, same fix pattern, checked on the sibling rule.
test('tags-without-datalayer fires from deep-scan-observed activity alone, not just a statically-declared ID', () => {
  const surface = baseSurface(); // no gtmId/ga4Id in static HTML
  const deep = baseDeep({ dataLayerPresent: false, trackingSignals: { ...baseDeep().trackingSignals, ga4Requests: 2 } });
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'tags-without-datalayer');
  assert.ok(finding, 'expected the finding to fire — tags are confirmed firing via deep scan even with nothing in static HTML');
  assert.match(finding!.observed[0], /deep scan/i);
});

// Real gap found live (2026-09-05): dazzlingbeautysolution.com had Meta +
// TikTok pixels confirmed but zero GTM and zero GA4 — no-measurement-layer
// stayed silent (it only fires when EVERYTHING is absent) and the only
// findings that showed were the two generic no-CMP ones, since those just
// check "does any tag exist at all." Individually gauging GA4 and GTM closes
// that blind spot.
test('ga4-not-detected-with-partial-tracking fires when other platforms are confirmed but GA4 is confirmed absent', () => {
  const surface = baseSurface({ hasMetaPixel: true, hasTiktokPixel: true });
  const deep = baseDeep({ trackingSignals: { ...baseDeep().trackingSignals, metaBrowserRequests: 2, tiktokBrowserRequests: 1 } });
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'ga4-not-detected-with-partial-tracking');
  assert.ok(finding, 'expected GA4 absence to be called out on its own, not buried under a generic no-CMP finding');
  assert.equal(finding!.severity, 'high');
  assert.equal(report.findings.some((f) => f.id === 'no-measurement-layer'), false, 'no-measurement-layer should not also fire — some tracking IS present');
});

test('gtm-not-detected-with-partial-tracking fires when tags are installed directly with no tag manager', () => {
  const surface = baseSurface({ ga4Id: 'G-DIRECT0001' });
  const deep = baseDeep();
  const report = runDiagnostics(surface, deep);
  const finding = report.findings.find((f) => f.id === 'gtm-not-detected-with-partial-tracking');
  assert.ok(finding, 'expected GTM absence to be called out when a tag is confirmed installed without going through a tag manager');
});

test('neither GA4 nor GTM individual-gauge finding fires when nothing is present at all (no-measurement-layer covers that case instead)', () => {
  const deep = baseDeep({ trackingSignals: { ga4Requests: 0, gtmRequests: 0, metaBrowserRequests: 0, tiktokBrowserRequests: 0, pinterestBrowserRequests: 0, snapchatBrowserRequests: 0, microsoftUetBrowserRequests: 0, serverSideEndpointCandidates: [] } });
  const report = runDiagnostics(baseSurface(), deep);
  assert.equal(report.findings.some((f) => f.id === 'ga4-not-detected-with-partial-tracking'), false);
  assert.equal(report.findings.some((f) => f.id === 'gtm-not-detected-with-partial-tracking'), false);
  assert.equal(report.earliestFailure?.id, 'no-measurement-layer');
});

test('neither individual-gauge finding fires without a deep scan, even if GA4/GTM are missing from static HTML', () => {
  const surface = baseSurface({ hasMetaPixel: true });
  const report = runDiagnostics(surface, null);
  assert.equal(report.findings.some((f) => f.id === 'ga4-not-detected-with-partial-tracking'), false);
  assert.equal(report.findings.some((f) => f.id === 'gtm-not-detected-with-partial-tracking'), false);
});

// Server-side detection was already being captured (serverSideEndpointCandidates)
// but only ever displayed as a text line in the With Access tab, never surfaced
// as an actual Priority Finding. Closing that gap.
test('server-side-tracking-confirmed fires as an info-level positive when a server-side endpoint is observed', () => {
  const deep = baseDeep({ trackingSignals: { ...baseDeep().trackingSignals, serverSideEndpointCandidates: ['gtm.mystore.com/g/collect'] } });
  const report = runDiagnostics(baseSurface({ ga4Id: 'G-REAL0001' }), deep);
  const finding = report.findings.find((f) => f.id === 'server-side-tracking-confirmed');
  assert.ok(finding, 'expected a confirmed server-side finding when a real endpoint is observed');
  assert.equal(finding!.severity, 'info');
  assert.match(finding!.observed[0], /gtm\.mystore\.com/);
});

test('server-side-tracking-confirmed does not fire when no server-side endpoint is observed', () => {
  const deep = baseDeep();
  const report = runDiagnostics(baseSurface({ ga4Id: 'G-REAL0001' }), deep);
  assert.equal(report.findings.some((f) => f.id === 'server-side-tracking-confirmed'), false);
});

test('consent-default-grants-before-interaction adds a server-side-specific possible reason when server-side tracking is also confirmed', () => {
  const consentRaw = { 1: 'default', 2: { ad_storage: 'granted', analytics_storage: 'granted' } };
  const deepWithServerSide = baseDeep({
    consent: { found: true, raw: consentRaw },
    trackingSignals: { ...baseDeep().trackingSignals, serverSideEndpointCandidates: ['gtm.mystore.com/g/collect'] },
  });
  const report = runDiagnostics(baseSurface(), deepWithServerSide);
  const finding = report.findings.find((f) => f.id === 'consent-default-grants-before-interaction')!;
  assert.ok(finding.possibleReasons!.some((r) => /server container needs the consent signal forwarded/.test(r.cause)));

  const deepWithoutServerSide = baseDeep({ consent: { found: true, raw: consentRaw } });
  const reportWithout = runDiagnostics(baseSurface(), deepWithoutServerSide);
  const findingWithout = reportWithout.findings.find((f) => f.id === 'consent-default-grants-before-interaction')!;
  assert.equal(findingWithout.possibleReasons!.some((r) => /server container needs the consent signal forwarded/.test(r.cause)), false);
});
