import { isValidTimeZone, todayInTz } from '../src/lib/dates.js';
import { sanitizeTask, type Task } from '../src/lib/types.js';
import { reconcile } from '../server/gcal.js';
import { errorMessage, json } from '../server/http.js';
import { K, pairs, pipeline, redis } from '../server/redis.js';
import { getSession } from '../server/session.js';

const MAX_CHANGES = 500;
// Re-send a little history every time so writes that commit out of order are never missed.
const CURSOR_OVERLAP_MS = 30_000;

function parse(v: unknown): Task | null {
  if (typeof v !== 'string') return null;
  try {
    return sanitizeTask(JSON.parse(v));
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!getSession(req)) return json({ error: 'Signed out' }, 401);
    const body = (await req.json().catch(() => null)) as { since?: unknown; changes?: unknown; tz?: unknown } | null;
    if (!body) return json({ error: 'Bad request' }, 400);

    const since = typeof body.since === 'number' && body.since > 0 ? body.since : 0;
    const raw = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
    const tz = isValidTimeZone(body.tz) ? body.tz : null;
    const now = Date.now();

    // newest version per id within this batch
    const incoming = new Map<string, Task>();
    for (const r of raw) {
      const t = sanitizeTask(r);
      if (t && (!incoming.has(t.id) || incoming.get(t.id)!.updatedAt < t.updatedAt)) incoming.set(t.id, t);
    }

    // last write wins against what the server already has
    const accepted: string[] = [];
    if (incoming.size) {
      const ids = [...incoming.keys()];
      const existing = await redis<Array<string | null>>('HMGET', K.tasks, ...ids);
      const fields: string[] = [];
      ids.forEach((id, i) => {
        const prev = parse(existing[i]);
        const next = incoming.get(id)!;
        if (!prev || next.updatedAt > prev.updatedAt) {
          fields.push(id, JSON.stringify(next));
          accepted.push(id);
        }
      });
      if (accepted.length) {
        await pipeline([
          ['HSET', K.tasks, ...fields],
          ['ZADD', K.ts, ...accepted.flatMap((id) => [now, id])],
          ['SADD', K.pending, ...accepted],
        ]);
      }
    }
    if (tz) await redis('SET', K.tz, tz);

    // everything that changed since the client's cursor (or everything, the first time)
    let tasks: Task[] = [];
    if (!since) {
      tasks = pairs(await redis('HGETALL', K.tasks)).map(([, v]) => parse(v)).filter((t): t is Task => !!t);
    } else {
      const ids = await redis<string[]>('ZRANGEBYSCORE', K.ts, since, '+inf');
      if (ids.length) {
        const vals = await redis<Array<string | null>>('HMGET', K.tasks, ...ids);
        tasks = vals.map(parse).filter((t): t is Task => !!t);
      }
    }

    // mirror to Google Calendar: changed tasks now, and a full pass once per day
    const gcal: { connected: boolean; error: string | null } = { connected: false, error: null };
    try {
      const [hasRefresh, lastFull, savedTz] = await pipeline([
        ['EXISTS', K.refresh],
        ['GET', K.full],
        ['GET', K.tz],
      ]);
      gcal.connected = Number(hasRefresh) === 1;
      if (gcal.connected) {
        const today = todayInTz(typeof savedTz === 'string' ? savedTz : 'UTC');
        const full = lastFull !== today;
        if (full || accepted.length) {
          const r = await reconcile({ full, ids: accepted });
          gcal.connected = r.connected;
          gcal.error = r.error ?? null;
        }
      }
      if (!gcal.error) gcal.error = await redis<string | null>('GET', K.err);
    } catch (e) {
      gcal.error = errorMessage(e);
    }

    return json({ cursor: now - CURSOR_OVERLAP_MS, tasks, gcal });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}
