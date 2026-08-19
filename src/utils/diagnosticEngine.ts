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
import type { Region } from './constants.ts';
import { REGIONS } from './constants.ts';

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
  /**
   * When a symptom can genuinely come from more than one distinct cause
   * that this scan can't tell apart (e.g. "nothing detected" could mean
   * not installed, blocked by consent, or running in an isolated sandbox
   * this scan can't see into — Shopify Custom Pixels, for one), list them
   * here instead of guessing which one it is. Each cause pairs with its
   * own concrete check — Locate+Point without a matching Guide per cause
   * just leaves the operator staring at a list of possibilities with no
   * next action. Finding which one is actually true is still manual work
   * by design; the app points at the possibilities AND how to test each.
   */
  possibleReasons?: Array<{ cause: string; howToCheck: string }>;
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

export interface ManualIds {
  gtmId?: string | null;
  ga4Id?: string | null;
}

export function runDiagnostics(
  surface: SurfaceAuditResult,
  deep: DeepScanResult | null,
  manual: ManualIds | null = null,
  // Optional on purpose — Stage 1 (URL-only, no access) calls this without a
  // region so its output stays region-blind, per the "no injected knowledge
  // on Stage 1" rule. Stage 2 (with access) passes the confirmed region so
  // findings like no-cmp-with-active-tags can name the actual privacy law
  // that applies, instead of the generic placeholder line below.
  region: Region | null = null
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

  // R1a — thorough check: BOTH static HTML and deep-scan network requests
  // confirm nothing. This is the only case that earns "critical" — it's
  // backed by everything this app can gather.
  if (hasDeep && !anyStaticTag && !anyObservedRequest) {
    findings.push({
      id: 'no-measurement-layer',
      severity: 'critical',
      confidence: 'high',
      title: 'No tracking found on page load',
      observed: [
        'No GTM, GA4, Meta Pixel, or TikTok Pixel code found in the page.',
        'No matching tracking requests seen during the scan.',
      ],
      proves: 'Your homepage sends no detectable tracking code to a visitor — checked two ways: the page source, and the live network requests.',
      doesNotProve: 'This doesn\'t mean tracking is missing everywhere — it could be hidden behind a cookie-consent popup, only added to other pages, or blocked by bot protection during this scan.',
      dependency: 'Everything downstream — attribution, ad performance, GA4 reporting — needs a working tracking layer first. This is the earliest possible failure; nothing comes before it.',
      downstreamConsequences: [
        'Ad platforms can\'t build retargeting audiences.',
        'No GA4/GTM data exists to compare against Shopify revenue.',
        'The financial audit (Tab 2) has no tracking signal to check.',
      ],
      firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
      possibleReasons: [
        {
          cause: 'Not actually installed.',
          howToCheck: 'Check Shopify Admin\'s Custom Pixels section for a saved GTM or GA4 entry. Search: "Shopify Admin custom pixels" if the menu has moved since this was written.',
        },
        {
          cause: 'Installed but blocked by cookie consent — won\'t fire until a visitor opts in.',
          howToCheck: 'Load the page yourself, accept the consent banner, then re-scan. If tracking now appears, consent gating was the cause.',
        },
        {
          cause: 'Installed via Shopify\'s Custom Pixels — these run in an isolated sandboxed worker this scan structurally cannot see into (confirmed against Shopify\'s own docs: sandboxed pixel requests "won\'t be directly visible in standard page source inspection methods"). Zero evidence here does not mean zero activity if this is the setup.',
          howToCheck: 'Open GTM Preview mode (or your sGTM container\'s own debug/preview tool) directly — it reads from your tag manager account, not the page, so it can see past the sandbox this scan can\'t. That said, Preview isn\'t a guarantee of live behavior: some things fire in Preview but not once published (or the reverse), so treat this as a strong signal, not final proof — the real test is checking again after publishing.',
        },
      ],
      requiresDeepScan: false,
    });
  }
  // R1b — static HTML alone shows nothing, but the deep scan hasn't run
  // yet: an INCOMPLETE check, not a confirmed absence. Static-only evidence
  // is genuinely weak — a second GTM container, consent-gated tags, and
  // dynamically-injected pixels routinely never appear in raw page source
  // at all (confirmed on a real store earlier this session). Presenting
  // this with the same "critical, point to first" alarm as the thorough
  // case above would claim more than a single, shallow pass actually
  // supports — this is the exact overclaim the whole engine exists to
  // avoid. Lower severity, and the first action is "go run the deep scan,"
  // not "act on this as if it were settled."
  else if (!hasDeep && !anyStaticTag) {
    findings.push({
      id: 'static-scan-only-inconclusive',
      severity: 'medium',
      confidence: 'low',
      title: 'Nothing found yet — deep scan hasn\'t run',
      observed: [
        'No GTM, GA4, Meta Pixel, or TikTok Pixel code found in the page source.',
        'The deep scan (real network requests, dataLayer, consent) hasn\'t run yet.',
      ],
      proves: 'Only that the raw page source has no visible tracking code.',
      doesNotProve: 'Whether tracking actually exists — this is the weakest evidence this app has. A second GTM container loaded by the first, consent-gated tags, or a pixel added by JavaScript often show nothing in the page source while working fine.',
      dependency: 'The deep scan needs to run before this means anything — don\'t act on this finding until it does.',
      downstreamConsequences: [],
      firstCheck: 'Run the read-only deep scan before concluding anything is missing.',
      possibleReasons: [
        {
          cause: 'Not installed yet, or installed but blocked by consent.',
          howToCheck: 'Run the deep scan below — it captures real network requests and will help tell these two apart.',
        },
        {
          cause: 'Installed via Shopify\'s Custom Pixels — sandboxed, and the deep scan has the same blind spot as this static pass. If the deep scan also comes back empty, that still doesn\'t rule this out.',
          howToCheck: 'Check GTM Preview mode (or your sGTM container\'s own debug/preview tool) directly — it doesn\'t rely on page-source inspection, so it can see past the sandbox. Still only a strong signal, not final proof: Preview can differ from what actually happens once published, so confirm again after publishing.',
        },
      ],
      requiresDeepScan: true,
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
      title: `${allObservedGtmIds.length} GTM containers found on one page`,
      observed: [
        `GTM container IDs found: ${allObservedGtmIds.join(', ')}.`,
        seenOnlyInNetwork
          ? 'At least one of these only showed up in real network requests, not the page source — it loads dynamically, which a static-only scan would miss entirely.'
          : 'Source: static page HTML.',
      ],
      proves: 'More than one GTM container loads on this page.',
      doesNotProve: 'This alone doesn\'t prove double-counted conversions — that depends on whether the same tags fire in both containers.',
      dependency: 'Trustworthy GA4/ads numbers need one clear source of truth for tag firing. Two containers loading the same tags is very likely to inflate counts.',
      downstreamConsequences: ['Pageviews or purchases may be counted twice in GA4 and ad-platform reporting, inflating ROAS and hiding your real cost per acquisition.'],
      firstCheck: 'Open GTM Preview mode for each container ID and check whether the same tags (e.g. GA4, Meta pixel) are active in more than one.',
      requiresDeepScan: seenOnlyInNetwork,
    });
  }

  // R2 — tags present but no dataLayer (upstream break for ecommerce data).
  // "Present" means either declared in static HTML OR confirmed firing via
  // deep-scan network requests — a tag that only ever loads dynamically
  // (never in static HTML, e.g. via Custom Pixels or a tag-management app)
  // is just as real a "tags present" case as one sitting in the page
  // source. This mirrors the exact class of gap found live on a real store
  // (magicspoon.com, 2026-08-15) where every tag loaded dynamically —
  // that store's dataLayer happened to be present so R2 itself wasn't
  // wrong there, but R6 below (same static-only gating pattern) missed a
  // real no-CMP-with-active-tags case. Fixed both while auditing for the
  // same mistake elsewhere.
  if (hasDeep && deep!.dataLayerPresent === false && (surface.gtmId || surface.ga4Id || anyObservedRequest)) {
    findings.push({
      id: 'tags-without-datalayer',
      severity: 'high',
      confidence: 'high',
      title: 'Tracking code is there, but no dataLayer',
      observed: [
        surface.gtmId
          ? `GTM container ${surface.gtmId} present in page HTML.`
          : surface.ga4Id
            ? `GA4 ID ${surface.ga4Id} present in page HTML.`
            : 'Tracking requests (GTM/GA4/Meta/TikTok) observed firing during the deep scan — not present in static HTML, so this only shows up with deep-scan evidence.',
        'window.dataLayer was missing or empty during the scan.',
      ],
      proves: 'The page loads tracking code, but nothing is confirmed to be feeding it structured ecommerce data.',
      doesNotProve: 'Basic pageview tracking may still work — this specifically threatens ecommerce events (view_item, add_to_cart, purchase), not the tags themselves.',
      dependency: 'GA4/GTM ecommerce reports need a populated dataLayer as input. If it\'s missing, GA4/GTM configuration doesn\'t matter yet — there\'s no data for it to read.',
      downstreamConsequences: [
        'GA4 ecommerce reports (revenue, items, order IDs) will be empty or unreliable.',
        'Ad platforms have no revenue signal to optimize bidding against.',
      ],
      firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
      possibleReasons: [
        {
          cause: 'dataLayer genuinely never implemented — no native Shopify Analytics, Elevar, or custom snippet exists.',
          howToCheck: 'Check theme.liquid / checkout scripts for a dataLayer setup. If none exists, that\'s the fix, before touching GTM/GA4 configuration at all.',
        },
        {
          cause: 'Declared in the wrong order — dataLayer must exist before the GTM snippet reads it, and a lot of manual installs get this backwards.',
          howToCheck: 'View page source: window.dataLayer = window.dataLayer || []; must appear above the GTM/gtag script tag, not below it.',
        },
        {
          cause: 'A third-party app (Elevar, or a similar dataLayer-providing app) owns this and isn\'t configured or isn\'t installed correctly.',
          howToCheck: 'This is external to what this app can inspect — check that app\'s own dashboard/settings directly, or its support docs, rather than troubleshooting it through GTM.',
        },
        {
          cause: 'Pushed from inside Shopify\'s Custom Pixels sandbox — those run in an isolated worker with their own scope, so pushes there won\'t appear on window.dataLayer on the main page.',
          howToCheck: 'Check GTM Preview mode (or the pixel\'s own debug tool) directly — it isn\'t limited by the same sandbox this scan is. Treat it as a strong signal, not final proof: Preview can behave differently from what actually runs once published.',
        },
      ],
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
        title: 'GTM code is on the page, but never loaded',
        observed: [`GTM container ${surface.gtmId} found in page HTML.`, 'No googletagmanager.com/gtm.js request for this ID was seen during the scan.'],
        proves: 'The container ID is in the page, but this scan never saw it load over the network.',
        doesNotProve: 'This can also happen if the scan ran before the script fired, or if cookie consent correctly blocked it pre-opt-in — that\'s not a bug.',
        dependency: 'A GTM container has to load before anything inside it can fire. If it\'s not loading, nothing configured inside it matters yet.',
        downstreamConsequences: ['Every tag inside this container is inactive for visitors who never trigger the load.'],
        firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
        possibleReasons: [
          {
            cause: 'Scan timing — the script hadn\'t fired yet when this page load was captured.',
            howToCheck: 'Re-run the deep scan once or twice more; a real installation should fire consistently, not intermittently.',
          },
          {
            cause: 'Blocked by cookie consent, correctly, pre-opt-in — not a bug.',
            howToCheck: 'Load the page yourself, accept the consent banner, then check DevTools Network tab for googletagmanager.com/gtm.js?id=' + surface.gtmId + '.',
          },
          {
            cause: 'The container is genuinely misconfigured or was never actually published in GTM (a draft version, not a live one).',
            howToCheck: 'Open GTM directly and confirm this container has a published, live version — not just a saved draft.',
          },
        ],
        requiresDeepScan: true,
      });
    }
    if (surface.ga4Id && deep!.trackingSignals.ga4Requests === 0 && !deep!.observedIds.ga4.includes(surface.ga4Id)) {
      findings.push({
        id: 'ga4-declared-not-observed',
        severity: 'medium',
        confidence: 'medium',
        title: 'GA4 code is on the page, but never sent data',
        observed: [`GA4 ID ${surface.ga4Id} found in page HTML.`, 'No request carrying this measurement ID was seen during the scan.'],
        proves: 'The measurement ID is on the page but wasn\'t confirmed sending data during this scan.',
        doesNotProve: 'Consent-gated tags correctly withholding data pre-opt-in look identical to this — don\'t treat this as proof of a misconfiguration on its own.',
        dependency: 'GA4 reporting needs that data request to actually reach Google. A tag that\'s "installed" but silent still produces zero data.',
        downstreamConsequences: ['GA4 will show little or no traffic even though the site looks wired up — usually misread as a GA4 account problem instead of a firing problem.'],
        firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
        possibleReasons: [
          {
            cause: 'Scan timing — the tag hadn\'t fired yet when this page load was captured.',
            howToCheck: 'Re-run the deep scan once or twice more; a real installation should fire consistently.',
          },
          {
            cause: 'Blocked by cookie consent, correctly, pre-opt-in — not a bug.',
            howToCheck: 'Load the page yourself, accept the consent banner, then check GA4 DebugView or Network tab for a request to google-analytics.com/g/collect with tid=' + surface.ga4Id + '.',
          },
          {
            cause: 'Routed through server-side GTM/a custom transport_url — the hit may be going to your own server endpoint, not directly to Google, which this scan\'s pattern match may not recognize as GA4 traffic.',
            howToCheck: 'Check your sGTM container\'s own debug/preview tool directly, and confirm the transport_url destination is actually receiving and forwarding the hit.',
          },
        ],
        requiresDeepScan: true,
      });
    }
    if (surface.ga4Id && deep!.observedIds.ga4.length > 0 && !deep!.observedIds.ga4.some((id) => id.toUpperCase() === surface.ga4Id!.toUpperCase())) {
      findings.push({
        id: 'ga4-id-mismatch',
        severity: 'high',
        confidence: 'measured',
        title: 'The GA4 ID on the page isn\'t the one actually firing',
        observed: [`Page HTML declares ${surface.ga4Id}.`, `Network requests observed firing with: ${deep!.observedIds.ga4.join(', ')}.`],
        proves: 'Two different GA4 IDs are involved — one shown in the page, a different one actually sending data.',
        doesNotProve: 'Nothing further — this is a direct, measured mismatch, not an inference.',
        dependency: 'Whoever owns GA4 reporting needs to know which property is actually receiving this traffic — it\'s not the one visible in the page.',
        downstreamConsequences: ['Anyone checking the "obvious" GA4 property will see no data and wrongly assume tracking is broken.'],
        firstCheck: `Check GA4 property ${deep!.observedIds.ga4.join(', ')} directly — that's where this traffic is actually going.`,
        requiresDeepScan: true,
      });
    }
  }

  // R4d/R4e — operator-supplied ID (Tab 2 only) doesn't match what evidence
  // shows. Consolidated here rather than as a separate parallel check in
  // auditLogic.ts, so there is exactly one place tracking-evidence findings
  // come from regardless of which tab is asking. Only fires when evidence
  // actually exists to compare against — an operator ID with nothing
  // detected at all is already covered by no-measurement-layer above.
  if (manual?.gtmId && allObservedGtmIds.length > 0 && !allObservedGtmIds.some((id) => id.toUpperCase() === manual.gtmId!.toUpperCase())) {
    findings.push({
      id: 'manual-gtm-mismatch',
      severity: 'high',
      confidence: 'measured',
      title: 'Your GTM ID doesn\'t match what the evidence shows',
      observed: [`Supplied GTM ID: ${manual.gtmId}.`, `Evidence (static HTML + deep scan, where available) shows: ${allObservedGtmIds.join(', ')}.`],
      proves: 'The GTM ID entered for this audit isn\'t the one actually on this page.',
      doesNotProve: 'Nothing further — this is a direct, measured mismatch, not an inference.',
      dependency: 'Every conclusion in this audit that assumes your ID is correct needs a second look once the right container is confirmed.',
      downstreamConsequences: ['Findings built around the wrong container may point at the wrong fix.'],
      firstCheck: `Double check this is the right store/container — evidence points to ${allObservedGtmIds.join(', ')}, not ${manual.gtmId}.`,
      requiresDeepScan: false,
    });
  }
  {
    const allObservedGa4Ids = Array.from(new Set([
      ...(surface.ga4Id ? [surface.ga4Id] : []),
      ...(hasDeep ? deep!.observedIds.ga4 : []),
    ]));
    if (manual?.ga4Id && allObservedGa4Ids.length > 0 && !allObservedGa4Ids.some((id) => id.toUpperCase() === manual.ga4Id!.toUpperCase())) {
      findings.push({
        id: 'manual-ga4-mismatch',
        severity: 'high',
        confidence: 'measured',
        title: 'Your GA4 ID doesn\'t match what the evidence shows',
        observed: [`Supplied GA4 ID: ${manual.ga4Id}.`, `Evidence (static HTML + deep scan, where available) shows: ${allObservedGa4Ids.join(', ')}.`],
        proves: 'The GA4 ID entered for this audit isn\'t the one actually present/firing on this page.',
        doesNotProve: 'Nothing further — this is a direct, measured mismatch, not an inference.',
        dependency: 'Every conclusion in this audit that assumes your ID is correct needs a second look once the right property is confirmed.',
        downstreamConsequences: ['Findings built around the wrong property may point at the wrong fix.'],
        firstCheck: `Double check this is the right property — evidence points to ${allObservedGa4Ids.join(', ')}, not ${manual.ga4Id}.`,
        requiresDeepScan: false,
      });
    }
  }

  // R5 — dataLayer present, no events observed (correctly hedged, not a failure)
  if (hasDeep && deep!.dataLayerPresent === true && deep!.eventEvidence.length === 0) {
    findings.push({
      id: 'datalayer-no-events-on-load',
      severity: 'info',
      confidence: 'high',
      title: 'dataLayer exists, but no events showed up on load',
      observed: ['window.dataLayer is present.', 'No recognizable event names were found in the first 25 dataLayer entries captured on load.'],
      proves: 'A dataLayer object exists on the page.',
      doesNotProve: 'This does NOT show whether add_to_cart, view_item, or purchase fire — those only happen when a visitor clicks or navigates, which a homepage-load scan can\'t see.',
      dependency: 'Checking real events (add_to_cart, purchase) needs a manual walkthrough or imported evidence — not something a page-load scan can tell you.',
      downstreamConsequences: [],
      firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
      possibleReasons: [
        {
          cause: 'Normal — add_to_cart/purchase are interaction-triggered, not page-load events, so a homepage load genuinely wouldn\'t show them.',
          howToCheck: 'Use the guided checks (GTM Preview / GA4 DebugView) to click through a real interaction and confirm events fire — this scan structurally cannot see them.',
        },
        {
          cause: 'Events use non-standard naming this scan\'s pattern match didn\'t recognize.',
          howToCheck: 'Open GTM Preview and look at the raw dataLayer pushes directly, rather than relying on this scan\'s event-name detection.',
        },
        {
          cause: 'Pushed from inside Shopify\'s Custom Pixels sandbox — isolated from the main-page dataLayer this scan reads.',
          howToCheck: 'Check the pixel\'s own debug tool or GTM/sGTM Preview mode directly — same caveat as above: a strong signal for what\'s pushed, not a guarantee it\'ll match live behavior once anything changes post-publish.',
        },
      ],
      requiresDeepScan: true,
    });
  }

  // R6 — compliance: tags active, no CMP detected. `region` only sharpens
  // which law gets named in the text below — it never changes whether this
  // finding fires, since "tags active + no CMP signature" is the same
  // observation everywhere. "Active" means either a static signature OR a
  // real deep-scan-observed request — gating on static evidence alone
  // missed a real case live (magicspoon.com, 2026-08-15): every tag loaded
  // dynamically, deep scan confirmed GTM/GA4/Meta/TikTok all firing with no
  // CMP detected, and this rule silently never fired because it only ever
  // checked static HTML for "is anything active."
  if ((anyStaticTag || anyObservedRequest) && !surface.hasCmp) {
    const tagsSeenOnlyInNetwork = !anyStaticTag && anyObservedRequest;
    const privacyRule = region
      ? `Most privacy rules require consent before non-essential tracking runs — for this store's market, that's ${REGIONS[region].privacyTerm} (${REGIONS[region].label}).`
      : 'Most privacy rules require consent before non-essential tracking runs.';
    findings.push({
      id: 'no-cmp-with-active-tags',
      severity: 'medium',
      confidence: 'low',
      title: 'Tracking is active, but no consent tool was found',
      observed: [
        tagsSeenOnlyInNetwork
          ? 'Tracking requests (GTM/GA4/Meta/TikTok) observed firing during the deep scan — not present in static HTML.'
          : 'At least one tracking signature (GTM/GA4/Meta/TikTok) found on page load.',
        'No known consent-tool signature (OneTrust, Cookiebot, CookieYes, etc.) matched in page HTML.',
      ],
      proves: 'No third-party consent-management script from the known signature list was detected.',
      doesNotProve: 'This does NOT confirm a compliance gap — Shopify\'s built-in consent banner (if enabled under Customer privacy settings) isn\'t on this signature list and wouldn\'t be detected here.',
      dependency: `${privacyRule} If tags are active before consent, the consent tool (or its absence) is what to fix — not the individual tags.`,
      downstreamConsequences: ['Possible regulatory exposure if tags genuinely fire before consent, depending on the store\'s target markets.'],
      firstCheck: 'Check each possible reason below, in order — this scan can\'t tell which one it is.',
      possibleReasons: [
        {
          cause: 'Genuinely no consent tool configured anywhere.',
          howToCheck: 'Check Shopify Admin\'s Customer privacy settings — if nothing\'s enabled there either, this is the real gap. Search: "Shopify customer privacy settings" if the menu location has moved.',
        },
        {
          cause: 'Shopify\'s own built-in consent banner is enabled — it\'s not on this scan\'s known-signature list, so it wouldn\'t be detected here even if active.',
          howToCheck: 'Check Shopify Admin\'s Customer privacy settings directly to confirm whether the native banner is on. Search: "Shopify customer privacy settings" if the menu location has moved.',
        },
        {
          cause: 'A consent tool outside the known signature list (an app-based or custom CMP) is running.',
          howToCheck: 'This is external to what this scan\'s signature list covers — check that app/tool\'s own settings directly, and confirm in GTM whether Consent Mode gates tags on accept/decline.',
        },
      ],
      requiresDeepScan: tagsSeenOnlyInNetwork,
    });
  }

  // R7 — legacy Universal Analytics snippet still present. Not a functional
  // failure (UA stopped processing data in July 2023, this can't be
  // "broken" any further than it already permanently is) — it's clutter
  // that real, established stores routinely carry from before the mandatory
  // GA4 migration, never cleaned up. Worth surfacing so it doesn't get
  // mistaken for live tracking when someone else audits this later.
  if (surface.hasLegacyUa) {
    findings.push({
      id: 'legacy-ua-present',
      severity: 'info',
      confidence: 'measured',
      title: 'Old Universal Analytics snippet still on the page',
      observed: [`A Universal Analytics ID (${surface.legacyUaId}) was found in the page HTML.`],
      proves: 'This store still carries a Universal Analytics snippet from before the GA4 migration.',
      doesNotProve: 'This does not indicate a current tracking problem — UA stopped collecting data in July 2023 and cannot fire, work, or break any further than it already has.',
      dependency: 'Not a dependency for anything downstream — this is dead code, not a broken link in the tracking chain.',
      downstreamConsequences: ['Can confuse a future audit into thinking there\'s a second, older analytics setup still active.'],
      firstCheck: 'Safe to remove from the theme whenever convenient — it collects nothing and blocks nothing.',
      requiresDeepScan: false,
    });
  }

  // Fallback — nothing blocking found among the rules above
  if (findings.length === 0) {
    findings.push({
      id: 'no-blocking-dependency-issue',
      severity: 'info',
      confidence: hasDeep ? 'medium' : 'low',
      title: 'No blocking issues found on page load',
      observed: ['Tracking signatures present and, where deep-scan evidence exists, checked against observed network requests.'],
      proves: 'Nothing in this page-load evidence points to a broken tracking setup.',
      doesNotProve: 'This does not confirm checkout events (add_to_cart, purchase) fire correctly, or that ad-platform attribution is accurate — those need the guided manual checks or Tab 2 access.',
      dependency: 'Page-load evidence is the shallowest layer. Clean evidence here just means the next layer (interaction events, checkout) is where to look next.',
      downstreamConsequences: [],
      firstCheck: 'Move on to the guided manual checks (GTM Preview, GA4 DebugView, ad-platform checks, Shopify order reconciliation) to check what a page-load scan can\'t see.',
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

export interface FindingCategoryInfo {
  category: string;
  fixType: string;
}

// Maps each finding id to a stable category + concrete fix type, so leads
// (and findings generally) can be grouped by "what kind of problem" and
// searched/filtered by "what kind of fix," not just read one at a time off
// a flat id. Kept as a separate lookup rather than a field on
// DiagnosticFinding — this is a display/grouping concern, not part of the
// evidence-and-proof contract (observed/proves/doesNotProve/...) each
// finding makes.
export const FINDING_CATEGORIES: Record<string, FindingCategoryInfo> = {
  'no-measurement-layer': { category: 'Measurement/Attribution', fixType: 'Install a measurement layer (GTM/GA4)' },
  'static-scan-only-inconclusive': { category: 'Pending', fixType: 'Run a deep scan to confirm' },
  'duplicate-gtm-containers': { category: 'Container/Technical Setup', fixType: 'Remove the duplicate GTM container' },
  'tags-without-datalayer': { category: 'Container/Technical Setup', fixType: 'Wire tags to a populated dataLayer' },
  'gtm-declared-not-observed': { category: 'Measurement/Attribution', fixType: 'Fix GTM container not firing' },
  'ga4-declared-not-observed': { category: 'Measurement/Attribution', fixType: 'Fix GA4 not sending data' },
  'ga4-id-mismatch': { category: 'Measurement/Attribution', fixType: 'Correct the declared GA4 ID' },
  'manual-gtm-mismatch': { category: 'Measurement/Attribution', fixType: 'Reconcile GTM ID mismatch' },
  'manual-ga4-mismatch': { category: 'Measurement/Attribution', fixType: 'Reconcile GA4 ID mismatch' },
  'datalayer-no-events-on-load': { category: 'Container/Technical Setup', fixType: 'Confirm interaction events actually fire' },
  'no-cmp-with-active-tags': { category: 'Consent/Compliance', fixType: 'Install/connect a consent management tool' },
  'legacy-ua-present': { category: 'Cleanup', fixType: 'Remove the legacy Universal Analytics snippet' },
  'no-blocking-dependency-issue': { category: 'Clean', fixType: 'No action needed' },
};

export function getFindingCategory(id: string): FindingCategoryInfo {
  return FINDING_CATEGORIES[id] ?? { category: 'Uncategorized', fixType: 'Review manually' };
}
