import React, { useEffect, useState } from 'react';
import {
  fetchLeads,
  createLead,
  updateLead,
  deleteLead,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
} from '../../utils/leadsApi';
import type { Lead, LeadStatus } from '../../utils/leadsApi';

const statusColor: Record<LeadStatus, string> = {
  interested: '#4ade80',
  not_interested: '#94a3b8',
  in_queue: '#38bdf8',
  in_progress: '#fbbf24',
};

interface LeadRegisterProps {
  /** Prefills the add-lead URL field, e.g. from whatever was just scanned in another tab. */
  prefillUrl?: string;
}

export const LeadRegister: React.FC<LeadRegisterProps> = ({ prefillUrl }) => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [newStatus, setNewStatus] = useState<LeadStatus>('in_queue');
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState<LeadStatus | 'all'>('all');

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
  useEffect(() => { if (prefillUrl) setNewUrl(prefillUrl); }, [prefillUrl]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;
    setIsAdding(true);
    setError(null);
    try {
      const lead = await createLead(newUrl.trim(), newStatus);
      setLeads((prev) => [lead, ...prev]);
      setNewUrl('');
      setNewStatus('in_queue');
    } catch (err: any) {
      setError(err.message || 'Could not add lead.');
    } finally {
      setIsAdding(false);
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

  const visibleLeads = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px 0' }}>Lead Register</h2>
        <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
          A lean pipeline tracker — who you've scanned, who's worth following up with. Not scan evidence, just operator intent.
        </div>
      </div>

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Store URL (e.g., prospect-store.com)"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          style={{ flex: 2, minWidth: '220px', padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
        />
        <select
          value={newStatus}
          onChange={(e) => setNewStatus(e.target.value as LeadStatus)}
          style={{ padding: '10px 12px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', color: '#fff', fontSize: '0.9rem' }}
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={isAdding || !newUrl.trim()}
          style={{ backgroundColor: '#b45309', color: '#fff', border: 'none', padding: '0 24px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          {isAdding ? 'Adding...' : '+ Add Lead'}
        </button>
      </form>

      {error && (
        <div style={{ marginBottom: '12px', color: '#fca5a5', fontSize: '0.82rem', backgroundColor: 'rgba(229,72,77,0.08)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
          ❌ {error}
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
          {leads.length === 0 ? 'No leads yet — add a store URL above to start tracking.' : 'No leads match this filter.'}
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
                    style={{ backgroundColor: 'transparent', color: '#fca5a5', border: '1px solid #475569', borderRadius: '6px', padding: '5px 9px', fontSize: '0.78rem', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '4px' }}>
                Added {new Date(lead.createdAt).toLocaleDateString()}
                {lead.updatedAt !== lead.createdAt ? ` · updated ${new Date(lead.updatedAt).toLocaleDateString()}` : ''}
              </div>
              <input
                type="text"
                defaultValue={lead.notes}
                placeholder="Notes (saved on blur)..."
                onBlur={(e) => handleNotesBlur(lead.id, e.target.value)}
                style={{ width: '100%', marginTop: '8px', padding: '7px 10px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#e2e8f0', fontSize: '0.8rem', outline: 'none' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
