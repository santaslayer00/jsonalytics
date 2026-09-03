const test = require('node:test');
const assert = require('node:assert/strict');
const { redactPII, REDACTED } = require('../lib/piiRedaction.cjs');

test('redacts known PII container objects entirely, regardless of their internal fields', () => {
  const input = { user_data: { address: { city: 'Auckland', custom_field: 'x' } } };
  const out = redactPII(input);
  assert.equal(out.user_data, REDACTED);
});

test('leaves an empty PII container object alone rather than redacting nothing into something', () => {
  const input = { user_data: { address: {} } };
  const out = redactPII(input);
  assert.equal(out.user_data, REDACTED);
});

test('redacts individual PII fields (email, phone, name) wherever they appear, not just inside a container', () => {
  const input = { customer_email: 'noop', email: 'real@store.com', phone: '+1 555 123 4567', first_name: 'Jane' };
  const out = redactPII(input);
  assert.equal(out.email, REDACTED);
  assert.equal(out.phone, REDACTED);
  assert.equal(out.first_name, REDACTED);
});

test('redacts an email-shaped string value even under an unrecognized key name', () => {
  const input = { some_custom_field: 'shopper@example.com' };
  const out = redactPII(input);
  assert.equal(out.some_custom_field, REDACTED);
});

test('does not touch legitimate non-PII fields like product/event names or ecommerce values', () => {
  const input = { event: 'purchase', item_name: 'Sheepskin Cushion', value: 129.99, currency: 'NZD' };
  const out = redactPII(input);
  assert.deepEqual(out, input);
});

test('recurses through arrays of dataLayer entries, the real shape captured from window.dataLayer', () => {
  const input = [
    { event: 'gtm.dom' },
    { event: 'purchase', user_data: { email: 'real@store.com' }, ecommerce: { value: 50 } },
  ];
  const out = redactPII(input);
  assert.equal(out[0].event, 'gtm.dom');
  assert.equal(out[1].user_data, REDACTED);
  assert.deepEqual(out[1].ecommerce, { value: 50 });
});

test('handles null/undefined/non-object values without throwing', () => {
  assert.equal(redactPII(null), null);
  assert.equal(redactPII(undefined), undefined);
  assert.equal(redactPII('plain string'), 'plain string');
  assert.equal(redactPII(42), 42);
});
