import React, { useEffect, useState } from 'react';
import {
  fetchLeads,
  createLead,
  updateLead,
  deleteLead,
  searchAdLibrary,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
} from '../../utils/leadsApi';
import type { Lead, LeadStatus, AdLibraryResult } from '../../utils/leadsApi';
import { runSurfaceAudit, fetchDeepScan } from '../../utils/auditLogic';
import { runDiagnostics, getFindingCategory } from '../../utils/diagnosticEngine';
import type { DiagnosticSeverity } from '../../utils/diagnosticEngine';
import { formatRelativeTime, detectRegionFromUrl } from '../../utils/formatters';
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

// Outreach timing — local to this component, only matters at the point of
// contacting a lead. Send windows were previously worked out by hand per
// lead (Rippl Impact Gear: held for 1:30 PM IST to land at 9 AM UK time);
// this computes the same thing for every lead instead of redoing the math
// each time. OPERATOR_TZ assumes IST, matching that precedent.
const OPERATOR_TZ = 'Asia/Kolkata';
const SEND_WINDOW_LOCAL_HOUR = 9; // 9 AM local — the UK-9AM precedent above
const REGION_TIMEZONES: Record<Region, { tz: string; label: string }> = {
  US: { tz: 'America/New_York', label: 'US · ET' },
  UK: { tz: 'Europe/London', label: 'UK' },
  CA: { tz: 'America/Toronto', label: 'Canada · ET' },
  AU: { tz: 'Australia/Sydney', label: 'Australia · Sydney' },
  IN: { tz: 'Asia/Kolkata', label: 'India · IST' },
  NZ: { tz: 'Pacific/Auckland', label: 'New Zealand' },
};

function zonedParts(date: Date, timeZone: string): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10) };
}

// Next UTC instant at which `timeZone` reads `hour`:00 local, on or after
// `now`. Re-measures the offset after each adjustment rather than trusting
// a single guess, so it converges correctly across DST without a hardcoded
// offset table.
function nextLocalHour(timeZone: string, hour: number, now: Date): Date {
  let t = now.getTime();
  for (let i = 0; i < 3; i++) {
    const { hour: h, minute: m } = zonedParts(new Date(t), timeZone);
    t += ((hour - h) * 60 - m) * 60000;
  }
  if (t <= now.getTime()) {
    t += 24 * 3600 * 1000;
    const { hour: h, minute: m } = zonedParts(new Date(t), timeZone);
    t += ((hour - h) * 60 - m) * 60000;
  }
  return new Date(t);
}

function formatZoned(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

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
  const [adLibTerms, setAdLibTerms] = useState('');
  const [adLibCountries, setAdLibCountries] = useState('US,CA,AU,NZ,GB');
  const [adLibResults, setAdLibResults] = useState<AdLibraryResult[]>([]);
  const [isSearchingAdLib, setIsSearchingAdLib] = useState(false);
  const [addingAdLibId, setAddingAdLibId] = useState<string | null>(null);

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

  // Pulls a plausible bare domain out of Ad Library's link caption/title
  // text (e.g. "Shop Now at mystore.com") — these fields carry the
  // advertiser's actual destination text; page_name is just the Facebook
  // Page's display name and is not reliably a URL at all.
  const extractCandidateUrl = (result: AdLibraryResult): string | null => {
    const texts = [
      ...(result.ad_creative_link_captions || []),
      ...(result.ad_creative_link_titles || []),
      ...(result.ad_creative_link_descriptions || []),
    ];
    for (const text of texts) {
      const match = text.match(/([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?/i);
      if (match) return match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
    }
    return null;
  };

  const handleAdLibSearch = async () => {
    if (!adLibTerms.trim()) return;
    setIsSearchingAdLib(true);
    setError(null);
    setAdLibResults([]);
    try {
      setAdLibResults(await searchAdLibrary(adLibTerms.trim(), adLibCountries));
    } catch (err: any) {
      setError(err.message || 'Ad Library search failed.');
    } finally {
      setIsSearchingAdLib(false);
    }
  };

  // Adds the lead, then immediately runs the same real deep-scan pipeline
  // handleScan already uses — never registers on the Ad Library hit alone,
  // matches the standing "deep-scan gated" lead-sourcing rule.
  const handleAddFromAdLib = async (result: AdLibraryResult) => {
    const url = extractCandidateUrl(result);
    if (!url) { setError('No usable URL found in this ad\'s link text — skip or check it manually.'); return; }
    setAddingAdLibId(result.id);
    setError(null);
    try {
      const lead = await createLead(url, 'not_contacted', result.page_name || '');
      setLeads((prev) => [...prev, lead]);
      await handleScan(lead);
      setAdLibResults((prev) => prev.filter((r) => r.id !== result.id));
    } catch (err: any) {
      setError(err.message || `Could not add ${url}.`);
    } finally {
      setAddingAdLibId(null);
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

      <details style={{ backgroundColor: '#1e293b', borderRadius: '10px', border: '1px solid #334155', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Find leads via Meta Ad Library</summary>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
          <input
            type="text"
            placeholder="Keyword (e.g. jewellery, skincare)"
            value={adLibTerms}
            onChange={(e) => setAdLibTerms(e.target.value)}
            style={{ flex: 3, minWidth: '200px', padding: '8px 10px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.82rem', outline: 'none' }}
          />
          <input
            type="text"
            placeholder="Countries (comma-separated)"
            value={adLibCountries}
            onChange={(e) => setAdLibCountries(e.target.value)}
            style={{ flex: 2, minWidth: '160px', padding: '8px 10px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#f8fafc', fontSize: '0.82rem', outline: 'none' }}
          />
          <button
            onClick={handleAdLibSearch}
            disabled={isSearchingAdLib || !adLibTerms.trim()}
            style={{ backgroundColor: '#b45309', color: '#f8fafc', border: 'none', padding: '0 16px', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '0.82rem' }}
          >
            {isSearchingAdLib ? 'Searching...' : 'Search'}
          </button>
        </div>
        <div style={{ color: '#64748b', fontSize: '0.72rem', marginTop: '6px' }}>
          Returns up to 5 currently-active ads. Requires META_AD_LIBRARY_TOKEN set in .env (Meta identity verification required — see README).
        </div>
        {adLibResults.length > 0 && (
          <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
            {adLibResults.map((r) => {
              const candidateUrl = extractCandidateUrl(r);
              return (
                <div key={r.id} style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', padding: '8px 10px', fontSize: '0.78rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ color: '#f8fafc', fontWeight: 600 }}>{r.page_name || 'Unnamed advertiser'}</div>
                    <div style={{ color: candidateUrl ? '#94a3b8' : '#e8792c' }}>{candidateUrl || 'No URL found in ad text — check manually'}</div>
                  </div>
                  <button
                    onClick={() => handleAddFromAdLib(r)}
                    disabled={!candidateUrl || addingAdLibId === r.id}
                    style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '6px', padding: '6px 12px', fontSize: '0.75rem', fontWeight: 600, cursor: candidateUrl ? 'pointer' : 'default', opacity: candidateUrl ? 1 : 0.5 }}
                  >
                    {addingAdLibId === r.id ? 'Adding + scanning...' : 'Add & scan'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </details>

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
              {(() => {
                const region = detectRegionFromUrl(lead.storeUrl);
                if (!region) {
                  return (
                    <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '4px' }}>
                      Timezone: unknown — no country signal in the domain, check manually.
                    </div>
                  );
                }
                const { tz, label } = REGION_TIMEZONES[region];
                const now = new Date();
                const sendAt = nextLocalHour(tz, SEND_WINDOW_LOCAL_HOUR, now);
                return (
                  <div style={{ color: '#94a3b8', fontSize: '0.7rem', marginTop: '4px' }}>
                    🌐 {label} · local now {formatZoned(now, tz)} · next 9 AM window {formatZoned(sendAt, tz)} (send at {formatZoned(sendAt, OPERATOR_TZ)} your time)
                  </div>
                );
              })()}
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
              {/* Theme-update drift: previousScan is shifted into place
                  server-side whenever a new lastScan lands (see server.cjs),
                  so re-scanning the same store naturally builds one level of
                  history — enough to catch tracking that broke silently
                  between two scans (theme update, app uninstall) without a
                  full audit trail. Only renders once a lead's been scanned
                  twice; a newly-appeared cause is the actionable case, a
                  resolved one is just informational. */}
              {lead.lastScan && lead.previousScan && (() => {
                const currentTags = new Set(lead.lastScan!.causeTags || []);
                const previousTags = new Set(lead.previousScan!.causeTags || []);
                const newlyBroken = [...currentTags].filter((t) => !previousTags.has(t));
                const fixed = [...previousTags].filter((t) => !currentTags.has(t));
                if (newlyBroken.length === 0 && fixed.length === 0) return null;
                return (
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #334155', fontSize: '0.72rem', display: 'grid', gap: '4px' }}>
                    {newlyBroken.length > 0 && (
                      <div style={{ color: '#e8792c', fontWeight: 700 }}>
                        ⚠ New since the scan {formatRelativeTime(lead.previousScan.scannedAt)}: {newlyBroken.map((t) => getFindingCategory(t).fixType).join(', ')}
                      </div>
                    )}
                    {fixed.length > 0 && (
                      <div style={{ color: '#94a3b8' }}>
                        ✓ Resolved since the scan {formatRelativeTime(lead.previousScan.scannedAt)}: {fixed.map((t) => getFindingCategory(t).fixType).join(', ')}
                      </div>
                    )}
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
