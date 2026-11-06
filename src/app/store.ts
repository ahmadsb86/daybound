import { sanitizeTask, type Task } from '../lib/types';

const KEY = 'daybound:v1';

type Snapshot = Task | { id: string; missing: true };

class Store {
  tasks: Record<string, Task> = {};
  /** ids changed locally and not yet confirmed by the server */
  dirty = new Set<string>();
  /** server cursor for delta sync */
  cursor = 0;
  /** null = never checked */
  signedIn: boolean | null = null;
  history: string[] = [];

  onLocalChange: () => void = () => {};
  private listeners = new Set<() => void>();
  private undoStack: { label: string; before: Snapshot[] }[] = [];

  load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const tasks: Record<string, Task> = {};
      for (const v of Object.values(data.tasks ?? {})) {
        const t = sanitizeTask(v);
        if (t) tasks[t.id] = t;
      }
      this.tasks = tasks;
      this.dirty = new Set(Array.isArray(data.dirty) ? data.dirty.filter((id: unknown) => typeof id === 'string') : []);
      this.cursor = typeof data.cursor === 'number' ? data.cursor : 0;
      this.signedIn = typeof data.signedIn === 'boolean' ? data.signedIn : null;
      this.history = Array.isArray(data.history) ? data.history.filter((h: unknown) => typeof h === 'string').slice(-50) : [];
    } catch {
      // corrupt or unavailable storage: start empty
    }
  }

  save(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          tasks: this.tasks,
          dirty: [...this.dirty],
          cursor: this.cursor,
          signedIn: this.signedIn,
          history: this.history.slice(-50),
        }),
      );
    } catch {
      // storage full or blocked; the in-memory state still works
    }
  }

  /** Another tab or window changed storage. */
  watchOtherWindows(): void {
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      this.load();
      this.emit();
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  all(): Task[] {
    return Object.values(this.tasks);
  }

  nextVersion(prev?: Task): number {
    return Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1);
  }

  /** Apply local edits. Each call is one undo step. */
  commit(label: string, changes: Task[], undoable = true): void {
    if (!changes.length) return;
    const before: Snapshot[] = changes.map((c) =>
      this.tasks[c.id] ? { ...this.tasks[c.id] } : { id: c.id, missing: true as const },
    );
    for (const c of changes) {
      this.tasks[c.id] = c;
      this.dirty.add(c.id);
    }
    if (undoable) {
      this.undoStack.push({ label, before });
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    this.save();
    this.emit();
    this.onLocalChange();
  }

  update(t: Task, patch: Partial<Task>): Task {
    return { ...t, ...patch, updatedAt: this.nextVersion(t) };
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const changes: Task[] = [];
    for (const b of entry.before) {
      const cur = this.tasks[b.id];
      if ('missing' in b) {
        if (cur) changes.push(this.update(cur, { deleted: true }));
      } else {
        changes.push({ ...b, updatedAt: this.nextVersion(cur) });
      }
    }
    this.commit('undo', changes, false);
    return entry.label;
  }

  pushHistory(line: string): void {
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 50) this.history.shift();
    this.save();
  }

  /** Server data arrived. Local edits that are newer and still unsent win. */
  mergeRemote(remote: Task[]): void {
    for (const r of remote) {
      const local = this.tasks[r.id];
      if (local && this.dirty.has(r.id) && local.updatedAt > r.updatedAt) continue;
      this.tasks[r.id] = r;
      if (local && this.dirty.has(r.id) && local.updatedAt <= r.updatedAt) this.dirty.delete(r.id);
    }
  }
}

export const store = new Store();

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
