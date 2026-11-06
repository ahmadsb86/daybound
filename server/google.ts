import { env } from './http.js';
import { K, redis } from './redis.js';

// calendar.app.created: may create its own secondary calendars and manage events on those only.
// It cannot read or touch any of your other calendars.
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created'];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GoogleAuthError extends Error {}

export function authUrl(redirectUri: string, state: string, consent: boolean, hint?: string): string {
  const p = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
    prompt: consent ? 'consent' : 'select_account',
  });
  if (hint) p.set('login_hint', hint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
  return data;
}

/** The ID token came straight from Google's token endpoint over TLS, so decoding without verifying the signature is fine. */
export function idTokenClaims(idToken: string | undefined): { email?: string; email_verified?: boolean } {
  if (!idToken) return {};
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function cacheAccessToken(token: string, expiresIn: number): Promise<void> {
  await redis('SET', K.access, token, 'EX', Math.max(60, expiresIn - 120));
}

/** A valid access token for Calendar, or null if Google was never connected. */
export async function accessToken(): Promise<string | null> {
  const cached = await redis<string | null>('GET', K.access);
  if (cached) return cached;
  const refresh = await redis<string | null>('GET', K.refresh);
  if (!refresh) return null;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      await redis('DEL', K.refresh);
      throw new GoogleAuthError('Google access expired or was revoked. Type login to reconnect.');
    }
    throw new Error(data.error_description || data.error || `Google token refresh failed (${res.status})`);
  }
  await cacheAccessToken(data.access_token, data.expires_in);
  return data.access_token;
}
