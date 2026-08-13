import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml } from '../src/utils/auditLogic.ts';
import type { AuditDashboardResult } from '../src/utils/auditLogic.ts';

function baseResult(overrides: Partial<AuditDashboardResult['report']> = {}): AuditDashboardResult {
  return {
    url: 'https://example.com',
    score: 50,
    status: 'ok',
    metrics: { gtmDetected: false, gtmId: 'Not found', ga4Active: false, ga4Id: 'Not found', metaPixel: false, tiktokPixel: false, cmpDetected: false, cmpName: 'None', pageSpeed: 'Not measured', sslValid: true, grossRevenue: 0, netOutcome: 0, roas: 0, cac: 0 },
    recommendations: [],
    report: {
      headline: 'Test audit',
      storeMode: 'test',
      status: 'ok',
      summary: 'Test summary',
      signalSources: { dataLayer: 'unknown', stape: 'unknown', purchaseSignals: 'not-validated', consentMode: 'unknown' },
      evidenceDepth: 'static-only',
      signalFindings: [],
      issueList: [],
      businessMetrics: [],
      topIssues: { issues: [], totalFound: 0 },
      ...overrides,
    },
  };
}

test('the exported PDF HTML includes a Top Issues section, not just the old Findings/Business Metrics sections', () => {
  const html = buildReportHtml(baseResult({
    topIssues: { issues: [{ id: 'x', category: 'tracking', severity: 'high', title: 'No dataLayer', detail: 'proof text', firstCheck: 'check this' }], totalFound: 1 },
  }));
  assert.match(html, /Top Issues/);
  assert.match(html, /No dataLayer/);
  assert.match(html, /check this/);
});

test('a manually-confirmed failed check (merged into topIssues before export) shows up in the exported HTML', () => {
  const html = buildReportHtml(baseResult({
    topIssues: {
      issues: [{ id: 'manual-purchase-firing', category: 'manual', severity: 'critical', title: 'Validate purchase firing — failed manual verification', detail: 'Operator-confirmed via GTM Preview: no tag fired', firstCheck: 'Fix, then re-verify' }],
      totalFound: 1,
    },
  }));
  assert.match(html, /failed manual verification/);
  assert.match(html, /no tag fired/);
});

test('an honest "no issues" message renders when the list is empty, not a blank section', () => {
  const html = buildReportHtml(baseResult());
  assert.match(html, /No confirmed issues/);
});

test('when more issues exist than are shown, the PDF discloses the true total rather than implying completeness', () => {
  const html = buildReportHtml(baseResult({
    topIssues: {
      issues: Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, category: 'tracking' as const, severity: 'low' as const, title: `Issue ${i}`, detail: 'd', firstCheck: 'c' })),
      totalFound: 14,
    },
  }));
  assert.match(html, /top 10 of 14 found/);
});
