export type LeadStatus = 'not_contacted' | 'contacted' | 'interested' | 'not_interested' | 'in_progress';

export const LEAD_STATUSES: LeadStatus[] = ['not_contacted', 'contacted', 'interested', 'not_interested', 'in_progress'];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  not_contacted: 'Not contacted',
  contacted: 'Contacted',
  interested: 'Interested',
  not_interested: 'Not interested',
  in_progress: 'In progress',
};

import type { SurfaceAuditResult, DeepScanResult } from './auditLogic';

export interface LeadScanCache {
  scannedAt: string; // ISO timestamp
  surfaceResult: SurfaceAuditResult;
  deepScan: DeepScanResult | null;
  /** Finding ids from this scan's diagnostic report (e.g. 'no-cmp-with-active-tags'), excluding info-only/all-clear findings — the searchable "common cause" keywords for this lead. */
  causeTags?: string[];
}

export interface Lead {
  id: string;
  storeUrl: string;
  storeName: string;
  status: LeadStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Cached evidence from the last scan run from the Leads tab. Null/absent until "Scan"/"Re-scan" is clicked — never written silently. */
  lastScan?: LeadScanCache | null;
}

const PROXY_BASE = '/api';

async function readJsonOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export async function fetchLeads(): Promise<Lead[]> {
  const res = await fetch(`${PROXY_BASE}/leads`);
  const body = await readJsonOrThrow(res);
  return body.leads || [];
}

export async function createLead(storeUrl: string, status: LeadStatus = 'not_contacted', storeName = ''): Promise<Lead> {
  const res = await fetch(`${PROXY_BASE}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeUrl, status, storeName }),
  });
  const body = await readJsonOrThrow(res);
  return body.lead;
}

export async function updateLead(id: string, patch: Partial<Pick<Lead, 'status' | 'notes' | 'storeName' | 'lastScan'>>): Promise<Lead> {
  const res = await fetch(`${PROXY_BASE}/leads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await readJsonOrThrow(res);
  return body.lead;
}

export async function deleteLead(id: string): Promise<void> {
  const res = await fetch(`${PROXY_BASE}/leads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await readJsonOrThrow(res);
}
