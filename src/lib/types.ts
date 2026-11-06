export interface Task {
  id: string;
  title: string;
  /** lowercase, without '#'. The first tag is the task's group. */
  tags: string[];
  /** first planned day, YYYY-MM-DD */
  start: string;
  /** last planned day (inclusive), YYYY-MM-DD. Never moved by the overdue rollover. */
  end: string;
  createdAt: number;
  /** client clock, ms. Last write wins per task. */
  updatedAt: number;
  resolvedAt: number | null;
  /** tombstone so deletes propagate between devices */
  deleted: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts anything, returns a clean Task or null. Used on every boundary (storage, network). */
export function sanitizeTask(x: unknown): Task | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[\w-]{1,64}$/.test(o.id)) return null;
  if (typeof o.title !== 'string' || typeof o.start !== 'string' || typeof o.end !== 'string') return null;
  if (!DATE_RE.test(o.start) || !DATE_RE.test(o.end) || o.start > o.end) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const tags = Array.isArray(o.tags)
    ? o.tags
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .map((t) => t.toLowerCase().slice(0, 40))
        .slice(0, 10)
    : [];
  return {
    id: o.id,
    title: o.title.slice(0, 500),
    tags,
    start: o.start,
    end: o.end,
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
    resolvedAt: typeof o.resolvedAt === 'number' && Number.isFinite(o.resolvedAt) ? o.resolvedAt : null,
    deleted: o.deleted === true,
  };
}
