/**
 * Appends a real scan observation to benchmarks/real-world-scan-benchmarks.json
 * — never overwrites or removes existing entries, only adds new dated
 * observations. This is how new stores (or repeat scans of an existing one,
 * to catch drift over time) get folded into the reference dataset going
 * forward, instead of it staying a frozen one-time snapshot of 23 stores.
 *
 * Requires the local dev server (npm run server) to already be running,
 * since it goes through the same /api/scan + /api/scan/deep routes the app
 * itself uses — this records what the REAL app functions produce, not a
 * reimplementation of the scan logic.
 *
 * Usage: npm run benchmark -- <url> [region]
 *   e.g. npm run benchmark -- https://example.com US
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , rawUrl, rawRegion] = process.argv;
if (!rawUrl) {
  console.error('Usage: npm run benchmark -- <url> [region: US|UK|CA|AU|IN]');
  process.exit(1);
}
const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
const region = (rawRegion || 'US') as 'US' | 'UK' | 'CA' | 'AU' | 'IN';

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  if (typeof input === 'string' && input.startsWith('/api')) return realFetch(`http://127.0.0.1:4000${input}`, init);
  return realFetch(input, init);
}) as typeof fetch;

const auditMod = await import(new URL('../src/utils/auditLogic.ts', import.meta.url).href);
const diagMod = await import(new URL('../src/utils/diagnosticEngine.ts', import.meta.url).href);

const BENCHMARK_URL = new URL('../benchmarks/real-world-scan-benchmarks.json', import.meta.url);

console.log(`Scanning ${url} (${region})...`);

const surface = await auditMod.runSurfaceAudit(url, region);
if (surface.status !== 'ok') {
  console.error('Static scan failed:', surface.error);
  process.exit(1);
}

let deep: any = null;
try {
  deep = await auditMod.fetchDeepScan(url);
} catch (err: any) {
  console.warn('Deep scan failed, recording static-only observation:', err.message);
}

const effective = auditMod.resolveEffectiveSignals(surface, null); // static-only, matches what Stage 1 actually computes
const scannedAt = new Date().toISOString().slice(0, 10);

const stage1Record = {
  url,
  region,
  scannedAt,
  staticTags: [surface.gtmId && 'GTM', surface.ga4Id && 'GA4', surface.hasMetaPixel && 'Meta', surface.hasTiktokPixel && 'TikTok'].filter(Boolean),
  missingSignalCount: effective.missingSignalCount,
};

let stage2Record: any = null;
if (deep) {
  const report = diagMod.runDiagnostics(surface, deep, null, region);
  stage2Record = {
    url,
    region,
    scannedAt,
    deepFires: [
      deep.trackingSignals.gtmRequests > 0 && 'GTM',
      deep.trackingSignals.ga4Requests > 0 && 'GA4',
      deep.trackingSignals.metaBrowserRequests > 0 && 'Meta',
      deep.trackingSignals.tiktokBrowserRequests > 0 && 'TikTok',
    ].filter(Boolean),
    earliestFailure: report.earliestFailure ? report.earliestFailure.id : 'none',
    severity: report.earliestFailure ? report.earliestFailure.severity : null,
    allFindings: report.findings.map((f: any) => f.id),
  };
}

const benchmarks = JSON.parse(readFileSync(BENCHMARK_URL, 'utf8'));
benchmarks.stage1_url_scan.records.push(stage1Record);
if (stage2Record) benchmarks.stage2_full_audit.records.push(stage2Record);
writeFileSync(BENCHMARK_URL, JSON.stringify(benchmarks, null, 2) + '\n');

console.log('Recorded stage1 observation:', JSON.stringify(stage1Record));
if (stage2Record) console.log('Recorded stage2 observation:', JSON.stringify(stage2Record));
else console.log('No stage2 observation recorded (deep scan failed).');
console.log(`\nTotals now: stage1=${benchmarks.stage1_url_scan.records.length} stage2=${benchmarks.stage2_full_audit.records.length}`);
