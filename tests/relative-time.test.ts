import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from '../src/utils/formatters.ts';

const NOW = new Date('2026-08-13T12:00:00.000Z').getTime();

test('just scanned reads as "just now", not "0m ago"', () => {
  assert.equal(formatRelativeTime('2026-08-13T11:59:45.000Z', NOW), 'just now');
});

test('minutes, hours, and days scale correctly', () => {
  assert.equal(formatRelativeTime('2026-08-13T11:55:00.000Z', NOW), '5m ago');
  assert.equal(formatRelativeTime('2026-08-13T09:00:00.000Z', NOW), '3h ago');
  assert.equal(formatRelativeTime('2026-08-10T12:00:00.000Z', NOW), '3d ago');
});

test('an invalid timestamp does not throw or silently show a nonsense number', () => {
  assert.equal(formatRelativeTime('not-a-date', NOW), 'unknown');
});
