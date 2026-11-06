import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './http.js';

const SESSION = 'db_session';
const STATE = 'db_state';
const DAY = 86_400_000;

function secret(): string {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return s;
}

export function allowedEmail(): string {
  return env('ALLOWED_EMAIL').trim().toLowerCase();
}

function sign(data: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function getSession(req: Request): { email: string } | null {
  const d = verify(readCookie(req, SESSION));
  if (!d || d.typ !== 'session' || typeof d.email !== 'string') return null;
  if (d.email !== allowedEmail()) return null;
  return { email: d.email };
}

export function sessionCookie(email: string): string {
  const days = 365;
  return cookie(SESSION, sign({ typ: 'session', email, exp: Date.now() + days * DAY }), days * 86_400);
}

export function clearSessionCookie(): string {
  return cookie(SESSION, '', 0);
}

export function newState(): { state: string; cookie: string } {
  const state = randomBytes(18).toString('base64url');
  return { state, cookie: cookie(STATE, sign({ typ: 'state', s: state, exp: Date.now() + 600_000 }), 600) };
}

export function checkState(req: Request, state: string | null): boolean {
  const d = verify(readCookie(req, STATE));
  return !!state && !!d && d.typ === 'state' && d.s === state;
}

export function clearStateCookie(): string {
  return cookie(STATE, '', 0);
}
