/**
 * AUDIT -> LOCATE -> POINT -> GUIDE
 *
 * Turns raw scan evidence (static HTML signatures + optional read-only deep
 * scan) into ranked, dependency-aware root-cause candidates. This is the
 * piece that stops the app from just saying "GA4 detected" / "GTM detected"
 * and instead answers: what was observed, what does it prove, what does it
 * NOT prove, what's the earliest meaningful failure, and what should the
 * operator check first.
 *
 * Every rule here is gated on real evidence fields from SurfaceAuditResult /
 * DeepScanResult. A rule that needs deep-scan evidence and doesn't have it
 * simply does not fire — it never guesses to fill the gap.
 */

import type { SurfaceAuditResult, DeepScanResult } from './auditLogic';

export type DiagnosticSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type DiagnosticConfidence = 'measured' | 'high' | 'medium' | 'low';

export interface DiagnosticFinding {
  id: string;
  severity: DiagnosticSeverity;
  confidence: DiagnosticConfidence;
  title: string;
  /** What was actually observed, and where (page HTML / page-load network / dataLayer). */
  observed: string[];
  /** What the evidence confirms. */
  proves: string;
  /** Explicit boundary — what this evidence does NOT confirm. */
  doesNotProve: string;
  /** The dependency relationship: what should exist upstream/downstream. */
  dependency: string;
  /** Symptoms further downstream that follow from this if left unfixed. */
  downstreamConsequences: string[];
  /** The concrete first thing the operator should check. */
  firstCheck: string;
  requiresDeepScan: boolean;
}

export interface DiagnosticReport {
  findings: DiagnosticFinding[]; // ranked, most severe first
  earliestFailure: DiagnosticFinding | null; // the "point to first" answer
  evidenceDepth: 'surface-only' | 'surface+deep';
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function runDiagnostics(
  surface: SurfaceAuditResult,
  deep: DeepScanResult | null
): DiagnosticReport {
  const findings: DiagnosticFinding[] = [];
  const hasDeep = !!deep;

  const anyStaticTag = !!(surface.gtmId || surface.ga4Id || surface.hasMetaPixel || surface.hasTiktokPixel);
  const anyObservedRequest = !!deep && (
    deep.trackingSignals.ga4Requests > 0 ||
    deep.trackingSignals.gtmRequests > 0 ||
    deep.trackingSignals.metaBrowserRequests > 0 ||
    deep.trackingSignals.tiktokBrowserRequests > 0
  );

  // R1 — nothing at all
  if (!anyStaticTag && (!hasDeep || !anyObservedRequest)) {
    findings.push({
      id: 'no-measurement-layer',
      severity: 'critical',
      confidence: hasDeep ? 'high' : 'medium',
      title: 'No measurement layer detected on page load',
      observed: [
        'No GTM container ID, GA4 measurement ID, Meta Pixel, or TikTok Pixel signature found in the page HTML.',
        hasDeep ? 'No matching tracking network requests observed during the read-only page-load scan.' : 'Deep scan not yet run — network-request evidence not available.',
      ],
      proves: 'The homepage, as loaded by an unauthenticated visitor, ships no detectable tracking code.',
      doesNotProve: 'This does not prove tracking is absent store-wide — it could be gated behind consent, loaded only on other templates, or blocked by bot protection during this scan.',
      dependency: 'Every downstream metric (attribution, ROAS measurement, retargeting audiences, GA4 reporting) depends on a measurement layer existing first. This is the earliest possible failure — there is nothing upstream of it.',
      downstreamConsequences: [
        'Ad platforms cannot build retargeting audiences.',
        'No GA4/GTM data exists to reconcile against Shopify revenue.',
        'Any financial audit (Tab 2) will have no tracking signal to validate against.',
      ],
      firstCheck: 'Confirm in Shopify Admin whether a GTM container or GA4 tag is configured at all (Online Store > Preferences, or Custom Pixels). If one is configured, re-scan — it may be blocked by this run or gated behind consent-on-load.',
      requiresDeepScan: false,
    });
  }

  // R3 — duplicate GTM containers. Static HTML only shows what's literally in
  // the initial source; a second container chain-loaded by the first (a very
  // common real-world pattern) only shows up in the deep-scan network
  // evidence. Union both sources so a real duplicate isn't missed just
  // because the static regex only ever captures the first-loaded container.
  const allObservedGtmIds = Array.from(new Set([
    ...surface.gtmIdsAll,
    ...(hasDeep ? deep!.observedIds.gtm : []),
  ]));
  if (allObservedGtmIds.length > 1) {
    const seenOnlyInNetwork = hasDeep && deep!.observedIds.gtm.some((id) => !surface.gtmIdsAll.includes(id));
    findings.push({
      id: 'duplicate-gtm-containers',
      severity: 'high',
      confidence: 'measured',
      title: `${allObservedGtmIds.length} distinct GTM containers found`,
      observed: [
        `GTM container IDs found: ${allObservedGtmIds.join(', ')}.`,
        seenOnlyInNetwork
          ? 'At least one of these only appeared in the deep-scan network requests, not the static page source — it is loaded dynamically (e.g. chain-loaded by the first container), which a static-only scan would miss entirely.'
          : 'Source: static page HTML.',
      ],
      proves: 'More than one GTM container is loading on this page.',
      doesNotProve: 'This does not by itself prove double-counted conversions — that depends on whether the same tags are configured to fire in both containers.',
      dependency: 'A single source of truth for tag firing is a precondition for trustworthy GA4/ads numbers. Two containers loading the same tag types is very likely to inflate counts.',
      downstreamConsequences: ['Pageviews, purchases, or both may be double-counted in GA4 and ad-platform reporting, inflating ROAS and hiding the real CAC.'],
      firstCheck: 'Open GTM Preview mode for each container ID and check whether the same tags (e.g. GA4 config, Meta base pixel) are active in more than one.',
      requiresDeepScan: seenOnlyInNetwork,
    });
  }

  // R2 — tags present but no dataLayer (upstream break for ecommerce data)
  if (hasDeep && deep!.dataLayerPresent === false && (surface.gtmId || surface.ga4Id)) {
    findings.push({
      id: 'tags-without-datalayer',
      severity: 'high',
      confidence: 'high',
      title: 'Tracking tags present, but no dataLayer object found',
      observed: [
        surface.gtmId ? `GTM container ${surface.gtmId} present in page HTML.` : `GA4 ID ${surface.ga4Id} present in page HTML.`,
        'window.dataLayer was not an array (or was absent) during the read-only page-load check.',
      ],
      proves: 'The page loads tag infrastructure, but nothing is confirmed to be pushing structured ecommerce data into a dataLayer for it to consume.',
      doesNotProve: 'Basic pageview tracking may still work via gtag/GTM defaults — this specifically threatens ecommerce event data (view_item, add_to_cart, purchase), not tag presence itself.',
      dependency: 'GTM/GA4 ecommerce reporting depends on a populated dataLayer as its input. If the dataLayer is missing, GA4/GTM configuration correctness is irrelevant — there is no data for it to read. This is upstream of any GA4 event-mapping issue.',
      downstreamConsequences: [
        'GA4 ecommerce reports (revenue, items, transaction IDs) will be empty or built from unreliable auto-detected events.',
        'Ad-platform value-based bidding has no revenue signal to optimize against.',
      ],
      firstCheck: 'View page source and check the theme.liquid / checkout scripts for a Shopify dataLayer implementation (native Shopify Analytics, Elevar, or a custom liquid snippet). If none exists, that is the root fix before touching GTM/GA4 configuration.',
      requiresDeepScan: true,
    });
  }

  // R4 — declared in HTML but not observed firing (reconciliation)
  if (hasDeep) {
    if (surface.gtmId && deep!.trackingSignals.gtmRequests === 0 && !deep!.observedIds.gtm.includes(surface.gtmId)) {
      findings.push({
        id: 'gtm-declared-not-observed',
        severity: 'medium',
        confidence: 'medium',
        title: 'GTM container code present, but no container load request observed',
        observed: [`GTM container ${surface.gtmId} found in page HTML.`, 'No googletagmanager.com/gtm.js request for this ID was captured during the page-load scan.'],
        proves: 'The container ID is referenced in the page, but this scan did not observe it actually loading over the network.',
        doesNotProve: 'This can also happen if the scan ran before the script executed, or if consent gating deliberately blocks it before opt-in (which is correct behavior, not a bug).',
        dependency: 'A GTM container must actually load before any tags inside it can fire. If it is not loading, everything configured inside it is a moot point.',
        downstreamConsequences: ['All tags configured inside this GTM container are inactive for visitors who never trigger the load.'],
        firstCheck: 'Open the page in a real browser with DevTools Network tab open and confirm a request to googletagmanager.com/gtm.js?id=' + surface.gtmId + ' actually fires.',
        requiresDeepScan: true,
      });
    }
    if (surface.ga4Id && deep!.trackingSignals.ga4Requests === 0 && !deep!.observedIds.ga4.includes(surface.ga4Id)) {
      findings.push({
        id: 'ga4-declared-not-observed',
        severity: 'medium',
        confidence: 'medium',
        title: 'GA4 measurement ID present, but no matching request observed',
        observed: [`GA4 ID ${surface.ga4Id} found in page HTML.`, 'No collect request carrying this measurement ID was captured during the page-load scan.'],
        proves: 'The measurement ID is referenced in the page but was not confirmed sending data during this scan.',
        doesNotProve: 'Consent-gated tags correctly withholding data pre-opt-in would look identical to this — do not treat this as proof of misconfiguration on its own.',
        dependency: 'GA4 reporting depends on the collect request actually reaching Google with this ID. A declared-but-silent tag produces zero data even though "GA4 is installed."',
        downstreamConsequences: ['GA4 property will show little or no traffic despite the site appearing wired up, which usually gets misdiagnosed as a GA4 account problem instead of a firing problem.'],
        firstCheck: 'Use GA4 DebugView or the Network tab to confirm a request to google-analytics.com/g/collect with tid=' + surface.ga4Id + ' fires on page load.',
        requiresDeepScan: true,
      });
    }
    if (surface.ga4Id && deep!.observedIds.ga4.length > 0 && !deep!.observedIds.ga4.some((id) => id.toUpperCase() === surface.ga4Id!.toUpperCase())) {
      findings.push({
        id: 'ga4-id-mismatch',
        severity: 'high',
        confidence: 'measured',
        title: 'GA4 ID in page HTML does not match the ID actually firing',
        observed: [`Page HTML declares ${surface.ga4Id}.`, `Network requests observed firing with: ${deep!.observedIds.ga4.join(', ')}.`],
        proves: 'Two different GA4 measurement IDs are involved — one referenced statically, a different one actually sending data.',
        doesNotProve: 'Nothing further — this is a direct, measured mismatch, not an inference.',
        dependency: 'Whoever owns GA4 reporting needs to know which property is actually receiving this traffic — it is not the one visible in page source.',
        downstreamConsequences: ['Anyone checking the "obvious" GA4 property (the one in page source) will see no data and wrongly conclude tracking is broken.'],
        firstCheck: `Check GA4 property ${deep!.observedIds.ga4.join(', ')} directly — that is where this traffic is actually landing.`,
        requiresDeepScan: true,
      });
    }
  }

  // R5 — dataLayer present, no events observed (correctly hedged, not a failure)
  if (hasDeep && deep!.dataLayerPresent === true && deep!.eventEvidence.length === 0) {
    findings.push({
      id: 'datalayer-no-events-on-load',
      severity: 'info',
      confidence: 'high',
      title: 'dataLayer exists, but no events were readable on page load',
      observed: ['window.dataLayer is present.', 'No entries with a recognizable event name were found in the first 25 dataLayer pushes captured on load.'],
      proves: 'A dataLayer object exists on the page.',
      doesNotProve: 'This does NOT show whether add_to_cart, view_item, or purchase events fire — those are interaction- or navigation-triggered and cannot appear in a read-only homepage-load scan by design.',
      dependency: 'Event-level validation (add_to_cart, purchase) is a downstream check that requires either a manual guided walkthrough or imported evidence — not something this scan can or should claim.',
      downstreamConsequences: [],
      firstCheck: 'Use the guided checks below (GTM Preview / GA4 DebugView) to validate interaction events manually — do not treat this scan as having ruled them in or out.',
      requiresDeepScan: true,
    });
  }

  // R6 — compliance: tags active, no CMP detected
  if (anyStaticTag && !surface.hasCmp) {
    findings.push({
      id: 'no-cmp-with-active-tags',
      severity: 'medium',
      confidence: 'low',
      title: 'Tracking tags active, no known consent tool detected',
      observed: ['At least one tracking signature (GTM/GA4/Meta/TikTok) found on page load.', 'No known CMP script signature (OneTrust, Cookiebot, CookieYes, etc.) matched in page HTML.'],
      proves: 'No third-party consent-management script from the known signature list was detected.',
      doesNotProve: 'This does NOT confirm a compliance gap — Shopify\'s native consent banner (if enabled in Admin > Customer privacy) is not covered by this signature list and would not be detected here.',
      dependency: 'Regional privacy rules generally require consent before non-essential tracking runs. If tags are active pre-consent, the CMP (or its absence) is the upstream control point — not the individual tags.',
      downstreamConsequences: ['Potential regulatory exposure if tags genuinely fire before consent, depending on the store\'s target markets.'],
      firstCheck: 'Check Shopify Admin > Settings > Customer privacy for the native consent banner, and confirm in GTM whether Consent Mode is wired to gate tags on grant/deny.',
      requiresDeepScan: false,
    });
  }

  // Fallback — nothing blocking found among the rules above
  if (findings.length === 0) {
    findings.push({
      id: 'no-blocking-dependency-issue',
      severity: 'info',
      confidence: hasDeep ? 'medium' : 'low',
      title: 'No page-load blocking issues found',
      observed: ['Tracking signatures present and, where deep-scan evidence exists, reconciled against observed network requests.'],
      proves: 'Nothing in this read-only page-load evidence points to a broken upstream dependency.',
      doesNotProve: 'This does not confirm checkout-level events (add_to_cart, purchase) fire correctly, nor that ad-platform attribution is accurate — those require the guided manual checks or Tab 2 access.',
      dependency: 'Page-load evidence is the shallowest layer of the pipeline. Clear page-load evidence just means the next layer (interaction events, checkout) is where to look next.',
      downstreamConsequences: [],
      firstCheck: 'Proceed to the guided manual checks (GTM Preview, GA4 DebugView, ad-platform diagnostics, Shopify order reconciliation) to validate the parts a page-load scan cannot see.',
      requiresDeepScan: false,
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const earliestFailure = findings.find((f) => f.severity !== 'info') || null;

  return {
    findings,
    earliestFailure,
    evidenceDepth: hasDeep ? 'surface+deep' : 'surface-only',
  };
}
