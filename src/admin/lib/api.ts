/**
 * Every call to `/api/admin` (one Vercel function routed by `?op=`, api/_lib/adminTypes.ts has the payloads).
 * A 401 means the session lapsed: the caller's `onUnauthorized` sends the page back to sign-in rather than
 * leaving a dashboard full of errors. Any other failure is a toast, and the call resolves to null.
 */
import { toast } from './toast';

export type AdminOp = 'session' | 'visitors' | 'visitor' | 'insights';

/** `/api/admin?op=visitor&id=…`. */
export function adminUrl(op: AdminOp, params: Record<string, string | number> = {}): string {
  const q = new URLSearchParams({ op, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return `/api/admin?${q}`;
}

export interface ApiCallOptions {
  errorMessage?: string;
  onUnauthorized?: () => void;
}

export async function apiCall<T = unknown>(url: string, init?: RequestInit, options: ApiCallOptions = {}): Promise<T | null> {
  const { errorMessage = 'Request failed.', onUnauthorized } = options;
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    if (res.status === 401) {
      if (onUnauthorized) onUnauthorized();
      else toast.error(errorMessage);
      return null;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error || errorMessage);
      return null;
    }
    // A 204 (DELETE) has no body; resolve to something truthy so callers can tell success from failure.
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  } catch {
    toast.error('Network error.');
    return null;
  }
}
