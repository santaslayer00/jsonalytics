import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullAudit } from '../src/utils/auditLogic.ts';

// runFullAudit calls fetch('/api/scan?...') internally — mock it so this
// test exercises the real function without needing a live backend.
function withMockedScanFetch(html: string, fn: () => Promise<void>) {
  const original = global.fetch;
  global.fetch = (async (url: string) => {
    if (String(url).includes('/api/scan')) {
      return { ok: true, json: async () => ({ url: 'https://example.com', html }) } as any;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as any;
  return fn().finally(() => { global.fetch = original; });
}

test('a small store (under 500 orders) with a real leak still gets a "start here" pointer', async () => {
  await withMockedScanFetch('<html><body>no tracking here</body></html>', async () => {
    const result = await runFullAudit(
      'https://example.com',
      {
        grossRevenue: 100_000,
        totalOrders: 50, // well under the old 500-order gate
        newCustomers: 10,
        rtoOrders: 20, // a large RTO share -> the biggest leak
        codOrders: 20,
        cogs: 20_000,
        shipping: 5_000,
        adSpend: 0,
        settlementDays: 0,
        avgOrderValue: 2_000,
      },
      'GTM-TEST123',
      null,
      'US'
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.report.volumeNote, 'expected a start-here note even though order volume is well under 500');
    assert.match(result.report.volumeNote!, /RTO returns/);
    assert.doesNotMatch(result.report.volumeNote!, /High order volume/, 'a 50-order store should not get the high-volume phrasing');
  });
});

test('no confirmed leaks -> an honest "nothing flagged" note, not silence', async () => {
  await withMockedScanFetch('<html><body>no tracking here</body></html>', async () => {
    const result = await runFullAudit(
      'https://example.com',
      { grossRevenue: 10_000, totalOrders: 10, newCustomers: 5, rtoOrders: 0, codOrders: 0, cogs: 2_000, shipping: 500, adSpend: 0, settlementDays: 0, avgOrderValue: 1_000 },
      'GTM-TEST123',
      null,
      'US'
    );
    assert.match(result.report.volumeNote!, /No major \$ leaks flagged/);
  });
});
