import React, { useEffect, useMemo, useState } from 'react';
import {
  runSurfaceAudit,
  runFullAudit,
  fetchLiveShopifyInputs,
  fetchGa4LiveReport,
  fetchGtmContainerMatch,
  fetchDeepScan,
  buildReportHtml,
  exportReportPdf,
} from './utils/auditLogic';
import type { AuditInputs, DeepScanResult, SurfaceAuditResult } from './utils/auditLogic';
import { resolveEffectiveSignals, buildSurfaceCards, reconcileLiveApiEvidence } from './utils/auditLogic';
import { mergeManualFindings } from './utils/topIssues';
import type { ManualCheckResult } from './utils/topIssues';
import { runDiagnostics } from './utils/diagnosticEngine';
import type { DiagnosticSeverity } from './utils/diagnosticEngine';
import { CSVUploader } from './components/stage2/CSVUploader';
import { LeadRegister } from './components/leads/LeadRegister';
import { getAdapterStateLabel } from './utils/sourceAdapters';
import { REGIONS } from './utils/constants';
import type { Region } from './utils/constants';
import { formatCurrency, isSameStoreUrl } from './utils/formatters';

const severityColor: Record<DiagnosticSeverity, string> = {
  critical: '#fca5a5',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#93c5fd',
  info: '#4ade80',
};
const severityLabel: Record<DiagnosticSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'CLEAR',
};

type TabKey = 'noAccess' | 'withAccess' | 'clientReport' | 'leads';

const toneColor: Record<string, string> = {
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#fca5a5',
};

const guidedChecks = [
  { id: 'purchase-firing', title: 'Validate purchase firing', where: 'GTM Preview / Tag Assistant', lookFor: 'One purchase event with value, currency, transaction_id, and items.', good: 'Exactly one purchase tag fires with the Shopify order ID.', href: 'https://tagassistant.google.com/' },
  { id: 'ga4-ecommerce', title: 'Validate GA4 ecommerce', where: 'GA4 DebugView', lookFor: 'purchase and add_to_cart events with ecommerce parameters.', good: 'Events appear once and revenue matches the test order.', href: 'https://support.google.com/analytics/answer/7201382' },
  { id: 'ad-platform-attribution', title: 'Validate ad-platform attribution', where: 'Meta Events Manager / platform diagnostics', lookFor: 'Browser and server events, matching event_id, and no duplicate purchase.', good: 'A single deduplicated purchase is received with no critical diagnostics.', href: 'https://www.facebook.com/events_manager2/' },
  { id: 'revenue-reconciliation', title: 'Reconcile store revenue', where: 'Shopify Orders export', lookFor: 'The same date range, refunds, COD orders, and fulfillment statuses.', good: 'Shopify order totals provide the confirmed source for the report.', href: 'https://admin.shopify.com/' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('noAccess');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [region, setRegion] = useState<Region>('US');

  // ---- Tab 1: No Access ----
  const [surfaceUrl, setSurfaceUrl] = useState('');
  const [isSurfaceScanning, setIsSurfaceScanning] = useState(false);
  const [surfaceResult, setSurfaceResult] = useState<SurfaceAuditResult | null>(null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  // Deliberately separate from Tab 2's audit-deep-scan state below (and from
  // each other's URL) — sharing one slot across tabs let Tab 1's deep-scan
  // evidence for one store get silently attributed to Tab 2's audit of a
  // completely different store. See validSurfaceDeepScan/validAuditDeepScan.
  const [surfaceDeepScan, setSurfaceDeepScan] = useState<DeepScanResult | null>(null);
  const [isSurfaceDeepScanning, setIsSurfaceDeepScanning] = useState(false);
  const [surfaceDeepScanError, setSurfaceDeepScanError] = useState<string | null>(null);

  // ---- Tab 2: With Access ----
  const [storeUrl, setStoreUrl] = useState('');
  const [auditDeepScan, setAuditDeepScan] = useState<DeepScanResult | null>(null);
  const [isAuditDeepScanning, setIsAuditDeepScanning] = useState(false);
  const [auditDeepScanError, setAuditDeepScanError] = useState<string | null>(null);
  const [gtmIdInput, setGtmIdInput] = useState('');
  const [ga4IdInput, setGa4IdInput] = useState('');
  const [ga4PropertyIdInput, setGa4PropertyIdInput] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [csvRtoSuggestion, setCsvRtoSuggestion] = useState<number | null>(null);
  // Outcomes recorded inline against the guided manual checks — keyed by
  // guidedChecks[].id. Reset whenever a new audit runs, so results always
  // belong to the audit currently on screen.
  const [guidedCheckOutcomes, setGuidedCheckOutcomes] = useState<Record<string, { outcome: 'pass' | 'fail' | 'unsure'; note: string }>>({});
  const [csvInputs, setCsvInputs] = useState<AuditInputs | null>(null);
  const [financialInputs, setFinancialInputs] = useState({ cogs: '', shipping: '', adSpend: '', settlementDays: '', newCustomers: '', rtoOrders: '' });
  const [isPullingShopify, setIsPullingShopify] = useState(false);
  const [shopifyPullError, setShopifyPullError] = useState<string | null>(null);
  const [liveGa4, setLiveGa4] = useState<any>(null);
  const [liveGtmMatch, setLiveGtmMatch] = useState<any>(null);
  const [liveDataError, setLiveDataError] = useState<string | null>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [accessStatus, setAccessStatus] = useState({ ga4: { connected: false }, gtm: { connected: false }, shopify: { configured: false } });
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const refreshAccessStatus = async () => {
    try {
      const response = await fetch('/api/status');
      if (response.ok) setAccessStatus(await response.json());
    } catch { /* Backend may not be running yet; UI presents disconnected state. */ }
  };
  useEffect(() => { void refreshAccessStatus(); }, []);

  // ===== Tab 1 handlers =====

  const handleSurfaceScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!surfaceUrl) return;
    setIsSurfaceScanning(true);
    setSurfaceResult(null);
    setSurfaceError(null);
    setSurfaceDeepScan(null);
    setSurfaceDeepScanError(null);
    try {
      const result = await runSurfaceAudit(surfaceUrl, region);
      setSurfaceResult(result);
      if (result.status === 'error') {
        setSurfaceError(result.error || 'Scan failed.');
      }
    } catch (err: any) {
      setSurfaceError(err.message || 'Scan failed unexpectedly.');
    } finally {
      setIsSurfaceScanning(false);
    }
  };

  const handleSurfaceDeepScan = async () => {
    if (!surfaceUrl) return;
    setIsSurfaceDeepScanning(true);
    setSurfaceDeepScanError(null);
    try {
      setSurfaceDeepScan(await fetchDeepScan(surfaceUrl));
    } catch (err: any) {
      setSurfaceDeepScanError(err.message || 'Deep scan failed.');
    } finally {
      setIsSurfaceDeepScanning(false);
    }
  };

  const handleAuditDeepScan = async () => {
    if (!storeUrl) return;
    setIsAuditDeepScanning(true);
    setAuditDeepScanError(null);
    try {
      setAuditDeepScan(await fetchDeepScan(storeUrl));
    } catch (err: any) {
      setAuditDeepScanError(err.message || 'Deep scan failed.');
    } finally {
      setIsAuditDeepScanning(false);
    }
  };

  // Guards against stale cross-store evidence: a deep scan is only valid
  // for the exact URL it was run against. Without this, switching tabs (or
  // editing the URL field after scanning) would silently let one store's
  // network evidence get attributed to a different store's evidence/audit.
  const validSurfaceDeepScan = useMemo(
    () => (surfaceDeepScan && isSameStoreUrl(surfaceDeepScan.url, surfaceUrl) ? surfaceDeepScan : null),
    [surfaceDeepScan, surfaceUrl]
  );
  const validAuditDeepScan = useMemo(
    () => (auditDeepScan && isSameStoreUrl(auditDeepScan.url, storeUrl) ? auditDeepScan : null),
    [auditDeepScan, storeUrl]
  );
  const surfaceDeepScanStale = !!surfaceDeepScan && !validSurfaceDeepScan;
  const auditDeepScanStale = !!auditDeepScan && !validAuditDeepScan;

  const extractDataLayerEvents = (deep: DeepScanResult | null) =>
    Array.from(new Set((deep?.dataLayer || []).flatMap((entry: any) => {
      if (typeof entry?.event === 'string') return [entry.event];
      if (Array.isArray(entry) && entry[0] === 'event' && typeof entry[1] === 'string') return [entry[1]];
      return [];
    })));
  const extractEcommerceFields = (deep: DeepScanResult | null) =>
    Array.from(new Set((deep?.dataLayer || []).flatMap((entry: any) => {
      const ecommerce = entry?.ecommerce;
      return ecommerce && typeof ecommerce === 'object' ? Object.keys(ecommerce) : [];
    })));

  // Tab 1's own evidence panel reads eventEvidence directly instead — this
  // pair is only needed for Tab 2's "dataLayer evidence" grid.
  const auditDataLayerEvents = extractDataLayerEvents(validAuditDeepScan);
  const auditEcommerceFields = extractEcommerceFields(validAuditDeepScan);

  // AUDIT -> LOCATE -> POINT -> GUIDE: rank root-cause candidates from
  // whatever real evidence exists so far (surface-only, or surface+deep).
  const diagnosticReport = useMemo(() => {
    if (!surfaceResult || surfaceResult.status !== 'ok') return null;
    return runDiagnostics(surfaceResult, validSurfaceDeepScan);
  }, [surfaceResult, validSurfaceDeepScan]);

  // Cards must reflect the strongest evidence available, not just the
  // static HTML pass — confirmed on a real store during testing that static
  // detection alone misses tags that load dynamically. Recomputed whenever
  // either scan updates, regardless of which the operator ran first.
  const enrichedCards = useMemo(() => {
    if (!surfaceResult || surfaceResult.status !== 'ok') return [];
    const effective = resolveEffectiveSignals(surfaceResult, validSurfaceDeepScan);
    return buildSurfaceCards(effective, surfaceResult.hasCmp, surfaceResult.cmpName, region);
  }, [surfaceResult, validSurfaceDeepScan, region]);

  // "GA4 connected" != "GA4 implementation is correct" — reconcile what the
  // live API actually reports against what was observed on the storefront.
  const apiReconciliation = useMemo(() => {
    if (!scanResult || scanResult.status === 'error') return [];
    return reconcileLiveApiEvidence(scanResult, liveGa4, liveGtmMatch, validAuditDeepScan, region);
  }, [scanResult, liveGa4, liveGtmMatch, validAuditDeepScan, region]);

  // Finish the audit in one sitting: a guided check marked "fail" becomes a
  // real, top-ranked issue in the same report immediately — not a separate
  // checklist you have to remember to reconcile with the findings later.
  const manualCheckResults: ManualCheckResult[] = useMemo(
    () =>
      guidedChecks
        .filter((c) => guidedCheckOutcomes[c.id])
        .map((c) => ({ id: c.id, title: c.title, where: c.where, outcome: guidedCheckOutcomes[c.id].outcome, note: guidedCheckOutcomes[c.id].note })),
    [guidedCheckOutcomes]
  );
  const mergedTopIssues = useMemo(() => {
    if (!scanResult || scanResult.status === 'error') return null;
    return mergeManualFindings(scanResult.report.topIssues, manualCheckResults);
  }, [scanResult, manualCheckResults]);

  // ===== Tab 2 handlers =====

  const handlePullLiveOrders = async () => {
    setIsPullingShopify(true);
    setShopifyPullError(null);
    try {
      const liveInputs = await fetchLiveShopifyInputs(startDate || undefined, endDate || undefined);
      setCsvInputs(liveInputs);
    } catch (err: any) {
      setShopifyPullError(err.message || 'Could not pull live Shopify orders.');
    } finally {
      setIsPullingShopify(false);
    }
  };

  const handleCSVVitals = (payload: {
    grossRevenue: number;
    totalOrders: number;
    codOrders: number;
    rtoOrders: number;
    newCustomers: number;
    avgOrderValue: number;
    suggestedRtoOrders?: number;
  }) => {
    // Suggestion only, from "restocked" fulfillment-status rows — pre-fills
    // the confirm-before-scan RTO field as a starting point, still fully
    // editable. csvInputs.rtoOrders itself stays honestly 0 either way.
    if (payload.suggestedRtoOrders) {
      setCsvRtoSuggestion(payload.suggestedRtoOrders);
      setFinancialInputs((current) => (current.rtoOrders === '' ? { ...current, rtoOrders: String(payload.suggestedRtoOrders) } : current));
    } else {
      setCsvRtoSuggestion(null);
    }
    const derivedInputs: AuditInputs = {
      grossRevenue: payload.grossRevenue,
      totalOrders: payload.totalOrders,
      newCustomers: payload.newCustomers,
      rtoOrders: payload.rtoOrders,
      codOrders: payload.codOrders,
      cogs: 0,
      shipping: 0,
      adSpend: 0,
      settlementDays: 0,
      avgOrderValue: payload.avgOrderValue,
    };

    setCsvInputs(derivedInputs);
  };

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeUrl) return;

    if (!csvInputs) {
      setScanError('Load Shopify data (CSV upload or live pull) before scanning — no default numbers are used.');
      return;
    }
    const requiredFinancialFields = ['cogs', 'shipping', 'adSpend', 'settlementDays'] as const;
    if (requiredFinancialFields.some((field) => financialInputs[field] === '' || Number(financialInputs[field]) < 0)) {
      setScanError('Enter confirmed COGS, shipping, ad spend, and settlement days before scanning.');
      return;
    }
    if (csvInputs.newCustomers === 0 && (financialInputs.newCustomers === '' || Number(financialInputs.newCustomers) < 0)) {
      setScanError('New-customer data was not available in the order source. Enter the confirmed count before scanning.');
      return;
    }
    // CSV/live Shopify order pulls can never determine RTO (return-to-origin)
    // from order data alone — csvInputs.rtoOrders is always 0 from those
    // sources, whether or not RTO is actually zero. Require a confirmed
    // count so the report never silently presents "RTO: 0%" as measured
    // when it was actually just never computed.
    if (csvInputs.rtoOrders === 0 && (financialInputs.rtoOrders === '' || Number(financialInputs.rtoOrders) < 0)) {
      setScanError('RTO (return-to-origin) order count was not available in the order source. Enter the confirmed count (0 if genuinely none) before scanning.');
      return;
    }
    if (!gtmIdInput.trim() && !ga4IdInput.trim()) {
      setScanError('Enter at least a GTM ID or GA4 ID to run the with-access audit — this tab requires credentials.');
      return;
    }

    setIsScanning(true);
    setScanResult(null);
    setScanError(null);
    setLiveGa4(null);
    setLiveGtmMatch(null);
    setLiveDataError(null);
    setGuidedCheckOutcomes({}); // a new audit needs its own fresh manual verification

    try {
      const result = await runFullAudit(
        storeUrl,
        {
          ...csvInputs,
          cogs: Number(financialInputs.cogs),
          shipping: Number(financialInputs.shipping),
          adSpend: Number(financialInputs.adSpend),
          settlementDays: Number(financialInputs.settlementDays),
          newCustomers: csvInputs.newCustomers || Number(financialInputs.newCustomers),
          rtoOrders: csvInputs.rtoOrders || Number(financialInputs.rtoOrders),
        },
        gtmIdInput.trim() || null,
        ga4IdInput.trim() || null,
        region,
        validAuditDeepScan
      );
      setScanResult(result);
      if (result.status === 'error') {
        setScanError(result.report.summary);
      }

      if (ga4PropertyIdInput.trim()) {
        fetchGa4LiveReport(ga4PropertyIdInput.trim(), startDate || '30daysAgo', endDate || 'today')
          .then(setLiveGa4)
          .catch((err: any) => setLiveDataError(err.message || 'GA4 live report failed.'));
      }
      fetchGtmContainerMatch(
        gtmIdInput.trim() || (result.metrics.gtmId !== 'Not found' ? result.metrics.gtmId : null)
      )
        .then(setLiveGtmMatch)
        .catch((err: any) => setLiveDataError(err.message || 'GTM container check failed.'));
    } catch (err: any) {
      setScanError(err.message || 'Scan failed unexpectedly.');
    } finally {
      setIsScanning(false);
    }
  };

  const handleExportPdf = async () => {
    if (!scanResult) return;
    setIsExportingPdf(true);
    try {
      // The PDF must reflect the same manually-verified findings shown on
      // screen, not just automated evidence — otherwise "finishing in one
      // sitting" would still leave the exported report out of date.
      const reportForExport = mergedTopIssues
        ? { ...scanResult, report: { ...scanResult.report, topIssues: mergedTopIssues } }
        : scanResult;
      const html = buildReportHtml(reportForExport);
      const blob = await exportReportPdf(html);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jsonalytics-audit-report.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || 'PDF export failed.');
    } finally {
      setIsExportingPdf(false);
    }
  };

  const tabButtonStyle = (tab: TabKey): React.CSSProperties => ({
    padding: '10px 20px',
    borderRadius: '8px 8px 0 0',
    border: '1px solid #334155',
    borderBottom: activeTab === tab ? '1px solid #0f172a' : '1px solid #334155',
    backgroundColor: activeTab === tab ? '#0f172a' : '#1e293b',
    color: activeTab === tab ? '#f8fafc' : '#94a3b8',
    fontWeight: activeTab === tab ? 700 : 500,
    cursor: 'pointer',
    fontSize: '0.88rem',
  });

  return (
    <div className="app-shell" style={{ minHeight: '100vh', color: '#f8fafc', fontFamily: 'sans-serif', padding: '2rem' }}>
      <div className="app-frame" style={{ maxWidth: '1180px', margin: '0 auto' }}>

        {/* Header */}
        <header className="topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem', borderBottom: '1px solid #334155', paddingBottom: '1rem' }}>
          <div className="brand-lockup" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <svg width="40" height="40" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
              <rect x="1" y="1" width="42" height="42" rx="10" fill="#1e293b" stroke="#334155" />
              <path d="M14 17 L14 15 A8 6 0 0 1 30 15 L30 17" fill="none" stroke="#e8792c" strokeWidth="2" strokeLinecap="round" />
              <rect x="11" y="17" width="22" height="17" rx="3" fill="none" stroke="#e8792c" strokeWidth="2" />
              <circle cx="30" cy="30" r="7" fill="#e8792c" />
              <path d="M27 30 L29.3 32.3 L33 27.5" fill="none" stroke="#1e293b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <div style={{ fontSize: '1.15rem', fontWeight: 600, letterSpacing: '0.2px' }}>
                <span style={{ color: '#f9fafb' }}>JSON</span><span style={{ color: '#e8792c' }}>alytics</span>
              </div>
              <div style={{ color: '#94a3b8', fontSize: '0.76rem', marginTop: '2px' }}>Stop guessing, start growing.</div>
            </div>
          </div>
          <div className="top-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: '#94a3b8' }}>
              Market
              <select
                aria-label="Market"
                value={region}
                onChange={(e) => setRegion(e.target.value as Region)}
                style={{ backgroundColor: '#1f2937', color: '#f8fafc', border: '1px solid #334155', borderRadius: '8px', padding: '5px 8px', fontSize: '0.8rem' }}
              >
                {Object.values(REGIONS).map((r) => (
                  <option key={r.code} value={r.code}>{r.label} ({r.currency})</option>
                ))}
              </select>
            </label>
            <span style={{ backgroundColor: '#1f2937', color: '#fbbf24', padding: '4px 12px', borderRadius: '999px', fontSize: '0.875rem', border: '1px solid #334155' }}>
              LIVE FEED
            </span>
            <span style={{ backgroundColor: '#1f2937', color: '#94a3b8', padding: '4px 12px', borderRadius: '999px', fontSize: '0.875rem', border: '1px solid #334155' }}>
              Sources: {[accessStatus.shopify.configured, accessStatus.ga4.connected, accessStatus.gtm.connected].filter(Boolean).length} Connected
            </span>
            <span className="window-buttons" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button aria-label="Minimize" onClick={() => setIsMinimized(!isMinimized)} style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: '#374151', color: '#f8fafc', border: '1px solid #52525b', fontSize: '14px' }}>−</button>
              <button aria-label="Close" onClick={() => setIsClosed(!isClosed)} style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: '#b45309', color: '#fff', border: '1px solid #f97316', fontSize: '14px' }}>×</button>
            </span>
          </div>
        </header>

        {isClosed && (
          <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
            <div style={{ color: '#fbbf24', fontSize: '0.82rem' }}>Console Closed</div>
            <button onClick={() => setIsClosed(false)} style={{ marginTop: '8px', backgroundColor: '#b45309', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 12px' }}>Reopen</button>
          </div>
        )}

        {!isClosed && (
          <>
            {/* ===== Tabs ===== */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '0' }}>
              <button style={tabButtonStyle('noAccess')} onClick={() => setActiveTab('noAccess')}>
                🔍 No Access — Surface Dashboard
              </button>
              <button style={tabButtonStyle('withAccess')} onClick={() => setActiveTab('withAccess')}>
                🔐 With Access — Full Audit
              </button>
              <button style={{ ...tabButtonStyle('clientReport'), opacity: scanResult ? 1 : 0.55 }} onClick={() => scanResult && setActiveTab('clientReport')} disabled={!scanResult}>
                📄 Client Report
              </button>
              <button style={tabButtonStyle('leads')} onClick={() => setActiveTab('leads')}>
                📋 Leads
              </button>
            </div>
            <div style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: '1.5rem', marginBottom: '2rem' }}>

              {/* ================= TAB 1: NO ACCESS ================= */}
              {activeTab === 'noAccess' && !isMinimized && (
                <div>
                  <div style={{ marginBottom: '1rem' }}>
                    <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px 0' }}>Surface Scan Dashboard</h2>
                    <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                      URL only — no store credentials needed. Directional public signals only; financial impact is not confirmed here.
                    </div>
                  </div>

                  <form onSubmit={handleSurfaceScan} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    <input
                      type="text"
                      placeholder="Enter store URL (e.g., mystore.myshopify.com)"
                      value={surfaceUrl}
                      onChange={(e) => setSurfaceUrl(e.target.value)}
                      style={{ flex: 2, minWidth: '240px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                    />
                    <button
                      type="submit"
                      disabled={isSurfaceScanning}
                      style={{ backgroundColor: '#b45309', color: '#fff', border: 'none', padding: '0 24px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                    >
                      {isSurfaceScanning ? 'Scanning...' : 'Scan Store'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSurfaceDeepScan()}
                      disabled={isSurfaceDeepScanning || !surfaceUrl}
                      style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', padding: '0 16px', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isSurfaceDeepScanning ? 'Running read-only inspection...' : '🔍 Read-only Deep Scan'}
                    </button>
                  </form>

                  {surfaceError && (
                    <div style={{ marginBottom: '12px', color: '#fca5a5', fontSize: '0.82rem', backgroundColor: 'rgba(229,72,77,0.08)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                      ❌ {surfaceError}
                    </div>
                  )}
                  {surfaceDeepScanError && (
                    <div style={{ marginBottom: '12px', color: '#fca5a5', fontSize: '0.8rem' }}>❌ {surfaceDeepScanError}</div>
                  )}

                  {surfaceResult && surfaceResult.status === 'ok' && (
                    <>
                      {diagnosticReport && (
                        <div style={{ marginTop: '0.5rem' }}>
                          {diagnosticReport.earliestFailure ? (
                            <div style={{ backgroundColor: 'rgba(229,72,77,0.08)', border: `1px solid ${severityColor[diagnosticReport.earliestFailure.severity]}55`, borderLeft: `4px solid ${severityColor[diagnosticReport.earliestFailure.severity]}`, borderRadius: '8px', padding: '14px 16px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '1px', color: severityColor[diagnosticReport.earliestFailure.severity] }}>📍 POINT TO FIRST — {severityLabel[diagnosticReport.earliestFailure.severity]}</span>
                              </div>
                              <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '6px' }}>{diagnosticReport.earliestFailure.title}</div>
                              <div style={{ fontSize: '0.8rem', color: '#e2e8f0', marginBottom: '4px' }}><strong>Observed:</strong> {diagnosticReport.earliestFailure.observed.join(' ')}</div>
                              <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '4px' }}><strong>Proves:</strong> {diagnosticReport.earliestFailure.proves}</div>
                              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '4px' }}><strong>Does not prove:</strong> {diagnosticReport.earliestFailure.doesNotProve}</div>
                              <div style={{ fontSize: '0.8rem', color: '#38bdf8', marginTop: '8px' }}><strong>First check:</strong> {diagnosticReport.earliestFailure.firstCheck}</div>
                            </div>
                          ) : (
                            <div style={{ backgroundColor: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '8px', padding: '12px 16px', fontSize: '0.82rem', color: '#f1f5f9' }}>
                              ✔ No blocking dependency issue found in page-load evidence. Proceed to guided manual checks below.
                            </div>
                          )}
                          {diagnosticReport.findings.length > 1 && (
                            <details style={{ marginTop: '10px' }}>
                              <summary style={{ cursor: 'pointer', fontSize: '0.78rem', color: '#94a3b8' }}>Show all {diagnosticReport.findings.length} diagnostic findings ({diagnosticReport.evidenceDepth === 'surface+deep' ? 'surface + deep scan evidence' : 'surface evidence only — run deep scan for more'})</summary>
                              <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                                {diagnosticReport.findings.map((f) => (
                                  <div key={f.id} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderLeft: `3px solid ${severityColor[f.severity]}`, borderRadius: '6px', padding: '10px 12px', fontSize: '0.76rem' }}>
                                    <div style={{ fontWeight: 700, color: severityColor[f.severity] }}>{severityLabel[f.severity]} · {f.title}</div>
                                    <div style={{ color: '#cbd5e1', marginTop: '4px' }}><strong>Dependency:</strong> {f.dependency}</div>
                                    {f.downstreamConsequences.length > 0 && <div style={{ color: '#94a3b8', marginTop: '4px' }}><strong>If left unfixed:</strong> {f.downstreamConsequences.join(' ')}</div>}
                                    <div style={{ color: '#64748b', marginTop: '4px' }}>Confidence: {f.confidence}{f.requiresDeepScan && !validSurfaceDeepScan ? ' — run deep scan for stronger evidence' : ''}</div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginTop: '1.25rem' }}>
                        {enrichedCards.map((card, i) => (
                          <div key={i} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '14px' }}>
                            <div style={{ color: '#94a3b8', fontSize: '0.72rem', letterSpacing: '0.5px', textTransform: 'uppercase' }}>{card.label}</div>
                            <div style={{ marginTop: '6px', fontSize: '1.1rem', fontWeight: 700, color: toneColor[card.tone] }}>{card.value}</div>
                            <div style={{ marginTop: '6px', color: '#cbd5e1', fontSize: '0.76rem', lineHeight: 1.35 }}>{card.explainer}</div>
                            {card.confidence && <div style={{ marginTop: '7px', color: '#94a3b8', fontSize: '0.68rem', lineHeight: 1.3 }}>Unconfirmed: {card.confidence}</div>}
                          </div>
                        ))}
                      </div>

                      {surfaceDeepScanStale && (
                        <div style={{ color: '#fbbf24', fontSize: '0.75rem', marginTop: '1.25rem' }}>⚠ Deep scan evidence was for a different URL — re-run "Read-only Deep Scan" for this one.</div>
                      )}
                      {validSurfaceDeepScan && (
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155', marginTop: '1.25rem' }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '10px' }}>Deep Scan (Headless Browser)</div>
                          <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '6px' }}>
                            dataLayer present: <span style={{ color: validSurfaceDeepScan.dataLayerPresent ? '#4ade80' : '#fbbf24' }}>{validSurfaceDeepScan.dataLayerPresent ? 'Yes' : 'No'}</span>
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '6px' }}>
                            Consent signal found: <span style={{ color: validSurfaceDeepScan.consent.found ? '#4ade80' : '#fbbf24' }}>{validSurfaceDeepScan.consent.found ? 'Yes' : 'No'}</span>
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '6px' }}>
                            Page-load events observed: {validSurfaceDeepScan.eventEvidence.length ? validSurfaceDeepScan.eventEvidence.map((item) => item.event).join(', ') : 'None readable'}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '8px' }}>{validSurfaceDeepScan.note}</div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ================= TAB 2: WITH ACCESS ================= */}
              {activeTab === 'withAccess' && !isMinimized && (
                <div>
                  <div style={{ marginBottom: '1rem' }}>
                    <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px 0' }}>Full Store Compliance & Financial Audit</h2>
                    <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                      Uses Shopify order data plus optional GA4/GTM access. Financial conclusions remain conservative and traceable to the selected source/date range.
                    </div>
                  </div>

                  <div style={{ background: 'linear-gradient(180deg, #202b37 0%, #171b21 100%)', padding: '1.25rem', borderRadius: '12px', border: '1px solid #334155', marginBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <h3 style={{ fontSize: '0.95rem', margin: 0, color: '#f8fafc' }}>Run Audit</h3>
                      <span style={{ fontSize: '0.72rem', color: '#4ade80', letterSpacing: '1px', backgroundColor: 'rgba(74, 222, 128, 0.08)', padding: '6px 12px', borderRadius: '999px', border: '1px solid rgba(74,222,128,0.25)' }}>Use npm run dev:all</span>
                    </div>
                    <form onSubmit={handleScan} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <input
                        type="text"
                        placeholder="Enter Shopify store URL (e.g., mystore.myshopify.com)"
                        value={storeUrl}
                        onChange={(e) => setStoreUrl(e.target.value)}
                        style={{ width: '100%', padding: '12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '1rem', outline: 'none' }}
                      />
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          placeholder="GTM-XXXXXXX (required, or use GA4 ID)"
                          value={gtmIdInput}
                          onChange={(e) => setGtmIdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '220px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                        />
                        <input
                          type="text"
                          placeholder="G-XXXXXXXXXX (required, or use GTM ID)"
                          value={ga4IdInput}
                          onChange={(e) => setGa4IdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '220px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                        />
                        <input
                          type="text"
                          placeholder="GA4 Property ID e.g. 354981234 (numeric — for live report pull)"
                          value={ga4PropertyIdInput}
                          onChange={(e) => setGa4PropertyIdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '220px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                        />
                        <button
                          type="submit"
                          disabled={isScanning}
                          style={{ backgroundColor: '#b45309', color: '#fff', border: 'none', padding: '0 24px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          {isScanning ? 'Scanning...' : 'Audit Store'}
                        </button>
                      </div>
                    </form>
                    {scanError && (
                      <div style={{ marginTop: '12px', color: '#fca5a5', fontSize: '0.82rem', backgroundColor: 'rgba(229,72,77,0.08)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                        ❌ {scanError}
                      </div>
                    )}
                  </div>

                  <div style={{ color: '#64748b', fontSize: '0.72rem', marginBottom: '10px' }}>
                    Store size doesn't change how this works: the audit reads aggregate totals and a single representative scan, never a per-order or per-product review — a 50-order store and a 50,000-order store go through the exact same steps. Large live pulls automatically retry through Shopify's rate limits instead of failing partway through.
                  </div>
                  <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <CSVUploader onDataParsed={handleCSVVitals} />
                    <button
                      onClick={handlePullLiveOrders}
                      disabled={isPullingShopify}
                      style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', padding: '10px 16px', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isPullingShopify ? 'Pulling live orders...' : '⚡ Pull Live Shopify Orders'}
                    </button>
                    <input type="date" aria-label="Shopify start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ padding: '9px', backgroundColor: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px' }} />
                    <input type="date" aria-label="Shopify end date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ padding: '9px', backgroundColor: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px' }} />
                    {shopifyPullError && <span style={{ color: '#fca5a5', fontSize: '0.78rem' }}>❌ {shopifyPullError}</span>}
                    {csvInputs && !shopifyPullError && (
                      <span style={{ color: '#4ade80', fontSize: '0.78rem' }}>✓ Using {csvInputs.totalOrders} orders; refunds/voids/restocks and first-time customers require verified inputs.</span>
                    )}
                    {!csvInputs && (
                      <span style={{ color: '#fbbf24', fontSize: '0.78rem' }}>⚠ No order data loaded yet — scan is disabled until you do</span>
                    )}
                  </div>

                  {csvInputs && (
                    <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155', marginBottom: '1rem' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>Confirmed financial inputs</div>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', margin: '4px 0 10px' }}>Required before calculating financial metrics. Values are never estimated — the one exception is RTO, which may be pre-filled from a CSV suggestion below, and still requires your confirmation.</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: '10px' }}>
                        {([
                          ['cogs', 'COGS ($)'], ['shipping', 'Shipping cost ($)'], ['adSpend', 'Ad spend ($)'], ['settlementDays', 'Settlement days'], ['newCustomers', 'New customers (if missing)'], ['rtoOrders', 'RTO orders (if missing, 0 if none)'],
                        ] as const).map(([field, label]) => (
                          <input key={field} type="number" min="0" placeholder={label} value={financialInputs[field]} onChange={(e) => setFinancialInputs((current) => ({ ...current, [field]: e.target.value }))} style={{ padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }} />
                        ))}
                      </div>
                      {csvRtoSuggestion !== null && (
                        <div style={{ color: '#fbbf24', fontSize: '0.72rem', marginTop: '8px' }}>
                          Suggested from CSV: {csvRtoSuggestion} order{csvRtoSuggestion === 1 ? '' : 's'} with fulfillment status "restocked" — pre-filled above as a starting point, not a confirmed count. "Restocked" is Shopify's own signal for inventory returned to origin, but confirm before scanning.
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '12px', alignItems: 'center', flexWrap: 'wrap' }}><div style={{ fontSize: '0.9rem', fontWeight: 700 }}>Source connections</div><button onClick={() => void refreshAccessStatus()} style={{ background: '#0f172a', color: '#cbd5e1', border: '1px solid #475569', borderRadius: '7px', padding: '6px 10px' }}>Refresh status</button></div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                      <button onClick={() => window.open('/api/ga4/auth', '_blank')} style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '7px', padding: '7px 10px' }}>{accessStatus.ga4.connected ? 'GA4 connected' : 'Connect GA4'}</button>
                      <button onClick={() => window.open('/api/gtm/auth', '_blank')} style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '7px', padding: '7px 10px' }}>{accessStatus.gtm.connected ? 'GTM connected' : 'Connect GTM'}</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
                      {Object.entries({ shopify: accessStatus.shopify.configured ? 'ready' : 'not-configured', ga4: accessStatus.ga4.connected ? 'connected' : 'not-configured', gtm: accessStatus.gtm.connected ? 'connected' : 'not-configured', dataLayer: validAuditDeepScan?.dataLayerPresent ? 'ready' : 'waiting', consent: validAuditDeepScan?.consent.found ? 'ready' : 'waiting' }).map(([key, value]) => (
                        <div key={key} style={{ backgroundColor: '#0f172a', borderRadius: '8px', padding: '10px', border: '1px solid #334155' }}>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase' }}>{key}</div>
                          <div style={{ marginTop: '6px', fontSize: '0.78rem', color: value === 'waiting' || value === 'not-configured' ? '#fbbf24' : '#4ade80' }}>{getAdapterStateLabel(value as any)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div><div style={{ fontSize: '0.9rem', fontWeight: 700 }}>dataLayer evidence</div><div style={{ color: '#94a3b8', fontSize: '0.75rem', marginTop: '4px' }}>Read-only browser evidence; it does not validate checkout purchase firing.</div></div>
                      <button onClick={() => handleAuditDeepScan()} disabled={isAuditDeepScanning || !storeUrl} style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #475569', padding: '9px 13px', borderRadius: '8px', cursor: 'pointer' }}>{isAuditDeepScanning ? 'Inspecting...' : 'Inspect dataLayer'}</button>
                    </div>
                    {auditDeepScanError && <div style={{ color: '#fca5a5', fontSize: '0.78rem', marginTop: '8px' }}>❌ {auditDeepScanError}</div>}
                    {auditDeepScanStale && (
                      <div style={{ color: '#fbbf24', fontSize: '0.75rem', marginTop: '8px' }}>⚠ dataLayer evidence was for a different URL — re-run "Inspect dataLayer" for this one before auditing.</div>
                    )}
                    {validAuditDeepScan && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '12px', fontSize: '0.8rem' }}>
                        <div><span style={{ color: '#94a3b8' }}>dataLayer</span><div style={{ color: validAuditDeepScan.dataLayerPresent ? '#4ade80' : '#fbbf24', marginTop: '4px' }}>{validAuditDeepScan.dataLayerPresent ? 'Detected' : 'Not detected'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Events</span><div style={{ marginTop: '4px' }}>{auditDataLayerEvents.length ? auditDataLayerEvents.join(', ') : 'None readable'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Ecommerce fields</span><div style={{ marginTop: '4px' }}>{auditEcommerceFields.length ? auditEcommerceFields.join(', ') : 'None readable'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Consent / server-side heuristic</span><div style={{ marginTop: '4px' }}>{validAuditDeepScan.consent.found ? 'Consent signal detected' : 'Consent unconfirmed'} · {validAuditDeepScan.trackingSignals.serverSideEndpointCandidates.length ? 'Possible server endpoint (heuristic)' : 'No server endpoint observed'}</div></div>
                      </div>
                    )}
                  </div>

                  {scanResult && scanResult.status !== 'error' && (
                    <div style={{ display: 'grid', gap: '1.5rem' }}>
                      <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155' }}>
                        <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '4px' }}>Guided next checks</div>
                        <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '12px' }}>These stay manual on purpose — this app never clicks Add to Cart or Checkout for you. Mark the outcome here and it becomes a real, ranked issue below immediately, so you can finish the whole audit in one sitting instead of a separate follow-up.</div>
                        <div style={{ display: 'grid', gap: '10px' }}>
                          {guidedChecks.map((check) => {
                            const recorded = guidedCheckOutcomes[check.id];
                            const outcomeColor = recorded?.outcome === 'pass' ? '#4ade80' : recorded?.outcome === 'fail' ? '#fca5a5' : recorded?.outcome === 'unsure' ? '#fbbf24' : '#334155';
                            return (
                              <div key={check.id} style={{ backgroundColor: '#0f172a', border: `1px solid ${outcomeColor}`, borderRadius: '8px', padding: '12px', fontSize: '0.8rem' }}>
                                <div style={{ fontWeight: 700 }}>{check.title} <a href={check.href} target="_blank" rel="noreferrer" style={{ color: '#38bdf8', marginLeft: '6px' }}>Open tool ↗</a></div>
                                <div style={{ color: '#cbd5e1', marginTop: '5px' }}><strong>Where:</strong> {check.where} · <strong>Look for:</strong> {check.lookFor}</div>
                                <div style={{ color: '#4ade80', marginTop: '5px' }}><strong>Good result:</strong> {check.good}</div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' }}>
                                  {(['pass', 'fail', 'unsure'] as const).map((outcome) => (
                                    <button
                                      key={outcome}
                                      onClick={() => setGuidedCheckOutcomes((prev) => ({ ...prev, [check.id]: { outcome, note: prev[check.id]?.note || '' } }))}
                                      style={{
                                        backgroundColor: recorded?.outcome === outcome ? outcomeColor : 'transparent',
                                        color: recorded?.outcome === outcome ? '#0f172a' : '#94a3b8',
                                        border: `1px solid ${recorded?.outcome === outcome ? outcomeColor : '#475569'}`,
                                        borderRadius: '6px', padding: '4px 10px', fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer',
                                      }}
                                    >
                                      {outcome === 'pass' ? '✓ Pass' : outcome === 'fail' ? '✗ Fail' : '? Unsure'}
                                    </button>
                                  ))}
                                  {recorded?.outcome === 'fail' && (
                                    <input
                                      type="text"
                                      placeholder="What did you actually see? (feeds the Top Issues detail below)"
                                      defaultValue={recorded.note}
                                      onBlur={(e) => setGuidedCheckOutcomes((prev) => ({ ...prev, [check.id]: { outcome: 'fail', note: e.target.value } }))}
                                      style={{ flex: 1, minWidth: '220px', padding: '5px 8px', backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '6px', color: '#e2e8f0', fontSize: '0.74rem' }}
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      {/* Overview Card */}
                      <div style={{ backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '12px', border: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <p style={{ color: '#94a3b8', margin: '0 0 4px 0', fontSize: '0.875rem' }}>Audit Target</p>
                          <h3 style={{ margin: 0, fontSize: '1.25rem' }}>{scanResult.url}</h3>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <p style={{ color: '#94a3b8', margin: '0 0 4px 0', fontSize: '0.875rem' }}>Health Score</p>
                          <span style={{ fontSize: '2rem', fontWeight: 'bold', color: '#4ade80' }}>{scanResult.score}%</span>
                        </div>
                      </div>

                      {/* Volume triage note — "point me to the biggest leak" */}
                      {scanResult.report.volumeNote && (
                        <div style={{ backgroundColor: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '10px', padding: '14px' }}>
                          <div style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.82rem', marginBottom: '4px' }}>📍 Start Here</div>
                          <div style={{ color: '#f1f5f9', fontSize: '0.85rem' }}>{scanResult.report.volumeNote}</div>
                        </div>
                      )}

                      {/* Metrics Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '8px', border: '1px solid #334155' }}>
                          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Google Tag Manager</span>
                          <p style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '8px 0 0 0', color: scanResult.metrics.gtmDetected ? '#4ade80' : '#fbbf24' }}>{scanResult.metrics.gtmId}</p>
                        </div>
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '8px', border: '1px solid #334155' }}>
                          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>GA4 Measurement ID</span>
                          <p style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '8px 0 0 0', color: scanResult.metrics.ga4Active ? '#4ade80' : '#fbbf24' }}>{scanResult.metrics.ga4Id}</p>
                        </div>
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '8px', border: '1px solid #334155' }}>
                          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Meta Pixel</span>
                          <p style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '8px 0 0 0', color: scanResult.metrics.metaPixel ? '#4ade80' : '#fbbf24' }}>{scanResult.metrics.metaPixel ? 'Detected' : 'Not detected'}</p>
                        </div>
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '8px', border: '1px solid #334155' }}>
                          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>TikTok Pixel</span>
                          <p style={{ fontSize: '1.1rem', fontWeight: 'bold', margin: '8px 0 0 0', color: scanResult.metrics.tiktokPixel ? '#4ade80' : '#fbbf24' }}>{scanResult.metrics.tiktokPixel ? 'Detected' : 'Not detected'}</p>
                        </div>
                      </div>

                      {/* Live API Confirmation */}
                      {(liveGa4 || liveGtmMatch || liveDataError) && (
                        <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155' }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '4px' }}>Live API Confirmation</div>
                          <div style={{ color: '#94a3b8', fontSize: '0.72rem', marginBottom: '10px' }}>"Connected" is not the same claim as "correctly implemented" — reconciled against storefront evidence below.</div>
                          {liveDataError && <div style={{ color: '#fca5a5', fontSize: '0.8rem', marginBottom: '8px' }}>⚠ {liveDataError}</div>}
                          {liveGa4 && (
                            <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                              GA4 (last 30d): {liveGa4.sessions} sessions, {liveGa4.totalUsers} users, {liveGa4.conversions} conversions, ${liveGa4.purchaseRevenue.toLocaleString()} revenue
                            </div>
                          )}
                          {apiReconciliation.length > 0 && (
                            <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
                              {apiReconciliation.map((f, i) => (
                                <div key={i} style={{ fontSize: '0.78rem', color: f.tone === 'good' ? '#4ade80' : f.tone === 'bad' ? '#fca5a5' : '#fbbf24', lineHeight: 1.4 }}>
                                  {f.tone === 'good' ? '✓ ' : '⚠ '}{f.text}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Report-first section */}
                      <div style={{ backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '12px', border: '1px solid #334155' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                          <div>
                            <div style={{ color: '#94a3b8', fontSize: '0.78rem', letterSpacing: '1px' }}>REPORT FOCUS</div>
                            <h3 style={{ marginTop: '4px', fontSize: '1.2rem' }}>{scanResult.report.headline}</h3>
                          </div>
                          <span style={{ backgroundColor: '#0f172a', border: '1px solid #334155', padding: '6px 12px', borderRadius: '999px', color: '#f8fafc' }}>{scanResult.report.storeMode}</span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '1rem' }}>
                          <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                            <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Source Signals</div>
                            <div style={{ marginTop: '6px', color: '#e2e8f0', fontWeight: 700 }}>DL: {scanResult.report.signalSources.dataLayer}</div>
                            <div style={{ color: '#e2e8f0', fontWeight: 700 }}>Stape: {scanResult.report.signalSources.stape}</div>
                            <div style={{ color: '#e2e8f0', fontWeight: 700 }}>Purchase: {scanResult.report.signalSources.purchaseSignals}</div>
                            <div style={{ marginTop: '6px', color: scanResult.report.evidenceDepth === 'static+deep' ? '#4ade80' : '#fbbf24', fontSize: '0.72rem' }}>
                              Evidence: {scanResult.report.evidenceDepth === 'static+deep' ? 'static HTML + deep scan' : 'static HTML only — run "Inspect dataLayer" above, then re-audit for stronger evidence'}
                            </div>
                          </div>
                          <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                            <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Status</div>
                            <div style={{ marginTop: '6px', color: '#fbbf24' }}>{scanResult.report.status}</div>
                          </div>
                          <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                            <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Live Feed</div>
                            <div style={{ marginTop: '6px', color: '#22c55e' }}>Surface scan live • deeper API pull pending</div>
                          </div>
                        </div>

                        <div style={{ marginBottom: '1rem', color: '#cbd5e1' }}>{scanResult.report.summary}</div>

                        <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px', marginBottom: '12px' }}>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '8px' }}>Top 8 Business Metrics — call-ready</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
                            {scanResult.report.businessMetrics.map((metric: { label: string; value: string; explainer: string }, i: number) => (
                              <div key={i} style={{ backgroundColor: '#1e293b', borderRadius: '6px', padding: '8px 10px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                                  <span style={{ color: '#94a3b8' }}>{metric.label}</span>
                                  <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{metric.value}</span>
                                </div>
                                <div style={{ marginTop: '4px', color: '#64748b', fontSize: '0.7rem', lineHeight: 1.35 }}>{metric.explainer}</div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Top Issues{manualCheckResults.length > 0 ? ' (includes your guided-check results below)' : ''}</div>
                            <div style={{ fontSize: '0.68rem', color: '#64748b' }}>
                              {mergedTopIssues!.totalFound > 10
                                ? `Showing top 10 of ${mergedTopIssues!.totalFound} found`
                                : `${mergedTopIssues!.totalFound} found`}
                            </div>
                          </div>
                          {mergedTopIssues!.issues.length === 0 ? (
                            <div style={{ fontSize: '0.78rem', color: '#4ade80' }}>✔ No confirmed issues from the evidence gathered — proceed to the guided checks below to validate what a scan can't see.</div>
                          ) : (
                            <div style={{ display: 'grid', gap: '8px' }}>
                              {mergedTopIssues!.issues.map((issue: { id: string; severity: DiagnosticSeverity; category: string; title: string; detail: string; firstCheck: string; amount?: number }, i: number) => (
                                <div key={issue.id} style={{ fontSize: '0.76rem', borderLeft: `3px solid ${severityColor[issue.severity]}`, paddingLeft: '8px', paddingBottom: '6px', borderBottom: i < mergedTopIssues!.issues.length - 1 ? '1px solid #334155' : 'none' }}>
                                  <div>
                                    <span style={{ color: severityColor[issue.severity], fontWeight: 700 }}>#{i + 1} {severityLabel[issue.severity]}</span>
                                    {' — '}<strong>{issue.title}</strong>
                                    {issue.amount ? <span style={{ color: '#94a3b8' }}> ({formatCurrency(issue.amount, region)})</span> : null}
                                  </div>
                                  <div style={{ color: '#cbd5e1', marginTop: '3px' }}>{issue.detail}</div>
                                  <div style={{ color: '#38bdf8', marginTop: '3px' }}>First check: {issue.firstCheck}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Compact, always-visible here too — not hidden behind the Client Report tab */}
                      <details style={{ backgroundColor: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '0.75rem 1rem' }}>
                        <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: '#94a3b8' }}>Audit scope &amp; limitations ({scanResult.report.scopeNotes.length})</summary>
                        <ul style={{ paddingLeft: '18px', color: '#cbd5e1', lineHeight: 1.5, fontSize: '0.8rem', marginTop: '8px' }}>
                          {scanResult.report.scopeNotes.map((note: { category: string; statement: string }, i: number) => <li key={i}><strong>{note.category}:</strong> {note.statement}</li>)}
                        </ul>
                      </details>

                      {/* Recommendations */}
                      <div style={{ backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '12px', border: '1px solid #334155' }}>
                        <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem' }}>Audit Findings & Recommendations</h3>
                        <div style={{ display: 'grid', gap: '10px' }}>
                          {scanResult.recommendations.map((rec: { type: string; text: string }, idx: number) => (
                            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: '#0f172a', padding: '10px 14px', borderRadius: '8px', border: '1px solid #334155' }}>
                              {rec.type === 'success' && <span aria-hidden="true" style={{ color: '#4ade80', fontSize: '1rem' }}>✓</span>}
                              {rec.type === 'warning' && <span aria-hidden="true" style={{ color: '#facc15', fontSize: '1rem' }}>!</span>}
                              {rec.type === 'info' && <span aria-hidden="true" style={{ color: '#38bdf8', fontSize: '1rem' }}>⚡</span>}
                              <span style={{ fontSize: '0.95rem' }}>{rec.text}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Export */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          onClick={handleExportPdf}
                          disabled={isExportingPdf}
                          style={{ backgroundColor: '#b45309', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          {isExportingPdf ? 'Generating PDF...' : '📄 Export PDF Report'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ================= TAB 3: CLIENT REPORT ================= */}
              {activeTab === 'clientReport' && !isMinimized && scanResult && (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <div>
                    <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px' }}>Client-Ready Audit Report</h2>
                    <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Built from the confirmed Tab 2 inputs. Unverified implementation checks remain explicitly marked.</div>
                  </div>
                  <div style={{ backgroundColor: '#f8fafc', color: '#0f172a', padding: '2rem', borderRadius: '12px' }}>
                    <div style={{ borderBottom: '2px solid #e8792c', paddingBottom: '14px', marginBottom: '18px' }}>
                      <div style={{ color: '#b45309', fontWeight: 800, letterSpacing: '1px', fontSize: '0.8rem' }}>JSONALYTICS</div>
                      <h1 style={{ margin: '6px 0', fontSize: '1.6rem' }}>Store Measurement & Business Audit</h1>
                      <div style={{ color: '#475569', fontSize: '0.9rem' }}>{scanResult.url}</div>
                    </div>
                    <p style={{ lineHeight: 1.55, color: '#334155' }}>{scanResult.report.summary}</p>
                    <h3 style={{ marginTop: '22px' }}>Confirmed business metrics</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' }}>
                      {scanResult.report.businessMetrics.map((metric: { label: string; value: string; explainer: string }, i: number) => (
                        <div key={i} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '12px' }}>
                          <div style={{ color: '#64748b', fontSize: '0.75rem' }}>{metric.label}</div>
                          <div style={{ fontWeight: 700, marginTop: '4px' }}>{metric.value}</div>
                          <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '4px', lineHeight: 1.35 }}>{metric.explainer}</div>
                        </div>
                      ))}
                    </div>
                    <h3 style={{ marginTop: '22px' }}>Priority actions {mergedTopIssues!.totalFound > 10 ? `(top 10 of ${mergedTopIssues!.totalFound})` : ''}</h3>
                    {mergedTopIssues!.issues.length === 0 ? (
                      <p style={{ color: '#334155' }}>No confirmed issues from the evidence gathered for this audit.</p>
                    ) : (
                      <ol style={{ paddingLeft: '20px', color: '#334155', lineHeight: 1.55 }}>
                        {mergedTopIssues!.issues.map((issue: { id: string; title: string; detail: string; firstCheck: string }) => (
                          <li key={issue.id}><strong>{issue.title}:</strong> {issue.detail} <em>First check: {issue.firstCheck}</em></li>
                        ))}
                      </ol>
                    )}
                    <h3 style={{ marginTop: '22px' }}>Audit scope &amp; limitations</h3>
                    <ul style={{ paddingLeft: '20px', color: '#334155', lineHeight: 1.55, fontSize: '0.9rem' }}>
                      {scanResult.report.scopeNotes.map((note: { category: string; statement: string }, i: number) => <li key={i}><strong>{note.category}:</strong> {note.statement}</li>)}
                    </ul>
                    <div style={{ marginTop: '20px', padding: '12px', background: '#fff7ed', borderLeft: '4px solid #e8792c', color: '#7c2d12', fontSize: '0.85rem' }}>
                      Scope note: this report confirms supplied financial inputs and observable page signals ({scanResult.report.evidenceDepth === 'static+deep' ? 'static HTML plus read-only deep-scan network evidence' : 'static HTML only — deep scan not run for this audit'}). Checkout and event implementation items require the stated validation steps.
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={handleExportPdf} disabled={isExportingPdf} style={{ backgroundColor: '#b45309', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{isExportingPdf ? 'Generating PDF...' : 'Export Client PDF'}</button>
                  </div>
                </div>
              )}

              {/* ================= TAB 4: LEADS ================= */}
              {activeTab === 'leads' && !isMinimized && (
                <LeadRegister prefillUrl={surfaceUrl || storeUrl} region={region} />
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
