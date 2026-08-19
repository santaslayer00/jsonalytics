/**
 * Unified "Top Issues" list — merges tracking-evidence findings
 * (diagnosticEngine.ts) with financial leaks (calculateAudit's LeakItem[])
 * into one ranked list, capped at 10.
 *
 * Region affects this through LOGIC, not just wording:
 *  - Tracking findings (GTM/GA4/Meta/TikTok/dataLayer/duplicate containers)
 *    are universal engineering problems — same rules, same ranking, in
 *    every market. Nothing about them changes by region.
 *  - COD/RTO findings are ranked primarily by their own measured $ amount
 *    (which already reflects market reality on its own: a US store with 0
 *    COD orders produces $0 leak, a COD-heavy IN store produces a real
 *    number) — no invented per-country benchmark numbers are used anywhere
 *    here, only the store's own measured data.
 *  - The one real region-conditioned RULE: in COD-typical markets (India),
 *    a genuine COD/RTO leak is guaranteed a top-10 slot once it clears a
 *    trivial-amount floor, because COD/RTO health is a first-order signal
 *    for that market's operators. In markets where COD is atypical
 *    (US/UK/CA/AU), a nonzero COD share is flagged as a market-structure
 *    anomaly worth confirming (could be intentional B2B/manual invoicing,
 *    could be a checkout misconfiguration) rather than routine — same
 *    evidence, different, defensible interpretation.
 */

import type { DiagnosticReport, DiagnosticSeverity } from './diagnosticEngine';
import type { LeakItem } from './auditLogic';
import type { Region } from './constants';
import { formatCurrency } from './formatters.ts';

export type TopIssueCategory = 'tracking' | 'financial' | 'compliance' | 'manual';

export interface TopIssue {
  id: string;
  category: TopIssueCategory;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  firstCheck: string;
  amount?: number; // $ amount, for financial issues only
  // Locate — carried across from DiagnosticFinding for tracking-category
  // issues only; financial/manual issues never had this evidence tier and
  // stay undefined rather than getting a fabricated one.
  observed?: string[];
  doesNotProve?: string;
  // Whether stronger evidence (a deep scan) exists but hasn't been pulled
  // in yet — the basis for the "Missing / where to find it" block. Carried
  // across the same way as the other Locate fields.
  requiresDeepScan?: boolean;
  // Guide — same source. Undefined means "no distinct candidate causes for
  // this one," not "no guidance" (firstCheck/detail still apply either way).
  possibleReasons?: Array<{ cause: string; howToCheck: string }>;
}

export interface TopIssuesResult {
  issues: TopIssue[]; // ranked, capped at 10
  totalFound: number; // honest count before capping — never silently truncated without disclosure
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

// Markets where cash-on-delivery is a common, structurally significant
// payment method on Shopify storefronts. Not a fabricated statistic — this
// only gates which INTERPRETATION applies to a store's own measured COD
// share; it never invents a number for what that share "should" be.
export const COD_TYPICAL_MARKETS: Region[] = ['IN'];

export function buildTopIssues(
  diagnostic: DiagnosticReport,
  leaks: LeakItem[],
  region: Region,
  cap = 10,
  // Narrows toward what the client actually reported, without letting a
  // guess override real evidence: severity still decides rank first — this
  // only breaks ties WITHIN the same severity tier, so a guessed-wrong
  // category can never bury a genuinely more severe finding.
  boostCategory?: TopIssueCategory
): TopIssuesResult {
  const issues: TopIssue[] = [];

  // Tracking findings: identical logic in every market. Only real,
  // actionable findings count as "issues" — the info-level "all clear" /
  // "not evaluable from page load" entries are hedges, not problems, and
  // don't belong in an issues count.
  for (const f of diagnostic.findings) {
    if (f.severity === 'info') continue;
    issues.push({
      id: f.id,
      category: 'tracking',
      severity: f.severity,
      title: f.title,
      detail: f.proves,
      firstCheck: f.firstCheck,
      observed: f.observed,
      doesNotProve: f.doesNotProve,
      requiresDeepScan: f.requiresDeepScan,
      possibleReasons: f.possibleReasons,
    });
  }

  // Financial leaks: ranked by their own measured $ amount. Severity is
  // derived from relative size within this store's own leaks, not an
  // external benchmark.
  const rankedLeaks = [...leaks].filter((l) => l.amt > 0).sort((a, b) => b.amt - a.amt);
  const isCodTypical = COD_TYPICAL_MARKETS.includes(region);

  rankedLeaks.forEach((leak, i) => {
    const isCodOrRto = /rto|cod/i.test(leak.name);
    let severity: DiagnosticSeverity = i === 0 ? 'high' : i === 1 ? 'medium' : 'low';
    let detail = `Confirmed from your entered figures — this is real, not estimated.`;

    if (isCodOrRto) {
      detail = isCodTypical
        ? 'COD/RTO exposure is a first-order signal in COD-heavy markets — worth tracking even when other leaks are numerically larger.'
        : "COD/RTO activity in a market where card/digital checkout usually dominates — confirm this is intentional (B2B, manual orders) rather than a checkout misconfiguration, since it's atypical here regardless of size.";
    }

    issues.push({
      id: `leak-${leak.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      category: 'financial',
      severity,
      title: leak.name,
      detail,
      firstCheck: isCodOrRto
        ? 'Reconcile COD/RTO order counts against your logistics/courier RTO report for the same period — this app only has order counts, not delivery outcomes.'
        : 'Confirm this figure against your ad platform spend/revenue reports for the same date range.',
      amount: leak.amt,
    });
  });

  // Guarantee: in a COD-typical market, a real (non-trivial) COD/RTO leak
  // is never pushed out of the top 10 purely by being smaller than other
  // leaks — pull it back in if the generic cap would have dropped it.
  issues.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    if (boostCategory) {
      const boostDiff = (b.category === boostCategory ? 1 : 0) - (a.category === boostCategory ? 1 : 0);
      if (boostDiff !== 0) return boostDiff;
    }
    return (b.amount || 0) - (a.amount || 0);
  });

  let capped = issues.slice(0, cap);
  if (isCodTypical) {
    const codRtoIssue = issues.find((i) => /rto|cod/i.test(i.title));
    if (codRtoIssue && !capped.includes(codRtoIssue)) {
      capped = [...capped.slice(0, cap - 1), codRtoIssue];
    }
  }

  return { issues: capped, totalFound: issues.length };
}

/**
 * Splits a ranked issues list into confident "Top Issues" (one clear cause,
 * one clear check — duplicate containers, ID mismatches, financial leaks,
 * confirmed manual-check failures) vs "Edge Cases" (genuinely ambiguous —
 * multiple candidate causes, some possibly outside what this scan can see
 * at all, like a Custom Pixels sandbox). possibleReasons being populated IS
 * the signal for "edge case" — that field only ever gets set on findings
 * where the diagnostic engine itself couldn't narrow to one cause, so this
 * reuses a real distinction already made upstream instead of inventing a
 * new classification here.
 */
export function partitionEdgeCases(issues: TopIssue[]): { topIssues: TopIssue[]; edgeCases: TopIssue[] } {
  const topIssues: TopIssue[] = [];
  const edgeCases: TopIssue[] = [];
  for (const issue of issues) {
    (issue.possibleReasons && issue.possibleReasons.length > 0 ? edgeCases : topIssues).push(issue);
  }
  return { topIssues, edgeCases };
}

/**
 * The Client Report's Validation tab, precisely: "report shows what's
 * broken, validation shows what all has been fixed" (explicit user
 * definition, 2026-08-15). A raw re-scan alone only answers "what's wrong
 * today" — it takes a diff against the original to answer "did the fix
 * work." Matches by `id`, which is stable across separate scan runs for
 * the same underlying cause (a rule id like 'no-cmp-with-active-tags', or a
 * leak id like 'leak-rto-returns' — never a random per-instance value), so
 * "resolved" means the exact same finding is genuinely gone, not relabeled.
 */
export function diffTopIssues(before: TopIssuesResult, after: TopIssuesResult): { resolved: TopIssue[]; stillOpen: TopIssue[]; newlyFound: TopIssue[] } {
  const beforeIds = new Set(before.issues.map((i) => i.id));
  const afterIds = new Set(after.issues.map((i) => i.id));
  return {
    resolved: before.issues.filter((i) => !afterIds.has(i.id)),
    stillOpen: after.issues.filter((i) => beforeIds.has(i.id)),
    newlyFound: after.issues.filter((i) => !beforeIds.has(i.id)),
  };
}

// Tracking findings where a wrong/duplicate/missing measurement ID is
// plausibly, directly connected to a revenue-reporting gap — not every
// tracking finding qualifies (no-cmp-with-active-tags or legacy-ua-present
// have nothing to do with revenue accuracy). Kept as an explicit allowlist
// rather than "any tracking finding" so this never overreaches into a
// finding the reconciliation number has no real relationship to.
const REVENUE_RELEVANT_FINDING_IDS = new Set([
  'ga4-id-mismatch',
  'duplicate-gtm-containers',
  'gtm-declared-not-observed',
  'ga4-declared-not-observed',
  'manual-gtm-mismatch',
  'manual-ga4-mismatch',
]);

/**
 * Attaches the REAL, measured GA4-vs-Shopify revenue gap (not an invented
 * benchmark or estimated percentage) to the small set of tracking findings
 * a wrong/duplicate/missing measurement ID could plausibly explain. Only
 * fires when both revenue figures are real, confirmed numbers — never
 * computed on a pre-sale/no-access Report, since that's the one case this
 * data genuinely doesn't exist yet. Post-hoc on an already-ranked,
 * already-capped TopIssuesResult (called after buildTopIssues), so it never
 * reorders or re-selects which issues made the top 10 — it only enriches
 * ones already there with a real dollar figure where one now exists.
 *
 * Deliberately keeps the same hedge language already used in
 * reconcileLiveApiEvidence (date range / refunds / attribution timing can
 * also explain a gap) — a real measured number is still not proof this
 * specific finding caused all of it, and the text has to say so every time
 * it appears, not just the first time this gap is mentioned elsewhere.
 */
export function attachRevenueImpact(topIssues: TopIssuesResult, ga4Revenue: number, shopifyRevenue: number, region: Region): TopIssuesResult {
  if (!(ga4Revenue > 0) || !(shopifyRevenue > 0)) return topIssues; // no real data to compute from — leave untouched, never estimate

  const diffAmount = Math.abs(ga4Revenue - shopifyRevenue);
  if (diffAmount === 0) return topIssues; // numbers already reconcile — nothing to attach

  const diffPct = ((ga4Revenue - shopifyRevenue) / shopifyRevenue) * 100;
  const sign = diffPct >= 0 ? '+' : '';
  const hedgeSentence = ` In this audit, GA4-reported revenue differs from your confirmed Shopify revenue by ${formatCurrency(diffAmount, region)} (${sign}${diffPct.toFixed(0)}%) for this window — only a fair comparison if both used the same date range, and refunds/attribution timing can also explain a gap, so this isn't proof this finding alone caused it.`;

  return {
    ...topIssues,
    issues: topIssues.issues.map((issue) =>
      REVENUE_RELEVANT_FINDING_IDS.has(issue.id)
        ? { ...issue, amount: diffAmount, detail: issue.detail + hedgeSentence }
        : issue
    ),
  };
}

/**
 * Folds outcomes from the guided manual checks (GTM Preview, GA4 DebugView,
 * ad-platform diagnostics, Shopify reconciliation) into the same ranked
 * list — so doing those checks in the same sitting actually finishes the
 * audit instead of leaving it as a disconnected side checklist. A failed
 * manual check is direct human verification, not inference from evidence —
 * the strongest tier this app has — so it always leads the list, ahead of
 * every automated finding regardless of the automated severity scale.
 * Passed/unsure checks are not issues and add nothing here.
 */
export interface ManualCheckResult {
  id: string;
  title: string;
  where: string;
  outcome: 'pass' | 'fail' | 'unsure';
  note: string;
}

export function mergeManualFindings(base: TopIssuesResult, manualResults: ManualCheckResult[], cap = 10): TopIssuesResult {
  const failed = manualResults.filter((m) => m.outcome === 'fail');
  const manualIssues: TopIssue[] = failed.map((m) => ({
    id: `manual-${m.id}`,
    category: 'manual',
    severity: 'critical',
    title: `${m.title} — failed manual verification`,
    detail: m.note
      ? `Operator-confirmed via ${m.where}: ${m.note}`
      : `Operator-confirmed failure via ${m.where} — direct human verification, the strongest evidence tier this app has.`,
    firstCheck: `Fix, then re-verify in ${m.where} before re-auditing.`,
  }));

  if (manualIssues.length === 0) return base;

  return {
    issues: [...manualIssues, ...base.issues].slice(0, cap),
    totalFound: base.totalFound + manualIssues.length,
  };
}
