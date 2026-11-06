import { diffDays, dow, ISODate, MONTHS_SHORT, WEEKDAYS, ymd } from './dates.js';
import type { Task } from './types.js';

export const INBOX = 'inbox';

export function isOpen(t: Task): boolean {
  return !t.deleted && !t.resolvedAt;
}

/** Open tasks never end before today: once the planned days are over, the task rolls forward. */
export function effectiveEnd(t: Task, today: ISODate): ISODate {
  return isOpen(t) && t.end < today ? today : t.end;
}

export function overdueDays(t: Task, today: ISODate): number {
  return isOpen(t) && t.end < today ? diffDays(today, t.end) : 0;
}

export function groupOf(t: Task): string {
  return t.tags[0] ?? INBOX;
}

/** Most urgent first: overdue (longest overdue first), then by due date, then start. */
export function compareUrgency(a: Task, b: Task, today: ISODate): number {
  const oa = overdueDays(a, today);
  const ob = overdueDays(b, today);
  if (oa !== ob) return ob - oa;
  if (a.end !== b.end) return a.end < b.end ? -1 : 1;
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/** FNV-1a, 32 bit */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type RGB = [number, number, number];

// Muted, evenly weighted hues that sit well on the dark slate background.
export const PALETTE: RGB[] = [
  [141, 180, 226], // blue
  [156, 204, 138], // green
  [226, 184, 107], // amber
  [196, 160, 224], // lilac
  [116, 199, 184], // teal
  [229, 154, 192], // pink
  [183, 194, 106], // olive
  [126, 170, 214], // steel
];
const INBOX_RGB: RGB = [139, 148, 163];

export function groupColor(group: string): RGB {
  if (group === INBOX) return INBOX_RGB;
  return PALETTE[hashString(group) % PALETTE.length];
}

export type DueKind = 'over' | 'today' | 'soon' | 'later' | 'future' | 'done';

export function dueLabel(t: Task, today: ISODate): { text: string; kind: DueKind } {
  if (t.resolvedAt) {
    const d = new Date(t.resolvedAt);
    return { text: `done ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`, kind: 'done' };
  }
  const over = overdueDays(t, today);
  if (over) return { text: `${over}d over`, kind: 'over' };
  const left = diffDays(t.end, today);
  const future = t.start > today;
  let text: string;
  if (left === 0) text = 'today';
  else if (left === 1) text = 'tomorrow';
  else if (left <= 6) text = WEEKDAYS[dow(t.end)];
  else {
    const [y, m, d] = ymd(t.end);
    text = `${MONTHS_SHORT[m - 1]} ${d}${y !== ymd(today)[0] ? ` ${y}` : ''}`;
  }
  const kind: DueKind = future ? 'future' : left <= 1 ? 'today' : left <= 6 ? 'soon' : 'later';
  return { text, kind };
}

/** Inclusive length of a span in days */
export function spanDays(start: ISODate, end: ISODate): number {
  return diffDays(end, start) + 1;
}


