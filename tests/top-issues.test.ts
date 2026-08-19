import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopIssues, mergeManualFindings, partitionEdgeCases, diffTopIssues, attachRevenueImpact } from '../src/utils/topIssues.ts';
import type { ManualCheckResult, TopIssuesResult } from '../src/utils/topIssues.ts';
import type { DiagnosticReport, DiagnosticFinding } from '../src/utils/diagnosticEngine.ts';
import type { LeakItem } from '../src/utils/auditLogic.ts';

function finding(overrides: Partial<DiagnosticFinding>): DiagnosticFinding {
  return {
    id: 'x',
    severity: 'medium',
    confidence: 'high',
    title: 'X',
    observed: [],
    proves: 'proves-x',
    doesNotProve: 'does-not-prove-x',
    dependency: 'dep',
    downstreamConsequences: [],
    firstCheck: 'check-x',
    requiresDeepScan: false,
    ...overrides,
  };
}

function report(findings: DiagnosticFinding[]): DiagnosticReport {
  return { findings, earliestFailure: findings[0] || null, evidenceDepth: 'surface-only' };
}

test('buildTopIssues carries observed/doesNotProve/possibleReasons across for tracking issues — Stage 2 needs this for the Locate+Point/Guide tabs, not just title+detail', () => {
  const r = report([finding({
    id: 'sandboxed',
    severity: 'critical',
    observed: ['nothing seen'],
    doesNotProve: 'could be sandboxed',
    possibleReasons: [{ cause: 'not installed', howToCheck: 'check admin' }, { cause: 'sandboxed', howToCheck: 'check gtm preview' }],
  })]);
  const result = buildTopIssues(r, [], 'US');
  const issue = result.issues.find((i) => i.id === 'sandboxed')!;
  assert.deepEqual(issue.observed, ['nothing seen']);
  assert.equal(issue.doesNotProve, 'could be sandboxed');
  assert.equal(issue.possibleReasons!.length, 2);
});

test('financial leaks never carry possibleReasons/observed — that evidence tier only exists for tracking findings, never fabricated for a $ leak', () => {
  const r = report([]);
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 500 }];
  const result = buildTopIssues(r, leaks, 'US');
  assert.equal(result.issues[0].possibleReasons, undefined);
  assert.equal(result.issues[0].observed, undefined);
});

test('buildTopIssues carries requiresDeepScan across — the basis for the "Missing / where to find it" block', () => {
  const r = report([finding({ id: 'needs-deep', severity: 'medium', requiresDeepScan: true })]);
  const result = buildTopIssues(r, [], 'US');
  assert.equal(result.issues.find((i) => i.id === 'needs-deep')!.requiresDeepScan, true);
});

test('partitionEdgeCases splits on possibleReasons presence — the same signal the diagnostic engine already uses for "ambiguous," not a new classification', () => {
  const r = report([
    finding({ id: 'clean', severity: 'high', title: 'Clean finding' }), // no possibleReasons
    finding({ id: 'ambiguous', severity: 'medium', title: 'Ambiguous finding', possibleReasons: [{ cause: 'a', howToCheck: 'b' }] }),
  ]);
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 500 }]; // financial leaks never have possibleReasons
  const result = buildTopIssues(r, leaks, 'US');
  const { topIssues, edgeCases } = partitionEdgeCases(result.issues);

  assert.equal(edgeCases.length, 1);
  assert.equal(edgeCases[0].id, 'ambiguous');
  assert.ok(topIssues.some((i) => i.id === 'clean'));
  assert.ok(topIssues.some((i) => i.title === 'RTO returns'));
  assert.equal(topIssues.length + edgeCases.length, result.issues.length); // nothing lost or duplicated in the split
});

test('boostCategory reorders within the same severity tier, toward what the client reported', () => {
  const r = report([finding({ id: 'tracking-issue', severity: 'high', title: 'Tracking issue' })]);
  const leaks: LeakItem[] = [{ name: 'Ad spend leak', amt: 5000 }]; // first leak always ranks 'high' too — a real tie

  const noBoost = buildTopIssues(r, leaks, 'US');
  assert.equal(noBoost.issues[0].category, 'financial'); // amount tie-break wins by default

  const boosted = buildTopIssues(r, leaks, 'US', 10, 'tracking');
  assert.equal(boosted.issues[0].category, 'tracking'); // client said "tracking" — now leads the tie
});

test('boostCategory can never demote a genuinely more severe finding — severity still decides first', () => {
  const r = report([
    finding({ id: 'critical-tracking', severity: 'critical', title: 'Critical tracking gap' }),
  ]);
  const leaks: LeakItem[] = [{ name: 'Small ad leak', amt: 10 }]; // ranks 'high', below critical regardless

  const boosted = buildTopIssues(r, leaks, 'US', 10, 'financial');
  assert.equal(boosted.issues[0].category, 'tracking'); // critical beats a boosted-but-lower-severity item
});

test('info-level findings (all-clear / hedges) are excluded from the issues count', () => {
  const r = report([finding({ id: 'ok', severity: 'info' }), finding({ id: 'real', severity: 'high' })]);
  const result = buildTopIssues(r, [], 'US');
  assert.equal(result.totalFound, 1);
  assert.equal(result.issues[0].id, 'real');
});

test('financial leaks are ranked by their own measured $ amount, biggest first', () => {
  const leaks: LeakItem[] = [
    { name: 'ROAS opportunity gap (vs 3x)', amt: 500 },
    { name: 'RTO returns', amt: 5000 },
  ];
  const result = buildTopIssues(report([]), leaks, 'US');
  assert.equal(result.issues[0].title, 'RTO returns');
  assert.equal(result.issues[1].title, 'ROAS opportunity gap (vs 3x)');
});

test('COD/RTO gets different, honest interpretation text by market — not a fabricated benchmark either way', () => {
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 1000 }];
  const inResult = buildTopIssues(report([]), leaks, 'IN');
  const usResult = buildTopIssues(report([]), leaks, 'US');
  assert.match(inResult.issues[0].detail, /first-order signal/i);
  assert.match(usResult.issues[0].detail, /atypical/i);
  assert.notEqual(inResult.issues[0].detail, usResult.issues[0].detail);
});

test('caps at 10 but reports the honest total found, never silently pretending fewer exist', () => {
  const manyFindings = Array.from({ length: 14 }, (_, i) => finding({ id: `f${i}`, severity: 'medium' }));
  const result = buildTopIssues(report(manyFindings), [], 'US');
  assert.equal(result.issues.length, 10);
  assert.equal(result.totalFound, 14);
});

test('a real COD/RTO leak in a COD-typical market is guaranteed a top-10 slot even if it would otherwise be crowded out', () => {
  const manyHighSeverity = Array.from({ length: 10 }, (_, i) => finding({ id: `h${i}`, severity: 'critical' }));
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 50 }]; // small, would rank last
  const result = buildTopIssues(report(manyHighSeverity), leaks, 'IN');
  assert.ok(result.issues.some((i) => i.title === 'RTO returns'), 'RTO must not be crowded out in a COD-typical market');
});

test('the same small RTO leak has no such guarantee in a non-COD-typical market', () => {
  const manyHighSeverity = Array.from({ length: 10 }, (_, i) => finding({ id: `h${i}`, severity: 'critical' }));
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 50 }];
  const result = buildTopIssues(report(manyHighSeverity), leaks, 'US');
  assert.equal(result.issues.some((i) => i.title === 'RTO returns'), false);
});

test('the top-10 cap and honest totalFound hold in EVERY target market, not just the ones spot-checked elsewhere (US/IN)', () => {
  const manyFindings = Array.from({ length: 8 }, (_, i) => finding({ id: `f${i}`, severity: 'high' }));
  const leaks: LeakItem[] = [
    { name: 'RTO returns', amt: 3000 },
    { name: 'COD settlement lag (cash locked)', amt: 800 },
    { name: 'ROAS opportunity gap (vs 3x)', amt: 1200 },
  ];
  for (const region of ['US', 'UK', 'CA', 'AU', 'IN'] as const) {
    const result = buildTopIssues(report(manyFindings), leaks, region);
    assert.ok(result.issues.length <= 10, `${region}: cap exceeded (${result.issues.length} issues)`);
    assert.equal(result.totalFound, 11, `${region}: totalFound should count all 8 findings + 3 leaks regardless of market`);
    // Every issue must carry non-empty guidance — no region should silently
    // blank out a detail/firstCheck string (the synthetic tracking findings
    // used here are short by design; the point is catching empty/undefined,
    // which real diagnosticEngine.ts findings would never produce either).
    for (const issue of result.issues) {
      assert.ok(issue.detail && issue.detail.length > 0, `${region}: issue "${issue.title}" has an empty detail`);
      assert.ok(issue.firstCheck && issue.firstCheck.length > 0, `${region}: issue "${issue.title}" has an empty firstCheck`);
    }
  }
});

test('only India gets the COD-typical guarantee/anomaly framing — UK, CA, and AU are treated identically to US', () => {
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 1000 }];
  const usDetail = buildTopIssues(report([]), leaks, 'US').issues[0].detail;
  for (const region of ['UK', 'CA', 'AU'] as const) {
    const detail = buildTopIssues(report([]), leaks, region).issues[0].detail;
    assert.equal(detail, usDetail, `${region} should use the same non-COD-typical framing as US`);
    assert.match(detail, /atypical/i);
  }
});

test('zero-amount leaks are not surfaced as issues at all', () => {
  const leaks: LeakItem[] = [{ name: 'RTO returns', amt: 0 }];
  const result = buildTopIssues(report([]), leaks, 'IN');
  assert.equal(result.totalFound, 0);
});

function baseTopIssues(): TopIssuesResult {
  return { issues: [{ id: 'a', category: 'tracking', severity: 'high', title: 'A', detail: 'd', firstCheck: 'c' }], totalFound: 1 };
}

test('a failed manual check leads the list, ahead of every automated finding regardless of severity', () => {
  const manual: ManualCheckResult[] = [{ id: 'purchase', title: 'Purchase firing', where: 'GTM Preview', outcome: 'fail', note: 'No purchase tag fired on test order' }];
  const result = mergeManualFindings(baseTopIssues(), manual);
  assert.equal(result.issues[0].category, 'manual');
  assert.equal(result.issues[0].severity, 'critical');
  assert.match(result.issues[0].detail, /No purchase tag fired on test order/);
  assert.equal(result.totalFound, 2);
});

test('passed and unsure checks add nothing — only confirmed failures become issues', () => {
  const manual: ManualCheckResult[] = [
    { id: 'a', title: 'A', where: 'x', outcome: 'pass', note: '' },
    { id: 'b', title: 'B', where: 'x', outcome: 'unsure', note: '' },
  ];
  const result = mergeManualFindings(baseTopIssues(), manual);
  assert.deepEqual(result, baseTopIssues());
});

test('no manual results at all leaves the base list completely untouched', () => {
  const result = mergeManualFindings(baseTopIssues(), []);
  assert.deepEqual(result, baseTopIssues());
});

function issue(id: string, overrides: Partial<TopIssuesResult['issues'][number]> = {}): TopIssuesResult['issues'][number] {
  return { id, category: 'tracking', severity: 'high', title: id, detail: 'd', firstCheck: 'c', ...overrides };
}

test('diffTopIssues: a finding present before and gone after counts as resolved', () => {
  const before = { issues: [issue('no-measurement-layer')], totalFound: 1 };
  const after = { issues: [], totalFound: 0 };
  const diff = diffTopIssues(before, after);
  assert.equal(diff.resolved.length, 1);
  assert.equal(diff.resolved[0].id, 'no-measurement-layer');
  assert.equal(diff.stillOpen.length, 0);
  assert.equal(diff.newlyFound.length, 0);
});

test('diffTopIssues: the same id in both counts as still open, not resolved', () => {
  const before = { issues: [issue('no-cmp-with-active-tags')], totalFound: 1 };
  const after = { issues: [issue('no-cmp-with-active-tags')], totalFound: 1 };
  const diff = diffTopIssues(before, after);
  assert.equal(diff.resolved.length, 0);
  assert.equal(diff.stillOpen.length, 1);
  assert.equal(diff.stillOpen[0].id, 'no-cmp-with-active-tags');
});

test('diffTopIssues: a finding that only appears after counts as newly found, not resolved or still open', () => {
  const before = { issues: [], totalFound: 0 };
  const after = { issues: [issue('duplicate-gtm-containers')], totalFound: 1 };
  const diff = diffTopIssues(before, after);
  assert.equal(diff.resolved.length, 0);
  assert.equal(diff.stillOpen.length, 0);
  assert.equal(diff.newlyFound.length, 1);
  assert.equal(diff.newlyFound[0].id, 'duplicate-gtm-containers');
});

test('diffTopIssues: everything resolved leaves all three buckets correctly empty or full', () => {
  const before = { issues: [issue('a'), issue('b')], totalFound: 2 };
  const after = { issues: [], totalFound: 0 };
  const diff = diffTopIssues(before, after);
  assert.equal(diff.resolved.length, 2);
  assert.equal(diff.stillOpen.length, 0);
  assert.equal(diff.newlyFound.length, 0);
});

test('diffTopIssues: a real mixed before/after (some fixed, some not, one new) sorts correctly into all 3 buckets', () => {
  const before = { issues: [issue('no-measurement-layer'), issue('no-cmp-with-active-tags')], totalFound: 2 };
  const after = { issues: [issue('no-cmp-with-active-tags'), issue('gtm-declared-not-observed')], totalFound: 2 };
  const diff = diffTopIssues(before, after);
  assert.deepEqual(diff.resolved.map((i) => i.id), ['no-measurement-layer']);
  assert.deepEqual(diff.stillOpen.map((i) => i.id), ['no-cmp-with-active-tags']);
  assert.deepEqual(diff.newlyFound.map((i) => i.id), ['gtm-declared-not-observed']);
});

test('attachRevenueImpact: a real GA4-vs-Shopify gap attaches a measured dollar amount to a revenue-relevant tracking finding', () => {
  const before = { issues: [issue('duplicate-gtm-containers')], totalFound: 1 };
  const after = attachRevenueImpact(before, 12000, 10000, 'US');
  assert.equal(after.issues[0].amount, 2000);
  assert.match(after.issues[0].detail, /differs from your confirmed Shopify revenue/);
  assert.match(after.issues[0].detail, /\$2,000/);
  assert.match(after.issues[0].detail, /isn't proof this finding alone caused it/); // hedge must travel with the number every time
});

test('attachRevenueImpact: never touches a finding with no plausible connection to revenue accuracy (e.g. no-cmp-with-active-tags)', () => {
  const before = { issues: [issue('no-cmp-with-active-tags')], totalFound: 1 };
  const after = attachRevenueImpact(before, 12000, 10000, 'US');
  assert.equal(after.issues[0].amount, undefined);
  assert.equal(after.issues[0].detail, 'd'); // untouched
});

test('attachRevenueImpact: does nothing when either revenue figure is missing/zero — never estimates from partial data', () => {
  const before = { issues: [issue('ga4-id-mismatch')], totalFound: 1 };
  assert.deepEqual(attachRevenueImpact(before, 0, 10000, 'US'), before);
  assert.deepEqual(attachRevenueImpact(before, 12000, 0, 'US'), before);
});

test('attachRevenueImpact: a real reconciliation (no gap) attaches nothing — only a genuine discrepancy is worth surfacing', () => {
  const before = { issues: [issue('ga4-id-mismatch')], totalFound: 1 };
  assert.deepEqual(attachRevenueImpact(before, 10000, 10000, 'US'), before);
});

test('attachRevenueImpact: only enriches the relevant findings in a mixed list, leaves the rest exactly as they were', () => {
  const before = {
    issues: [issue('ga4-id-mismatch'), issue('no-cmp-with-active-tags'), issue('legacy-ua-present')],
    totalFound: 3,
  };
  const after = attachRevenueImpact(before, 15000, 10000, 'US');
  assert.equal(after.issues[0].amount, 5000);
  assert.equal(after.issues[1].amount, undefined);
  assert.equal(after.issues[2].amount, undefined);
});
