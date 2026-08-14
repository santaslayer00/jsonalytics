import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameStoreUrl, normalizeUrlForCompare } from '../src/utils/formatters.ts';

test('same host with/without scheme, trailing slash, and case is treated as the same store', () => {
  assert.equal(normalizeUrlForCompare('https://Example.com/'), normalizeUrlForCompare('example.com'));
  assert.equal(normalizeUrlForCompare('http://example.com'), normalizeUrlForCompare('EXAMPLE.COM/'));
});

test('different hosts are never treated as the same store', () => {
  assert.equal(isSameStoreUrl('https://store-a.com', 'https://store-b.com'), false);
});

test('isSameStoreUrl is the guard that prevents stale cross-store deep-scan evidence from being reused', () => {
  // Regression case: deep-scanning store A in one tab must not silently get
  // attributed to store B's audit in another tab (or the same tab after the
  // URL field is edited).
  assert.equal(isSameStoreUrl('https://prospect-a.myshopify.com', 'https://prospect-a.myshopify.com'), true);
  assert.equal(isSameStoreUrl('https://prospect-a.myshopify.com', 'https://prospect-b.myshopify.com'), false);
});
