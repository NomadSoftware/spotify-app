import { API_BASE } from './config';
import { getAccessToken } from './auth';

export interface ApiOptions {
  method?: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class SpotifyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawApi(path: string, opts: ApiOptions = {}): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return res;
}

export async function api<T = undefined>(path: string, opts: ApiOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await rawApi(path, opts);

    if (res.status === 401 && attempt === 1) {
      // Access token was revoked/expired beyond our refresh margin: force a
      // refresh (throws if the session is unrecoverable) and retry once.
      await getAccessToken();
      continue;
    }
    if (res.status === 429 && attempt <= 3) {
      const retryAfter = Math.min(Number(res.headers.get('Retry-After') ?? '2'), 60);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    if (res.status === 204 || res.status === 304) return undefined as T;
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const json = (await res.json()) as { error?: { message?: string } };
        if (json.error?.message) message = `${res.status} — ${json.error.message}`;
      } catch {
        /* non-JSON error body */
      }
      throw new SpotifyApiError(res.status, message);
    }
    return (await res.json()) as T;
  }
}

/** Walk an offset-paginated collection endpoint and return every item. */
export async function paged<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  const limit = (params.limit as number | undefined) ?? 50;
  for (;;) {
    const page = await api<{ total: number; items: T[] }>(path, { params: { ...params, limit, offset } });
    out.push(...page.items);
    if (page.items.length === 0 || out.length >= page.total) return out;
    offset += page.items.length;
  }
}
