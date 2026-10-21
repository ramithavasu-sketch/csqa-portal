// Setmore API (access approved for the QA account). The refresh token lives only in the
// SETMORE_REFRESH_TOKEN function secret; an access token is fetched per run.
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

export async function setmoreGet(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** dd-MM-yyyy, the format Setmore's appointment search expects */
export const smDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
