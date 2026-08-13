/**
 * Core Audit Logic & Formulas
 * Priority: Functional Accuracy & Operator-Grade Reliability
 *
 * Two modes:
 *  - Tab 1 (No Access): runSurfaceAudit() — URL only, no credentials.
 *    Produces 7 business-metric cards, each either wired to a real surface
 *    signal (honest, hedged, ~80-90% directional accuracy) or explicitly
 *    locked "Needs live access" when no surface signal can imply it.
 *  - Tab 2 (With Access): runFullAudit() — GTM ID / GA4 ID / Shopify data
 *    required. Produces the full financial audit as a detailed text report
 *    (not cards) + a prioritized "look here first" triage list.
 */

import { REGIONS } from './constants.ts';
import type { Region } from './constants.ts';
import { formatCurrency } from './formatters.ts';
import { runDiagnostics } from './diagnosticEngine.ts';
import { buildTopIssues, COD_TYPICAL_MARKETS } from './topIssues.ts';
import type { TopIssuesResult } from './topIssues.ts';

export interface AuditInputs {
  grossRevenue: number;
  totalOrders: number;
  newCustomers: number;
  rtoOrders: number;
  codOrders: number;
  cogs: number;
  shipping: number;
  adSpend: number;
  settlementDays: number;
  avgOrderValue: number;
}

export interface AuditResults {
  cac: number;
  roas: number;
  rtoPct: number;
  rtoLoss: number;
  codPct: number;
  codLoss: number;
  grossMargin: number;
  grossRevenue: number;
  netOutcome: number;
  burnRate: number;
  burnRateUnsustainable: boolean;
  settlementLag: number;
  leaks: LeakItem[];
}

export interface LeakItem {
  name: string;
  amt: number;
  priority?: boolean;
}

export interface AuditSourceSignal {
  dataLayer: 'available' | 'missing' | 'unknown';
  stape: 'live' | 'not-present' | 'unknown';
  purchaseSignals: 'observed' | 'sandbox-blocked' | 'not-validated';
  consentMode: 'configured' | 'missing' | 'unknown';
}

export interface AuditReportIssue {
  category: string;
  owner: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  statement: string;
}

export interface SignalFinding {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad';
  note?: string;
}

export interface AuditDashboardResult {
  url: string;
  score: number;
  status: 'ok' | 'error';
  metrics: {
    gtmDetected: boolean;
    gtmId: string;
    ga4Active: boolean;
    ga4Id: string;
    metaPixel: boolean;
    tiktokPixel: boolean;
    cmpDetected: boolean;
    cmpName: string;
    pageSpeed: string;
    sslValid: boolean;
    grossRevenue: number;
    netOutcome: number;
    roas: number;
    cac: number;
  };
  recommendations: Array<{
    type: 'success' | 'warning' | 'info';
    text: string;
  }>;
  report: {
    headline: string;
    storeMode: string;
    status: string;
    summary: string;
    signalSources: AuditSourceSignal;
    evidenceDepth: 'static-only' | 'static+deep'; // whether deep-scan network evidence was reconciled in, or this is static HTML alone
    signalFindings: SignalFinding[]; // detailed text list, rendered as-is, never as a card grid
    issueList: AuditReportIssue[];
    businessMetrics: Array<{
      label: string;
      value: string;
      /** One simple sentence — read this off on a call without getting stuck explaining the metric first. */
      explainer: string;
    }>;
    topIssues: TopIssuesResult;
    volumeNote?: string;
  };
}

export interface Ga4LiveMetrics {
  sessions: number;
  totalUsers: number;
  conversions: number;
  purchaseRevenue: number;
}

// ---- Surface-audit (Tab 1) types ----

export interface SurfaceMetricCard {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad';
  explainer: string; // 1-line, sales-call ready
  locked?: boolean; // true = no surface signal can honestly imply this; needs Tab 2 access
  confidence?: string; // shown only on non-locked cards — honest about estimate vs measured
}

export interface SurfaceAuditResult {
  url: string;
  status: 'ok' | 'error';
  error?: string;
  gtmId: string | null;
  gtmIdsAll: string[]; // every distinct GTM-xxxxx found in static HTML — >1 implies duplicate containers
  ga4Id: string | null;
  hasMetaPixel: boolean;
  metaPixelId: string | null;
  hasTiktokPixel: boolean;
  tiktokPixelId: string | null;
  hasCmp: boolean;
  cmpName: string | null;
  sslValid: boolean;
  missingSignalCount: number; // out of 4 (GTM, GA4, Meta, TikTok)
  blindSpotPct: number;
  cards: SurfaceMetricCard[];
}

// Vite proxies /api to the local backend in development, so the UI does not
// depend on a hard-coded browser-visible localhost port.
const PROXY_BASE = '/api';

/**
 * Illustrative weights used ONLY for the no-access surface audit, where no
 * real client financial data exists yet. They describe tracking coverage only,
 * never a measured buyer-journey percentage or financial outcome.
 */
const SURFACE_BENCHMARKS = {
  blindSpotWeights: {
    missingGtm: 40,
    missingGa4: 40,
    missingMetaPixel: 10,
    missingTiktokPixel: 10,
  },
};

// Known consent-management-platform script signatures. Used only to detect
// PRESENCE — absence does not prove non-compliance, it's flagged as a risk
// signal worth checking, never as a legal conclusion.
const CMP_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OneTrust', pattern: /cdn\.cookielaw\.org|onetrust/i },
  { name: 'Cookiebot', pattern: /consent\.cookiebot\.com|cookiebot/i },
  { name: 'CookieYes', pattern: /cdn-cookieyes\.com|cookieyes/i },
  { name: 'Osano', pattern: /cmp\.osano\.com/i },
  { name: 'TrustArc', pattern: /consent\.trustarc\.com/i },
  { name: 'Complianz', pattern: /complianz/i },
  { name: 'Termly', pattern: /app\.termly\.io/i },
  { name: 'Iubenda', pattern: /cdn\.iubenda\.com/i },
];

function detectCmp(html: string): { found: boolean; name: string | null } {
  for (const cmp of CMP_PATTERNS) {
    if (cmp.pattern.test(html)) return { found: true, name: cmp.name };
  }
  return { found: false, name: null };
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fetches the real storefront HTML through the local proxy and scans it
 * for tracking signatures. No fake data — if the proxy is down or the
 * store is unreachable, this throws instead of silently faking results.
 */
async function scanStoreHtml(storeUrl: string): Promise<{
  html: string;
  gtmId: string | null;
  gtmIdsAll: string[];
  ga4Id: string | null;
  hasMetaPixel: boolean;
  metaPixelId: string | null;
  hasTiktokPixel: boolean;
  tiktokPixelId: string | null;
  hasCmp: boolean;
  cmpName: string | null;
}> {
  const res = await fetch(`${PROXY_BASE}/scan?url=${encodeURIComponent(storeUrl)}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Proxy returned ${res.status}`);
  }

  const { html } = await res.json();

  const gtmIdsAll = Array.from(new Set((html.match(/GTM-[A-Z0-9]+/g) as string[] | null) || []));
  const ga4Match = html.match(/G-[A-Z0-9]{6,}/);
  const hasMetaPixel = /fbq\s*\(\s*['"]init['"]/.test(html) || /connect\.facebook\.net\/en_US\/fbevents/.test(html);
  const metaPixelMatch = html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/);
  const hasTiktokPixel = /ttq\.load\s*\(/.test(html);
  const tiktokPixelMatch = html.match(/ttq\.load\(\s*['"]([A-Z0-9]{10,})['"]/i);
  const cmp = detectCmp(html);

  return {
    html,
    gtmId: gtmIdsAll[0] || null,
    gtmIdsAll,
    ga4Id: ga4Match ? ga4Match[0] : null,
    hasMetaPixel,
    metaPixelId: metaPixelMatch ? metaPixelMatch[1] : null,
    hasTiktokPixel,
    tiktokPixelId: tiktokPixelMatch ? tiktokPixelMatch[1] : null,
    hasCmp: cmp.found,
    cmpName: cmp.name,
  };
}

// ---- Evidence reconciliation ----
// Static HTML regex matching only sees what's literally in the initial page
// source. Real stores commonly chain-load a second GTM container, GA4, or
// Meta/TikTok pixels via JavaScript after load — none of that appears in
// the static HTML, only in the deep-scan network/dataLayer evidence.
// Confirmed on a real live store during testing: static scan reported 0 of
// GA4/Meta/TikTok while deep scan proved all three were actively firing.
// Everything that decides "detected or not" (cards, health score, report,
// PDF) must go through this so it reflects the strongest evidence available
// — never static-only when deep evidence exists and disagrees.
export interface EffectiveSignals {
  gtmId: string | null;
  gtmIdsAll: string[]; // union of static-HTML and network-observed GTM IDs
  gtmDetected: boolean;
  ga4Id: string | null;
  ga4Detected: boolean;
  metaDetected: boolean;
  tiktokDetected: boolean;
  missingSignalCount: number; // out of 4
  blindSpotPct: number;
  usedDeepEvidence: boolean;
}

type SignalSource = Pick<SurfaceAuditResult, 'gtmId' | 'gtmIdsAll' | 'ga4Id' | 'hasMetaPixel' | 'hasTiktokPixel'>;

export function resolveEffectiveSignals(scan: SignalSource, deep: DeepScanResult | null): EffectiveSignals {
  const networkGtmIds = deep ? deep.observedIds.gtm : [];
  const networkGa4Ids = deep ? deep.observedIds.ga4 : [];

  const gtmIdsAll = Array.from(new Set([...scan.gtmIdsAll, ...networkGtmIds]));
  const gtmId = scan.gtmId || networkGtmIds[0] || null;
  const gtmDetected = gtmIdsAll.length > 0;

  const ga4Id = scan.ga4Id || networkGa4Ids[0] || null;
  const ga4Detected = !!ga4Id;

  const metaDetected = scan.hasMetaPixel || (deep ? deep.trackingSignals.metaBrowserRequests > 0 : false);
  const tiktokDetected = scan.hasTiktokPixel || (deep ? deep.trackingSignals.tiktokBrowserRequests > 0 : false);

  const signals = [gtmDetected, ga4Detected, metaDetected, tiktokDetected];
  const missingSignalCount = signals.filter((s) => !s).length;

  const w = SURFACE_BENCHMARKS.blindSpotWeights;
  const blindSpotPct = Math.min(
    100,
    (gtmDetected ? 0 : w.missingGtm) +
      (ga4Detected ? 0 : w.missingGa4) +
      (metaDetected ? 0 : w.missingMetaPixel) +
      (tiktokDetected ? 0 : w.missingTiktokPixel)
  );

  return { gtmId, gtmIdsAll, gtmDetected, ga4Id, ga4Detected, metaDetected, tiktokDetected, missingSignalCount, blindSpotPct, usedDeepEvidence: !!deep };
}

export function buildSurfaceCards(
  effective: EffectiveSignals,
  hasCmp: boolean,
  cmpName: string | null,
  region: Region
): SurfaceMetricCard[] {
  return [
    {
      label: 'Attribution',
      value: `${effective.missingSignalCount} of 4 core tracking signals not detected`,
      tone: effective.blindSpotPct >= 60 ? 'bad' : effective.blindSpotPct >= 30 ? 'warn' : 'good',
      explainer: 'Do you actually know which channel brought the sale, or are you guessing?',
      confidence: effective.usedDeepEvidence
        ? 'Static page-load signal plus read-only network evidence from a deep scan. Still does not measure customer journeys or conversion attribution.'
        : 'Public page-load signal only. It does not measure customer journeys or conversion attribution — run a deep scan for stronger evidence.',
    },
    {
      label: 'ROAS Measurement Risk',
      value: effective.missingSignalCount > 0 ? 'ROAS needs confirmation in platform data' : 'Tag presence detected; ROAS still unconfirmed',
      tone: effective.missingSignalCount > 0 ? 'warn' : 'good',
      explainer: 'Are your ads actually making you money, or just spending it?',
      confidence: 'No spend, revenue, or ROAS is calculated from a surface scan.',
    },
    {
      label: `Compliance (${REGIONS[region].privacyTerm} tracking)`,
      value: hasCmp ? `Consent tool detected (${cmpName})` : 'No consent tool detected',
      tone: hasCmp ? 'good' : 'warn',
      explainer: `Is your tracking collecting data in a way that could get flagged under ${REGIONS[region].label} privacy law?`,
      confidence: hasCmp
        ? 'Presence confirmed on page load.'
        : 'Absence noted from page load only — does not itself confirm legal exposure.',
    },
    {
      label: 'CAC',
      value: 'Needs live access',
      tone: 'warn',
      explainer: 'What are you paying to get one buyer — and is that buyer worth more than that?',
      locked: true,
    },
    {
      label: 'Gross Margin',
      value: 'Needs live access',
      tone: 'warn',
      explainer: "After product cost, shipping, and fees — what's actually left per order?",
      locked: true,
    },
    {
      label: 'COD Failure Rate',
      value: 'Needs live access',
      tone: 'warn',
      explainer: 'How much revenue walks away at the door when the customer refuses the package?',
      locked: true,
    },
    {
      label: 'RTO Rate',
      value: 'Needs live access',
      tone: 'warn',
      explainer: "How much is it costing you to ship an order that never even gets delivered?",
      locked: true,
    },
  ];
}

/**
 * TAB 1 — NO ACCESS.
 * URL only. Never requires CSV/Shopify/GA4/GTM credentials.
 * 7 cards, honest split:
 *  - Attribution, ROAS Risk, Compliance: wired to real surface signals
 *    (GTM/GA4/pixel/CMP presence). Hedged, ~80-90% directional accuracy —
 *    never presented as measured fact.
 *  - CAC, Gross Margin, COD, RTO: no surface signal implies these. Locked
 *    "Needs live access" rather than a fabricated formula.
 */
export const runSurfaceAudit = async (
  storeUrl: string,
  region: Region = 'US'
): Promise<SurfaceAuditResult> => {
  let scan: Awaited<ReturnType<typeof scanStoreHtml>>;
  try {
    scan = await scanStoreHtml(storeUrl);
  } catch (err: any) {
    return {
      url: storeUrl,
      status: 'error',
      error: err.message || 'Could not scan store',
      gtmId: null,
      gtmIdsAll: [],
      ga4Id: null,
      hasMetaPixel: false,
      metaPixelId: null,
      hasTiktokPixel: false,
      tiktokPixelId: null,
      hasCmp: false,
      cmpName: null,
      sslValid: false,
      missingSignalCount: 4,
      blindSpotPct: 100,
      cards: [],
    };
  }

  const sslValid = storeUrl.trim().toLowerCase().startsWith('https://');
  // No deep-scan evidence exists yet at initial-scan time — deep scan is a
  // separate, later operator action. App.tsx recomputes cards reactively via
  // resolveEffectiveSignals/buildSurfaceCards once deep-scan evidence
  // arrives, so this initial static-only pass is just the starting point.
  const effective = resolveEffectiveSignals(scan, null);
  const cards = buildSurfaceCards(effective, scan.hasCmp, scan.cmpName, region);

  return {
    url: storeUrl,
    status: 'ok',
    gtmId: scan.gtmId,
    gtmIdsAll: scan.gtmIdsAll,
    ga4Id: scan.ga4Id,
    hasMetaPixel: scan.hasMetaPixel,
    metaPixelId: scan.metaPixelId,
    hasTiktokPixel: scan.hasTiktokPixel,
    tiktokPixelId: scan.tiktokPixelId,
    hasCmp: scan.hasCmp,
    cmpName: scan.cmpName,
    sslValid,
    missingSignalCount: effective.missingSignalCount,
    blindSpotPct: effective.blindSpotPct,
    cards,
  };
};

/**
 * TAB 2 — WITH ACCESS.
 * inputs is required — no default fallback object. Caller (App.tsx) blocks
 * the scan until real CSV/Shopify data is loaded.
 * manualGtmId / manualGa4Id are optional user-supplied IDs, cross-checked
 * (case-insensitively) against what the live HTML scan actually detects.
 *
 * Output is a detailed TEXT report (signalFindings, issueList,
 * businessMetrics, recommendations) — deliberately not a per-metric card
 * grid, so it reads as a report you can talk through on a client call.
 */
export const runFullAudit = async (
  storeUrl: string,
  inputs: AuditInputs,
  manualGtmId: string | null = null,
  manualGa4Id: string | null = null,
  region: Region = 'US',
  deepEvidence: DeepScanResult | null = null
): Promise<AuditDashboardResult> => {
  const audit = calculateAudit(inputs);

  let scan: Awaited<ReturnType<typeof scanStoreHtml>>;
  try {
    scan = await scanStoreHtml(storeUrl);
  } catch (err: any) {
    return buildFailedResult(storeUrl, err.message || 'Could not scan store');
  }

  // Reconcile static-HTML detection against deep-scan network evidence (if
  // the operator already ran one) rather than trusting static HTML alone —
  // see resolveEffectiveSignals for why this matters.
  const effective = resolveEffectiveSignals(scan, deepEvidence);

  const gtmId = effective.gtmId || manualGtmId;
  const ga4Id = effective.ga4Id || manualGa4Id;
  const gtmMismatch = !!(effective.gtmId && manualGtmId && effective.gtmId.toUpperCase() !== manualGtmId.toUpperCase());
  const ga4Mismatch = !!(effective.ga4Id && manualGa4Id && effective.ga4Id.toUpperCase() !== manualGa4Id.toUpperCase());

  const signalsFound = [gtmId, ga4Id, effective.metaDetected, effective.tiktokDetected].filter(Boolean).length;
  const healthScore = Math.round((signalsFound / 4) * 100);

  const recommendations: AuditDashboardResult['recommendations'] = [];
  recommendations.push(
    gtmId
      ? { type: 'success', text: `Google Tag Manager container (${gtmId}) confirmed${scan.gtmId ? ' on the live page' : deepEvidence ? ' via deep-scan network evidence, not present in static HTML' : ' — manually supplied, not detected in live HTML'}.` }
      : { type: 'warning', text: 'No Google Tag Manager container detected or supplied.' }
  );
  recommendations.push(
    ga4Id
      ? { type: 'success', text: `GA4 measurement ID (${ga4Id}) confirmed${scan.ga4Id ? ' on the live page' : deepEvidence ? ' via deep-scan network evidence, not present in static HTML' : ' — manually supplied, not detected in live HTML'}.` }
      : { type: 'warning', text: 'No GA4 measurement ID detected or supplied.' }
  );
  recommendations.push(
    effective.metaDetected
      ? { type: 'success', text: `Meta Pixel detected${scan.hasMetaPixel ? ' in page HTML' : ' via deep-scan network evidence (not present in static HTML)'}.` }
      : { type: 'info', text: 'Meta Pixel not detected on the page.' }
  );
  recommendations.push(
    effective.tiktokDetected
      ? { type: 'success', text: `TikTok Pixel detected${scan.hasTiktokPixel ? ' in page HTML' : ' via deep-scan network evidence (not present in static HTML)'}.` }
      : { type: 'info', text: 'TikTok Pixel not detected on the page.' }
  );
  recommendations.push(
    scan.hasCmp
      ? { type: 'success', text: `Consent management tool detected (${scan.cmpName}).` }
      : { type: 'warning', text: 'No consent management tool detected — DPDP-aligned tracking risk, verify manually before claiming compliance.' }
  );
  recommendations.push({
    type: 'info',
    text: `RTO impact is ${audit.rtoPct.toFixed(2)}% of orders; COD share is ${audit.codPct.toFixed(2)}%.`,
  });
  if (audit.burnRateUnsustainable) {
    recommendations.push({
      type: 'warning',
      text: 'Ad spend currently exceeds gross margin — burn rate is unsustainable at this volume.',
    });
  }

  const issueList: AuditReportIssue[] = [
    {
      category: 'Purchase signal validation',
      owner: 'Checkout / Pixel layer',
      severity: 'critical',
      statement: 'This scan only checks what loads on the homepage. Purchase event firing must be confirmed with a real test checkout.',
    },
    deepEvidence
      ? {
          category: 'Runtime data layer',
          owner: 'Tracking / GTM configuration',
          severity: deepEvidence.dataLayerPresent ? 'low' : 'high',
          statement: deepEvidence.dataLayerPresent
            ? 'dataLayer confirmed present via read-only deep-scan evidence.'
            : 'Read-only deep scan found no dataLayer object on page load — ecommerce event data (add_to_cart, purchase) has nothing to read from.',
        }
      : {
          category: 'Runtime data layer',
          owner: 'Tracking / GTM configuration',
          severity: 'high',
          statement: 'dataLayer contents are set by JavaScript after load and are not visible in a static HTML scan — needs a headless browser check to confirm. Run the deep scan before auditing for stronger evidence.',
        },
    {
      category: 'Measurement source trust',
      owner: 'Analytics architecture',
      severity: 'medium',
      statement: deepEvidence
        ? 'This combines a static surface scan with read-only deep-scan network evidence — still not an authenticated pull from GA4/GTM APIs, so treat it as a strong signal, not final proof.'
        : 'This is a surface scan, not an authenticated pull from GA4/GTM APIs — treat it as a first signal, not final proof.',
    },
  ];

  if (gtmMismatch) {
    issueList.push({
      category: 'GTM ID mismatch',
      owner: 'Tracking config',
      severity: 'high',
      statement: `Observed evidence shows ${effective.gtmId}, but ${manualGtmId} was supplied. One of these is wrong or stale.`,
    });
  }
  if (ga4Mismatch) {
    issueList.push({
      category: 'GA4 ID mismatch',
      owner: 'Tracking config',
      severity: 'high',
      statement: `Observed evidence shows ${effective.ga4Id}, but ${manualGa4Id} was supplied. One of these is wrong or stale.`,
    });
  }
  if (!scan.hasCmp) {
    issueList.push({
      category: 'Consent tooling',
      owner: 'Compliance / Tracking config',
      severity: 'medium',
      statement: 'No known consent-management script detected on page load. Confirm manually — Shopify\'s own native consent banner (if used) isn\'t covered by this signature list.',
    });
  }

  // ---- Triage: rank leaks by $ impact and flag where to look first ----
  const rankedLeaks = [...audit.leaks].sort((a, b) => b.amt - a.amt);
  rankedLeaks.forEach((leak, i) => {
    leak.priority = i < 2 && leak.amt > 0;
  });

  // "Start here" pointer — LOCATE -> POINT. Previously this only appeared
  // for stores with 500+ orders, so smaller stores (the more typical SMB
  // case) never got a priority pointer even though rankedLeaks was already
  // computed for them. Now always surfaces the single biggest confirmed $
  // leak regardless of volume; the framing just adjusts for high volume.
  const topLeak = rankedLeaks[0];
  const volumeNote = topLeak && topLeak.amt > 0
    ? inputs.totalOrders >= 500
      ? `High order volume (${inputs.totalOrders} orders) — don't audit product-by-product. Start with "${topLeak.name}" (~${formatCurrency(topLeak.amt, region)}), the single largest leak, before anything else.`
      : `Start with "${topLeak.name}" (~${formatCurrency(topLeak.amt, region)}) — the single largest confirmed $ leak in this audit.`
    : 'No major $ leaks flagged from the confirmed inputs — focus review on tracking coverage and the guided checks below.';

  const isCodTypicalMarket = COD_TYPICAL_MARKETS.includes(region);

  // Unified "Top Issues": merges tracking-evidence findings (identical logic
  // in every market) with financial leaks (ranked by this store's own
  // measured $ amounts, with one real region-conditioned rule for COD/RTO —
  // see topIssues.ts). Runs the diagnostic engine here too, from whatever
  // evidence this Tab-2 audit has (deep scan is optional and, if the
  // operator already ran it before clicking "Audit Store", gets used).
  const diagnosticReport = runDiagnostics(
    {
      url: storeUrl,
      status: 'ok',
      gtmId: scan.gtmId,
      gtmIdsAll: scan.gtmIdsAll,
      ga4Id: scan.ga4Id,
      hasMetaPixel: scan.hasMetaPixel,
      metaPixelId: scan.metaPixelId,
      hasTiktokPixel: scan.hasTiktokPixel,
      tiktokPixelId: scan.tiktokPixelId,
      hasCmp: scan.hasCmp,
      cmpName: scan.cmpName,
      sslValid: storeUrl.trim().toLowerCase().startsWith('https://'),
      missingSignalCount: effective.missingSignalCount,
      blindSpotPct: effective.blindSpotPct,
      cards: [],
    },
    deepEvidence
  );
  const topIssuesResult = buildTopIssues(diagnosticReport, audit.leaks, region);

  // Detailed text findings — replaces the old boxed metric-card grid.
  // Rendered as a plain list in App.tsx, not individual cards.
  const signalFindings: SignalFinding[] = [
    {
      label: 'Google Tag Manager',
      value: gtmId || 'Not found',
      tone: gtmId ? 'good' : 'bad',
      note: gtmMismatch ? `Mismatch: observed evidence shows ${effective.gtmId}` : undefined,
    },
    {
      label: 'GA4 Measurement ID',
      value: ga4Id || 'Not found',
      tone: ga4Id ? 'good' : 'bad',
      note: ga4Mismatch ? `Mismatch: observed evidence shows ${effective.ga4Id}` : undefined,
    },
    {
      label: 'Meta Pixel',
      value: effective.metaDetected ? 'Detected' : 'Not detected',
      tone: effective.metaDetected ? 'good' : 'warn',
      note: effective.metaDetected && !scan.hasMetaPixel ? 'Detected via deep-scan network evidence only — not present in static HTML.' : undefined,
    },
    {
      label: 'TikTok Pixel',
      value: effective.tiktokDetected ? 'Detected' : 'Not detected',
      tone: effective.tiktokDetected ? 'good' : 'warn',
      note: effective.tiktokDetected && !scan.hasTiktokPixel ? 'Detected via deep-scan network evidence only — not present in static HTML.' : undefined,
    },
    {
      label: 'Consent Tool (CMP)',
      value: scan.hasCmp ? `Detected (${scan.cmpName})` : 'Not detected',
      tone: scan.hasCmp ? 'good' : 'warn',
      note: scan.hasCmp ? undefined : 'Verify manually — may use a native/custom banner not in the signature list.',
    },
  ];

  return {
    url: storeUrl,
    score: healthScore,
    status: 'ok',
    metrics: {
      gtmDetected: !!gtmId,
      gtmId: gtmId || 'Not found',
      ga4Active: !!ga4Id,
      ga4Id: ga4Id || 'Not found',
      metaPixel: effective.metaDetected,
      tiktokPixel: effective.tiktokDetected,
      cmpDetected: scan.hasCmp,
      cmpName: scan.cmpName || 'None',
      pageSpeed: 'Not measured',
      sslValid: storeUrl.startsWith('https://'),
      grossRevenue: audit.grossRevenue,
      netOutcome: audit.netOutcome,
      roas: audit.roas,
      cac: audit.cac,
    },
    recommendations,
    report: {
      headline: 'Purchase path measurement audit',
      storeMode: 'Live surface scan',
      status: signalsFound >= 2 ? 'Core tags detected — validate purchase event next' : 'Tracking gaps found on page load',
      summary: deepEvidence
        ? `Scanned the live storefront HTML and combined it with read-only deep-scan network evidence. Found ${signalsFound} of 4 tracking signatures (GTM, GA4, Meta, TikTok) between the two. This still only confirms what loads on page view — it does not confirm the purchase event fires, which needs a real checkout test or GA4/GTM API access.`
        : `Scanned the live storefront HTML directly. Found ${signalsFound} of 4 tracking signatures (GTM, GA4, Meta, TikTok). This confirms what loads on page view — it does not yet confirm the purchase event fires, which needs a real checkout test or GA4/GTM API access. Static HTML alone can miss tags that load dynamically; run the deep scan before auditing for stronger evidence.`,
      signalSources: {
        dataLayer: deepEvidence ? (deepEvidence.dataLayerPresent ? 'available' : 'missing') : 'unknown',
        stape: deepEvidence ? (deepEvidence.trackingSignals.serverSideEndpointCandidates.length > 0 ? 'live' : 'not-present') : 'unknown',
        purchaseSignals: 'not-validated',
        consentMode: scan.hasCmp ? 'configured' : 'missing',
      },
      evidenceDepth: deepEvidence ? 'static+deep' : 'static-only',
      signalFindings,
      issueList,
      businessMetrics: [
        { label: 'Gross Revenue', value: formatCurrency(audit.grossRevenue, region), explainer: 'Total order value before any costs are subtracted — your top-line number.' },
        { label: 'ROAS', value: `${audit.roas.toFixed(2)}x`, explainer: 'For every $1 spent on ads, how many $ came back in revenue — below 1x means ads are losing money outright.' },
        { label: 'CAC', value: formatCurrency(audit.cac, region), explainer: 'What it costs in ad spend alone to acquire one new customer.' },
        { label: 'Gross Margin', value: formatCurrency(audit.grossMargin, region), explainer: "What's left after product cost and shipping — before ad spend and other overhead." },
        {
          label: 'RTO Rate',
          value: `${audit.rtoPct.toFixed(2)}% (${formatCurrency(audit.rtoLoss, region)})`,
          explainer: isCodTypicalMarket
            ? 'Share of orders that came back undelivered — a first-order cost driver in COD-heavy markets like this one.'
            : 'Share of orders that came back undelivered — normally near-zero outside COD-heavy markets, so any non-zero figure is worth a second look.',
        },
        {
          label: 'COD Share',
          value: `${audit.codPct.toFixed(2)}% (share only; failure cost not confirmed)`,
          explainer: isCodTypicalMarket
            ? 'Share of orders paid cash-on-delivery — higher share usually tracks with higher RTO exposure.'
            : 'Share of orders paid cash-on-delivery — uncommon in this market, so a non-zero figure is worth confirming is intentional.',
        },
        { label: 'Settlement Lag (cash locked)', value: formatCurrency(audit.settlementLag, region), explainer: "Cash tied up waiting for COD payments to actually settle — money you've technically earned but can't spend yet." },
        { label: 'Cash Flow Health', value: `${audit.netOutcome >= 0 ? 'Healthy' : 'At Risk'}`, explainer: "Whether gross margin actually covers ad spend — 'At Risk' means you're spending more on ads than you're making before overhead." },
      ],
      topIssues: topIssuesResult,
      volumeNote,
    },
  };
};

function buildFailedResult(storeUrl: string, errorMessage: string): AuditDashboardResult {
  return {
    url: storeUrl,
    score: 0,
    status: 'error',
    metrics: {
      gtmDetected: false,
      gtmId: 'Scan failed',
      ga4Active: false,
      ga4Id: 'Scan failed',
      metaPixel: false,
      tiktokPixel: false,
      cmpDetected: false,
      cmpName: 'N/A',
      pageSpeed: 'N/A',
      sslValid: false,
      grossRevenue: 0,
      netOutcome: 0,
      roas: 0,
      cac: 0,
    },
    recommendations: [
      { type: 'warning', text: `Scan failed: ${errorMessage}` },
      { type: 'info', text: 'Check that server.cjs is running (node server.cjs) and the store URL is correct.' },
    ],
    report: {
      headline: 'Scan could not complete',
      storeMode: 'Error',
      status: 'Failed',
      summary: errorMessage,
      signalSources: { dataLayer: 'unknown', stape: 'unknown', purchaseSignals: 'not-validated', consentMode: 'unknown' },
      evidenceDepth: 'static-only',
      signalFindings: [],
      issueList: [],
      businessMetrics: [],
      topIssues: { issues: [], totalFound: 0 },
    },
  };
}

export const calculateAudit = (inputs: AuditInputs): AuditResults => {
  const {
    grossRevenue,
    totalOrders,
    newCustomers,
    rtoOrders,
    codOrders,
    cogs,
    shipping,
    adSpend,
    settlementDays,
    avgOrderValue,
  } = inputs;

  const cac = newCustomers > 0 ? adSpend / newCustomers : 0;
  const roas = adSpend > 0 ? grossRevenue / adSpend : 0;

  const rtoPct = totalOrders > 0 ? (rtoOrders / totalOrders) * 100 : 0;
  const rtoLoss = totalOrders > 0 ? (rtoOrders / totalOrders) * grossRevenue : 0;

  const codPct = totalOrders > 0 ? (codOrders / totalOrders) * 100 : 0;
  const codLoss = 0;

  const grossMargin = grossRevenue - cogs - shipping;
  const netOutcome = grossMargin - adSpend;

  const burnRateUnsustainable = grossMargin <= 0 && adSpend > 0;
  const burnRate = grossMargin > 0 ? adSpend / grossMargin : (adSpend > 0 ? Infinity : 0);

  const settlementLag = (codOrders * avgOrderValue) * (settlementDays / 30);

  const leaks: LeakItem[] = [];
  if (rtoLoss > 0) leaks.push({ name: 'RTO returns', amt: rtoLoss });
  if (settlementLag > 0) leaks.push({ name: 'COD settlement lag (cash locked)', amt: settlementLag });

  if (adSpend > 0 && roas < 3) {
    const idealRevenue = adSpend * 3;
    const gap = idealRevenue - grossRevenue;
    if (gap > 0) leaks.push({ name: 'ROAS opportunity gap (vs 3x)', amt: gap });
  }

  return {
    cac,
    roas,
    rtoPct,
    rtoLoss,
    codPct,
    codLoss,
    grossRevenue,
    grossMargin,
    netOutcome,
    burnRate,
    burnRateUnsustainable,
    settlementLag,
    leaks,
  };
};

export function shopifyOrdersToAuditInputs(rawOrders: any[]): AuditInputs {
  let grossRevenue = 0;
  let codOrdersCount = 0;
  let rtoOrdersCount = 0;

  for (const order of rawOrders) {
    const total = parseFloat(order.total_price) || 0;
    grossRevenue += total;

    const gateway = (order.gateway || order.payment_gateway_names?.[0] || '').toLowerCase();
    if (gateway.includes('cash') || gateway.includes('delivery') || gateway.includes('cod')) {
      codOrdersCount++;
    }

  }

  // A slice of orders cannot establish a customer's lifetime first purchase.
  // The operator must enter a verified new-customer count.
  const newCustomersCount = 0;

  const totalOrders = rawOrders.length;
  const avgOrderValue = totalOrders > 0 ? grossRevenue / totalOrders : 0;

  return {
    grossRevenue,
    totalOrders,
    codOrders: codOrdersCount,
    rtoOrders: rtoOrdersCount,
    newCustomers: newCustomersCount,
    cogs: 0,
    shipping: 0,
    adSpend: 0,
    settlementDays: 0,
    avgOrderValue,
  };
}

export async function fetchLiveShopifyInputs(startDate?: string, endDate?: string): Promise<AuditInputs> {
  const query = new URLSearchParams();
  if (startDate) query.set('startDate', startDate);
  if (endDate) query.set('endDate', endDate);
  const res = await fetch(`${PROXY_BASE}/shopify/orders?${query}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Shopify orders request failed (${res.status})`);
  }
  const data = await res.json();
  return shopifyOrdersToAuditInputs(data.orders || []);
}

export async function fetchGa4LiveReport(propertyId: string, startDate: string, endDate: string): Promise<Ga4LiveMetrics> {
  const res = await fetch(`${PROXY_BASE}/ga4/report?propertyId=${encodeURIComponent(propertyId)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `GA4 report request failed (${res.status})`);
  }
  const data = await res.json();
  const row = data.rows?.[0]?.metricValues || [];
  return {
    sessions: Number(row[0]?.value || 0),
    totalUsers: Number(row[1]?.value || 0),
    conversions: Number(row[2]?.value || 0),
    purchaseRevenue: Number(row[3]?.value || 0),
  };
}

export async function fetchGtmContainerMatch(gtmId: string | null): Promise<{ matched: boolean; containerName?: string }> {
  if (!gtmId) return { matched: false };
  const res = await fetch(`${PROXY_BASE}/gtm/containers`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `GTM containers request failed (${res.status})`);
  }
  const data = await res.json();
  const containers = data.containers || [];
  const match = containers.find((c: any) => (c.publicId || '').toUpperCase() === gtmId.toUpperCase());
  return match ? { matched: true, containerName: match.name } : { matched: false };
}

// ---- Live GA4/GTM API reconciliation (Tab 2) ----
// "GA4 API connected" is not the same claim as "storefront GA4 implementation
// is correct." This compares what the connected GA4/GTM accounts actually
// report against what was observed on the storefront, and only states a
// discrepancy where the evidence genuinely supports one — a dev/test store
// with low real traffic is expected to show near-zero GA4 numbers, so that
// case is explicitly hedged rather than flagged as broken.
export interface ApiReconciliationFinding {
  tone: 'good' | 'warn' | 'bad';
  text: string;
}

export function reconcileLiveApiEvidence(
  result: Pick<AuditDashboardResult, 'metrics'>,
  liveGa4: Ga4LiveMetrics | null,
  gtmMatch: { matched: boolean; containerName?: string } | null,
  deep: DeepScanResult | null
): ApiReconciliationFinding[] {
  const findings: ApiReconciliationFinding[] = [];

  if (gtmMatch) {
    findings.push(
      gtmMatch.matched
        ? { tone: 'good', text: `GTM container confirmed live in your connected account: ${gtmMatch.containerName}.` }
        : { tone: 'warn', text: 'The audited GTM ID was not found among the containers in your connected GTM account — you may be connected to the wrong account, or this container belongs to someone else.' }
    );
  }

  if (liveGa4) {
    const hasEcommerceEvidence = !!deep && deep.eventEvidence.some((e) => e.ecommerceFields.length > 0);
    if (liveGa4.conversions > 0 || liveGa4.purchaseRevenue > 0) {
      if (deep && !hasEcommerceEvidence) {
        findings.push({
          tone: 'warn',
          text: `GA4 reports ${liveGa4.conversions} conversions / $${liveGa4.purchaseRevenue.toLocaleString()} revenue for this window, but the storefront deep scan found no ecommerce dataLayer fields on page load. This isn't a contradiction by itself (conversions happen at checkout, not the homepage) — but if GA4 revenue doesn't reconcile with Shopify order totals for the same window, check how GA4 is receiving purchase data.`,
        });
      } else {
        findings.push({ tone: 'good', text: `GA4 reports real conversions (${liveGa4.conversions}) and revenue ($${liveGa4.purchaseRevenue.toLocaleString()}) for this window — cross-check the revenue figure against Shopify order totals for the same date range before trusting it as final.` });
      }
    } else if (result.metrics.ga4Active && liveGa4.sessions === 0) {
      findings.push({
        tone: 'warn',
        text: 'GA4 shows 0 sessions in this window despite a GA4 tag being detected on the storefront. For a genuinely low-traffic dev/test store this can be entirely accurate — confirm against a known test visit before concluding tracking is broken.',
      });
    }
  }

  return findings;
}

export interface DeepScanResult {
  url: string;
  dataLayer: any[] | null;
  dataLayerPresent: boolean;
  consent: { found: boolean; raw: any };
  trackingRequestsSeen: string[];
  eventEvidence: Array<{ event: string; ecommerceFields: string[]; evidence: 'observed-on-page-load' }>;
  trackingSignals: {
    ga4Requests: number;
    gtmRequests: number;
    metaBrowserRequests: number;
    tiktokBrowserRequests: number;
    serverSideEndpointCandidates: string[];
  };
  observedIds: { ga4: string[]; gtm: string[] };
  note: string;
}

export async function fetchDeepScan(storeUrl: string): Promise<DeepScanResult> {
  const res = await fetch(`${PROXY_BASE}/scan/deep?url=${encodeURIComponent(storeUrl)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Deep scan request failed (${res.status})`);
  }
  return res.json();
}

export function buildReportHtml(scanResult: AuditDashboardResult): string {
  return `<html><body style="font-family:sans-serif;padding:24px">
    <h1>${escapeHtml(scanResult.report.headline)}</h1>
    <p style="color:#666;font-size:0.85em">Evidence: ${scanResult.report.evidenceDepth === 'static+deep' ? 'static HTML + read-only deep scan' : 'static HTML only'}</p>
    <p>${escapeHtml(scanResult.report.summary)}</p>
    <h3>Top Issues${scanResult.report.topIssues.totalFound > scanResult.report.topIssues.issues.length ? ` (top ${scanResult.report.topIssues.issues.length} of ${scanResult.report.topIssues.totalFound} found)` : ''}</h3>
    ${scanResult.report.topIssues.issues.length === 0
      ? '<p>No confirmed issues from the evidence gathered for this audit.</p>'
      : `<ol>${scanResult.report.topIssues.issues
          .map((i) => `<li><b>${escapeHtml(i.title)}</b> (${escapeHtml(i.severity)})${i.amount ? ` — $${Math.round(i.amount).toLocaleString()}` : ''}: ${escapeHtml(i.detail)} <i>First check: ${escapeHtml(i.firstCheck)}</i></li>`)
          .join('')}</ol>`
    }
    <h3>Signal Findings</h3>
    <ul>${scanResult.report.signalFindings
      .map((f) => `<li>${escapeHtml(f.label)}: ${escapeHtml(f.value)}${f.note ? ` — ${escapeHtml(f.note)}` : ''}</li>`)
      .join('')}</ul>
    <h3>Business Metrics</h3>
    <ul>${scanResult.report.businessMetrics
      .map((m) => `<li>${escapeHtml(m.label)}: ${escapeHtml(m.value)}</li>`)
      .join('')}</ul>
    <h3>Findings</h3>
    <ul>${scanResult.report.issueList
      .map((i) => `<li><b>${escapeHtml(i.category)}</b>: ${escapeHtml(i.statement)}</li>`)
      .join('')}</ul>
    <h3>Recommendations</h3>
    <ul>${scanResult.recommendations.map((r) => `<li>${escapeHtml(r.text)}</li>`).join('')}</ul>
  </body></html>`;
}

export async function exportReportPdf(reportHtml: string): Promise<Blob> {
  const res = await fetch(`${PROXY_BASE}/report/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: reportHtml }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `PDF export failed (${res.status})`);
  }
  return res.blob();
}
