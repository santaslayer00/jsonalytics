// SSRF guard shared by server.cjs's scan endpoints. Kept as a standalone
// module (no Express/Puppeteer imports) so it can be unit-tested directly
// without booting the server.
const dns = require('dns').promises;
const net = require('net');

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0 || a >= 224) return true; // loopback, 10/8, 0/8, multicast+reserved
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return true; // not a recognizable IP — treat as unsafe rather than guessing
}

async function assertScannableUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http:// or https:// URLs can be scanned.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Local/internal hostnames cannot be scanned.');
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve the store hostname.');
  }
  if (!addresses.length || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new Error('That URL resolves to a private or internal address and cannot be scanned.');
  }
  return parsed;
}

// assertScannableUrl only validates the URL it's given. fetch()/browser
// navigation follow redirects by default, so a URL that passes the check
// could still redirect to a private/internal address — the check would
// never see the real final destination. safeFetch closes that gap by
// re-validating every hop before following it.
async function safeFetch(url, options = {}, { maxRedirects = 5 } = {}) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertScannableUrl(currentUrl);
    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (isRedirect && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects.');
}

module.exports = { isPrivateOrReservedIp, assertScannableUrl, safeFetch };
