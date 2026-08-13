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
 * Detects the most likely region from a URL.
 */
export const detectRegionFromUrl = (url: string): Region => {
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
  return 'US'; // Default to US
};
