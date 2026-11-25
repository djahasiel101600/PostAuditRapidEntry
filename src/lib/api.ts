/**
 * REST API client for the Django backend (replaces Firebase SDK access).
 * JWT access/refresh tokens are stored in localStorage; 401s trigger a
 * single-flight refresh and one retry.
 */

const ACCESS_KEY = 'rci_access_token';
const REFRESH_KEY = 'rci_refresh_token';

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export function setTokens(access: string, refresh: string): void {
  try {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  } catch {
    // ignore storage failure
  }
}

export function clearTokens(): void {
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    // ignore storage failure
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    const doRefresh = async (): Promise<boolean> => {
      let refresh: string | null = null;
      try {
        refresh = localStorage.getItem(REFRESH_KEY);
      } catch {
        refresh = null;
      }
      if (!refresh) return false;
      try {
        const res = await fetch('/api/auth/refresh/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { access: string; refresh?: string };
        setTokens(data.access, data.refresh || refresh);
        return true;
      } catch {
        return false;
      }
    };
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function parseError(res: Response): Promise<ApiError> {
  let detail: unknown = null;
  try {
    detail = await res.json();
  } catch {
    // non-JSON error body
  }
  const message =
    detail && typeof detail === 'object' && 'detail' in detail
      ? String((detail as { detail: unknown }).detail)
      : `Request failed (${res.status})`;
  return new ApiError(res.status, message, detail);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () => {
    const headers = new Headers(init.headers);
    const token = getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(`/api${path}`, { ...init, headers });
  };

  let res = await doFetch();
  if (res.status === 401 && getAccessToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await doFetch();
    } else {
      clearTokens();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => apiFetch<T>(path);
export const apiPost = <T>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' });

export function logApiError(error: unknown, operation: string, path: string): void {
  console.error(`API Error (${operation} ${path}):`, error instanceof Error ? error.message : error);
}

/** Firestore-Timestamp-compatible shim so existing ts.toDate() callers keep working. */
export function wrapTimestamp(iso?: string): { toDate: () => Date } | undefined {
  if (!iso) return undefined;
  return { toDate: () => new Date(iso) };
}