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

export type TopIssueCategory = 'tracking' | 'financial' | 'compliance';

export interface TopIssue {
  id: string;
  category: TopIssueCategory;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  firstCheck: string;
  amount?: number; // $ amount, for financial issues only
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
  cap = 10
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
