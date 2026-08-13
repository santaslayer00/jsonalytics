import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopIssues, mergeManualFindings } from '../src/utils/topIssues.ts';
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
