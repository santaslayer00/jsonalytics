import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml, buildValidationReportHtml } from '../src/utils/auditLogic.ts';
import type { AuditDashboardResult } from '../src/utils/auditLogic.ts';
import type { TopIssue } from '../src/utils/topIssues.ts';

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
      scopeNotes: [],
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
  assert.match(html, /proof text/);
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

test('issue amounts in the PDF use the selected region currency, not a hard-coded $', () => {
  const issues = [{ id: 'x', category: 'financial' as const, severity: 'high' as const, title: 'RTO leak', detail: 'd', firstCheck: 'c', amount: 1000 }];
  const usd = buildReportHtml(baseResult({ topIssues: { issues, totalFound: 1 } }), 'US');
  const inr = buildReportHtml(baseResult({ topIssues: { issues, totalFound: 1 } }), 'IN');
  const gbp = buildReportHtml(baseResult({ topIssues: { issues, totalFound: 1 } }), 'UK');
  assert.match(usd, /\$/);
  assert.match(gbp, /£/);
  assert.doesNotMatch(gbp, /\$1,000|\$1000/); // the old bug: a literal "$" prefix regardless of region
  assert.notEqual(usd, inr);
});

test('a client-reported issue shows as disclosed context in the PDF, not a verified finding', () => {
  const withNote = buildReportHtml(baseResult({ clientReportedIssue: 'GA4 revenue looks off vs Shopify' }));
  assert.match(withNote, /Client reported/);
  assert.match(withNote, /GA4 revenue looks off vs Shopify/);
  assert.match(withNote, /not independently verified/i);

  const withoutNote = buildReportHtml(baseResult());
  assert.doesNotMatch(withoutNote, /Client reported/);
});

test('the financial calculator table renders each business metric with its explainer, and the email footer is embedded', () => {
  const html = buildReportHtml(baseResult({
    businessMetrics: [{ label: 'Gross Margin', value: '$75,000', explainer: "What's left after product cost and shipping." }],
  }));
  assert.match(html, /Financial Calculator/);
  assert.match(html, /Gross Margin/);
  assert.match(html, /\$75,000/);
  assert.match(html, /What&#39;s left after product cost and shipping\./);
  assert.match(html, /jagjit@jsonalytics\.com/);
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

test('the Report PDF never includes firstCheck — the fix hint stays out of the pre-sale document', () => {
  const html = buildReportHtml(baseResult({
    topIssues: { issues: [{ id: 'x', category: 'tracking', severity: 'high', title: 'No dataLayer', detail: 'proof text', firstCheck: 'a very specific fix instruction' }], totalFound: 1 },
  }));
  assert.match(html, /proof text/);
  assert.doesNotMatch(html, /a very specific fix instruction/);
});

function topIssue(id: string, overrides: Partial<TopIssue> = {}): TopIssue {
  return { id, category: 'tracking', severity: 'high', title: id, detail: 'd', firstCheck: 'c', ...overrides };
}

test('the Report PDF splits issues into Confirmed (measured) vs Worth Confirming (has possibleReasons) — not one flat list', () => {
  const html = buildReportHtml(baseResult({
    topIssues: {
      issues: [
        topIssue('duplicate-gtm-containers', { title: 'Duplicate GTM containers' }),
        topIssue('no-cmp-with-active-tags', {
          title: 'No consent tool found',
          possibleReasons: [{ cause: 'Genuinely no CMP configured.', howToCheck: 'Check Shopify privacy settings.' }],
        }),
      ],
      totalFound: 2,
    },
  }));
  assert.match(html, /CONFIRMED/);
  assert.match(html, /WORTH CONFIRMING/);
  // Confirmed section comes before its issue, worth-confirming section before its own — verify ordering, not just presence
  const confirmedIdx = html.indexOf('CONFIRMED');
  const duplicateIdx = html.indexOf('Duplicate GTM containers');
  const worthConfirmingIdx = html.indexOf('WORTH CONFIRMING');
  const noCmpIdx = html.indexOf('No consent tool found');
  assert.ok(confirmedIdx < duplicateIdx && duplicateIdx < worthConfirmingIdx, 'Confirmed issue should render under the CONFIRMED heading, before WORTH CONFIRMING');
  assert.ok(worthConfirmingIdx < noCmpIdx, 'Low-confidence issue should render under the WORTH CONFIRMING heading');
});

test('the Validation PDF includes the warning banner, resolved items with technical notes, and still-open items with firstCheck (paying-client depth)', () => {
  const result = baseResult();
  const diff = { resolved: [topIssue('no-measurement-layer', { title: 'No tracking found' })], stillOpen: [topIssue('no-cmp-with-active-tags', { title: 'No consent tool', detail: 'tags active', firstCheck: 'check Shopify privacy settings' })], newlyFound: [] };
  const html = buildValidationReportHtml(result, diff, { 'no-measurement-layer': 'Installed GTM via Custom Pixels, published container, confirmed firing in Preview.' });
  assert.match(html, /don't modify the tracking setup/i);
  assert.match(html, /No tracking found/);
  assert.match(html, /Installed GTM via Custom Pixels/);
  assert.match(html, /No consent tool/);
  assert.match(html, /check Shopify privacy settings/); // Validation, unlike Report, DOES include firstCheck
  assert.match(html, /jagjit@jsonalytics\.com/);
});

test('the Validation PDF never fabricates a technical-steps note for a resolved issue the operator left blank', () => {
  const result = baseResult();
  const diff = { resolved: [topIssue('gtm-declared-not-observed', { title: 'GTM not observed' })], stillOpen: [], newlyFound: [] };
  const html = buildValidationReportHtml(result, diff, {});
  assert.match(html, /GTM not observed/);
  assert.doesNotMatch(html, /Technical steps taken/); // no note supplied -> no fabricated line
});
