import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogNote } from '../src/utils/auditLogic.ts';

test('an empty catalog gets no note — nothing honest to say about product volume', () => {
  assert.equal(buildCatalogNote({ total: 0, active: 0, draft: 0, archived: 0 }), null);
});

test('a real catalog gets a "check the template once" pointer, not a per-product claim', () => {
  const note = buildCatalogNote({ total: 4200, active: 3900, draft: 250, archived: 50 });
  assert.match(note!, /4200 products/);
  assert.match(note!, /3900 active/);
  assert.match(note!, /product-by-product/i);
  assert.doesNotMatch(note!, /\bconfirmed\b/i); // never claims tracking was actually checked
});

test('a catalog with zero active products is stated honestly, not silently dropped', () => {
  const note = buildCatalogNote({ total: 12, active: 0, draft: 12, archived: 0 });
  assert.match(note!, /none currently active/);
});

test('a single-product catalog uses correct grammar — "1 product," not "1 products"', () => {
  const note = buildCatalogNote({ total: 1, active: 1, draft: 0, archived: 0 });
  assert.match(note!, /^1 product /);
  assert.doesNotMatch(note!, /1 products/);
});
