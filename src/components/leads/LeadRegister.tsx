import React, { useEffect, useState } from 'react';
import {
  fetchLeads,
  updateLead,
  deleteLead,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
} from '../../utils/leadsApi';
import type { Lead, LeadStatus } from '../../utils/leadsApi';
import { runSurfaceAudit, fetchDeepScan } from '../../utils/auditLogic';
import { runDiagnostics, getFindingCategory } from '../../utils/diagnosticEngine';
import type { DiagnosticSeverity } from '../../utils/diagnosticEngine';
import { formatRelativeTime } from '../../utils/formatters';
import type { Region } from '../../utils/constants';

const statusColor: Record<LeadStatus, string> = {
  not_contacted: '#94a3b8',
  contacted: '#f8fafc',
  interested: '#f8fafc',
  not_interested: '#94a3b8',
  in_progress: '#b45309',
};

// Local to this component on purpose — diagnosticEngine.ts's own severity
// rank is internal (used to sort findings within one report), this ranks
// leads against each other by their worst finding, a different job.
const OUTREACH_RANK: Record<DiagnosticSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const severityColor: Record<DiagnosticSeverity, string> = {
  critical: '#e8792c',
  high: '#e8792c',
  medium: '#94a3b8',
  low: '#94a3b8',
  info: '#94a3b8',
};

function leadOutreachRank(lead: Lead): number {
  if (!lead.lastScan) return -1; // unscanned sinks below every scanned lead, scanned or clean
  const diagnostic = runDiagnostics(lead.lastScan.surfaceResult, lead.lastScan.deepScan ?? null);
  if (!diagnostic.earliestFailure) return 0; // scanned, genuinely clean — ranks above "unknown," below any real gap
  return OUTREACH_RANK[diagnostic.earliestFailure.severity];
}

interface LeadRegisterProps {
  region: Region;
}

export const LeadRegister: React.FC<LeadRegisterProps> = ({ region }) => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LeadStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // A Set, not a single id — Scan All runs 2 leads concurrently per batch,
  // and a single scanningId would only ever show one of the two as
  // "Scanning..." even though both are genuinely in flight.
  const [scanningIds, setScanningIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [isScanningAll, setIsScanningAll] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setLeads(await fetchLeads());
    } catch (err: any) {
      setError(err.message || 'Could not load leads.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  // Scans every currently-visible lead that doesn't already have a cached
  // result — never silently re-scans ones already scanned, same "explicit
  // action only, cache until asked" rule as the single Scan button.
  // Batches of 2 with a 1.5s pause: handleScan now runs a real Puppeteer
  // deep scan per lead (see its own comment), not the old lightweight
  // static-only fetch() — the previous batch-of-10 pacing was calibrated
  // for that cheaper path and would reproduce the same DNS/rate-limit
  // failures the 20-store benchmark run hit earlier this session under
  // rapid concurrent Puppeteer launches.
  const SCAN_ALL_BATCH_SIZE = 2;
  const SCAN_ALL_BATCH_PAUSE_MS = 1500;
  const handleScanAll = async () => {
    const targets = visibleLeads.filter((l) => !l.lastScan);
    if (targets.length === 0) return;
    setIsScanningAll(true);
    setError(null);
    let done = 0;
    try {
      for (let i = 0; i < targets.length; i += SCAN_ALL_BATCH_SIZE) {
        const batch = targets.slice(i, i + SCAN_ALL_BATCH_SIZE);
        setBulkProgress(`Scanning ${done + 1}-${Math.min(done + batch.length, targets.length)} of ${targets.length}...`);
        await Promise.all(batch.map((lead) => handleScan(lead)));
        done += batch.length;
        if (i + SCAN_ALL_BATCH_SIZE < targets.length) await new Promise((r) => setTimeout(r, SCAN_ALL_BATCH_PAUSE_MS));
      }
    } finally {
      setIsScanningAll(false);
      setBulkProgress(null);
    }
  };

  const handleStatusChange = async (id: string, status: LeadStatus) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l))); // optimistic
    try {
      await updateLead(id, { status });
    } catch (err: any) {
      setError(err.message || 'Could not update status.');
      void load(); // reconcile with server state on failure
    }
  };

  const handleNotesBlur = async (id: string, notes: string) => {
    try {
      await updateLead(id, { notes });
    } catch (err: any) {
      setError(err.message || 'Could not save notes.');
    }
  };

  const handleDelete = async (id: string) => {
    const previous = leads;
    setLeads((prev) => prev.filter((l) => l.id !== id)); // optimistic
    try {
      await deleteLead(id);
    } catch (err: any) {
      setError(err.message || 'Could not delete lead.');
      setLeads(previous);
    }
  };

  // Explicit action only — cached findings are never written silently.
  // Full deep scan (static + real network capture), matching the standing
  // "deep scan is the standard, most direct impact" rule (2026-08-16) — was
  // static-only until this, which meant clicking Re-scan here actually
  // downgraded a lead's evidence if it had richer deep-scan data attached
  // by the daily farming sequence. Slower per-lead than the old static-only
  // pass, but no longer produces evidence weaker than what "Scan All" or
  // the automated sequence already store.
  const handleScan = async (lead: Lead) => {
    setScanningIds((prev) => new Set(prev).add(lead.id));
    setError(null);
    try {
      const surfaceResult = await runSurfaceAudit(lead.storeUrl, region);
      if (surfaceResult.status === 'error') {
        throw new Error(surfaceResult.error || 'Scan failed.');
      }
      let deepScan = null;
      try {
        deepScan = await fetchDeepScan(lead.storeUrl);
      } catch (err: any) {
        setError(`Deep scan failed for ${lead.storeUrl} (${err.message}) — cached static-only evidence instead.`);
      }
      // Stored once here rather than only recomputed for display — this is
      // what makes a cause searchable/groupable across the whole register,
      // not just readable one lead at a time.
      const causeTags = runDiagnostics(surfaceResult, deepScan, null, region).findings
        .filter((f) => f.severity !== 'info')
        .map((f) => f.id);
      const updated = await updateLead(lead.id, {
        lastScan: { scannedAt: new Date().toISOString(), surfaceResult, deepScan, causeTags },
      });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? updated : l)));
    } catch (err: any) {
      setError(err.message || `Could not scan ${lead.storeUrl}.`);
    } finally {
      setScanningIds((prev) => { const next = new Set(prev); next.delete(lead.id); return next; });
    }
  };

  // Auto-ranked: real gaps first, clean scans after, unscanned at the
  // bottom — so scanning a batch surfaces the ones actually worth
  // outreach without having to read every row. Ties keep creation order
  // (Array.sort is stable) rather than reshuffling on every render.
  const query = searchQuery.trim().toLowerCase();
  const visibleLeads = [...(filter === 'all' ? leads : leads.filter((l) => l.status === filter))]
    .filter((l) =>
      !query ||
      l.storeUrl.toLowerCase().includes(query) ||
      l.notes.toLowerCase().includes(query) ||
      (l.lastScan?.causeTags || []).some((tag) => {
        if (tag.toLowerCase().includes(query)) return true;
        const info = getFindingCategory(tag);
        return info.category.toLowerCase().includes(query) || info.fixType.toLowerCase().includes(query);
      })
    )
    .sort((a, b) => leadOutreachRank(b) - leadOutreachRank(a));
  const unscannedCount = visibleLeads.filter((l) => !l.lastScan).length;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px 0' }}>Lead Register</h2>
      </div>

      <input
        type="text"
        placeholder="Search by URL, notes, or cause (e.g. consent, duplicate-gtm)..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: '#f8fafc', fontSize: '0.9rem', outline: 'none', marginBottom: '1rem' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button
          onClick={handleScanAll}
          disabled={isScanningAll || unscannedCount === 0}
          style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '8px', padding: '8px 16px', fontSize: '0.82rem', fontWeight: 600, cursor: unscannedCount === 0 ? 'default' : 'pointer', opacity: unscannedCount === 0 ? 0.6 : 1 }}
        >
          {isScanningAll ? 'Scanning...' : `Scan All Unscanned (${unscannedCount})`}
        </button>
        {bulkProgress && <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>{bulkProgress}</span>}
      </div>

      {error && (
        <div style={{ marginBottom: '12px', color: '#e8792c', fontSize: '0.82rem', backgroundColor: 'rgba(232,121,44,0.08)', border: '1px solid rgba(232,121,44,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
          Error: {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {(['all', ...LEAD_STATUSES] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              backgroundColor: filter === s ? '#1e293b' : 'transparent',
              color: filter === s ? '#f8fafc' : '#94a3b8',
              border: '1px solid #334155',
              borderRadius: '999px',
              padding: '5px 12px',
              fontSize: '0.78rem',
              cursor: 'pointer',
            }}
          >
            {s === 'all' ? `All (${leads.length})` : `${LEAD_STATUS_LABELS[s]} (${leads.filter((l) => l.status === s).length})`}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading leads...</div>
      ) : visibleLeads.length === 0 ? (
        <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
          {leads.length === 0 ? 'No leads yet — the scan sequence adds them here automatically.' : 'No leads match this filter/search.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {visibleLeads.map((lead) => (
            <div key={lead.id} style={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderLeft: `3px solid ${statusColor[lead.status]}`, borderRadius: '8px', padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, wordBreak: 'break-all' }}>{lead.storeUrl}</div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <select
                    value={lead.status}
                    onChange={(e) => handleStatusChange(lead.id, e.target.value as LeadStatus)}
                    style={{ backgroundColor: '#0f172a', color: statusColor[lead.status], border: '1px solid #334155', borderRadius: '6px', padding: '5px 8px', fontSize: '0.78rem', fontWeight: 600 }}
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleDelete(lead.id)}
                    aria-label={`Remove ${lead.storeUrl}`}
                    style={{ backgroundColor: 'transparent', color: '#e8792c', border: '1px solid #334155', borderRadius: '6px', padding: '5px 9px', fontSize: '0.78rem', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div style={{ color: '#94a3b8', fontSize: '0.7rem', marginTop: '4px' }}>
                Added {new Date(lead.createdAt).toLocaleDateString()}
                {lead.updatedAt !== lead.createdAt ? ` · updated ${new Date(lead.updatedAt).toLocaleDateString()}` : ''}
              </div>
              <input
                type="text"
                defaultValue={lead.notes}
                placeholder="Notes (saved on blur)..."
                onBlur={(e) => handleNotesBlur(lead.id, e.target.value)}
                style={{ width: '100%', marginTop: '8px', padding: '7px 10px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.8rem', outline: 'none' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #334155', flexWrap: 'wrap' }}>
                {lead.lastScan ? (
                  (() => {
                    const diagnostic = runDiagnostics(lead.lastScan.surfaceResult, lead.lastScan.deepScan ?? null);
                    return (
                      <div style={{ fontSize: '0.76rem', color: '#94a3b8' }}>
                        <span style={{ color: '#94a3b8' }}>Cached — scanned {formatRelativeTime(lead.lastScan.scannedAt)}: </span>
                        {diagnostic.earliestFailure ? (
                          <span>
                            <span style={{ color: severityColor[diagnostic.earliestFailure.severity], fontWeight: 700 }}>
                              {diagnostic.earliestFailure.severity.toUpperCase()}
                            </span>
                            {' '}{diagnostic.earliestFailure.title}
                          </span>
                        ) : (
                          <span style={{ color: '#f8fafc' }}>No blocking issue found</span>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <div style={{ fontSize: '0.76rem', color: '#94a3b8' }}>Not scanned yet — nothing cached, no network call made until you ask.</div>
                )}
                <button
                  onClick={() => handleScan(lead)}
                  disabled={scanningIds.has(lead.id)}
                  style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '6px', padding: '5px 10px', fontSize: '0.74rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  {scanningIds.has(lead.id) ? 'Scanning...' : lead.lastScan ? 'Re-scan' : 'Scan now'}
                </button>
              </div>
              {/* Grouped by category (Consent/Compliance, Measurement/
                  Attribution, Container/Technical Setup, Cleanup) with its
                  concrete fix type, instead of a flat list of raw finding
                  ids — lets outreach be planned by "what kind of problem"
                  at a glance across the whole register. */}
              {lead.lastScan && lead.lastScan.causeTags && lead.lastScan.causeTags.length > 0 && (() => {
                const byCategory = new Map<string, Set<string>>();
                for (const tag of lead.lastScan.causeTags) {
                  const { category, fixType } = getFindingCategory(tag);
                  if (!byCategory.has(category)) byCategory.set(category, new Set());
                  byCategory.get(category)!.add(fixType);
                }
                return (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                    {Array.from(byCategory.entries()).map(([category, fixTypes]) => (
                      <span
                        key={category}
                        title={Array.from(fixTypes).join(' · ')}
                        style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', padding: '3px 8px', fontSize: '0.68rem', color: '#94a3b8' }}
                      >
                        <strong style={{ color: '#94a3b8' }}>{category}</strong>: {Array.from(fixTypes).join(' · ')}
                      </span>
                    ))}
                  </div>
                );
              })()}
              {/* Research starting points for reaching the actual
                  decision-maker, not a generic inbox — strictly what the
                  store's own public page already publishes (social links,
                  a mailto:, its own About/Contact page), plus a direct link
                  to Meta's own public Ad Library search UI. That last one is
                  just a constructed URL for the operator to open and browse
                  themselves — this app never requests or parses Ad Library
                  content itself; automating that is against Meta's terms
                  and a real enforcement risk, browsing it by hand isn't. */}
              {lead.lastScan && (() => {
                const cs = lead.lastScan.surfaceResult.contactSignals;
                // Safe by construction, not by try/catch: aboutOrContactPageUrl
                // only ever comes from a regex-captured href on the store's own
                // page (see extractContactSignals), so it's always either a
                // relative path or a full URL — never something that needs
                // the URL constructor (which can throw on a bad base) to join.
                const base = lead.storeUrl.startsWith('http') ? lead.storeUrl.replace(/\/+$/, '') : `https://${lead.storeUrl.replace(/\/+$/, '')}`;
                const aboutHref = cs.aboutOrContactPageUrl
                  ? (cs.aboutOrContactPageUrl.startsWith('http') ? cs.aboutOrContactPageUrl : `${base}${cs.aboutOrContactPageUrl.startsWith('/') ? '' : '/'}${cs.aboutOrContactPageUrl}`)
                  : null;
                // Same string-only approach as base above — no URL() parsing.
                const hostname = lead.storeUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
                const adLibraryQuery = encodeURIComponent(lead.storeName || hostname);
                const adLibraryHref = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${adLibraryQuery}&search_type=keyword_unordered`;
                return (
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #334155', fontSize: '0.72rem' }}>
                    {cs.socialLinks.map((s, i) => (
                      <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ color: '#e8792c' }}>{s.platform}</a>
                    ))}
                    {cs.contactEmail && <a href={`mailto:${cs.contactEmail}`} style={{ color: '#e8792c' }}>{cs.contactEmail}</a>}
                    {aboutHref && <a href={aboutHref} target="_blank" rel="noreferrer" style={{ color: '#e8792c' }}>About/Contact page</a>}
                    <a href={adLibraryHref} target="_blank" rel="noreferrer" style={{ color: '#e8792c' }}>Meta Ad Library</a>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
