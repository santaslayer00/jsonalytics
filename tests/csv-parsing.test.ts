import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSVRows, parseShopifyOrdersCsv } from '../src/utils/csvParsing.ts';

function csv(rows: string[][]): string {
  return rows.map((r) => r.join(',')).join('\n');
}

test('parseCSVRows handles quoted cells with embedded commas and escaped quotes', () => {
  const rows = parseCSVRows('a,"b, with comma","c ""quoted"""\nx,y,z');
  assert.deepEqual(rows, [['a', 'b, with comma', 'c "quoted"'], ['x', 'y', 'z']]);
});

test('rejects a CSV missing the required Name column', () => {
  assert.throws(() => parseShopifyOrdersCsv(csv([['Total', 'Gateway'], ['10', 'cash']])), /Missing "Name" column/i);
});

test('rejects an empty or header-only CSV rather than silently returning zeros', () => {
  assert.throws(() => parseShopifyOrdersCsv(''), /Empty CSV/i);
  assert.throws(() => parseShopifyOrdersCsv(csv([['Name', 'Total']])), /not contain enough data/i);
});

test('dedupes multi-line-item orders by Name, sums revenue once per order', () => {
  const text = csv([
    ['Name', 'Total', 'Gateway'],
    ['#1001', '50', 'shopify_payments'],
    ['#1001', '50', 'shopify_payments'], // second line item of the same order
    ['#1002', '30', 'cash on delivery'],
  ]);
  const result = parseShopifyOrdersCsv(text);
  assert.equal(result.totalOrders, 2);
  assert.equal(result.grossRevenue, 80); // 50 (once) + 30, not 130
  assert.equal(result.codOrders, 1);
});

test('RTO stays honestly 0 even when "restocked" orders exist — only the suggestion field reflects it', () => {
  const text = csv([
    ['Name', 'Total', 'Gateway', 'Fulfillment Status'],
    ['#1001', '50', 'shopify_payments', 'fulfilled'],
    ['#1002', '30', 'cash on delivery', 'restocked'],
    ['#1003', '20', 'cash on delivery', 'restocked'],
  ]);
  const result = parseShopifyOrdersCsv(text);
  assert.equal(result.rtoOrders, 0, 'rtoOrders must never be inferred from CSV data');
  assert.equal(result.suggestedRtoOrders, 2, 'suggestedRtoOrders should count "restocked" rows as a hint');
});

test('newCustomers is always 0 from a CSV slice — cannot determine lifetime-first-purchase from one export', () => {
  const text = csv([['Name', 'Total', 'Email'], ['#1001', '50', 'a@example.com']]);
  assert.equal(parseShopifyOrdersCsv(text).newCustomers, 0);
});

test('detects the predominant billing-country region, mapping CA correctly (not the dropped AE market)', () => {
  const text = csv([
    ['Name', 'Total', 'Billing Country'],
    ['#1', '10', 'CA'],
    ['#2', '10', 'CA'],
    ['#3', '10', 'US'],
  ]);
  assert.equal(parseShopifyOrdersCsv(text).detectedRegion, 'CA');
});

test('rows shorter than the header (malformed export) are skipped, not crashed on', () => {
  const text = 'Name,Total,Gateway\n#1001,50,shopify_payments\n#1002,30\n#1003,20,cash';
  const result = parseShopifyOrdersCsv(text);
  assert.equal(result.totalOrders, 2); // #1002's short row is skipped
});
