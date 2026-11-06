// End-to-end check of the API routes against an in-memory Redis and a fake Google.
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInTz } from '../src/lib/dates';
import type { Task } from '../src/lib/types';

process.env.KV_REST_API_URL = 'https://redis.test';
process.env.KV_REST_API_TOKEN = 'tok';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.ALLOWED_EMAIL = 'me@example.com';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.APP_URL = 'https://daybound.test';
process.env.CRON_SECRET = 'cron';

/* ---------- fake Redis ---------- */
let db = new Map<string, any>();
function redisExec(cmd: string[]): any {
  const [c, k, ...a] = cmd;
  const hash = () => (db.get(k) as Map<string, string>) ?? db.set(k, new Map()).get(k);
  const set = () => (db.get(k) as Set<string>) ?? db.set(k, new Set()).get(k);
  switch (c.toUpperCase()) {
    case 'GET': return typeof db.get(k) === 'string' ? db.get(k) : null;
    case 'SET': {
      if (a.includes('NX') && db.has(k)) return null;
      db.set(k, a[0]);
      return 'OK';
    }
    case 'GETDEL': { const v = db.get(k) ?? null; db.delete(k); return v; }
    case 'DEL': return db.delete(k) ? 1 : 0;
    case 'EXISTS': return db.has(k) ? 1 : 0;
    case 'HSET': { const h = hash(); for (let i = 0; i < a.length; i += 2) h.set(a[i], a[i + 1]); return a.length / 2; }
    case 'HMGET': { const h = db.get(k) as Map<string, string> | undefined; return a.map((f) => h?.get(f) ?? null); }
    case 'HGETALL': { const h = db.get(k) as Map<string, string> | undefined; return h ? [...h.entries()].flat() : []; }
    case 'HDEL': { const h = db.get(k) as Map<string, string> | undefined; a.forEach((f) => h?.delete(f)); return a.length; }
    case 'ZADD': { const z = hash(); for (let i = 0; i < a.length; i += 2) z.set(a[i + 1], a[i]); return 1; }
    case 'ZRANGEBYSCORE': {
      const z = (db.get(k) as Map<string, string>) ?? new Map();
      return [...z.entries()].filter(([, s]) => Number(s) >= Number(a[0])).map(([m]) => m);
    }
    case 'SADD': { const s = set(); a.forEach((m) => s.add(m)); return 1; }
    case 'SMEMBERS': return [...((db.get(k) as Set<string>) ?? [])];
    case 'SREM': { const s = db.get(k) as Set<string> | undefined; a.forEach((m) => s?.delete(m)); return 1; }
    default: throw new Error(`fake redis: ${c}`);
  }
}

/* ---------- fake Google ---------- */
let events = new Map<string, any>();
let calendars = new Set<string>();
let nextId = 1;
const calls: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const body = init.body ? (typeof init.body === 'string' ? init.body : init.body.toString()) : '';
  const res = (data: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://redis.test')) {
    const parsed = JSON.parse(body);
    if (url.endsWith('/pipeline')) return res(parsed.map((c: string[]) => ({ result: redisExec(c) })));
    return res({ result: redisExec(parsed) });
  }
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      const claims = Buffer.from(JSON.stringify({ email: 'me@example.com', email_verified: true })).toString('base64url');
      return res({ access_token: 'at1', expires_in: 3600, refresh_token: 'rt1', id_token: `h.${claims}.s`, scope: 'openid email https://www.googleapis.com/auth/calendar.app.created' });
    }
    return res({ access_token: 'at2', expires_in: 3600 });
  }
  const g = url.match(/^https:\/\/www\.googleapis\.com\/calendar\/v3(\/calendars(?:\/([^/]+))?(?:\/events(?:\/([^/?]+))?)?)/);
  if (g) {
    const method = init.method ?? 'GET';
    const cal = g[2] && decodeURIComponent(g[2]);
    const ev = g[3] && decodeURIComponent(g[3]);
    calls.push(`${method} ${ev ? 'event' : cal ? 'events' : 'calendars'}`);
    if (!cal && method === 'POST') { const id = `cal${nextId++}`; calendars.add(id); return res({ id }); }
    if (cal && !calendars.has(cal)) return res({ error: { message: 'Not Found' } }, 404);
    if (cal && !g[0].includes('/events') && method === 'GET') return res({ id: cal });
    if (!ev && method === 'POST') { const id = `ev${nextId++}`; events.set(id, JSON.parse(body)); return res({ id, ...JSON.parse(body) }); }
    if (ev && method === 'PATCH') { if (!events.has(ev)) return res({ error: { message: 'gone' } }, 404); events.set(ev, JSON.parse(body)); return res({ id: ev }); }
    if (ev && method === 'DELETE') { if (!events.has(ev)) return res(null, 410); events.delete(ev); return res(null, 204); }
  }
  return realFetch(input, init);
}) as typeof fetch;

/* ---------- helpers ---------- */
const { POST: sync } = await import('../api/sync');
const { POST: pair } = await import('../api/pair');
const { GET: login } = await import('../api/login');
const { GET: callback } = await import('../api/callback');
const { GET: cron } = await import('../api/cron');
const { sessionCookie } = await import('../server/session');

const TZ = 'America/New_York';
const today = todayInTz(TZ);
const cookie = sessionCookie('me@example.com').split(';')[0];

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, tags: ['school'], start: today, end: addDays(today, 2), createdAt: 1, updatedAt: 1, resolvedAt: null, deleted: false, ...patch };
}
async function doSync(changes: Task[], since = 0, withCookie = true) {
  const r = await sync(new Request('https://daybound.test/api/sync', {
    method: 'POST',
    headers: withCookie ? { cookie, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify({ since, changes, tz: TZ }),
  }));
  return { status: r.status, body: (await r.json()) as any };
}

beforeEach(() => {
  db = new Map();
  events = new Map();
  calendars = new Set();
  calls.length = 0;
});

describe('sync', () => {
  it('rejects requests without a session', async () => {
    expect((await doSync([], 0, false)).status).toBe(401);
  });

  it('stores tasks, last write wins, delta by cursor', async () => {
    const a = await doSync([task('a'), task('b')]);
    expect(a.status).toBe(200);
    expect(a.body.tasks.map((t: Task) => t.id).sort()).toEqual(['a', 'b']);
    // stale write loses
    await doSync([task('a', { title: 'old', updatedAt: 0 })]);
    // newer write wins
    await doSync([task('a', { title: 'new', updatedAt: 5 })]);
    const all = await doSync([]);
    expect(all.body.tasks.find((t: Task) => t.id === 'a').title).toBe('new');
    // delta: only recent writes come back after the cursor
    const later = await doSync([], Date.now() + 60_000);
    expect(later.body.tasks).toEqual([]);
    expect(all.body.gcal.connected).toBe(false);
  });
});

describe('google calendar mirror', () => {
  it('logs in with a calendar scope and stores the refresh token', async () => {
    const r = await login(new Request('https://daybound.test/api/login'));
    const loc = new URL(r.headers.get('location')!);
    expect(loc.host).toBe('accounts.google.com');
    expect(loc.searchParams.get('scope')).toContain('calendar.app.created');
    expect(loc.searchParams.get('prompt')).toBe('consent');
    const stateCookie = r.headers.get('set-cookie')!.split(';')[0];
    const cb = await callback(new Request(`https://daybound.test/api/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { cookie: stateCookie } }));
    expect(cb.headers.get('location')).toBe('/?signed_in=1');
    expect(cb.headers.get('set-cookie')).toContain('db_session=');
    expect(db.get('db:g:refresh')).toBe('rt1');
  });

  it('creates, updates and removes all-day events', async () => {
    db.set('db:g:refresh', 'rt1');
    const r1 = await doSync([task('a')]);
    expect(r1.body.gcal).toEqual({ connected: true, error: null });
    const [ev] = [...events.values()];
    expect(ev.start).toEqual({ date: today });
    expect(ev.end).toEqual({ date: addDays(today, 3) }); // exclusive end
    expect(ev.transparency).toBe('transparent');

    // unchanged task: no Google calls
    calls.length = 0;
    await doSync([task('a', { updatedAt: 2 })]);
    expect(calls).toEqual([]);

    // rename patches the same event
    await doSync([task('a', { title: 'renamed', updatedAt: 3 })]);
    expect(events.size).toBe(1);
    expect([...events.values()][0].summary).toBe('renamed');

    // resolving removes it
    await doSync([task('a', { resolvedAt: 9, updatedAt: 4 })]);
    expect(events.size).toBe(0);
  });

  it('gives the fixed groups their matching Google colors', async () => {
    db.set('db:g:refresh', 'rt1');
    await doSync([
      task('a', { tags: ['aca'] }),
      task('e', { tags: ['eca'] }),
      task('m', { tags: ['msc'] }),
      task('p', { tags: ['prs'] }),
    ]);
    const byTitle = new Map([...events.values()].map((e) => [e.summary, e.colorId]));
    expect(byTitle.get('task a')).toBe('11'); // Tomato, red
    expect(byTitle.get('task e')).toBe('5'); // Banana, golden
    expect(byTitle.get('task m')).toBe('4'); // Flamingo, pink
    expect(byTitle.get('task p')).toBe('7'); // Peacock, teal
  });

  it('rolls overdue tasks forward to today and marks them', async () => {
    db.set('db:g:refresh', 'rt1');
    await doSync([task('late', { start: addDays(today, -5), end: addDays(today, -2) })]);
    const [ev] = [...events.values()];
    expect(ev.summary).toBe('⚠ task late (2d over)');
    expect(ev.end).toEqual({ date: addDays(today, 1) });
  });

  it('never mirrors long-term tasks, and removes the event if one becomes long term', async () => {
    db.set('db:g:refresh', 'rt1');
    await doSync([task('lt1', { tags: ['lt'] })]);
    expect(events.size).toBe(0);

    // a dated task that is later moved into the long-term group loses its event
    await doSync([task('a')]);
    expect(events.size).toBe(1);
    await doSync([task('a', { tags: ['lt'], updatedAt: 2 })]);
    expect(events.size).toBe(0);

    // a full pass does not resurrect it
    db.delete('db:gcal:full');
    await cron(new Request('https://daybound.test/api/cron', { headers: { authorization: 'Bearer cron' } }));
    expect(events.size).toBe(0);
  });

  it('cron does a full pass and recreates a deleted calendar', async () => {
    db.set('db:g:refresh', 'rt1');
    await doSync([task('a'), task('b')]);
    expect(events.size).toBe(2);
    calendars.clear(); // user deleted the calendar in Google
    events.clear();
    db.delete('db:gcal:full');
    const unauth = await cron(new Request('https://daybound.test/api/cron'));
    expect(unauth.status).toBe(401);
    const r = await cron(new Request('https://daybound.test/api/cron', { headers: { authorization: 'Bearer cron' } }));
    expect((await r.json()).error ?? null).toBeNull();
    expect(events.size).toBe(2);
    expect(calendars.size).toBe(1);
  });
});

describe('pairing', () => {
  it('a signed-in device mints a one-time code another device can redeem', async () => {
    const mint = await pair(new Request('https://daybound.test/api/pair', { method: 'POST', headers: { cookie }, body: '{}' }));
    const { code } = (await mint.json()) as any;
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const redeem = await pair(new Request('https://daybound.test/api/pair', { method: 'POST', body: JSON.stringify({ code: code.toLowerCase() }) }));
    expect(redeem.status).toBe(200);
    expect(redeem.headers.get('set-cookie')).toContain('db_session=');
    const again = await pair(new Request('https://daybound.test/api/pair', { method: 'POST', body: JSON.stringify({ code }) }));
    expect(again.status).toBe(400);
  });
});
