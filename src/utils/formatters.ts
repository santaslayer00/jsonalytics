import { REGIONS } from './constants.ts';
import type { Region } from './constants.ts';

/**
 * Formats a number as currency based on the selected region.
 * Handles regional specifics like India's Lakh/Crore system.
 */
export const formatCurrency = (amount: number, regionCode: Region): string => {
  const config = REGIONS[regionCode];
  return new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency: config.currency,
    maximumFractionDigits: 0, // Usually audit numbers don't need decimals for high volume
  }).format(amount);
};

/**
 * Formats a number with regional digit grouping.
 */
export const formatNumber = (num: number, regionCode: Region): string => {
  const config = REGIONS[regionCode];
  return new Intl.NumberFormat(config.locale).format(num);
};

/**
 * Formats a percentage.
 */
export const formatPercent = (num: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(num / 100);
};

/**
 * Formats an ISO timestamp as a short relative time ("just now", "3h ago",
 * "5d ago"). `now` is injectable for testing — defaults to the real clock.
 */
export const formatRelativeTime = (isoTimestamp: string, now: number = Date.now()): string => {
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffSeconds = Math.max(0, Math.round((now - then) / 1000));
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths}mo ago`;
};

/**
 * Normalizes a URL for same-store comparison (not navigation) — trims,
 * adds a scheme if missing, lowercases the host, strips a trailing slash.
 * Used to guard against stale evidence: a deep scan is only valid for the
 * exact URL it was run against, and the operator can switch tabs or edit
 * the URL field after scanning, in either order.
 */
export const normalizeUrlForCompare = (url: string): string => {
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const u = new URL(target);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return target.toLowerCase();
  }
};

/** True only if `deepScanUrl` (the URL a deep scan was actually run against) matches `targetUrl` (the URL currently in play). */
export const isSameStoreUrl = (deepScanUrl: string, targetUrl: string): boolean =>
  normalizeUrlForCompare(deepScanUrl) === normalizeUrlForCompare(targetUrl);

/**
 * Detects the most likely region from a URL's TLD. Returns null when there's
 * no real signal (invalid URL, or a domain like *.myshopify.com with no
 * country-code TLD) — callers should leave the current region alone in that
 * case, not silently force a default. A previous version defaulted to 'US'
 * here, which meant auto-wiring this to the region selector would have
 * clobbered a manual non-US pick every time someone typed in the URL field.
 */
export const detectRegionFromUrl = (url: string): Region | null => {
  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();

    for (const region of Object.values(REGIONS)) {
      if (region.tlds.some(tld => hostname.endsWith(tld))) {
        return region.code;
      }
    }
  } catch {
    // Invalid URL, ignore detection
  }
  return null;
};
