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
import type { TopIssuesResult, TopIssueCategory, TopIssue } from './topIssues.ts';

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
  // Carried straight through from the surface scan — was already captured
  // on every run but only ever wired into the Lead Register's own display,
  // silently dropped for any ad-hoc Deep Scan run outside the Register.
  contactSignals?: SurfaceAuditResult['contactSignals'];
  metrics: {
    gtmDetected: boolean;
    gtmId: string;
    ga4Active: boolean;
    ga4Id: string;
    metaPixel: boolean;
    metaPixelId: string | null;
    tiktokPixel: boolean;
    tiktokPixelId: string | null;
    cmpDetected: boolean;
    cmpName: string;
    hasPinterestTag: boolean;
    pinterestTagId: string | null;
    hasSnapchatPixel: boolean;
    snapchatPixelId: string | null;
    hasMicrosoftUet: boolean;
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
    /** Audit-methodology caveats (what this scan can/cannot confirm) — NOT store issues. Real ranked issues are in topIssues. */
    scopeNotes: AuditReportIssue[];
    businessMetrics: Array<{
      label: string;
      value: string;
      /** One simple sentence — read this off on a call without getting stuck explaining the metric first. */
      explainer: string;
    }>;
    topIssues: TopIssuesResult;
    volumeNote?: string;
    /** What the operator typed in from the client, verbatim — never treated as a verified finding, only as context and a ranking hint. */
    clientReportedIssue?: string;
    clientReportedCategory?: TopIssueCategory;
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
  missingSignalCount: number; // out of 4 (GTM, GA4, Meta, TikTok) — the "core" set the score is built on
  blindSpotPct: number;
  cards: SurfaceMetricCard[];
  // Additional signals real, established stores commonly carry, tracked
  // separately from the core 4 rather than folded into missingSignalCount/
  // blindSpotPct — presence or absence of these isn't itself "good" or
  // "bad" the way core-tracking absence is, so they don't change the score.
  hasLegacyUa: boolean;
  legacyUaId: string | null;
  hasPinterestTag: boolean;
  pinterestTagId: string | null;
  hasSnapchatPixel: boolean;
  snapchatPixelId: string | null;
  hasMicrosoftUet: boolean;
  // Public research starting points for reaching the actual decision-maker
  // instead of a generic inbox — deliberately limited to what the store's
  // own public page already publishes (social links, a mailto:, a link to
  // its own About/Team/Contact page). Never a lookup against a third-party
  // profile or directory — that would cross from "reading a public page"
  // into people-search, which stays a manual step by design.
  contactSignals: {
    socialLinks: Array<{ platform: string; url: string }>;
    contactEmail: string | null;
    aboutOrContactPageUrl: string | null;
  };
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
    // GTM and GA4 are alternative PATHS to the same goal (a working
    // analytics layer) — GA4 can run directly via gtag.js or Shopify's
    // native integration with no GTM container at all, which is a
    // perfectly legitimate setup. Treating "no GTM" as an independent
    // 40-point penalty on top of "no GA4" double-counts one real gap as
    // two. Only dock the full penalty when NEITHER is present — the
    // literal "GTM not detected" fact still shows in missingSignalCount
    // (unchanged, always honest), just not double-weighted in the score.
    missingCoreAnalytics: 70,
    missingMetaPixel: 15,
    missingTiktokPixel: 15,
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
 * Every server error response ships both a short `error` label and a real
 * `detail: err.message` (see server.cjs) — but every fetch helper below was
 * only ever surfacing `error`, silently dropping `detail`. That's the exact
 * gap that turned a real, actionable Google API error ("Analytics Admin API
 * is disabled — enable it here: ...") into a dead-end "Could not list GA4
 * properties" with no next step. Fixed once, here, instead of patching each
 * call site's fallback text individually.
 */
function errorFromResponseBody(body: any, fallback: string): Error {
  if (body?.error && body?.detail) return new Error(`${body.error}: ${body.detail}`);
  return new Error(body?.error || fallback);
}

/**
 * Fetches the real storefront HTML through the local proxy and scans it
 * for tracking signatures. No fake data — if the proxy is down or the
 * store is unreachable, this throws instead of silently faking results.
 */
// Extracts only what the page itself already publishes for reaching a real
// person — social profile links (from the store's own footer/header, not a
// third-party search), a published mailto: address, and a link to the
// store's own About/Team/Contact page. Pure regex over already-fetched
// public HTML; never a request to a social platform or directory.
function extractContactSignals(html: string): SurfaceAuditResult['contactSignals'] {
  const socialPatterns: Array<[string, RegExp]> = [
    ['Instagram', /href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?#]+)/gi],
    ['LinkedIn', /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'\s?#]+)/gi],
    ['Twitter/X', /href=["'](https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"'\s?#]+)/gi],
    ['Facebook', /href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'\s?#]+)/gi],
  ];
  const socialLinks: Array<{ platform: string; url: string }> = [];
  const seen = new Set<string>();
  for (const [platform, pattern] of socialPatterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      // Share/follow-intent widget links (e.g. facebook.com/sharer/sharer.php,
      // x.com/intent/user — confirmed live on mejuri.com, a "Follow" button,
      // not their actual profile) are noise, not the brand's own profile.
      if (/sharer|share\.php|\/intent\/|dialog\/share/i.test(url)) continue;
      // Individual post/reel/story permalinks from an embedded Instagram
      // feed widget (e.g. instagram.com/reel/DZNYpaAhUkQ/ — confirmed live
      // on treatyjewellery.com, a homepage feed embed) aren't the brand's
      // profile link either.
      if (/instagram\.com\/(p|reel|tv|stories)\//i.test(url)) continue;
      // Same profile linked twice with/without "www." or a trailing slash is
      // extremely common (header + footer) — normalize before dedup-checking.
      const normalized = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      socialLinks.push({ platform, url });
    }
  }

  const mailtoMatch = html.match(/href=["']mailto:([^"'?\s]+)/i);
  const aboutMatch = html.match(/href=["']([^"']*\/pages\/(?:about[\w-]*|our-story|team|meet-the-team|contact[\w-]*))["']/i);

  return {
    socialLinks,
    contactEmail: mailtoMatch ? mailtoMatch[1] : null,
    aboutOrContactPageUrl: aboutMatch ? aboutMatch[1] : null,
  };
}

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
  hasLegacyUa: boolean;
  legacyUaId: string | null;
  hasPinterestTag: boolean;
  pinterestTagId: string | null;
  hasSnapchatPixel: boolean;
  snapchatPixelId: string | null;
  hasMicrosoftUet: boolean;
  contactSignals: SurfaceAuditResult['contactSignals'];
}> {
  const res = await fetch(`${PROXY_BASE}/scan?url=${encodeURIComponent(storeUrl)}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw errorFromResponseBody(body, `Proxy returned ${res.status}`);
  }

  const { html } = await res.json();

  const gtmIdsAll = Array.from(new Set((html.match(/GTM-[A-Z0-9]+/g) as string[] | null) || []));
  // Real GA4 IDs are always exactly "G-" + 10 alphanumeric chars, and are
  // effectively always a mix of letters and digits (Google generates them
  // pseudo-randomly, never as a readable word). The old open-ended
  // /G-[A-Z0-9]{6,}/ matched the first "G-" + 6-or-more run anywhere in the
  // page — including inside CSS custom property names built from English
  // words (--COLOR-BG-GRADIENT contains "G-GRADIENT", --FONT-SUBHEADING
  // contains "G-SUBHEADING", etc.), confirmed live on shopflavcity.com
  // where it grabbed "G-GRADIENT" instead of the real "G-66LXV4EHDF" a few
  // lines later — a false positive that would have made a genuine
  // ga4-id-mismatch finding rest on a fabricated-by-accident declared ID.
  // Requiring exactly 10 chars AND at least one digit rejects every CSS
  // word match while still matching the real ID.
  const ga4Candidates = (html.match(/G-[A-Z0-9]{10}\b/g) as string[] | null) || [];
  const ga4Match = ga4Candidates.find((id) => /[0-9]/.test(id.slice(2))) || null;
  const hasMetaPixel = /fbq\s*\(\s*['"]init['"]/.test(html) || /connect\.facebook\.net\/en_US\/fbevents/.test(html);
  const metaPixelMatch = html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/);
  const hasTiktokPixel = /ttq\.load\s*\(/.test(html);
  const tiktokPixelMatch = html.match(/ttq\.load\(\s*['"]([A-Z0-9]{10,})['"]/i);
  const cmp = detectCmp(html);

  // Legacy Universal Analytics — stopped processing data in July 2023, but
  // real stores that have been live a while routinely still have the old
  // snippet sitting in the theme, never removed. Detecting it isn't about
  // finding a "bug" (it's inert, not broken); it's clutter and confusion
  // when someone else is trying to figure out what's actually tracking.
  const legacyUaMatch = html.match(/UA-\d{4,10}-\d{1,4}/);

  // Signature patterns confirmed against each platform's current official
  // docs (Pinterest developers.pinterest.com, Snap community docs, Microsoft
  // Advertising Learn docs) rather than assumed from memory — see chat.
  const hasPinterestTag = /pintrk\s*\(\s*['"]load['"]/.test(html) || /s\.pinimg\.com\/ct\/core\.js/.test(html);
  const pinterestTagMatch = html.match(/pintrk\(\s*['"]load['"]\s*,\s*['"]([\w-]+)['"]/);
  const hasSnapchatPixel = /snaptr\s*\(\s*['"]init['"]/.test(html) || /sc-static\.net\/scevent\.min\.js/.test(html);
  const snapchatPixelMatch = html.match(/snaptr\(\s*['"]init['"]\s*,\s*['"]([\w-]+)['"]/);
  const hasMicrosoftUet = /\buetq\b/.test(html) || /bat\.bing\.com\/bat\.js/.test(html);
  const contactSignals = extractContactSignals(html);

  return {
    html,
    gtmId: gtmIdsAll[0] || null,
    gtmIdsAll,
    ga4Id: ga4Match,
    hasMetaPixel,
    metaPixelId: metaPixelMatch ? metaPixelMatch[1] : null,
    hasTiktokPixel,
    tiktokPixelId: tiktokPixelMatch ? tiktokPixelMatch[1] : null,
    hasCmp: cmp.found,
    cmpName: cmp.name,
    hasLegacyUa: !!legacyUaMatch,
    legacyUaId: legacyUaMatch ? legacyUaMatch[0] : null,
    hasPinterestTag,
    pinterestTagId: pinterestTagMatch ? pinterestTagMatch[1] : null,
    hasSnapchatPixel,
    snapchatPixelId: snapchatPixelMatch ? snapchatPixelMatch[1] : null,
    hasMicrosoftUet,
    contactSignals,
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
  const hasCoreAnalytics = gtmDetected || ga4Detected;
  const blindSpotPct = Math.min(
    100,
    (hasCoreAnalytics ? 0 : w.missingCoreAnalytics) +
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
  // Whether the PRECONDITION for measuring ad performance exists at all —
  // real evidence (tracking presence), never a fabricated ROAS/CAC number.
  // A surface scan can honestly say "attribution is broken," never "ROAS is 1.4x."
  const attributionBroken = effective.missingSignalCount === 4;
  const attributionPartial = effective.missingSignalCount > 0 && effective.missingSignalCount < 4;

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
      label: `Compliance (${REGIONS[region].privacyTerm} tracking)`,
      value: hasCmp ? `Consent tool detected (${cmpName})` : 'No consent tool detected',
      tone: hasCmp ? 'good' : 'warn',
      explainer: `Is your tracking collecting data in a way that could get flagged under ${REGIONS[region].label} privacy law?`,
      confidence: hasCmp
        ? 'Presence confirmed on page load.'
        : 'Absence noted from page load only — does not itself confirm legal exposure.',
    },
    // The 8 cards below are the same "Top 8 Business Metrics" shown once
    // real Shopify/financial data is loaded (With Access tab) — same
    // labels, so stage 1 previews exactly what stage 2 confirms. None of
    // these ever show a fabricated number or a region-based guess: where
    // real surface evidence exists (tracking presence), the value is an
    // honest possibility statement grounded in that evidence; a URL scan
    // has zero public signal for revenue, margin, cash flow, RTO, COD, or
    // settlement lag regardless of market, so all six stay locked. Value
    // stays empty string on purpose (2026-08-15, explicit user request —
    // removed the repeated "Credentials Safe" status line entirely, not
    // just hid it) — the trust pitch lives once in the banner above the
    // card grid (App.tsx), and the explainer alone carries each card now.
    // (Stage 2's real businessMetrics array is where region legitimately
    // sharpens interpretation — of measured numbers, not guesses.)
    {
      label: 'Gross Revenue',
      value: '',
      tone: 'good',
      explainer: 'Is this store doing real volume, or is a full audit not even worth your time yet?',
      locked: true,
    },
    {
      label: 'ROAS',
      value: attributionBroken
        ? 'Unmeasurable — no ad-tracking signal found'
        : attributionPartial
          ? 'Partially measurable — some channels untracked'
          : 'Tracking present — real ROAS still needs live spend data',
      tone: attributionBroken ? 'bad' : 'warn',
      explainer: 'Are your ads actually making money, or is spend just leaking out untracked?',
      locked: false,
    },
    {
      label: 'CAC',
      value: attributionBroken
        ? 'Unmeasurable — no conversion tracking found'
        : attributionPartial
          ? 'Partially measurable — some channels untracked'
          : 'Tracking present — real CAC still needs live spend data',
      tone: attributionBroken ? 'bad' : 'warn',
      explainer: 'Do you know what it actually costs to win one customer, or is that a guess right now?',
      locked: false,
    },
    {
      label: 'Gross Margin',
      value: '',
      tone: 'good',
      explainer: 'After product cost and shipping, is there real margin left — or just revenue?',
      locked: true,
    },
    {
      label: 'RTO Rate',
      value: '',
      tone: 'good',
      explainer: 'How much revenue walks away at the door when a delivery is refused?',
      locked: true,
    },
    {
      label: 'COD Share',
      value: '',
      tone: 'good',
      explainer: 'How exposed is this store to cash-on-delivery risk?',
      locked: true,
    },
    {
      label: 'Settlement Lag (cash locked)',
      value: '',
      tone: 'good',
      explainer: "Is cash this store has already earned stuck waiting to settle?",
      locked: true,
    },
    {
      label: 'Cash Flow Health',
      value: '',
      tone: 'good',
      explainer: 'Once ad spend is counted, is this business actually solvent?',
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
      hasLegacyUa: false,
      legacyUaId: null,
      hasPinterestTag: false,
      pinterestTagId: null,
      hasSnapchatPixel: false,
      snapchatPixelId: null,
      hasMicrosoftUet: false,
      contactSignals: { socialLinks: [], contactEmail: null, aboutOrContactPageUrl: null },
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
    hasLegacyUa: scan.hasLegacyUa,
    legacyUaId: scan.legacyUaId,
    hasPinterestTag: scan.hasPinterestTag,
    pinterestTagId: scan.pinterestTagId,
    hasSnapchatPixel: scan.hasSnapchatPixel,
    snapchatPixelId: scan.snapchatPixelId,
    hasMicrosoftUet: scan.hasMicrosoftUet,
    contactSignals: scan.contactSignals,
  };
};

/**
 * TAB 2 — WITH ACCESS.
 * inputs is required — no default fallback object. Caller (App.tsx) blocks
 * the scan until real CSV/Shopify data is loaded.
 * manualGtmId / manualGa4Id are optional user-supplied IDs, cross-checked
 * (case-insensitively) against what the live HTML scan actually detects.
 *
 * Output is a detailed TEXT report (signalFindings, topIssues, scopeNotes,
 * businessMetrics, recommendations) — deliberately not a per-metric card
 * grid, so it reads as a report you can talk through on a client call.
 */
export const runFullAudit = async (
  storeUrl: string,
  // Optional on purpose — the tracking-diagnostic half of this audit
  // (GTM/GA4/pixel evidence, dataLayer, consent, Locate+Point+Guide) doesn't
  // need Shopify order data at all. null here means "no CSV/live pull
  // loaded yet" — businessMetrics/leaks/volumeNote degrade to an honest
  // "Unaccessed" state below rather than computing off fabricated zeros.
  inputs: AuditInputs | null,
  manualGtmId: string | null = null,
  manualGa4Id: string | null = null,
  region: Region = 'US',
  deepEvidence: DeepScanResult | null = null,
  clientReportedIssue: string | null = null,
  clientReportedCategory: TopIssueCategory | null = null
): Promise<AuditDashboardResult> => {
  const audit = inputs ? calculateAudit(inputs) : null;

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
      : { type: 'warning', text: `No consent tool detected — possible risk under ${REGIONS[region].label} privacy rules, verify manually before claiming compliance.` }
  );
  // These 3 are outside the "core 4" score — absence isn't flagged (not
  // every store runs Pinterest/Snapchat/Microsoft Ads), but presence is
  // worth surfacing since it's tracking infrastructure the operator needs
  // to know about, same as Meta/TikTok. Legacy UA is dead code, not a
  // tracking gap — stopped processing in July 2023 — flagged as clutter
  // to clean up, not a functional problem.
  if (scan.hasPinterestTag) {
    recommendations.push({ type: 'success', text: `Pinterest Tag detected${scan.pinterestTagId ? ` (${scan.pinterestTagId})` : ''}.` });
  }
  if (scan.hasSnapchatPixel) {
    recommendations.push({ type: 'success', text: `Snapchat Pixel detected${scan.snapchatPixelId ? ` (${scan.snapchatPixelId})` : ''}.` });
  }
  if (scan.hasMicrosoftUet) {
    recommendations.push({ type: 'success', text: 'Microsoft Ads (UET) tag detected.' });
  }
  if (scan.hasLegacyUa) {
    recommendations.push({ type: 'info', text: `Legacy Universal Analytics snippet still present (${scan.legacyUaId}) — stopped collecting data in July 2023, safe to remove, but adds noise when auditing what's actually tracking.` });
  }
  if (audit) {
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
  } else {
    recommendations.push({
      type: 'info',
      text: 'No order data loaded yet — financial metrics (RTO, COD, burn rate) need Shopify order data (CSV upload or live pull) to compute.',
    });
  }

  const scopeNotes: AuditReportIssue[] = [
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

  // GTM/GA4 ID mismatch and "no CMP detected" used to be separate, parallel
  // findings pushed only here — duplicating what the diagnostic engine
  // already covers (or, for ID mismatch, could cover once it knows the
  // manually-supplied IDs). Consolidated: diagnosticEngine.ts now owns all
  // tracking-evidence findings including manual-ID reconciliation (see
  // manual-gtm-mismatch/manual-ga4-mismatch below), and no-cmp-with-active-tags
  // already covers the consent check. issueList/scopeNotes stays limited to
  // genuine audit-methodology caveats — not a second, overlapping issues list.

  // ---- Triage: rank leaks by $ impact and flag where to look first ----
  const rankedLeaks = audit ? [...audit.leaks].sort((a, b) => b.amt - a.amt) : [];
  rankedLeaks.forEach((leak, i) => {
    leak.priority = i < 2 && leak.amt > 0;
  });

  // "Start here" pointer — LOCATE -> POINT. Previously this only appeared
  // for stores with 500+ orders, so smaller stores (the more typical SMB
  // case) never got a priority pointer even though rankedLeaks was already
  // computed for them. Now always surfaces the single biggest confirmed $
  // leak regardless of volume; the framing just adjusts for high volume.
  const topLeak = rankedLeaks[0];
  const volumeNote = !audit || !inputs
    ? 'No order data loaded yet — this audit covers tracking evidence only. Load Shopify order data (CSV upload or live pull) to see financial leaks and business metrics.'
    : topLeak && topLeak.amt > 0
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
      hasLegacyUa: scan.hasLegacyUa,
      legacyUaId: scan.legacyUaId,
      hasPinterestTag: scan.hasPinterestTag,
      pinterestTagId: scan.pinterestTagId,
      hasSnapchatPixel: scan.hasSnapchatPixel,
      snapchatPixelId: scan.snapchatPixelId,
      hasMicrosoftUet: scan.hasMicrosoftUet,
      contactSignals: scan.contactSignals,
    },
    deepEvidence,
    { gtmId: manualGtmId, ga4Id: manualGa4Id },
    region
  );
  const topIssuesResult = buildTopIssues(diagnosticReport, audit ? audit.leaks : [], region, 10, clientReportedCategory || undefined);

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

  // businessMetrics degrades to an honest "Unaccessed" state when no order
  // data has been loaded — same pattern as Stage 1's locked cards, never a
  // computed number off inputs that don't exist.
  const businessMetrics = audit
    ? [
        { label: 'Gross Revenue', value: formatCurrency(audit.grossRevenue, region), explainer: 'Total order value before any costs are subtracted — your top-line number.' },
        { label: 'ROAS', value: `${audit.roas.toFixed(2)}x`, explainer: `For every ${formatCurrency(1, region)} spent on ads, how many came back in revenue — below 1x means ads are losing money outright.` },
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
      ]
    : [
        { label: 'Gross Revenue', value: 'Unaccessed — load order data to see this', explainer: 'Total order value before any costs are subtracted — your top-line number.' },
        { label: 'ROAS', value: 'Unaccessed — load order data to see this', explainer: 'For every dollar spent on ads, how many came back in revenue — below 1x means ads are losing money outright.' },
        { label: 'CAC', value: 'Unaccessed — load order data to see this', explainer: 'What it costs in ad spend alone to acquire one new customer.' },
        { label: 'Gross Margin', value: 'Unaccessed — load order data to see this', explainer: "What's left after product cost and shipping — before ad spend and other overhead." },
        { label: 'RTO Rate', value: 'Unaccessed — load order data to see this', explainer: 'Share of orders that came back undelivered.' },
        { label: 'COD Share', value: 'Unaccessed — load order data to see this', explainer: 'Share of orders paid cash-on-delivery.' },
        { label: 'Settlement Lag (cash locked)', value: 'Unaccessed — load order data to see this', explainer: "Cash tied up waiting for COD payments to actually settle — money you've technically earned but can't spend yet." },
        { label: 'Cash Flow Health', value: 'Unaccessed — load order data to see this', explainer: "Whether gross margin actually covers ad spend." },
      ];

  return {
    url: storeUrl,
    score: healthScore,
    status: 'ok',
    contactSignals: scan.contactSignals,
    metrics: {
      gtmDetected: !!gtmId,
      gtmId: gtmId || 'Not found',
      ga4Active: !!ga4Id,
      ga4Id: ga4Id || 'Not found',
      metaPixel: effective.metaDetected,
      metaPixelId: scan.metaPixelId,
      tiktokPixel: effective.tiktokDetected,
      tiktokPixelId: scan.tiktokPixelId,
      cmpDetected: scan.hasCmp,
      cmpName: scan.cmpName || 'None',
      hasPinterestTag: scan.hasPinterestTag,
      pinterestTagId: scan.pinterestTagId,
      hasSnapchatPixel: scan.hasSnapchatPixel,
      snapchatPixelId: scan.snapchatPixelId,
      hasMicrosoftUet: scan.hasMicrosoftUet,
      pageSpeed: 'Not measured',
      sslValid: storeUrl.startsWith('https://'),
      grossRevenue: audit?.grossRevenue ?? 0,
      netOutcome: audit?.netOutcome ?? 0,
      roas: audit?.roas ?? 0,
      cac: audit?.cac ?? 0,
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
      scopeNotes,
      businessMetrics,
      topIssues: topIssuesResult,
      volumeNote,
      clientReportedIssue: clientReportedIssue?.trim() || undefined,
      clientReportedCategory: clientReportedCategory || undefined,
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
      metaPixelId: null,
      tiktokPixel: false,
      tiktokPixelId: null,
      cmpDetected: false,
      cmpName: 'N/A',
      hasPinterestTag: false,
      pinterestTagId: null,
      hasSnapchatPixel: false,
      snapchatPixelId: null,
      hasMicrosoftUet: false,
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
      scopeNotes: [],
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
    throw errorFromResponseBody(body, `Shopify orders request failed (${res.status})`);
  }
  const data = await res.json();
  return shopifyOrdersToAuditInputs(data.orders || []);
}

export interface ShopifyProductCatalog {
  total: number;
  active: number;
  draft: number;
  archived: number;
}

export async function fetchShopifyProductCatalog(): Promise<ShopifyProductCatalog> {
  const res = await fetch(`${PROXY_BASE}/shopify/products/count`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw errorFromResponseBody(body, `Shopify product count request failed (${res.status})`);
  }
  return res.json();
}

// Same "point, don't dictate" pattern as the order-volume note: a catalog of
// any size shares one product-page template unless a client has deliberately
// customized individual products, so per-SKU tracking checks are the wrong
// amount of work regardless of whether the count is 20 or 20,000 — there's
// no honest threshold to branch on here, unlike the order-count note.
export function buildCatalogNote(catalog: ShopifyProductCatalog): string | null {
  if (catalog.total === 0) return null;
  const noun = catalog.total === 1 ? 'product' : 'products';
  const activeNote = catalog.active > 0 ? `${catalog.active} active` : 'none currently active';
  return `${catalog.total} ${noun} in the catalog (${activeNote}). Don't check tracking product-by-product — confirm it once on a representative product page. Shopify themes share a single product-page template unless a product has been individually customized.`;
}

export interface Ga4Property {
  propertyId: string;
  displayName: string;
  accountName: string;
}

export async function fetchGa4Properties(): Promise<Ga4Property[]> {
  const res = await fetch(`${PROXY_BASE}/ga4/properties`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw errorFromResponseBody(body, `GA4 properties request failed (${res.status})`);
  }
  const data = await res.json();
  return data.properties || [];
}

export async function fetchGa4LiveReport(propertyId: string, startDate: string, endDate: string): Promise<Ga4LiveMetrics> {
  const res = await fetch(`${PROXY_BASE}/ga4/report?propertyId=${encodeURIComponent(propertyId)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw errorFromResponseBody(body, `GA4 report request failed (${res.status})`);
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
    throw errorFromResponseBody(body, `GTM containers request failed (${res.status})`);
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
  deep: DeepScanResult | null,
  region: Region = 'US'
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
          text: `GA4 reports ${liveGa4.conversions} conversions / ${formatCurrency(liveGa4.purchaseRevenue, region)} revenue for this window, but the storefront deep scan found no ecommerce dataLayer fields on page load. This isn't a contradiction by itself (conversions happen at checkout, not the homepage) — but if GA4 revenue doesn't reconcile with Shopify order totals for the same window, check how GA4 is receiving purchase data.`,
        });
      } else {
        findings.push({ tone: 'good', text: `GA4 reports real conversions (${liveGa4.conversions}) and revenue (${formatCurrency(liveGa4.purchaseRevenue, region)}) for this window.` });
      }

      // Actual comparison against the confirmed Shopify figure, not just a
      // suggestion to go do it — both numbers are already in scope. Always
      // "warn" tone rather than an invented pass/fail threshold: a
      // percentage cutoff for "acceptable drift" would be a fabricated
      // benchmark with no real basis, and this is only a fair comparison at
      // all when both pulls used the same date range, which this function
      // has no way to confirm from here.
      if (liveGa4.purchaseRevenue > 0 && result.metrics.grossRevenue > 0) {
        const diffPct = ((liveGa4.purchaseRevenue - result.metrics.grossRevenue) / result.metrics.grossRevenue) * 100;
        const sign = diffPct >= 0 ? '+' : '';
        findings.push({
          tone: 'warn',
          text: `GA4 revenue (${formatCurrency(liveGa4.purchaseRevenue, region)}) vs. confirmed Shopify revenue (${formatCurrency(result.metrics.grossRevenue, region)}) for this audit: ${sign}${diffPct.toFixed(0)}% difference. Only a fair comparison if both used the same date range — refunds, currency conversion, and attribution timing can also explain a gap. Reconcile the date ranges before treating this as a tracking problem.`,
        });
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
    pinterestBrowserRequests: number;
    snapchatBrowserRequests: number;
    microsoftUetBrowserRequests: number;
    serverSideEndpointCandidates: string[];
  };
  observedIds: { ga4: string[]; gtm: string[] };
  note: string;
}

export async function fetchDeepScan(storeUrl: string): Promise<DeepScanResult> {
  const res = await fetch(`${PROXY_BASE}/scan/deep?url=${encodeURIComponent(storeUrl)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw errorFromResponseBody(body, `Deep scan request failed (${res.status})`);
  }
  return res.json();
}

// Shared by both PDF exports so the contact block can't drift between them
// — one place to update the name/email/phone/payment line, not two.
const CONTACT_FOOTER_HTML = `
    <hr style="margin-top:28px;border:none;border-top:1px solid #334155" />
    <p style="text-align:center;color:#94a3b8;font-size:0.8em;margin-top:12px">Prepared by JSONalytics™</p>
    <p style="text-align:center;font-size:1em;font-weight:700;color:#f8fafc;margin-top:12px">Jason <span style="color:#94a3b8;font-size:0.78em;font-weight:600">(preferred name)</span></p>
    <p style="text-align:center;font-size:1.15em;font-weight:800;color:#b45309;margin-top:2px">jagjit@jsonalytics.com</p>
    <p style="text-align:center;font-size:1em;font-weight:700;color:#f8fafc;margin-top:4px">WhatsApp: +91-8588006657</p>
    <p style="text-align:center;font-size:0.8em;color:#94a3b8;margin-top:6px">US account via Wise — universally accepted, easy international payment.</p>
    <p style="text-align:center;font-size:0.8em;color:#94a3b8;margin-top:4px">Ownership declaration available upon request.</p>`;

export function buildReportHtml(scanResult: AuditDashboardResult, region: Region = 'US'): string {
  return `<html><body style="font-family:sans-serif;padding:24px;background:#0f172a;color:#f8fafc">
    <h1>${escapeHtml(scanResult.report.headline)}</h1>
    <p style="color:#94a3b8;font-size:0.85em">Evidence: ${scanResult.report.evidenceDepth === 'static+deep' ? 'static HTML + read-only deep scan' : 'static HTML only'}</p>
    <p>${escapeHtml(scanResult.report.summary)}</p>
    ${scanResult.report.clientReportedIssue
      ? `<p style="background:#1e293b;border-left:4px solid #e8792c;padding:8px 12px;color:#f8fafc">Client reported: "${escapeHtml(scanResult.report.clientReportedIssue)}" — not independently verified, shown as context for this audit.</p>`
      : ''}
    <h3>Top Issues${scanResult.report.topIssues.totalFound > scanResult.report.topIssues.issues.length ? ` (top ${scanResult.report.topIssues.issues.length} of ${scanResult.report.topIssues.totalFound} found)` : ''}</h3>
    <!-- Deliberately no "first check" hint here — this PDF is the pre-sale
         Report deliverable; the fix steps belong in the Validation PDF,
         after the client is actually paying. Split into Confirmed/Worth
         Confirming (same partitionEdgeCases split as the on-screen Report
         and Stage 2's own Top Issues view) so the confidence gap between a
         measured finding and a low-confidence one reads clearly on the
         page itself, without needing a call to explain it. -->
    ${scanResult.report.topIssues.issues.length === 0
      ? '<p>No confirmed issues from the evidence gathered for this audit.</p>'
      : (() => {
          const issueRow = (i: typeof scanResult.report.topIssues.issues[number]) =>
            `<li><b>${escapeHtml(i.title)}</b> (${escapeHtml(i.severity)})${i.amount ? ` — ${escapeHtml(formatCurrency(i.amount, region))}` : ''}: ${escapeHtml(i.detail)}</li>`;
          const confirmed = scanResult.report.topIssues.issues.filter((i) => !i.possibleReasons || i.possibleReasons.length === 0);
          const worthConfirming = scanResult.report.topIssues.issues.filter((i) => i.possibleReasons && i.possibleReasons.length > 0);
          return `
            ${confirmed.length > 0 ? `<p style="font-size:0.85em;font-weight:bold;color:#f8fafc;margin-bottom:4px">CONFIRMED</p><ol>${confirmed.map(issueRow).join('')}</ol>` : ''}
            ${worthConfirming.length > 0 ? `<p style="font-size:0.85em;font-weight:bold;color:#b45309;margin:14px 0 2px">WORTH CONFIRMING</p><p style="font-size:0.8em;color:#94a3b8;margin:0 0 4px">Evidence points here, but more than one real-world cause is possible from outside evidence alone.</p><ol>${worthConfirming.map(issueRow).join('')}</ol>` : ''}
          `;
        })()
    }
    <h3>Signal Findings</h3>
    <ul>${scanResult.report.signalFindings
      .map((f) => `<li>${escapeHtml(f.label)}: ${escapeHtml(f.value)}${f.note ? ` — ${escapeHtml(f.note)}` : ''}</li>`)
      .join('')}</ul>
    <h3>Financial Calculator</h3>
    <table style="width:100%;border-collapse:collapse;font-size:0.92em;margin-bottom:8px">
      ${scanResult.report.businessMetrics
        .map((m) => {
          const isSubtotal = m.label === 'Gross Margin' || m.label === 'Cash Flow Health';
          return `<tr style="border-bottom:1px solid #334155;${isSubtotal ? 'font-weight:bold;background:#1e293b' : ''}">
            <td style="padding:8px 10px;color:#94a3b8">${escapeHtml(m.label)}</td>
            <td style="padding:8px 10px;text-align:right;white-space:nowrap;color:#f8fafc">${escapeHtml(m.value)}</td>
          </tr>
          <tr><td colspan="2" style="padding:0 10px 8px;color:#94a3b8;font-size:0.82em">${escapeHtml(m.explainer)}</td></tr>`;
        })
        .join('')}
    </table>
    <h3>Audit Scope &amp; Limitations</h3>
    <ul>${scanResult.report.scopeNotes
      .map((i) => `<li><b>${escapeHtml(i.category)}</b>: ${escapeHtml(i.statement)}</li>`)
      .join('')}</ul>
    <h3>Recommendations</h3>
    <ul>${scanResult.recommendations.map((r) => `<li>${escapeHtml(r.text)}</li>`).join('')}</ul>
    ${CONTACT_FOOTER_HTML}
  </body></html>`;
}

/**
 * The Validation PDF — deliberately NOT buildReportHtml reused with
 * different data. Validation's whole point (explicit user definition:
 * "report shows what's broken, validation shows what's been fixed") is the
 * diff, not a flat findings list, so it needs its own shape: resolved
 * issues get the operator's own typed technical-steps note (paying-client
 * depth, never auto-generated), still-open issues stay hedged the same way
 * the app always hedges, and a fixed warning up top protects the fix's
 * accuracy against changes the operator never made and can't be
 * responsible for.
 */
export function buildValidationReportHtml(
  result: AuditDashboardResult,
  diff: { resolved: TopIssue[]; stillOpen: TopIssue[]; newlyFound: TopIssue[] },
  techStepNotes: Record<string, string>
): string {
  return `<html><body style="font-family:sans-serif;padding:24px;background:#0f172a;color:#f8fafc">
    <h1>What's Been Fixed</h1>
    <p style="color:#94a3b8;font-size:0.85em">${escapeHtml(result.url)} — validated ${escapeHtml(new Date().toLocaleString())}</p>
    <p style="background:#1e293b;border-left:4px solid #e8792c;padding:10px 12px;color:#f8fafc;font-size:0.9em">
      To keep this accurate going forward: please don't modify the tracking setup covered in this report. Any other change to the store — installing a new app, a platform or theme update, a redesign — can affect tracking independently of this fix and may need a fresh check; that's outside the scope of what's validated here.
    </p>
    <h3>Resolved (${diff.resolved.length})</h3>
    ${diff.resolved.length === 0
      ? '<p>Nothing resolved yet compared to the original report.</p>'
      : `<ol>${diff.resolved
          .map((i) => `<li><b>${escapeHtml(i.title)}</b> — no longer detected.${techStepNotes[i.id]?.trim() ? `<br/><i>Technical steps taken: ${escapeHtml(techStepNotes[i.id].trim())}</i>` : ''}</li>`)
          .join('')}</ol>`
    }
    <h3>Still Open (${diff.stillOpen.length})</h3>
    ${diff.stillOpen.length === 0
      ? '<p>Everything from the original report is resolved.</p>'
      : `<ol>${diff.stillOpen.map((i) => `<li><b>${escapeHtml(i.title)}:</b> ${escapeHtml(i.detail)} <i>First check: ${escapeHtml(i.firstCheck)}</i></li>`).join('')}</ol>`
    }
    ${diff.newlyFound.length > 0
      ? `<h3>New since the original report (${diff.newlyFound.length})</h3><ol>${diff.newlyFound.map((i) => `<li><b>${escapeHtml(i.title)}:</b> ${escapeHtml(i.detail)}</li>`).join('')}</ol>`
      : ''
    }
    ${CONTACT_FOOTER_HTML}
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
    throw errorFromResponseBody(body, `PDF export failed (${res.status})`);
  }
  return res.blob();
}
