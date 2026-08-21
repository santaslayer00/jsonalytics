import React, { useEffect, useMemo, useState } from 'react';
import {
  runSurfaceAudit,
  runFullAudit,
  fetchLiveShopifyInputs,
  fetchGa4LiveReport,
  fetchGtmContainerMatch,
  fetchDeepScan,
  fetchShopifyProductCatalog,
  buildCatalogNote,
  fetchGa4Properties,
  buildReportHtml,
  buildValidationReportHtml,
  exportReportPdf,
} from './utils/auditLogic';
import type { AuditInputs, AuditDashboardResult, DeepScanResult, Ga4Property, ShopifyProductCatalog, SurfaceAuditResult } from './utils/auditLogic';
import { resolveEffectiveSignals, buildSurfaceCards, reconcileLiveApiEvidence } from './utils/auditLogic';
import { mergeManualFindings, partitionEdgeCases, diffTopIssues, attachRevenueImpact } from './utils/topIssues';
import type { ManualCheckResult, TopIssueCategory, TopIssue, TopIssuesResult } from './utils/topIssues';
import type { DiagnosticSeverity } from './utils/diagnosticEngine';
import { CSVUploader } from './components/stage2/CSVUploader';
import { LeadRegister } from './components/leads/LeadRegister';
import { getAdapterStateLabel } from './utils/sourceAdapters';
import { REGIONS } from './utils/constants';
import type { Region } from './utils/constants';
import { formatCurrency, isSameStoreUrl, detectRegionFromUrl } from './utils/formatters';

const severityColor: Record<DiagnosticSeverity, string> = {
  critical: '#e8792c',
  high: '#e8792c',
  medium: '#94a3b8',
  low: '#94a3b8',
  info: '#94a3b8',
};
const severityLabel: Record<DiagnosticSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'CLEAR',
};

// Whether the operator has actually confirmed everything CSV/live order
// data structurally cannot provide (COGS, shipping, ad spend, settlement
// days are never in an order export; new-customer/RTO counts only
// sometimes are). Scanning never requires this — see handleScan — but the
// PDF export does, since it's the deliverable that carries real $ numbers.
function isFinancialConfirmationComplete(
  csvInputs: AuditInputs,
  financialInputs: { cogs: string; shipping: string; adSpend: string; settlementDays: string; newCustomers: string; rtoOrders: string }
): boolean {
  const requiredFields = ['cogs', 'shipping', 'adSpend', 'settlementDays'] as const;
  if (requiredFields.some((field) => financialInputs[field] === '' || Number(financialInputs[field]) < 0)) return false;
  if (csvInputs.newCustomers === 0 && (financialInputs.newCustomers === '' || Number(financialInputs.newCustomers) < 0)) return false;
  // CSV/live Shopify order pulls can never determine RTO (return-to-origin)
  // from order data alone — csvInputs.rtoOrders is always 0 from those
  // sources, whether or not RTO is actually zero. A confirmed count is
  // required so the report never silently presents "RTO: 0%" as measured
  // when it was actually just never computed.
  if (csvInputs.rtoOrders === 0 && (financialInputs.rtoOrders === '' || Number(financialInputs.rtoOrders) < 0)) return false;
  return true;
}

// Locate+Point (light: what was found, what it proves, the one first check)
// vs Guide (heavy: every candidate cause paired with its own check) as two
// tabs, not one wall of text — used on both Stage 1's POINT TO FIRST panel
// and Stage 2's Top Issues list, so a finding reads the same way everywhere
// it appears. A module-level component (not defined inside App) because it
// owns its own tab state via useState.
interface FindingDetailData {
  observed?: string[];
  proves: string;
  doesNotProve?: string;
  firstCheck: string;
  requiresDeepScan?: boolean;
  possibleReasons?: Array<{ cause: string; howToCheck: string }>;
}
function FindingDetail({ finding, accentColor, hasDeepScan }: { finding: FindingDetailData; accentColor: string; hasDeepScan: boolean }) {
  // Locate+Point's job is what evidence exists AND what's still missing to
  // pull a stronger conclusion — requiresDeepScan is real data already on
  // every finding, this just surfaces it as an actual gap instead of a
  // one-line aside buried in the compact findings list elsewhere.
  const missingDeepScan = !!finding.requiresDeepScan && !hasDeepScan;
  const hasGuide = !!finding.possibleReasons?.length;
  const [tab, setTab] = useState<'locate' | 'guide'>('locate');
  const tabBtn = (key: 'locate' | 'guide'): React.CSSProperties => ({
    background: tab === key ? accentColor + '22' : 'transparent',
    color: tab === key ? accentColor : '#94a3b8',
    border: `1px solid ${tab === key ? accentColor : '#334155'}`,
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '0.72rem',
    fontWeight: 600,
    cursor: 'pointer',
  });
  return (
    <div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <button type="button" onClick={() => setTab('locate')} style={tabBtn('locate')}>Locate + Point</button>
        {hasGuide && (
          <button type="button" onClick={() => setTab('guide')} style={tabBtn('guide')}>Guide ({finding.possibleReasons!.length})</button>
        )}
      </div>
      {tab === 'locate' && (
        <div>
          {finding.observed && finding.observed.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '0.68rem', color: '#94a3b8', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>Observed</div>
              <div style={{ fontSize: '0.9rem', color: '#f8fafc', lineHeight: 1.6 }}>{finding.observed.join(' ')}</div>
            </div>
          )}
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '0.68rem', color: '#94a3b8', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>Proves</div>
            <div style={{ fontSize: '0.9rem', color: '#94a3b8', lineHeight: 1.6 }}>{finding.proves}</div>
          </div>
          {finding.doesNotProve && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '0.68rem', color: '#94a3b8', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>Does not prove</div>
              <div style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.6 }}>{finding.doesNotProve}</div>
            </div>
          )}
          {missingDeepScan && (
            <div style={{ marginBottom: '10px', backgroundColor: 'rgba(180,83,9,0.08)', border: '1px solid rgba(180,83,9,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
              <div style={{ fontSize: '0.68rem', color: '#b45309', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>Missing</div>
              <div style={{ fontSize: '0.88rem', color: '#f8fafc', lineHeight: 1.6 }}>Deep-scan network evidence (real requests, dataLayer, consent signals) — this conclusion is based on the page source alone.</div>
              <div style={{ fontSize: '0.82rem', color: '#b45309', marginTop: '6px' }}>Where to find it: run the Deep Scan (button above) — it doesn't need re-entering anything.</div>
            </div>
          )}
          <div style={{ backgroundColor: `${accentColor}11`, border: `1px solid ${accentColor}44`, borderRadius: '8px', padding: '12px 14px' }}>
            <div style={{ fontSize: '0.68rem', color: accentColor, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>First check</div>
            <div style={{ fontSize: '0.92rem', color: '#e8792c', lineHeight: 1.6, fontWeight: 500 }}>{finding.firstCheck}</div>
          </div>
        </div>
      )}
      {tab === 'guide' && hasGuide && (
        <div style={{ display: 'grid', gap: '12px' }}>
          {finding.possibleReasons!.map((r, i) => (
            <div key={i} style={{ fontSize: '0.9rem', color: '#94a3b8', lineHeight: 1.6, borderLeft: '3px solid #334155', paddingLeft: '14px' }}>
              <div style={{ color: '#f8fafc' }}>{i + 1}. {r.cause}</div>
              <div style={{ color: '#e8792c', marginTop: '4px' }}>{r.howToCheck}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One ranked issue row — used for both the "Top Issues" (confident, one
// cause) and "Edge Cases" (ambiguous, multiple candidate causes) sections,
// so an issue looks the same regardless of which bucket it landed in.
function IssueRow({ issue, index, isLast, region, hasDeepScan }: { issue: TopIssue; index: number; isLast: boolean; region: Region; hasDeepScan: boolean }) {
  return (
    <div style={{ fontSize: '0.8rem', borderLeft: `3px solid ${severityColor[issue.severity]}`, paddingLeft: '10px', paddingBottom: '10px', paddingTop: index > 0 ? '10px' : 0, borderBottom: isLast ? 'none' : '1px solid #334155' }}>
      <div>
        <span style={{ color: severityColor[issue.severity], fontWeight: 700 }}>#{index + 1} {severityLabel[issue.severity]}</span>
        {' — '}<strong>{issue.title}</strong>
        {issue.amount ? <span style={{ color: '#94a3b8' }}> ({formatCurrency(issue.amount, region)})</span> : null}
      </div>
      {issue.observed || issue.possibleReasons ? (
        <div style={{ marginTop: '8px' }}>
          <FindingDetail
            finding={{ observed: issue.observed, proves: issue.detail, doesNotProve: issue.doesNotProve, firstCheck: issue.firstCheck, requiresDeepScan: issue.requiresDeepScan, possibleReasons: issue.possibleReasons }}
            accentColor={severityColor[issue.severity]}
            hasDeepScan={hasDeepScan}
          />
        </div>
      ) : (
        <>
          <div style={{ color: '#94a3b8', marginTop: '3px' }}>{issue.detail}</div>
          <div style={{ color: '#e8792c', marginTop: '3px' }}>First check: {issue.firstCheck}</div>
        </>
      )}
    </div>
  );
}

// Client Report's two tabs render through this one component — "same to
// same" by construction, not by copy-pasting the JSX twice and hoping they
// stay in sync. `topIssues` is passed separately from `result.report.
// topIssues` because the "Full Audit" tab needs the guided-check-merged
// version (mergedTopIssues), which only ever applies to the original scan.
function ClientReportView({ result, topIssues, badge }: { result: AuditDashboardResult; topIssues: TopIssuesResult; badge: string }) {
  return (
    <div style={{ backgroundColor: '#0f172a', color: '#f8fafc', padding: '2rem', borderRadius: '12px' }}>
      <div style={{ borderBottom: '2px solid #e8792c', paddingBottom: '14px', marginBottom: '18px' }}>
        <div style={{ color: '#b45309', fontWeight: 800, letterSpacing: '1px', fontSize: '0.8rem' }}>JSONALYTICS™ · {badge}</div>
        <h1 style={{ margin: '6px 0', fontSize: '1.6rem' }}>Store Measurement &amp; Business Audit</h1>
        <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>{result.url}</div>
      </div>
      <h3 style={{ marginTop: '22px' }}>Confirmed business metrics</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' }}>
        {result.report.businessMetrics.map((metric: { label: string; value: string; explainer: string }, i: number) => (
          <div key={i} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '12px' }}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{metric.label}</div>
            <div style={{ fontWeight: 700, marginTop: '4px', color: '#f8fafc' }}>{metric.value}</div>
            <div style={{ color: '#94a3b8', fontSize: '0.7rem', marginTop: '4px', lineHeight: 1.35 }}>{metric.explainer}</div>
          </div>
        ))}
      </div>
      {result.report.clientReportedIssue && (
        <div style={{ marginTop: '18px', padding: '10px 12px', background: '#1e293b', borderLeft: '4px solid #e8792c', color: '#f8fafc', fontSize: '0.85rem' }}>
          Client reported: "{result.report.clientReportedIssue}" — not independently verified, shown as context for this audit.
        </div>
      )}
      <h3 style={{ marginTop: '22px' }}>Priority actions {topIssues.totalFound > 10 ? `(top 10 of ${topIssues.totalFound})` : ''}</h3>
      {/* Deliberately no "first check" / how-to-verify hint here — this is
          the pre-engagement Report, meant to explain what's wrong clearly
          enough to be credible, not hand over the fix steps for free. That
          depth belongs in Validation, after the client's actually paying.
          Split by partitionEdgeCases (same mechanism as Stage 2's own Top
          Issues/Edge Cases view) so the confidence gap is legible on the
          page itself — a "measured" finding (e.g. duplicate containers)
          reads very differently from a "low confidence, needs confirming"
          one (e.g. no-CMP-detected), and without a live call to explain
          that distinction, the document has to carry it on its own. */}
      {topIssues.issues.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>No confirmed issues from the evidence gathered for this audit.</p>
      ) : (() => {
        const { topIssues: confirmed, edgeCases: worthConfirming } = partitionEdgeCases(topIssues.issues);
        return (
          <>
            {confirmed.length > 0 && (
              <>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f8fafc', marginTop: '10px' }}>CONFIRMED</div>
                <ol style={{ paddingLeft: '20px', color: '#f8fafc', lineHeight: 1.55, marginTop: '4px' }}>
                  {confirmed.map((issue) => (
                    <li key={issue.id}><strong>{issue.title}:</strong> {issue.detail}</li>
                  ))}
                </ol>
              </>
            )}
            {worthConfirming.length > 0 && (
              <>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#b45309', marginTop: '14px' }}>WORTH CONFIRMING</div>
                <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>Evidence points here, but more than one real-world cause is possible from outside evidence alone.</div>
                <ol style={{ paddingLeft: '20px', color: '#f8fafc', lineHeight: 1.55, marginTop: '4px' }}>
                  {worthConfirming.map((issue) => (
                    <li key={issue.id}><strong>{issue.title}:</strong> {issue.detail}</li>
                  ))}
                </ol>
              </>
            )}
          </>
        );
      })()}
      <h3 style={{ marginTop: '22px' }}>Audit scope &amp; limitations</h3>
      <ul style={{ paddingLeft: '20px', color: '#f8fafc', lineHeight: 1.55, fontSize: '0.9rem' }}>
        {result.report.scopeNotes.map((note: { category: string; statement: string }, i: number) => <li key={i}><strong>{note.category}:</strong> {note.statement}</li>)}
      </ul>
      <div style={{ marginTop: '24px', textAlign: 'center', fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>Jason <span style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }}>(preferred name)</span></div>
      <div style={{ textAlign: 'center', fontSize: '1.15rem', fontWeight: 800, color: '#b45309', marginTop: '2px' }}>jagjit@jsonalytics.com</div>
      <div style={{ textAlign: 'center', fontSize: '1rem', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>WhatsApp: +91-8588006657</div>
      <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8', marginTop: '6px' }}>US account via Wise — universally accepted, easy international payment.</div>
      <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8', marginTop: '4px' }}>Ownership declaration available upon request.</div>
    </div>
  );
}

type TabKey = 'noAccess' | 'deepScan' | 'withAccess' | 'clientReport' | 'leads';

const toneColor: Record<string, string> = {
  good: '#f8fafc',
  warn: '#b45309',
  bad: '#e8792c',
};

// Plain-language labels for the raw internal signal states shown in the
// Report Focus card — operators shouldn't have to decode enum values like
// "not-validated" or "sandbox-blocked".
const signalSourceLabels: Record<string, Record<string, string>> = {
  dataLayer: { available: 'Detected', missing: 'Not detected', unknown: 'Not checked yet' },
  stape: { live: 'Possible server-side tracking', 'not-present': 'No server-side tracking seen', unknown: 'Not checked yet' },
  purchaseSignals: { observed: 'Purchase event seen', 'sandbox-blocked': 'Blocked during scan', 'not-validated': 'Not checked yet' },
};

const guidedChecks = [
  { id: 'purchase-firing', title: 'Validate purchase firing', where: 'GTM Preview / Tag Assistant', lookFor: 'One purchase event with value, currency, transaction_id, and items.', good: 'Exactly one purchase tag fires with the Shopify order ID.', href: 'https://tagassistant.google.com/' },
  { id: 'ga4-ecommerce', title: 'Validate GA4 ecommerce', where: 'GA4 DebugView', lookFor: 'purchase and add_to_cart events with ecommerce parameters.', good: 'Events appear once and revenue matches the test order.', href: 'https://support.google.com/analytics/answer/7201382' },
  { id: 'ad-platform-attribution', title: 'Validate ad-platform attribution', where: 'Meta Events Manager / platform diagnostics', lookFor: 'Browser and server events, matching event_id, and no duplicate purchase.', good: 'A single deduplicated purchase is received with no critical diagnostics.', href: 'https://www.facebook.com/events_manager2/' },
  { id: 'revenue-reconciliation', title: 'Reconcile store revenue', where: 'Shopify Orders export', lookFor: 'The same date range, refunds, COD orders, and fulfillment statuses.', good: 'Shopify order totals provide the confirmed source for the report.', href: 'https://admin.shopify.com/' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('noAccess');
  const [region, setRegion] = useState<Region>('US');

  // ---- Tab 1: No Access ----
  // Shares `storeUrl` (declared below, under Tab 2) with Deep Scan and With
  // Access on purpose — one store, entered once, regardless of which tab's
  // scan logic and results (kept fully separate) you run against it.
  const [isSurfaceScanning, setIsSurfaceScanning] = useState(false);
  const [surfaceResult, setSurfaceResult] = useState<SurfaceAuditResult | null>(null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);

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
  // Client Report's second tab: a fresh scan run on demand (never
  // auto-triggered) to check whether a fix actually landed. Kept fully
  // separate from scanResult so re-running it can never clobber the
  // original "what's broken" evidence being compared against.
  const [clientReportView, setClientReportView] = useState<'audit' | 'validation'>('audit');
  const [validationResult, setValidationResult] = useState<AuditDashboardResult | null>(null);
  const [isRunningValidation, setIsRunningValidation] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Manually typed only, by explicit request ("i can input these myself, no
  // need to automate") — a paying client gets real technical depth on what
  // was actually done for each resolved issue, which isn't something to
  // guess or auto-generate from the diagnostic text. Keyed by finding id,
  // survives across re-validation runs on the same audit cycle.
  const [techStepNotes, setTechStepNotes] = useState<Record<string, string>>({});
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
  // Defaults to the last 60 days, not unbounded "all time" — two reasons:
  // diagnosing a client's current issue needs a representative recent
  // window, not the store's entire history; and 60 days is also the actual
  // hard ceiling of the read_orders scope this app requests (extended order
  // history needs a Shopify Protected Customer Data review, not something
  // this app can just request). Defaulting to 90 would have silently
  // returned less than asked for. Visible and adjustable in the date
  // inputs, never a silent default.
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [productCatalog, setProductCatalog] = useState<ShopifyProductCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [ga4Properties, setGa4Properties] = useState<Ga4Property[]>([]);
  const [isLoadingGa4Properties, setIsLoadingGa4Properties] = useState(false);
  const [ga4PropertiesError, setGa4PropertiesError] = useState<string | null>(null);
  const [hasFetchedGa4Properties, setHasFetchedGa4Properties] = useState(false);
  // What the operator typed in from the client — never treated as a
  // verified finding, only shown as context and used to break ties within
  // the same severity tier in the ranked issues list (see buildTopIssues).
  const [clientReportedIssue, setClientReportedIssue] = useState('');
  const [clientReportedCategory, setClientReportedCategory] = useState<TopIssueCategory | null>(null);

  const refreshAccessStatus = async () => {
    try {
      const response = await fetch('/api/status');
      if (response.ok) setAccessStatus(await response.json());
    } catch { /* Backend may not be running yet; UI presents disconnected state. */ }
  };
  useEffect(() => { void refreshAccessStatus(); }, []);

  // Product-catalog volume, for "don't audit product-by-product" guidance —
  // just 3 count requests regardless of catalog size, so it's safe to fetch
  // automatically the moment Shopify is actually connected, no explicit
  // pull button needed the way the (potentially large, date-ranged) order
  // pull has one.
  useEffect(() => {
    if (!accessStatus.shopify.configured || productCatalog || isLoadingCatalog) return;
    setIsLoadingCatalog(true);
    setCatalogError(null);
    fetchShopifyProductCatalog()
      .then(setProductCatalog)
      .catch((err: any) => setCatalogError(err.message || 'Could not fetch product catalog count.'))
      .finally(() => setIsLoadingCatalog(false));
  }, [accessStatus.shopify.configured, productCatalog, isLoadingCatalog]);

  // Auto-list every GA4 property the connected Google account can see —
  // lets the operator pick from a dropdown instead of needing to already
  // know a numeric property ID. Only covers properties already shared with
  // this account (see fetchGa4Properties/server route comment).
  useEffect(() => {
    if (!accessStatus.ga4.connected || hasFetchedGa4Properties || isLoadingGa4Properties) return;
    setIsLoadingGa4Properties(true);
    setGa4PropertiesError(null);
    fetchGa4Properties()
      .then(setGa4Properties)
      .catch((err: any) => setGa4PropertiesError(err.message || 'Could not list GA4 properties.'))
      .finally(() => {
        setIsLoadingGa4Properties(false);
        setHasFetchedGa4Properties(true);
      });
  }, [accessStatus.ga4.connected, hasFetchedGa4Properties, isLoadingGa4Properties]);

  // Auto-detect region from a store's TLD as the operator types the URL —
  // only overrides when there's a real signal (detectRegionFromUrl returns
  // null for .myshopify.com/.com domains with no country code), so it never
  // clobbers a manual pick with a fake "detected" default.
  const applyUrlAndDetectRegion = (url: string, setUrl: (value: string) => void) => {
    setUrl(url);
    const detected = detectRegionFromUrl(url);
    if (detected) setRegion(detected);
  };

  // The "Reconcile store revenue" guided check is the one link that CAN be
  // store-specific (we already know storeUrl at this point) — the other 3
  // are generic external tools (Tag Assistant, a GA4 help doc, Meta Events
  // Manager) that have no per-store deep link, so they stay static.
  const resolveCheckHref = (check: { id: string; href: string }) => {
    if (check.id !== 'revenue-reconciliation' || !storeUrl.trim()) return check.href;
    const bareDomain = storeUrl.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `https://${bareDomain}/admin/orders`;
  };

  // ===== Tab 1 handlers =====

  // Stage 1 is a URL/page scan only — static HTML, no deep scan (that lives
  // in Stage 2 now, where it feeds the real diagnostic engine). The 8
  // business-metric cards below are a possibility claim from this static
  // evidence alone.
  const handleSurfaceScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storeUrl) return;
    setIsSurfaceScanning(true);
    setSurfaceResult(null);
    setSurfaceError(null);
    try {
      const result = await runSurfaceAudit(storeUrl, region);
      setSurfaceResult(result);
      if (result.status === 'error') setSurfaceError(result.error || 'Scan failed.');
      // Kick off the Deep Scan tab's full diagnostic in the background too
      // — not awaited, so this button's own "Scanning..." state reflects
      // just the surface half; the Deep Scan tab tracks its own progress
      // via isScanning and just has results waiting once it finishes.
      else void runDeepDiagnostic();
    } catch (err: any) {
      setSurfaceError(err.message || 'Scan failed unexpectedly.');
    } finally {
      setIsSurfaceScanning(false);
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
  const validAuditDeepScan = useMemo(
    () => (auditDeepScan && isSameStoreUrl(auditDeepScan.url, storeUrl) ? auditDeepScan : null),
    [auditDeepScan, storeUrl]
  );
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

  // Locate+Point/Guide (AUDIT -> LOCATE -> POINT -> GUIDE) lives only in the
  // Full Audit tab now — Stage 1 is the region-blind, screenshot-friendly
  // ice-breaker and no longer renders diagnostic detail at all.

  // Blends in the same-URL deep scan once it resolves (it's kicked off
  // automatically by handleSurfaceScan) so Stage 1's headline numbers don't
  // sit on a false "signal missing" verdict for stores that track fine via
  // client-side JS static HTML can't see — real false negative confirmed
  // live against gymshark.com. Stage 1's layout stays exactly as simple as
  // before (no added Locate+Point+Guide detail); only the evidence feeding
  // the existing cards changes. Reused by handleContinueToFullAudit below —
  // the detected GTM/GA4 ID is exactly the "logic applied" allowed to carry
  // forward to stage 2, where a real deep scan can confirm or correct it.
  const effectiveSurfaceSignals = useMemo(() => {
    if (!surfaceResult || surfaceResult.status !== 'ok') return null;
    return resolveEffectiveSignals(surfaceResult, validAuditDeepScan);
  }, [surfaceResult, validAuditDeepScan]);
  const enrichedCards = useMemo(() => {
    if (!surfaceResult || surfaceResult.status !== 'ok' || !effectiveSurfaceSignals) return [];
    return buildSurfaceCards(effectiveSurfaceSignals, surfaceResult.hasCmp, surfaceResult.cmpName, region);
  }, [surfaceResult, effectiveSurfaceSignals, region]);

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
    const withManual = mergeManualFindings(scanResult.report.topIssues, manualCheckResults);
    // Real dollar impact, not an estimate — only attaches once live GA4
    // revenue has actually been pulled (a separate, explicit action), so a
    // pre-sale Report/PDF exported before that never carries a fabricated
    // figure. See attachRevenueImpact's own comment for the full reasoning.
    if (!liveGa4 || !(liveGa4.purchaseRevenue > 0) || !(scanResult.metrics.grossRevenue > 0)) return withManual;
    return attachRevenueImpact(withManual, liveGa4.purchaseRevenue, scanResult.metrics.grossRevenue, region);
  }, [scanResult, manualCheckResults, liveGa4, region]);

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
    await runDeepDiagnostic();
  };

  // Shared by the Deep Scan tab's button AND the No Access tab's surface
  // scan — one URL submission now runs both, so the Deep Scan tab just
  // displays whatever's already there instead of needing its own manual
  // trigger. The button stays too, purely as a manual re-run.
  const runDeepDiagnostic = async () => {
    if (!storeUrl) return;

    // CSV/live order data — and its financial confirmation fields — are
    // fully optional at scan time now. The audit's tracking diagnostics
    // (GTM/GA4/pixel evidence, dataLayer, consent, Locate+Point+Guide) stand
    // on their own regardless. Confirmation is only enforced at PDF export
    // time (see handleExportPdf / isFinancialConfirmationComplete below),
    // where real financial numbers are actually needed — scanning never
    // blocks on it, it just determines whether this run's businessMetrics
    // come out real or honestly "Unaccessed."
    let auditInputs: AuditInputs | null = null;
    if (csvInputs && isFinancialConfirmationComplete(csvInputs, financialInputs)) {
      auditInputs = {
        ...csvInputs,
        cogs: Number(financialInputs.cogs),
        shipping: Number(financialInputs.shipping),
        adSpend: Number(financialInputs.adSpend),
        settlementDays: Number(financialInputs.settlementDays),
        newCustomers: csvInputs.newCustomers || Number(financialInputs.newCustomers),
        rtoOrders: csvInputs.rtoOrders || Number(financialInputs.rtoOrders),
      };
    }
    // gtmIdInput/ga4IdInput are an OPTIONAL manual cross-check (did the
    // evidence match what you already knew the ID should be), never a
    // prerequisite — runFullAudit already treats a blank one as null and
    // the diagnostic engine discovers real IDs from evidence on its own.
    // Previously hard-blocked the scan without one typed in first, which
    // was actively wrong: it's the exact live "scan a store you know
    // nothing about yet" case this tab needs to support.
    setIsScanning(true);
    setScanResult(null);
    setScanError(null);
    setLiveGa4(null);
    setLiveGtmMatch(null);
    setLiveDataError(null);
    setGuidedCheckOutcomes({}); // a new audit needs its own fresh manual verification
    // A fresh audit invalidates any prior validation — it was diffed
    // against the report this run is about to replace, so keeping it
    // around would compare "fixed" against the wrong baseline.
    setValidationResult(null);
    setValidationError(null);
    setClientReportView('audit');

    // Auto-run the deep scan alongside the audit if it hasn't already been
    // run for this exact URL (e.g. via a manual "Inspect dataLayer" click) —
    // same read-only guarantee either way, no reason to make it a separate
    // step the operator has to remember before every audit.
    let deepEvidence = validAuditDeepScan;
    if (!deepEvidence) {
      setIsAuditDeepScanning(true);
      setAuditDeepScanError(null);
      try {
        deepEvidence = await fetchDeepScan(storeUrl);
        setAuditDeepScan(deepEvidence);
      } catch (err: any) {
        setAuditDeepScanError(err.message || 'Deep scan failed.');
        deepEvidence = null; // fall back to static-only evidence rather than blocking the audit entirely
      } finally {
        setIsAuditDeepScanning(false);
      }
    }

    try {
      const result = await runFullAudit(
        storeUrl,
        auditInputs,
        gtmIdInput.trim() || null,
        ga4IdInput.trim() || null,
        region,
        deepEvidence,
        clientReportedIssue.trim() || null,
        clientReportedCategory
      );
      setScanResult(result);
      if (result.status === 'error') {
        setScanError(result.report.summary);
      }

      // Both live-API reconciliation calls are the "with real access keys"
      // half — bifurcated from the deep-scan diagnostic above on purpose.
      // The diagnostic result is already set and complete by this point;
      // these are independent, best-effort enrichments that only apply
      // when the operator's own Shopify/GTM/GA4 account is actually
      // connected. Previously fetchGtmContainerMatch fired unconditionally
      // on every scan (even with nothing connected), producing a confusing
      // liveDataError on an otherwise fully successful access-free deep
      // scan — gated the same way the GA4 call already was.
      if (ga4PropertyIdInput.trim()) {
        fetchGa4LiveReport(ga4PropertyIdInput.trim(), startDate || '30daysAgo', endDate || 'today')
          .then(setLiveGa4)
          .catch((err: any) => setLiveDataError(err.message || 'GA4 live report failed.'));
      }
      if (accessStatus.gtm.connected) {
        fetchGtmContainerMatch(
          gtmIdInput.trim() || (result.metrics.gtmId !== 'Not found' ? result.metrics.gtmId : null)
        )
          .then(setLiveGtmMatch)
          .catch((err: any) => setLiveDataError(err.message || 'GTM container check failed.'));
      }
    } catch (err: any) {
      setScanError(err.message || 'Scan failed unexpectedly.');
    } finally {
      setIsScanning(false);
    }
  };

  // Re-runs the audit against the same store/credentials to check whether
  // a fix actually landed — always a fresh deep scan (never the cached
  // pre-fix evidence, the whole point is capturing current state), and
  // deliberately skips the GA4-live-report/GTM-container-match side
  // fetches handleScan does — those are supplementary reconciliation, not
  // core to "did the tracking gap close," and keeping this lean matters
  // more here since it's meant to be run repeatedly, once per fix attempt.
  const handleRunValidation = async () => {
    if (!storeUrl) return;
    setIsRunningValidation(true);
    setValidationError(null);
    try {
      const validationInputs: AuditInputs | null =
        csvInputs && isFinancialConfirmationComplete(csvInputs, financialInputs)
          ? {
              ...csvInputs,
              cogs: Number(financialInputs.cogs),
              shipping: Number(financialInputs.shipping),
              adSpend: Number(financialInputs.adSpend),
              settlementDays: Number(financialInputs.settlementDays),
              newCustomers: csvInputs.newCustomers || Number(financialInputs.newCustomers),
              rtoOrders: csvInputs.rtoOrders || Number(financialInputs.rtoOrders),
            }
          : null;
      const deepEvidence = await fetchDeepScan(storeUrl).catch(() => null);
      const result = await runFullAudit(
        storeUrl,
        validationInputs,
        gtmIdInput.trim() || null,
        ga4IdInput.trim() || null,
        region,
        deepEvidence,
        null,
        null
      );
      setValidationResult(result);
      if (result.status === 'error') setValidationError(result.report.summary);
    } catch (err: any) {
      setValidationError(err.message || 'Validation scan failed unexpectedly.');
    } finally {
      setIsRunningValidation(false);
    }
  };

  // Shared by both Client Report tabs — `target`/`topIssuesOverride` let
  // Validation export its own fresh result instead of always exporting
  // scanResult. Errors go to the tab-appropriate setter so the message
  // shows up next to the button that was actually clicked.
  const handleExportPdf = async (
    target: AuditDashboardResult = scanResult,
    topIssuesOverride?: TopIssuesResult,
    setErr: (msg: string) => void = setScanError
  ) => {
    if (!target) return;
    // CSV/live order data — and its financial confirmation fields — are
    // optional to run the audit itself (tracking diagnostics stand on their
    // own), but the PDF is the result-driven client deliverable — it has to
    // carry real financial numbers, not the "Unaccessed" placeholders a
    // tracking-only audit produces. This is the one place that mandate is
    // actually enforced now (moved here from scan time).
    if (!csvInputs) {
      setErr('Load Shopify order data (CSV upload or live pull) before exporting the PDF — the report needs real financial numbers, not the tracking-only view.');
      return;
    }
    const requiredFinancialFields = ['cogs', 'shipping', 'adSpend', 'settlementDays'] as const;
    if (requiredFinancialFields.some((field) => financialInputs[field] === '' || Number(financialInputs[field]) < 0)) {
      setErr('Enter confirmed COGS, shipping, ad spend, and settlement days before exporting the PDF.');
      return;
    }
    if (csvInputs.newCustomers === 0 && (financialInputs.newCustomers === '' || Number(financialInputs.newCustomers) < 0)) {
      setErr('New-customer data was not available in the order source. Enter the confirmed count before exporting the PDF.');
      return;
    }
    // CSV/live Shopify order pulls can never determine RTO (return-to-origin)
    // from order data alone — csvInputs.rtoOrders is always 0 from those
    // sources, whether or not RTO is actually zero. Require a confirmed
    // count so the exported report never silently presents "RTO: 0%" as
    // measured when it was actually just never computed.
    if (csvInputs.rtoOrders === 0 && (financialInputs.rtoOrders === '' || Number(financialInputs.rtoOrders) < 0)) {
      setErr('RTO (return-to-origin) order count was not available in the order source. Enter the confirmed count (0 if genuinely none) before exporting the PDF.');
      return;
    }
    // The confirmed numbers above are only real in the PDF if the audit on
    // screen was actually run with them — catches "filled in the fields
    // after already scanning tracking-only" without silently re-scanning
    // behind the operator's back (which could also pick up live store
    // changes since the last review, a worse surprise than one extra click).
    if (target.report.businessMetrics.some((m: { value: string }) => m.value.includes('Unaccessed'))) {
      setErr('Numbers are confirmed but this audit run predates them — re-run the scan to include them, then export.');
      return;
    }
    setIsExportingPdf(true);
    try {
      // The PDF must reflect the same manually-verified findings shown on
      // screen, not just automated evidence — otherwise "finishing in one
      // sitting" would still leave the exported report out of date.
      const issuesForExport = topIssuesOverride || target.report.topIssues;
      const reportForExport = { ...target, report: { ...target.report, topIssues: issuesForExport } };
      const html = buildReportHtml(reportForExport, region);
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

  // Separate from handleExportPdf on purpose — Validation's export is a
  // diff (resolved/still-open/new + the operator's own typed technical
  // notes), not a flat findings list, so it needs buildValidationReportHtml,
  // not buildReportHtml with different data spliced in. No financial-data
  // gating here — this export doesn't carry the Financial Calculator at
  // all, so there's nothing to guard.
  const handleExportValidationPdf = async () => {
    if (!validationResult || validationResult.status !== 'ok' || !mergedTopIssues) return;
    setIsExportingPdf(true);
    try {
      const diff = diffTopIssues(mergedTopIssues, validationResult.report.topIssues);
      const html = buildValidationReportHtml(validationResult, diff, techStepNotes);
      const blob = await exportReportPdf(html);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jsonalytics-validation-report.pdf';
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

  // Shared between the Deep Scan tab (access-free) and the With Access tab
  // (where it renders at the top, per explicit request — the diagnostic
  // stays visible even while working the store-specific/financial half
  // below it). Defined once so the two tabs can never drift apart the way
  // Report/Validation would have without ClientReportView.
  // Consistent section-label style reused across every block below, so the
  // page reads as one system instead of each section inventing its own
  // heading treatment (the inconsistency — some sections labeled, some
  // not, some styled differently — was a real source of visual clutter,
  // not just an aesthetic nitpick).
  const sectionLabelStyle: React.CSSProperties = { color: '#94a3b8', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '10px' };

  // "Pay less emphasis on what's correct, notify what's wrong hard" —
  // explicit user direction (2026-08-19). A tile whose signal is present
  // stays small and quiet (muted gray, thin border, no visual competition
  // with actual problems); a missing/wrong one gets the orange accent,
  // bold weight, and a highlighted border so it's the thing the eye lands
  // on first. Same tile shape reused for every signal instead of 5+
  // separate ad-hoc renderings drifting from each other over time.
  const signalTile = (label: string, ok: boolean, value: string) => (
    <div
      key={label}
      style={
        ok
          ? { backgroundColor: '#0f172a', padding: '5px 8px', borderRadius: '6px', border: '1px solid #334155' }
          : { backgroundColor: 'rgba(232,121,44,0.1)', padding: '7px 9px', borderRadius: '6px', border: '1px solid #e8792c' }
      }
    >
      <span style={{ color: ok ? '#64748b' : '#e8792c', fontSize: ok ? '0.6rem' : '0.64rem', fontWeight: ok ? 500 : 700 }}>{label}</span>
      <p style={{ fontSize: ok ? '0.74rem' : '0.82rem', fontWeight: ok ? 500 : 800, margin: '3px 0 0 0', color: ok ? '#94a3b8' : '#e8792c' }}>{value}</p>
    </div>
  );

  const renderDiagnosticResults = () => {
    if (!scanResult || scanResult.status === 'error') return null;
    const cs = scanResult.contactSignals;
    const hasContactSignals = cs && (cs.socialLinks.length > 0 || cs.contactEmail || cs.aboutOrContactPageUrl);
    const otherPlatforms: string[] = [];
    if (scanResult.metrics.hasPinterestTag) otherPlatforms.push(`Pinterest${scanResult.metrics.pinterestTagId ? ` (${scanResult.metrics.pinterestTagId})` : ''}`);
    if (scanResult.metrics.hasSnapchatPixel) otherPlatforms.push(`Snapchat${scanResult.metrics.snapchatPixelId ? ` (${scanResult.metrics.snapchatPixelId})` : ''}`);
    if (scanResult.metrics.hasMicrosoftUet) otherPlatforms.push('Microsoft UET');
    return (
      <div style={{ display: 'grid', gap: '1rem' }}>
        {/* At a Glance — target/score + tracking signatures merged into one
            panel (was 5 separate bordered boxes: an Overview Card plus 4
            individual metric cards — consolidated to cut box-count clutter
            for what's meant to be a quick summary, not a wall of tiles). */}
        <div style={{ backgroundColor: '#1e293b', padding: '0.9rem 1rem', borderRadius: '10px', border: '1px solid #334155' }}>
          <div style={sectionLabelStyle}>At a Glance</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{scanResult.url}</h3>
            <div style={{ textAlign: 'right' }}>
              <p style={{ color: '#94a3b8', margin: '0 0 2px 0', fontSize: '0.66rem' }}>Health Score</p>
              <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#f8fafc' }}>{scanResult.score}%</span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '6px' }}>
            {signalTile('Google Tag Manager', scanResult.metrics.gtmDetected, scanResult.metrics.gtmId)}
            {signalTile('GA4 Measurement ID', scanResult.metrics.ga4Active, scanResult.metrics.ga4Id)}
            {signalTile('Meta Pixel', scanResult.metrics.metaPixel, scanResult.metrics.metaPixel ? (scanResult.metrics.metaPixelId || 'Detected') : 'Not detected')}
            {signalTile('TikTok Pixel', scanResult.metrics.tiktokPixel, scanResult.metrics.tiktokPixel ? (scanResult.metrics.tiktokPixelId || 'Detected') : 'Not detected')}
            {signalTile('Consent Tool (CMP)', scanResult.metrics.cmpDetected, scanResult.metrics.cmpDetected ? scanResult.metrics.cmpName : 'Not detected')}
          </div>
          {otherPlatforms.length > 0 && (
            <div style={{ marginTop: '8px', color: '#64748b', fontSize: '0.68rem' }}>Also detected: {otherPlatforms.join(', ')}</div>
          )}
          {hasContactSignals && (
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #334155', fontSize: '0.7rem' }}>
              {cs!.socialLinks.map((s: { platform: string; url: string }, i: number) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ color: '#94a3b8' }}>{s.platform}</a>
              ))}
              {cs!.contactEmail && <a href={`mailto:${cs!.contactEmail}`} style={{ color: '#94a3b8' }}>{cs!.contactEmail}</a>}
            </div>
          )}
        </div>

        {/* Volume triage note — "point me to the biggest leak" */}
        {scanResult.report.volumeNote && (
          <div style={{ backgroundColor: 'rgba(180,83,9,0.08)', border: '1px solid rgba(180,83,9,0.3)', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ color: '#b45309', fontWeight: 700, fontSize: '0.74rem', marginBottom: '3px' }}>Start Here</div>
            <div style={{ color: '#f8fafc', fontSize: '0.78rem' }}>{scanResult.report.volumeNote}</div>
          </div>
        )}

        {/* Priority Findings — the dominant section, deliberately the
            largest/most spacious on the page; everything above it is quick
            context, everything below it is secondary. */}
        <div style={{ backgroundColor: '#1e293b', padding: '1.5rem', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <div style={sectionLabelStyle}>Priority Findings</div>
              <h3 style={{ margin: 0, fontSize: '1.2rem' }}>{scanResult.report.headline}</h3>
            </div>
            <span style={{ backgroundColor: '#0f172a', border: '1px solid #334155', padding: '6px 12px', borderRadius: '999px', color: '#f8fafc', fontSize: '0.8rem' }}>{scanResult.report.storeMode}</span>
          </div>

          <details style={{ marginBottom: '1rem' }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Evidence sources</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '8px' }}>
              <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Source Signals</div>
                <div style={{ marginTop: '6px', color: '#f8fafc', fontWeight: 700 }}>dataLayer: {signalSourceLabels.dataLayer[scanResult.report.signalSources.dataLayer] || scanResult.report.signalSources.dataLayer}</div>
                <div style={{ color: '#f8fafc', fontWeight: 700 }}>Server-side: {signalSourceLabels.stape[scanResult.report.signalSources.stape] || scanResult.report.signalSources.stape}</div>
                <div style={{ color: '#f8fafc', fontWeight: 700 }}>Purchase: {signalSourceLabels.purchaseSignals[scanResult.report.signalSources.purchaseSignals] || scanResult.report.signalSources.purchaseSignals}</div>
                <div style={{ marginTop: '6px', color: scanResult.report.evidenceDepth === 'static+deep' ? '#f8fafc' : '#b45309', fontSize: '0.72rem' }}>
                  Evidence: {scanResult.report.evidenceDepth === 'static+deep' ? 'page scan + deep scan' : 'page scan only — deep scan failed, see error above'}
                </div>
              </div>
              <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Status</div>
                <div style={{ marginTop: '6px', color: '#b45309' }}>{scanResult.report.status}</div>
              </div>
            </div>
          </details>

          <div style={{ backgroundColor: '#0f172a', borderRadius: '8px', border: '1px solid #334155', padding: '12px' }}>
            {scanResult.report.clientReportedIssue && (
              <div style={{ backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '6px', padding: '8px 10px', marginBottom: '10px', fontSize: '0.76rem', color: '#f8fafc' }}>
                <strong>Client reported:</strong> "{scanResult.report.clientReportedIssue}"{scanResult.report.clientReportedCategory ? ` — ranked toward ${scanResult.report.clientReportedCategory} findings below` : ''}. Not independently verified — context only.
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Top Issues{manualCheckResults.length > 0 ? ' (includes your guided-check results below)' : ''}</div>
              <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                {mergedTopIssues!.totalFound > 10
                  ? `Showing top 10 of ${mergedTopIssues!.totalFound} found`
                  : `${mergedTopIssues!.totalFound} found`}
              </div>
            </div>
            {mergedTopIssues!.issues.length === 0 ? (
              <div style={{ fontSize: '0.78rem', color: '#f8fafc' }}>No confirmed issues from the evidence gathered — proceed to the guided checks below to validate what a scan can't see.</div>
            ) : (() => {
              const { topIssues: confidentIssues, edgeCases } = partitionEdgeCases(mergedTopIssues!.issues);
              return (
                <>
                  {confidentIssues.length > 0 && (
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {confidentIssues.map((issue, i) => (
                        <IssueRow key={issue.id} issue={issue} index={i} isLast={i === confidentIssues.length - 1} region={region} hasDeepScan={!!validAuditDeepScan} />
                      ))}
                    </div>
                  )}
                  {edgeCases.length > 0 && (
                    <div style={{ marginTop: confidentIssues.length > 0 ? '16px' : 0 }}>
                      <div style={{ backgroundColor: 'rgba(180,83,9,0.08)', border: '1px solid rgba(180,83,9,0.3)', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px', fontSize: '0.76rem', color: '#b45309' }}>
                        {edgeCases.length} edge case{edgeCases.length === 1 ? '' : 's'} found — {edgeCases.length === 1 ? 'this has' : 'these have'} more than one possible cause this scan can't narrow down on its own. Check the Guide tab on each.
                      </div>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {edgeCases.map((issue, i) => (
                          <IssueRow key={issue.id} issue={issue} index={confidentIssues.length + i} isLast={i === edgeCases.length - 1} region={region} hasDeepScan={!!validAuditDeepScan} />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Secondary/supplementary — kept visually lighter and collapsed by
            default so they don't compete with Priority Findings above. */}
        <details style={{ backgroundColor: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '0.75rem 1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Audit scope &amp; limitations ({scanResult.report.scopeNotes.length})</summary>
          <ul style={{ paddingLeft: '18px', color: '#94a3b8', lineHeight: 1.5, fontSize: '0.8rem', marginTop: '10px' }}>
            {scanResult.report.scopeNotes.map((note: { category: string; statement: string }, i: number) => <li key={i}><strong>{note.category}:</strong> {note.statement}</li>)}
          </ul>
        </details>

        <details style={{ backgroundColor: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '0.75rem 1rem' }} open={scanResult.recommendations.length > 0}>
          <summary style={{ cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Recommendations ({scanResult.recommendations.length})</summary>
          <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
            {scanResult.recommendations.map((rec: { type: string; text: string }, idx: number) => {
              // type was captured but never actually affected rendering —
              // every recommendation looked identical regardless of
              // severity. Warnings now get the loud/orange treatment,
              // success stays quiet/muted, matching the same "correct
              // stays quiet, wrong gets loud" rule applied everywhere else.
              const isWarning = rec.type === 'warning';
              const isSuccess = rec.type === 'success';
              return (
                <div
                  key={idx}
                  style={
                    isWarning
                      ? { backgroundColor: 'rgba(232,121,44,0.1)', padding: '10px 13px', borderRadius: '8px', border: '1px solid #e8792c' }
                      : { backgroundColor: '#0f172a', padding: '9px 12px', borderRadius: '8px', border: '1px solid #334155' }
                  }
                >
                  <span style={{ fontSize: isWarning ? '0.87rem' : '0.85rem', fontWeight: isWarning ? 700 : 400, color: isWarning ? '#e8792c' : isSuccess ? '#64748b' : '#f8fafc' }}>{rec.text}</span>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  };

  return (
    <div className="app-shell" style={{ minHeight: '100vh', color: '#f8fafc', fontFamily: 'sans-serif', padding: '2rem' }}>
      <div className="app-frame" style={{ maxWidth: '1180px', margin: '0 auto' }}>

        {/* Header */}
        <header className="topbar" style={{ display: 'flex', alignItems: 'center', justifyContent: (activeTab === 'withAccess' || activeTab === 'deepScan') ? 'space-between' : 'center', marginBottom: '2rem', borderBottom: '1px solid #334155', paddingBottom: '1.25rem' }}>
          <div className="brand-lockup" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <svg width="56" height="56" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
              <rect x="1" y="1" width="42" height="42" rx="10" fill="#1e293b" stroke="#334155" />
              <path d="M14 17 L14 15 A8 6 0 0 1 30 15 L30 17" fill="none" stroke="#e8792c" strokeWidth="2" strokeLinecap="round" />
              <rect x="11" y="17" width="22" height="17" rx="3" fill="none" stroke="#e8792c" strokeWidth="2" />
              <circle cx="30" cy="30" r="7" fill="#e8792c" />
              <path d="M27 30 L29.3 32.3 L33 27.5" fill="none" stroke="#1e293b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '2.3rem', fontWeight: 800, letterSpacing: '2px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#f8fafc' }}>JSON</span><span style={{ color: '#e8792c' }}>alytics</span>
              </div>
              <div style={{ color: '#94a3b8', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Stop guessing, start growing.</div>
            </div>
          </div>
          {/* Region matters on both Deep Scan (privacy-law naming, COD
              logic in the diagnostic) and With Access (currency formatting)
              — connection-status badges (LIVE FEED, Sources Connected) stay
              With-Access-only since that's the only tab access keys apply
              to. Stage 1 stays region-blind by design, and Client
              Report/Register are client-facing or churn-list surfaces
              where either would just be header noise. */}
          {(activeTab === 'deepScan' || activeTab === 'withAccess') && (
            <div className="top-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: '#94a3b8' }}>
                Market
                <select
                  aria-label="Market"
                  value={region}
                  onChange={(e) => setRegion(e.target.value as Region)}
                  style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '8px', padding: '5px 8px', fontSize: '0.8rem' }}
                >
                  {Object.values(REGIONS).map((r) => (
                    <option key={r.code} value={r.code}>{r.label} ({r.currency})</option>
                  ))}
                </select>
              </label>
              {activeTab === 'withAccess' && (
                <>
                  <span style={{ backgroundColor: '#1e293b', color: '#b45309', padding: '4px 12px', borderRadius: '999px', fontSize: '0.875rem', border: '1px solid #334155' }}>
                    LIVE FEED
                  </span>
                  <span style={{ backgroundColor: '#1e293b', color: '#94a3b8', padding: '4px 12px', borderRadius: '999px', fontSize: '0.875rem', border: '1px solid #334155' }}>
                    Sources: {[accessStatus.shopify.configured, accessStatus.ga4.connected, accessStatus.gtm.connected].filter(Boolean).length} Connected
                  </span>
                </>
              )}
            </div>
          )}
        </header>

        <>
            {/* ===== Tabs ===== */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '0' }}>
              <button style={tabButtonStyle('noAccess')} onClick={() => setActiveTab('noAccess')}>
                No Access — Surface Dashboard
              </button>
              <button style={tabButtonStyle('deepScan')} onClick={() => setActiveTab('deepScan')}>
                Deep Scan
              </button>
              <button style={tabButtonStyle('withAccess')} onClick={() => setActiveTab('withAccess')}>
                With Access — Full Audit
              </button>
              <button style={tabButtonStyle('clientReport')} onClick={() => setActiveTab('clientReport')}>
                Client Report
              </button>
              <button style={tabButtonStyle('leads')} onClick={() => setActiveTab('leads')}>
                Register
              </button>
            </div>
            <div style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: '1.5rem', marginBottom: '2rem' }}>

              {/* ================= TAB 1: NO ACCESS ================= */}
              {activeTab === 'noAccess' && (
                <div>
                  <h2 style={{ fontSize: '1.05rem', margin: '0 0 10px 0' }}>Surface Scan Dashboard</h2>

                  <form onSubmit={handleSurfaceScan} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    <input
                      type="text"
                      placeholder="Enter store URL (e.g., mystore.myshopify.com)"
                      value={storeUrl}
                      onChange={(e) => applyUrlAndDetectRegion(e.target.value, setStoreUrl)}
                      style={{ flex: 5, minWidth: '320px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: '#f8fafc', fontSize: '0.9rem', outline: 'none' }}
                    />
                    <button
                      type="submit"
                      disabled={isSurfaceScanning}
                      style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '0 24px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                    >
                      {isSurfaceScanning ? 'Scanning...' : 'Scan Store'}
                    </button>
                  </form>

                  {surfaceError && (
                    <div style={{ marginBottom: '12px', color: '#e8792c', fontSize: '0.82rem', backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                      Error: {surfaceError}
                    </div>
                  )}

                  {surfaceResult && surfaceResult.status === 'ok' && (
                    <>
                      {/* Client-facing first: the 8 business metric cards only —
                          Attribution/Compliance are diagnostic detail, not a
                          business metric, so they've moved to the bottom
                          section below instead of sitting in this screenshot-
                          friendly top block. This whole block IS the
                          deliverable a client sees cold (often just a
                          screenshot). */}
                      {/* Split is driven entirely by each card's own `locked`
                          flag — auto-adjusts per store, nothing hardcoded
                          about which labels land in which group. Both groups
                          render as full individual cards (big metric name,
                          1-line explainer, small value/status) — "Need
                          Access" is just a small section label separating
                          them, not a container that collapses the cards
                          underneath it into a list. Sized to fit the whole
                          block on one screen (2026-08-15, explicit request:
                          one screenshot, not a scroll). */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px' }}>
                        {enrichedCards.filter((c) => !c.locked && c.label !== 'Attribution' && !c.label.startsWith('Compliance')).map((card, i) => (
                          <div key={i} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '9px 11px' }}>
                            {/* Size hierarchy is deliberate, standard across every
                                card: the metric itself is what a client scans for
                                first, so it's the heading; the explainer is
                                supporting context, one step down; the value is
                                read last, smallest — a status line, not the point. */}
                            <div style={{ color: '#f8fafc', fontSize: '0.85rem', fontWeight: 700, letterSpacing: '0.1px' }}>{card.label}</div>
                            <div style={{ marginTop: '4px', fontSize: '0.76rem', fontWeight: 600, color: '#94a3b8', lineHeight: 1.3 }}>{card.explainer}</div>
                            {!!card.value && (
                              <div style={{ marginTop: '4px', fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.2px', color: toneColor[card.tone] }}>{card.value}</div>
                            )}
                          </div>
                        ))}
                      </div>

                      {enrichedCards.some((c) => c.locked) && (
                        <>
                          <div style={{ color: '#94a3b8', fontSize: '0.66rem', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', margin: '10px 0 6px' }}>Need Access</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px' }}>
                            {enrichedCards.filter((c) => c.locked && c.label !== 'Attribution' && !c.label.startsWith('Compliance')).map((card, i) => (
                              <div key={i} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '9px 11px' }}>
                                <div style={{ color: '#f8fafc', fontSize: '0.85rem', fontWeight: 700, letterSpacing: '0.1px' }}>{card.label}</div>
                                <div style={{ marginTop: '4px', fontSize: '0.76rem', fontWeight: 600, color: '#94a3b8', lineHeight: 1.3 }}>{card.explainer}</div>
                                {!!card.value && (
                                  <div style={{ marginTop: '4px', fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.2px', color: toneColor[card.tone] }}>{card.value}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Urgency grounded in a real, already-computed number
                          (missingSignalCount) — never fabricated, and only
                          shown when there's an actual gap to point at. */}
                      {!!effectiveSurfaceSignals?.missingSignalCount && (
                        <div style={{ color: '#b45309', fontSize: '0.85rem', fontWeight: 600, marginTop: '0.75rem' }}>
                          {effectiveSurfaceSignals.missingSignalCount} of 4 core tracking signals missing — every day this sits, ad spend keeps flowing into channels you can't measure.
                        </div>
                      )}

                      <div style={{ backgroundColor: 'rgba(232,121,44,0.12)', border: '1px solid #e8792c', borderRadius: '8px', padding: '10px 14px', marginTop: '0.75rem' }}>
                        <span style={{ color: '#e8792c', fontSize: '0.88rem', fontWeight: 800, lineHeight: 1.3 }}>
                          I can deliver accurate data for your business with access.
                        </span>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '0.2px', textTransform: 'uppercase' }}>Not an Agency.</div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ color: '#f8fafc', fontSize: '0.72rem', fontWeight: 700 }}>Jason <span style={{ color: '#94a3b8', fontSize: '0.6rem', fontWeight: 600 }}>(preferred name)</span></div>
                          <div style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: 600, marginTop: '2px' }}>jagjit@jsonalytics.com</div>
                          <div style={{ color: '#f8fafc', fontSize: '0.72rem', fontWeight: 600, marginTop: '2px' }}>WhatsApp: +91-8588006657</div>
                        </div>
                      </div>

                    </>
                  )}
                </div>
              )}

              {/* ================= TAB: DEEP SCAN — access-free, the entire
                  AUDIT->LOCATE->POINT->GUIDE diagnostic lives here and only
                  here now. Just a URL, nothing store-specific. ================= */}
              {activeTab === 'deepScan' && (
                <div>
                  <div style={{ marginBottom: '0.75rem' }}>
                    <h2 style={{ fontSize: '0.95rem', margin: 0 }}>Deep Scan — Audit, Locate, Point, Guide</h2>
                  </div>

                  {/* Pure visual — no input, no button. Scanning starts
                      automatically from the No Access tab's submission;
                      this tab only ever displays whatever's already there. */}
                  {isScanning && (
                    <div style={{ marginBottom: '10px', color: '#94a3b8', fontSize: '0.85rem' }}>Scanning...</div>
                  )}
                  {!isScanning && !scanResult && !scanError && (
                    <div style={{ marginBottom: '10px', color: '#64748b', fontSize: '0.85rem' }}>No scan yet — enter a URL on the No Access tab.</div>
                  )}
                  {scanError && (
                    <div style={{ marginBottom: '10px', color: '#e8792c', fontSize: '0.82rem', backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                      Error: {scanError}
                    </div>
                  )}

                  {renderDiagnosticResults()}

                  {scanResult && scanResult.status !== 'error' && (
                    <details style={{ backgroundColor: '#1e293b', borderRadius: '10px', border: '1px solid #334155', padding: '0.6rem 0.75rem', marginTop: '0.6rem' }}>
                      <summary style={{ cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Guided next checks ({guidedChecks.length})</summary>
                      <div style={{ display: 'grid', gap: '6px', marginTop: '8px' }}>
                        {guidedChecks.map((check) => {
                          const recorded = guidedCheckOutcomes[check.id];
                          const outcomeColor = recorded?.outcome === 'pass' ? '#f8fafc' : recorded?.outcome === 'fail' ? '#e8792c' : recorded?.outcome === 'unsure' ? '#b45309' : '#334155';
                          return (
                            <div key={check.id} style={{ backgroundColor: '#0f172a', border: `1px solid ${outcomeColor}`, borderRadius: '6px', padding: '8px 10px', fontSize: '0.72rem' }}>
                              <div style={{ fontWeight: 700 }}>{check.title} <a href={resolveCheckHref(check)} target="_blank" rel="noreferrer" style={{ color: '#e8792c', marginLeft: '6px' }}>Open</a></div>
                              <div style={{ color: '#94a3b8', marginTop: '4px' }}><strong>Where:</strong> {check.where} · <strong>Look for:</strong> {check.lookFor}</div>
                              <div style={{ color: '#f8fafc', marginTop: '4px' }}><strong>Good:</strong> {check.good}</div>
                              <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                                {(['pass', 'fail', 'unsure'] as const).map((outcome) => (
                                  <button
                                    key={outcome}
                                    onClick={() => setGuidedCheckOutcomes((prev) => ({ ...prev, [check.id]: { outcome, note: prev[check.id]?.note || '' } }))}
                                    style={{
                                      backgroundColor: recorded?.outcome === outcome ? outcomeColor : 'transparent',
                                      color: recorded?.outcome === outcome ? '#0f172a' : '#94a3b8',
                                      border: `1px solid ${recorded?.outcome === outcome ? outcomeColor : '#334155'}`,
                                      borderRadius: '5px', padding: '3px 8px', fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer',
                                    }}
                                  >
                                    {outcome === 'pass' ? 'Pass' : outcome === 'fail' ? 'Fail' : 'Unsure'}
                                  </button>
                                ))}
                                {recorded?.outcome === 'fail' && (
                                  <input
                                    type="text"
                                    placeholder="What did you actually see?"
                                    defaultValue={recorded.note}
                                    onBlur={(e) => setGuidedCheckOutcomes((prev) => ({ ...prev, [check.id]: { outcome: 'fail', note: e.target.value } }))}
                                    style={{ flex: 1, minWidth: '180px', padding: '4px 7px', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '5px', color: '#f8fafc', fontSize: '0.68rem' }}
                                  />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* ================= TAB: WITH ACCESS — reserved entirely for
                  store-specific, access-key-dependent work now: financial
                  data, connected accounts, live API reconciliation, the
                  client PDF export. No diagnostic/Locate+Point+Guide content
                  here at all — that's fully on the Deep Scan tab. ================= */}
              {activeTab === 'withAccess' && (
                <div>
                  <div style={{ marginBottom: '0.75rem' }}>
                    <h2 style={{ fontSize: '0.95rem', margin: 0 }}>Store-Specific Access — Financial &amp; Live API Audit</h2>
                  </div>

                  {scanResult ? (
                    <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginBottom: '0.85rem' }}>
                      Auditing <strong style={{ color: '#f8fafc' }}>{scanResult.url}</strong> — the diagnostic lives on the <strong>Deep Scan</strong> tab; this tab is financial data and connected-account reconciliation only.
                    </div>
                  ) : (
                    <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginBottom: '0.85rem' }}>
                      No scan yet — run one on the <strong>Deep Scan</strong> tab first, then come back here for financial data and account connections.
                    </div>
                  )}

                  <div style={{ backgroundColor: '#1e293b', padding: '0.85rem 1rem', borderRadius: '10px', border: '1px solid #334155', marginBottom: '0.85rem' }}>
                    <form onSubmit={handleScan} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          placeholder="Optional: what did the client report?"
                          value={clientReportedIssue}
                          onChange={(e) => setClientReportedIssue(e.target.value)}
                          style={{ flex: 2, minWidth: '200px', padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                        />
                        <select
                          value={clientReportedCategory || ''}
                          onChange={(e) => setClientReportedCategory((e.target.value || null) as TopIssueCategory | null)}
                          aria-label="Client-reported issue category"
                          style={{ padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                        >
                          <option value="">Not sure / general</option>
                          <option value="tracking">Sounds like tracking</option>
                          <option value="financial">Sounds like financial/COD/RTO</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          placeholder="GTM-XXXXXXX"
                          value={gtmIdInput}
                          onChange={(e) => setGtmIdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '150px', padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                        />
                        <input
                          type="text"
                          placeholder="G-XXXXXXXXXX"
                          value={ga4IdInput}
                          onChange={(e) => setGa4IdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '150px', padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                        />
                        {ga4Properties.length > 0 && (
                          <select
                            value={ga4Properties.some((p) => p.propertyId === ga4PropertyIdInput) ? ga4PropertyIdInput : ''}
                            onChange={(e) => setGa4PropertyIdInput(e.target.value)}
                            aria-label="GA4 property"
                            style={{ flex: 1, minWidth: '150px', padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                          >
                            <option value="">GA4 property ({ga4Properties.length})</option>
                            {ga4Properties.map((p) => (
                              <option key={p.propertyId} value={p.propertyId}>{p.displayName} · {p.accountName} ({p.propertyId})</option>
                            ))}
                          </select>
                        )}
                        <input
                          type="text"
                          placeholder={ga4Properties.length > 0 ? 'Or type a Property ID' : 'GA4 Property ID (numeric)'}
                          value={ga4PropertyIdInput}
                          onChange={(e) => setGa4PropertyIdInput(e.target.value)}
                          style={{ flex: 1, minWidth: '150px', padding: '6px 9px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.74rem', outline: 'none' }}
                        />
                        <button
                          type="submit"
                          disabled={isScanning}
                          style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '0 18px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.82rem' }}
                        >
                          {isScanning ? 'Scanning...' : 'Refresh Audit'}
                        </button>
                      </div>
                    </form>
                    {isLoadingGa4Properties && (
                      <div style={{ marginTop: '6px', color: '#94a3b8', fontSize: '0.68rem' }}>Loading GA4 properties…</div>
                    )}
                    {ga4PropertiesError && (
                      <div style={{ marginTop: '6px', color: '#94a3b8', fontSize: '0.68rem' }}>Couldn't list GA4 properties — {ga4PropertiesError}. Enter the property ID manually above.</div>
                    )}
                    {scanError && (
                      <div style={{ marginTop: '12px', color: '#e8792c', fontSize: '0.82rem', backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                        Error: {scanError}
                      </div>
                    )}
                  </div>

                  {(productCatalog || isLoadingCatalog || catalogError) && (
                    <div style={{ color: '#94a3b8', fontSize: '0.72rem', marginBottom: '10px' }}>
                      {productCatalog && buildCatalogNote(productCatalog)}
                      {isLoadingCatalog && 'Checking product catalog size…'}
                      {catalogError && `Product catalog count unavailable: ${catalogError}`}
                    </div>
                  )}
                  <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <CSVUploader onDataParsed={handleCSVVitals} />
                    <button
                      onClick={handlePullLiveOrders}
                      disabled={isPullingShopify}
                      style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', padding: '10px 16px', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isPullingShopify ? 'Pulling live orders...' : 'Pull Live Shopify Orders'}
                    </button>
                    <input type="date" aria-label="Shopify start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ padding: '9px', backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc', borderRadius: '8px' }} />
                    <input type="date" aria-label="Shopify end date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ padding: '9px', backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc', borderRadius: '8px' }} />
                    {shopifyPullError && <span style={{ color: '#e8792c', fontSize: '0.78rem' }}>Error: {shopifyPullError}</span>}
                    {csvInputs && !shopifyPullError && (
                      <span style={{ color: '#f8fafc', fontSize: '0.78rem' }}>Using {csvInputs.totalOrders} order{csvInputs.totalOrders === 1 ? '' : 's'}. Refunds, voids, and first-time customers still need your confirmed numbers below.</span>
                    )}
                    {!csvInputs && (
                      <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>No order data loaded — audit will run tracking-only. Load CSV or pull live orders for financial metrics and the PDF report.</span>
                    )}
                  </div>

                  {csvInputs && (
                    <div style={{ backgroundColor: '#1e293b', padding: '1rem', borderRadius: '12px', border: '1px solid #334155', marginBottom: '1rem' }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>Confirmed financial inputs</div>
                      <div style={{ color: '#94a3b8', fontSize: '0.75rem', margin: '4px 0 10px' }}>Needed to calculate financial metrics — nothing here is estimated. RTO may be pre-filled as a suggestion below, but still needs your confirmation.</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: '10px' }}>
                        {([
                          ['cogs', 'COGS ($)'], ['shipping', 'Shipping cost ($)'], ['adSpend', 'Ad spend ($)'], ['settlementDays', 'Settlement days'], ['newCustomers', 'New customers (if missing)'], ['rtoOrders', 'RTO orders (if missing, 0 if none)'],
                        ] as const).map(([field, label]) => (
                          <input key={field} type="number" min="0" placeholder={label} value={financialInputs[field]} onChange={(e) => setFinancialInputs((current) => ({ ...current, [field]: e.target.value }))} style={{ padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: '#f8fafc', fontSize: '0.85rem' }} />
                        ))}
                      </div>
                      {csvRtoSuggestion !== null && (
                        <div style={{ color: '#b45309', fontSize: '0.72rem', marginTop: '8px' }}>
                          Suggested from CSV: {csvRtoSuggestion} order{csvRtoSuggestion === 1 ? '' : 's'} marked "restocked" by Shopify. This is a starting point, not a confirmed count — check it before scanning.
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ backgroundColor: '#1e293b', padding: '0.6rem 0.75rem', borderRadius: '10px', border: '1px solid #334155', marginBottom: '0.6rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' }}><div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Source connections</div><button onClick={() => void refreshAccessStatus()} style={{ background: '#0f172a', color: '#94a3b8', border: '1px solid #334155', borderRadius: '6px', padding: '4px 8px', fontSize: '0.68rem' }}>Refresh</button></div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      <button onClick={() => window.open('/api/shopify/auth', '_blank')} style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '6px', padding: '4px 8px', fontSize: '0.7rem' }}>{accessStatus.shopify.configured ? 'Shopify Connected' : 'Connect Shopify'}</button>
                      <button onClick={() => window.open('/api/ga4/auth', '_blank')} style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '6px', padding: '4px 8px', fontSize: '0.7rem' }}>{accessStatus.ga4.connected ? 'GA4 Connected' : 'Connect GA4'}</button>
                      <button onClick={() => window.open('/api/gtm/auth', '_blank')} style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '6px', padding: '4px 8px', fontSize: '0.7rem' }}>{accessStatus.gtm.connected ? 'GTM Connected' : 'Connect GTM'}</button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '6px' }}>
                      {Object.entries({ shopify: accessStatus.shopify.configured ? 'ready' : 'not-configured', ga4: accessStatus.ga4.connected ? 'connected' : 'not-configured', gtm: accessStatus.gtm.connected ? 'connected' : 'not-configured', dataLayer: validAuditDeepScan?.dataLayerPresent ? 'ready' : 'waiting', consent: validAuditDeepScan?.consent.found ? 'ready' : 'waiting' }).map(([key, value]) => (
                        <div key={key} style={{ backgroundColor: '#0f172a', borderRadius: '6px', padding: '6px 8px', border: '1px solid #334155' }}>
                          <div style={{ fontSize: '0.62rem', color: '#94a3b8', textTransform: 'uppercase' }}>{key}</div>
                          <div style={{ marginTop: '3px', fontSize: '0.68rem', color: value === 'waiting' || value === 'not-configured' ? '#b45309' : '#f8fafc' }}>{getAdapterStateLabel(value as any)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#1e293b', padding: '0.6rem 0.75rem', borderRadius: '10px', border: '1px solid #334155', marginBottom: '0.6rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>dataLayer evidence</div>
                      <button onClick={() => handleAuditDeepScan()} disabled={isAuditDeepScanning || !storeUrl} style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.7rem' }}>{isAuditDeepScanning ? 'Scanning...' : 'Re-scan'}</button>
                    </div>
                    {auditDeepScanError && <div style={{ color: '#e8792c', fontSize: '0.7rem', marginTop: '6px' }}>Error: {auditDeepScanError}</div>}
                    {auditDeepScanStale && (
                      <div style={{ color: '#b45309', fontSize: '0.68rem', marginTop: '6px' }}>Different URL — re-scan before auditing.</div>
                    )}
                    {validAuditDeepScan && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px', marginTop: '8px', fontSize: '0.7rem' }}>
                        <div><span style={{ color: '#94a3b8' }}>dataLayer</span><div style={{ color: validAuditDeepScan.dataLayerPresent ? '#f8fafc' : '#b45309', marginTop: '2px' }}>{validAuditDeepScan.dataLayerPresent ? 'Detected' : 'Not detected'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Events</span><div style={{ marginTop: '2px' }}>{auditDataLayerEvents.length ? auditDataLayerEvents.join(', ') : 'None readable'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Ecommerce fields</span><div style={{ marginTop: '2px' }}>{auditEcommerceFields.length ? auditEcommerceFields.join(', ') : 'None readable'}</div></div>
                        <div><span style={{ color: '#94a3b8' }}>Consent &amp; server-side</span><div style={{ marginTop: '2px' }}>{validAuditDeepScan.consent.found ? 'Consent signal seen' : 'No consent signal'} · {validAuditDeepScan.trackingSignals.serverSideEndpointCandidates.length ? `server-side: ${validAuditDeepScan.trackingSignals.serverSideEndpointCandidates.join(', ')}` : 'no server-side endpoint seen'}</div></div>
                      </div>
                    )}
                  </div>

                  {(liveGa4 || liveGtmMatch || liveDataError) && (
                    <div style={{ backgroundColor: '#1e293b', padding: '0.6rem 0.75rem', borderRadius: '10px', border: '1px solid #334155', marginBottom: '0.6rem' }}>
                      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '6px' }}>Live API Confirmation</div>
                      {liveDataError && <div style={{ color: '#e8792c', fontSize: '0.74rem', marginBottom: '6px' }}>{liveDataError}</div>}
                      {liveGa4 && (
                        <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                          GA4 (last 30d): {liveGa4.sessions} sessions, {liveGa4.totalUsers} users, {liveGa4.conversions} conversions, {formatCurrency(liveGa4.purchaseRevenue, region)} revenue
                        </div>
                      )}
                      {apiReconciliation.length > 0 && (
                        <div style={{ display: 'grid', gap: '5px', marginTop: '8px' }}>
                          {apiReconciliation.map((f, i) => (
                            <div key={i} style={{ fontSize: '0.72rem', color: f.tone === 'good' ? '#f8fafc' : f.tone === 'bad' ? '#e8792c' : '#b45309', lineHeight: 1.35 }}>
                              {f.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {scanResult && scanResult.status !== 'error' && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => handleExportPdf(scanResult, mergedTopIssues || undefined, setScanError)}
                        disabled={isExportingPdf}
                        style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                      >
                        {isExportingPdf ? 'Generating PDF...' : 'Export PDF Report'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ================= TAB 3: CLIENT REPORT ================= */}
              {activeTab === 'clientReport' && !scanResult && (
                <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                  No audit run yet — go to <strong>Deep Scan</strong> and run a scan first. Once that's done, the Report and Validation tabs populate here automatically.
                </div>
              )}
              {activeTab === 'clientReport' && scanResult && (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <div>
                    <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px' }}>Client-Ready Audit Report</h2>
                  </div>

                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={() => setClientReportView('audit')}
                      style={{ padding: '8px 18px', borderRadius: '6px 6px 0 0', border: '1px solid #334155', borderBottom: clientReportView === 'audit' ? '1px solid #0f172a' : '1px solid #334155', backgroundColor: clientReportView === 'audit' ? '#0f172a' : '#1e293b', color: clientReportView === 'audit' ? '#f8fafc' : '#94a3b8', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
                    >
                      Report
                    </button>
                    <button
                      onClick={() => setClientReportView('validation')}
                      style={{ padding: '8px 18px', borderRadius: '6px 6px 0 0', border: '1px solid #334155', borderBottom: clientReportView === 'validation' ? '1px solid #0f172a' : '1px solid #334155', backgroundColor: clientReportView === 'validation' ? '#0f172a' : '#1e293b', color: clientReportView === 'validation' ? '#f8fafc' : '#94a3b8', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
                    >
                      Validation {validationResult ? '' : '(not run yet)'}
                    </button>
                  </div>

                  {clientReportView === 'audit' && (
                    <>
                      <ClientReportView result={scanResult} topIssues={mergedTopIssues!} badge="REPORT" />
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button onClick={() => handleExportPdf(scanResult, mergedTopIssues!, setScanError)} disabled={isExportingPdf} style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{isExportingPdf ? 'Generating PDF...' : 'Export Client PDF'}</button>
                      </div>
                    </>
                  )}

                  {clientReportView === 'validation' && (
                    validationResult && validationResult.status === 'ok' ? (
                      (() => {
                        const diff = diffTopIssues(mergedTopIssues!, validationResult.report.topIssues);
                        return (
                          <>
                            <div style={{ backgroundColor: '#0f172a', color: '#f8fafc', padding: '2rem', borderRadius: '12px' }}>
                              <div style={{ borderBottom: '2px solid #e8792c', paddingBottom: '14px', marginBottom: '18px' }}>
                                <div style={{ color: '#b45309', fontWeight: 800, letterSpacing: '1px', fontSize: '0.8rem' }}>JSONALYTICS™ · VALIDATION</div>
                                <h1 style={{ margin: '6px 0', fontSize: '1.6rem' }}>What's Been Fixed</h1>
                                <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>{validationResult.url}</div>
                              </div>
                              <div style={{ background: '#1e293b', borderLeft: '4px solid #e8792c', padding: '10px 12px', color: '#f8fafc', fontSize: '0.85rem', marginBottom: '18px' }}>
                                To keep this accurate going forward: please don't modify the tracking setup covered below. Any other change to the store — installing a new app, a platform or theme update, a redesign — can affect tracking independently of this fix and may need a fresh check; that's outside the scope of what's validated here.
                              </div>
                              <h3 style={{ marginTop: 0 }}>Resolved ({diff.resolved.length})</h3>
                              {/* Paying-client depth, per explicit request: real technical
                                  detail on what was actually done, typed by the operator —
                                  never auto-generated or guessed. */}
                              {diff.resolved.length === 0 ? (
                                <p style={{ color: '#94a3b8' }}>Nothing resolved yet compared to the original report.</p>
                              ) : (
                                <ol style={{ paddingLeft: '20px', color: '#f8fafc', lineHeight: 1.55 }}>
                                  {diff.resolved.map((issue: { id: string; title: string }) => (
                                    <li key={issue.id} style={{ marginBottom: '10px' }}>
                                      <strong>{issue.title}</strong> — no longer detected.
                                      <textarea
                                        placeholder="Technical steps taken (optional, for the client)..."
                                        value={techStepNotes[issue.id] || ''}
                                        onChange={(e) => setTechStepNotes((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                                        rows={2}
                                        style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px 8px', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.8rem', fontFamily: 'inherit', resize: 'vertical' }}
                                      />
                                    </li>
                                  ))}
                                </ol>
                              )}
                              <h3>Still Open ({diff.stillOpen.length})</h3>
                              {diff.stillOpen.length === 0 ? (
                                <p style={{ color: '#f8fafc', fontWeight: 600 }}>Everything from the original report is resolved.</p>
                              ) : (
                                <ol style={{ paddingLeft: '20px', color: '#94a3b8', lineHeight: 1.55 }}>
                                  {diff.stillOpen.map((issue: { id: string; title: string; detail: string; firstCheck: string }) => (
                                    <li key={issue.id}><strong>{issue.title}:</strong> {issue.detail} <em>First check: {issue.firstCheck}</em></li>
                                  ))}
                                </ol>
                              )}
                              {diff.newlyFound.length > 0 && (
                                <>
                                  <h3>New since the original report ({diff.newlyFound.length})</h3>
                                  <ol style={{ paddingLeft: '20px', color: '#f8fafc', lineHeight: 1.55 }}>
                                    {diff.newlyFound.map((issue: { id: string; title: string; detail: string }) => <li key={issue.id}><strong>{issue.title}:</strong> {issue.detail}</li>)}
                                  </ol>
                                </>
                              )}
                              <div style={{ marginTop: '20px', padding: '12px', background: '#1e293b', borderLeft: '4px solid #e8792c', color: '#f8fafc', fontSize: '0.85rem' }}>
                                Validated {new Date().toLocaleString()} — fresh evidence, same store, same credentials. Compared against the original Report tab by finding id.
                              </div>
                              <div style={{ marginTop: '24px', textAlign: 'center', fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>Jason <span style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600 }}>(preferred name)</span></div>
                              <div style={{ textAlign: 'center', fontSize: '1.15rem', fontWeight: 800, color: '#b45309', marginTop: '2px' }}>jagjit@jsonalytics.com</div>
                              <div style={{ textAlign: 'center', fontSize: '1rem', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>WhatsApp: +91-8588006657</div>
                              <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8', marginTop: '6px' }}>US account via Wise — universally accepted, easy international payment.</div>
                              <div style={{ textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8', marginTop: '4px' }}>Ownership declaration available upon request.</div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                              <button onClick={handleRunValidation} disabled={isRunningValidation} style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', padding: '10px 20px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}>{isRunningValidation ? 'Re-validating...' : 'Re-run Validation'}</button>
                              <button onClick={handleExportValidationPdf} disabled={isExportingPdf} style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{isExportingPdf ? 'Generating PDF...' : 'Export Validation PDF'}</button>
                            </div>
                            {validationError && (
                              <div style={{ color: '#e8792c', fontSize: '0.82rem', backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '8px', padding: '10px 14px' }}>Error: {validationError}</div>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      <div style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '1.5rem' }}>
                        <div style={{ color: '#94a3b8', fontSize: '0.88rem', marginBottom: '14px' }}>
                          Run this once the fix is live — it re-scans the same store fresh and shows exactly which of the original report's findings are now resolved, not just today's raw results.
                        </div>
                        <button onClick={handleRunValidation} disabled={isRunningValidation} style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{isRunningValidation ? 'Running...' : 'Run Validation Scan'}</button>
                        {validationError && (
                          <div style={{ marginTop: '12px', color: '#e8792c', fontSize: '0.82rem' }}>Error: {validationError}</div>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}

              {/* ================= TAB 4: LEADS ================= */}
              {activeTab === 'leads' && (
                <LeadRegister region={region} />
              )}
            </div>
        </>

      </div>
    </div>
  );
}
