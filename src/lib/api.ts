import { API_BASE } from './config';
import { getAccessToken, refreshAccessToken } from './auth';

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
      // Token rejected despite a locally-valid expiry (server-side revocation,
      // clock skew): unconditionally refresh and retry once.
      await refreshAccessToken();
      continue;
    }
    if (res.status === 429 && attempt <= 3) {
      const parsed = Number(res.headers.get('Retry-After') ?? '2');
      const retryAfter = Number.isFinite(parsed) ? Math.min(parsed, 60) : 2;
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
    // Write endpoints (e.g. /me/library) return 200 with an empty body.
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SpotifyApiError(res.status, `Unexpected non-JSON response: ${text.slice(0, 120)}`);
    }
  }
}

/** Walk an offset-paginated collection endpoint and return every item. */
export async function paged<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  const limit = typeof params.limit === 'number' ? params.limit : 50;
  for (;;) {
    const page = await api<{ total: number; items: T[] }>(path, { params: { ...params, limit, offset } });
    if (!page || !Array.isArray(page.items)) {
      // A 204-shaped body would otherwise crash on `.items` below.
      throw new SpotifyApiError(200, `Unexpected empty response shape from ${path}`);
    }
    out.push(...page.items);
    if (page.items.length === 0 || out.length >= page.total) return out;
    offset += page.items.length;
  }
}
