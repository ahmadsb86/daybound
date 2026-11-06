/*
 * One-way mirror: every open task becomes an all-day event on a dedicated "Daybound" calendar.
 * Resolved or deleted tasks lose their event. Overdue tasks are extended to today and marked.
 *
 * What was last pushed for each task is stored as a hash, so a pass only calls Google for tasks
 * whose event would actually change. A lock keeps two devices syncing at once from creating
 * duplicate events; whatever the lock skipped stays in the pending set for the next pass.
 */

import { createHash } from 'node:crypto';
import { addDays, todayInTz } from '../src/lib/dates.js';
import { effectiveEnd, groupOf, hashString, INBOX, overdueDays } from '../src/lib/tasks.js';
import { sanitizeTask, type Task } from '../src/lib/types.js';
import { accessToken } from './google.js';
import { errorMessage } from './http.js';
import { K, pairs, pipeline, redis } from './redis.js';

const API = 'https://www.googleapis.com/calendar/v3';

class CalendarGone extends Error {}

interface MapEntry {
  e: string;
  h: string;
}

export interface ReconcileResult {
  connected: boolean;
  skipped?: boolean;
  changed?: number;
  error?: string | null;
}

async function gfetch(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function gError(what: string, r: { status: number; data: any }): Error {
  return new Error(`${what} failed (${r.status}): ${r.data?.error?.message ?? 'unknown error'}`);
}

function desiredEvent(t: Task, today: string): Record<string, unknown> | null {
  if (t.deleted || t.resolvedAt) return null;
  const end = effectiveEnd(t, today);
  const over = overdueDays(t, today);
  const group = groupOf(t);
  const lines = [
    t.tags.length ? t.tags.map((x) => `#${x}`).join(' ') : '',
    `Planned ${t.start}${t.start === t.end ? '' : ` to ${t.end}`}`,
    over ? `Planned days ended ${over} day${over === 1 ? '' : 's'} ago. Still open.` : '',
    'Managed by Daybound. Changes made here are overwritten.',
  ].filter(Boolean);
  return {
    summary: over ? `⚠ ${t.title} (${over}d over)` : t.title,
    description: lines.join('\n'),
    start: { date: t.start },
    end: { date: addDays(end, 1) }, // all-day end dates are exclusive
    status: 'confirmed',
    transparency: 'transparent', // tasks don't make you look busy
    reminders: { useDefault: false },
    ...(group === INBOX ? {} : { colorId: String((hashString(group) % 11) + 1) }),
    extendedProperties: { private: { dayboundId: t.id } },
  };
}

function hashOf(ev: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(ev)).digest('hex').slice(0, 16);
}

async function ensureCalendar(token: string, tz: string): Promise<string> {
  const existing = await redis<string | null>('GET', K.cal);
  if (existing) return existing;
  const r = await gfetch(token, 'POST', '/calendars', {
    summary: 'Daybound',
    description: 'Tasks from Daybound, as all-day events. Edit tasks in Daybound; changes here are overwritten.',
    timeZone: tz,
  });
  if (r.status >= 300 || !r.data?.id) throw gError('Creating the Daybound calendar', r);
  await pipeline([
    ['SET', K.cal, r.data.id],
    ['DEL', K.map],
  ]);
  return r.data.id;
}

async function applyOne(
  token: string,
  calId: string,
  desired: Record<string, unknown> | null,
  entry: MapEntry | null,
): Promise<MapEntry | null> {
  const cal = `/calendars/${encodeURIComponent(calId)}/events`;
  if (!desired) {
    if (entry) {
      const r = await gfetch(token, 'DELETE', `${cal}/${encodeURIComponent(entry.e)}`);
      if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw gError('Deleting an event', r);
    }
    return null;
  }
  const h = hashOf(desired);
  if (entry) {
    const r = await gfetch(token, 'PATCH', `${cal}/${encodeURIComponent(entry.e)}`, desired);
    if (r.status < 300) return { e: entry.e, h };
    if (r.status !== 404 && r.status !== 410) throw gError('Updating an event', r);
  }
  const r = await gfetch(token, 'POST', cal, desired);
  if (r.status === 404) throw new CalendarGone();
  if (r.status >= 300 || !r.data?.id) throw gError('Creating an event', r);
  return { e: r.data.id, h };
}

function parseEntry(v: unknown): MapEntry | null {
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v);
    return typeof o.e === 'string' && typeof o.h === 'string' ? o : null;
  } catch {
    return null;
  }
}

function parseTask(v: unknown): Task | null {
  if (typeof v !== 'string') return null;
  try {
    return sanitizeTask(JSON.parse(v));
  } catch {
    return null;
  }
}

async function pass(full: boolean, extraIds: string[], retry: boolean): Promise<ReconcileResult> {
  let token: string | null;
  try {
    token = await accessToken();
  } catch (e) {
    const error = errorMessage(e);
    await redis('SET', K.err, error);
    return { connected: false, error };
  }
  if (!token) return { connected: false };

  const tz = (await redis<string | null>('GET', K.tz)) || 'UTC';
  const today = todayInTz(tz);

  try {
    const calId = await ensureCalendar(token, tz);
    if (full) {
      // unchanged tasks make no calls, so check once per pass that the calendar still exists
      const r = await gfetch(token, 'GET', `/calendars/${encodeURIComponent(calId)}`);
      if (r.status === 404 || r.status === 410) throw new CalendarGone();
    }
    const tasks = new Map<string, Task | null>();
    const entries = new Map<string, MapEntry | null>();
    const pendingIds = (await redis<string[]>('SMEMBERS', K.pending)) ?? [];

    if (full) {
      const [tflat, mflat] = await pipeline([
        ['HGETALL', K.tasks],
        ['HGETALL', K.map],
      ]);
      for (const [id, v] of pairs(tflat)) tasks.set(id, parseTask(v));
      for (const [id, v] of pairs(mflat)) entries.set(id, parseEntry(v));
    } else {
      const ids = [...new Set([...extraIds, ...pendingIds])];
      if (!ids.length) return { connected: true, changed: 0, error: null };
      const [tv, mv] = await pipeline([
        ['HMGET', K.tasks, ...ids],
        ['HMGET', K.map, ...ids],
      ]);
      ids.forEach((id, i) => {
        tasks.set(id, parseTask((tv as unknown[])[i]));
        entries.set(id, parseEntry((mv as unknown[])[i]));
      });
    }

    const ids = [...new Set([...tasks.keys(), ...entries.keys()])];
    const jobs: Array<() => Promise<void>> = [];
    const set: string[] = [];
    const del: string[] = [];
    const errors: string[] = [];
    const failed = new Set<string>();
    let gone = false;

    for (const id of ids) {
      const task = tasks.get(id) ?? null;
      const entry = entries.get(id) ?? null;
      const desired = task ? desiredEvent(task, today) : null;
      if (!desired && !entry) continue;
      if (desired && entry && entry.h === hashOf(desired)) continue;
      jobs.push(async () => {
        try {
          const next = await applyOne(token!, calId, desired, entry);
          if (next) set.push(id, JSON.stringify(next));
          else del.push(id);
        } catch (e) {
          failed.add(id);
          if (e instanceof CalendarGone) gone = true;
          else errors.push(errorMessage(e));
        }
      });
    }

    // a few at a time keeps well under Calendar API rate limits
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (next < jobs.length && !gone) await jobs[next++]();
      }),
    );

    const writes: Array<Array<string | number>> = [];
    if (set.length) writes.push(['HSET', K.map, ...set]);
    if (del.length) writes.push(['HDEL', K.map, ...del]);
    if (gone) throw new CalendarGone();
    if (full) writes.push(['SET', K.full, today]);
    const done = pendingIds.filter((id) => !failed.has(id));
    if (done.length) writes.push(['SREM', K.pending, ...done]);
    if (failed.size) writes.push(['SADD', K.pending, ...failed]);
    writes.push(errors.length ? ['SET', K.err, errors[0]] : ['DEL', K.err]);
    await pipeline(writes);
    return { connected: true, changed: set.length / 2 + del.length, error: errors[0] ?? null };
  } catch (e) {
    if (e instanceof CalendarGone && retry) {
      // someone deleted the calendar in Google: make a new one and push everything again
      await pipeline([
        ['DEL', K.cal],
        ['DEL', K.map],
      ]);
      return pass(true, [], false);
    }
    const error = errorMessage(e);
    await redis('SET', K.err, error).catch(() => undefined);
    return { connected: true, error };
  }
}

export async function reconcile(opts: { full: boolean; ids?: string[] }): Promise<ReconcileResult> {
  const got = await redis<string | null>('SET', K.lock, '1', 'NX', 'EX', 90);
  if (got !== 'OK') return { connected: true, skipped: true };
  try {
    return await pass(opts.full, opts.ids ?? [], true);
  } finally {
    await redis('DEL', K.lock).catch(() => undefined);
  }
}
