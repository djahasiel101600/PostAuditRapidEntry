/**
 * Client helpers for the server-side PhilGEPS registered-merchants lookup.
 * The backend proxies and caches https://philgeps.gov.ph lookups; the browser
 * never contacts the government site directly.
 */

import { apiFetch } from './api';

export interface PhilGepsMerchant {
  name: string;
  merchantType: string;
  /** ISO yyyy-mm-dd — date the merchant was approved in PhilGEPS. */
  redApprovalDate: string;
  status: string;
  activity: string;
  issuedDate: string;
  expiresDate: string;
  refNumber: string;
}

export interface PhilGepsLookupResponse {
  query: string;
  cached: boolean;
  match: PhilGepsMerchant | null;
  results: PhilGepsMerchant[];
}

export function lookupPhilGepsMerchant(name: string): Promise<PhilGepsLookupResponse> {
  return apiFetch<PhilGepsLookupResponse>(
    `/philgeps/merchants/?name=${encodeURIComponent(name.trim())}`,
  );
}

/** ISO yyyy-mm-dd -> MM-DD-YYYY (matches the "01-03-2026" field style). */
export function formatPhilGepsDate(iso: string): string {
  const parts = (iso || '').split('-');
  if (parts.length !== 3) return '';
  const [year, month, day] = parts;
  if (!year || !month || !day) return '';
  return `${month}-${day}-${year}`;
}
