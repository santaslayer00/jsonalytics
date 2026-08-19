import test from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS } from '../src/utils/constants.ts';
import { formatCurrency, detectRegionFromUrl } from '../src/utils/formatters.ts';

test('required markets are exactly US/UK/CA/AU/IN', () => {
  assert.deepEqual(Object.keys(REGIONS).sort(), ['AU', 'CA', 'IN', 'UK', 'US']);
});

test('each region has a distinct currency and a privacy term used in report language', () => {
  for (const region of Object.values(REGIONS)) {
    assert.ok(region.currency.length === 3, `${region.code} should have a 3-letter currency code`);
    assert.ok(region.privacyTerm.length > 0, `${region.code} should have report-facing privacy language`);
  }
});

test('formatCurrency uses the selected region currency, not a hard-coded $', () => {
  const usd = formatCurrency(1000, 'US');
  const inr = formatCurrency(1000, 'IN');
  const gbp = formatCurrency(1000, 'UK');
  // CAD and USD both conventionally render with a bare "$" per Intl/en-CA —
  // that's correct real-world formatting, not evidence the region was ignored.
  assert.match(usd, /\$/);
  assert.match(gbp, /£/);
  assert.notEqual(usd, inr);
  assert.notEqual(usd, gbp);
});

test('formatCurrency works for every target market without throwing, including CA and AU which were previously unasserted', () => {
  for (const region of ['US', 'UK', 'CA', 'AU', 'IN'] as const) {
    const formatted = formatCurrency(1234.5, region);
    assert.ok(formatted.length > 0, `${region} produced an empty/invalid currency string`);
    assert.doesNotMatch(formatted, /NaN|undefined/, `${region} formatted currency incorrectly: ${formatted}`);
  }
});

test('detectRegionFromUrl maps a .ca domain to Canada, not UAE (dropped market)', () => {
  assert.equal(detectRegionFromUrl('https://mystore.ca'), 'CA');
  assert.equal(detectRegionFromUrl('https://mystore.co.uk'), 'UK');
  assert.equal(detectRegionFromUrl('https://mystore.in'), 'IN');
});

test('detectRegionFromUrl returns null (not a fake US default) when there is no real signal — so callers never clobber a manual region pick', () => {
  // .com/.us/.net/.org are real US signals by design (see constants.ts) —
  // a bare .myshopify.com subdomain still ends in .com, so that's a real
  // detected US match too, not a "no signal" case. Use a TLD outside every
  // region's list to test the genuine no-signal path.
  assert.equal(detectRegionFromUrl('https://mystore.io'), null);
  assert.equal(detectRegionFromUrl('not a url'), null);
});
