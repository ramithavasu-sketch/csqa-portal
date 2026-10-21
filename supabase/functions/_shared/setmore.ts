// Setmore API (access approved for the QA account). The refresh token lives only in the
// SETMORE_REFRESH_TOKEN function secret. Setmore voids the previous access token when a new one
// is issued, so one access token is shared (app_secrets 'setmore_access') and renewed on a 401.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './auth.ts';

const BASE = 'https://developer.setmore.com/api/v1';

export async function setmoreToken(): Promise<string> {
  const rt = (Deno.env.get('SETMORE_REFRESH_TOKEN') ?? '').trim();
  if (!rt) throw new HttpError(501, 'Setmore is not connected: add the SETMORE_REFRESH_TOKEN secret');
  const res = await fetch(`${BASE}/o/oauth2/token?refreshToken=${encodeURIComponent(rt)}`);
  const body = await res.json().catch(() => ({}));
  const t = body?.data?.token?.access_token ?? body?.access_token;
  if (!res.ok || !t) throw new HttpError(502, `Setmore sign-in failed (${res.status}): ${body?.msg ?? body?.error ?? 'no access token returned'}`);
  return t;
}

/** Setmore caller with a shared access token; renews it once if Setmore says it expired. */
export function setmoreClient(sb: SupabaseClient) {
  let token = '';
  const fresh = async () => {
    token = await setmoreToken();
    await sb.from('app_secrets').upsert({ key: 'setmore_access', value: token, updated_at: new Date().toISOString() });
  };
  const call = async (method: string, path: string, payload?: unknown, retry = true): Promise<{ ok: boolean; status: number; body: any }> => {   // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!token) {
      const { data } = await sb.from('app_secrets').select('value, updated_at').eq('key', 'setmore_access').maybeSingle();
      if (data?.value && Date.now() - Date.parse(data.updated_at) < 50 * 60000) token = data.value; else await fresh();
    }
    const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    if (r.status === 401 && retry) { await fresh(); return call(method, path, payload, false); }
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, get: (path: string) => call('GET', path) };
}

export async function setmoreGet(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** dd-MM-yyyy, the format Setmore's appointment search expects */
export const smDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
