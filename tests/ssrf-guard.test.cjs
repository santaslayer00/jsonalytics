const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateOrReservedIp, assertScannableUrl, safeFetch } = require('../lib/ssrfGuard.cjs');

test('isPrivateOrReservedIp blocks loopback, RFC1918, link-local, and cloud metadata', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true); // cloud metadata endpoint
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
});

test('isPrivateOrReservedIp allows ordinary public addresses', () => {
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
});

test('assertScannableUrl rejects non-http(s) protocols', async () => {
  await assert.rejects(() => assertScannableUrl('file:///etc/passwd'), /http/i);
  await assert.rejects(() => assertScannableUrl('ftp://example.com'), /http/i);
});

test('assertScannableUrl rejects localhost/.local/.internal hostnames outright', async () => {
  await assert.rejects(() => assertScannableUrl('http://localhost:4000'), /local\/internal/i);
  await assert.rejects(() => assertScannableUrl('http://printer.local'), /local\/internal/i);
});

test('assertScannableUrl rejects a hostname that resolves to a private IP', async () => {
  const fakeLookup = async () => [{ address: '10.0.0.1', family: 4 }];
  await assert.rejects(
    () => assertScannableUrl('https://internal-service.example.com', { lookup: fakeLookup }),
    /private or internal/i
  );
});

test('assertScannableUrl accepts a hostname that resolves only to public IPs', async () => {
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const result = await assertScannableUrl('https://example.com', { lookup: fakeLookup });
  assert.equal(result.hostname, 'example.com');
});

test('assertScannableUrl rejects if ANY resolved address is private (DNS rebinding / dual-answer defense)', async () => {
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => assertScannableUrl('https://mixed.example.com', { lookup: fakeLookup })
  );
});

test('safeFetch follows a redirect chain that stays public', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    if (url === 'http://93.184.216.34/start') {
      return { status: 302, headers: { get: (h) => (h === 'location' ? 'http://93.184.216.35/final' : null) }, ok: false };
    }
    return { status: 200, ok: true, headers: { get: () => null }, url };
  };
  try {
    const res = await safeFetch('http://93.184.216.34/start');
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('safeFetch refuses to follow a redirect into a private address', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'http://93.184.216.34/start') {
      return { status: 302, headers: { get: (h) => (h === 'location' ? 'http://127.0.0.1/admin' : null) }, ok: false };
    }
    throw new Error('should never reach the redirect target');
  };
  try {
    await assert.rejects(() => safeFetch('http://93.184.216.34/start'), /private or internal/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('safeFetch gives up after too many redirects instead of looping forever', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const n = Number(url.split('/').pop());
    return { status: 302, headers: { get: (h) => (h === 'location' ? `http://93.184.216.34/${n + 1}` : null) }, ok: false };
  };
  try {
    await assert.rejects(() => safeFetch('http://93.184.216.34/0', {}, { maxRedirects: 3 }), /too many redirects/i);
  } finally {
    global.fetch = originalFetch;
  }
});
