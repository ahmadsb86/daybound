import { sanitizeTask, type Task } from '../lib/types';
import { store } from './store';

export type SyncState = 'demo' | 'idle' | 'syncing' | 'synced' | 'offline' | 'signedout' | 'error';

export const syncStatus = {
  state: 'idle' as SyncState,
  lastSync: 0,
  message: '',
  gcal: { connected: false, error: null as string | null },
};

const listeners = new Set<() => void>();
export function onSyncStatus(fn: () => void): void {
  listeners.add(fn);
}
function set(state: SyncState, message = ''): void {
  syncStatus.state = state;
  syncStatus.message = message;
  for (const fn of listeners) fn();
}

const BATCH = 200;
let demo = false;
let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function initSync(opts: { demo: boolean }): void {
  demo = opts.demo;
  if (demo) {
    set('demo');
    return;
  }
  store.onLocalChange = () => scheduleSync(400);
  window.addEventListener('online', () => scheduleSync(0));
  window.addEventListener('offline', () => set('offline', 'offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  });
  window.addEventListener('focus', () => scheduleSync(0));
  setInterval(() => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  }, 120_000);
  scheduleSync(0);
}

export function scheduleSync(delay: number): void {
  if (demo) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

export async function syncNow(): Promise<void> {
  if (demo) return;
  if (running) {
    again = true;
    return;
  }
  if (!navigator.onLine) {
    set('offline', 'offline');
    return;
  }
  running = true;
  set('syncing');
  try {
    // Push in batches so a long offline stretch never builds one giant request.
    for (let round = 0; round < 20; round++) {
      const ids = [...store.dirty].slice(0, BATCH);
      const sent = ids.map((id) => store.tasks[id]).filter((t): t is Task => !!t);
      const versions = new Map(sent.map((t) => [t.id, t.updatedAt]));
      const res = await fetch('/api/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          since: store.cursor,
          changes: sent,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (res.status === 401) {
        store.signedIn = false;
        store.save();
        set('signedout');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Sync failed (${res.status})`);
      }
      const data = await res.json();
      for (const [id, v] of versions) if (store.tasks[id]?.updatedAt === v) store.dirty.delete(id);
      for (const id of ids) if (!store.tasks[id]) store.dirty.delete(id);
      const remote = (Array.isArray(data.tasks) ? data.tasks : []).map(sanitizeTask).filter(Boolean) as Task[];
      store.mergeRemote(remote);
      store.cursor = typeof data.cursor === 'number' ? data.cursor : store.cursor;
      store.signedIn = true;
      syncStatus.gcal = {
        connected: !!data.gcal?.connected,
        error: typeof data.gcal?.error === 'string' ? data.gcal.error : null,
      };
      store.save();
      store.emit();
      if (ids.length < BATCH) break;
    }
    syncStatus.lastSync = Date.now();
    set('synced');
  } catch (e) {
    set(navigator.onLine ? 'error' : 'offline', e instanceof Error ? e.message : String(e));
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleSync(0);
    }
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function logout(): Promise<void> {
  await post('/api/logout', {}).catch(() => undefined);
  store.signedIn = false;
  store.cursor = 0;
  store.save();
  set('signedout');
}

export async function createPairCode(): Promise<string> {
  const r = await post('/api/pair', {});
  if (!r.ok) throw new Error(r.data.error || 'Couldn’t create a pairing code');
  return r.data.code;
}

export async function redeemPairCode(code: string): Promise<void> {
  const r = await post('/api/pair', { code });
  if (!r.ok) throw new Error(r.data.error || 'That code didn’t work');
  store.signedIn = true;
  store.save();
  await syncNow();
}
