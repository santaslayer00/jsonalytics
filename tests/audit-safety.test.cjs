const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.cjs'), 'utf8');
const logic = fs.readFileSync(path.join(root, 'src', 'utils', 'auditLogic.ts'), 'utf8');
const appTsx = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');

test('deep scan is read-only and does not click or navigate checkout', () => {
  const route = server.slice(server.indexOf("app.get('/api/scan/deep'"), server.indexOf('// ---- PDF export'));
  assert.match(route, /Intentionally read-only/);
  assert.doesNotMatch(route, /\.click\s*\(/);
  assert.doesNotMatch(route, /addToCartFired/);
});

test('surface/deep evidence labels checkout claims as unconfirmed', () => {
  assert.match(logic, /Purchase event firing must be confirmed/i);
  assert.match(server, /intentional test-checkout or imported evidence/i);
});

test('Shopify orders route uses pagination and optional selected dates', () => {
  const route = server.slice(server.indexOf("app.get('/api/shopify/orders'"), server.indexOf('// ---- GA4 OAuth'));
  assert.match(route, /created_at_min/);
  assert.match(route, /while \(nextUrl\)/);
  assert.match(route, /rel="next"/);
});

test('financial safeguards do not equate refund status with RTO or infer new customers', () => {
  const fn = logic.slice(logic.indexOf('export function shopifyOrdersToAuditInputs'), logic.indexOf('export async function fetchLiveShopifyInputs'));
  assert.doesNotMatch(fn, /financial === 'refunded'/);
  assert.match(fn, /const newCustomersCount = 0/);
});

test('RTO is never silently reported as measured zero — the app requires a confirmed count, same as new customers', () => {
  // csvInputs.rtoOrders is structurally always 0 from both the CSV parser
  // and the live Shopify orders pull (neither source can determine RTO from
  // order data alone). Without this guard, "RTO Rate: 0.00%" would render
  // as if it were measured when it was actually never computed.
  assert.match(appTsx, /csvInputs\.rtoOrders === 0/);
  assert.match(appTsx, /RTO \(return-to-origin\) order count was not available/i);
});

test('both scan endpoints run the SSRF guard before fetching/navigating to the operator-supplied URL', () => {
  const scanRoute = server.slice(server.indexOf("app.get('/api/scan'"), server.indexOf("app.get('/api/scan/deep'"));
  const deepRoute = server.slice(server.indexOf("app.get('/api/scan/deep'"), server.indexOf('// ---- PDF export'));
  assert.match(scanRoute, /assertScannableUrl\(target\)/);
  assert.match(deepRoute, /assertScannableUrl\(target\)/);
  assert.match(server, /require\('\.\/lib\/ssrfGuard\.cjs'\)/);
});
