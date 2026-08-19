import test from 'node:test';
import assert from 'node:assert/strict';
import { runSurfaceAudit } from '../src/utils/auditLogic.ts';

// "Only find the sources from webpages, actual public info, so that we
// aren't crossing laws" (explicit user request, 2026-08-16) — these signals
// come from plain regex over the store's own already-fetched public HTML,
// never a request to a social platform, directory, or third-party lookup.
function withMockedHtml(html: string, fn: () => Promise<void>) {
  const original = global.fetch;
  global.fetch = (async (url: string) => {
    if (String(url).includes('/api/scan')) {
      return { ok: true, json: async () => ({ url: 'https://example.com', html }) } as any;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as any;
  return fn().finally(() => { global.fetch = original; });
}

test('finds real social profile links in the footer, deduped, without picking up share-intent widgets', async () => {
  await withMockedHtml(`
    <footer>
      <a href="https://www.instagram.com/examplestore/">Instagram</a>
      <a href="https://instagram.com/examplestore/">Instagram again</a>
      <a href="https://www.linkedin.com/company/example-store">LinkedIn</a>
      <a href="https://twitter.com/examplestore">Twitter</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://example.com">Share on Facebook</a>
    </footer>
  `, async () => {
    const result = await runSurfaceAudit('https://example.com', 'US');
    assert.equal(result.status, 'ok');
    const platforms = result.contactSignals.socialLinks.map((s) => s.platform).sort();
    assert.deepEqual(platforms, ['Instagram', 'LinkedIn', 'Twitter/X']); // Facebook share widget excluded
    assert.equal(result.contactSignals.socialLinks.filter((s) => s.platform === 'Instagram').length, 1); // deduped
  });
});

test('finds a published mailto: contact email — never a guessed or scraped one', async () => {
  await withMockedHtml('<a href="mailto:hello@examplestore.com">Email us</a>', async () => {
    const result = await runSurfaceAudit('https://example.com', 'US');
    assert.equal(result.contactSignals.contactEmail, 'hello@examplestore.com');
  });
});

test('finds a link to the store\'s own About/Team/Contact page', async () => {
  await withMockedHtml('<a href="/pages/about-us">About Us</a>', async () => {
    const result = await runSurfaceAudit('https://example.com', 'US');
    assert.equal(result.contactSignals.aboutOrContactPageUrl, '/pages/about-us');
  });
});

test('a store with none of these published leaves every contact signal honestly empty, never fabricated', async () => {
  await withMockedHtml('<html><body>no links here</body></html>', async () => {
    const result = await runSurfaceAudit('https://example.com', 'US');
    assert.deepEqual(result.contactSignals.socialLinks, []);
    assert.equal(result.contactSignals.contactEmail, null);
    assert.equal(result.contactSignals.aboutOrContactPageUrl, null);
  });
});
