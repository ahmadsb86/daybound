import { diffDays, dow, ISODate, MONTHS_SHORT, WEEKDAYS, ymd } from './dates.js';
import type { Task } from './types.js';

export const INBOX = 'inbox';

/** The long-term group: its tasks carry no dates at all. */
export const LONG_TERM = 'lt';

/** Fixed groups, in the order their sections appear in the list. 'lt' always sits last. */
export const GROUP_ORDER = ['aca', 'eca', 'msc', 'prs'];

/** Tags recognized as a bare word, without a leading '#'. */
export const AUTO_TAGS: ReadonlySet<string> = new Set([...GROUP_ORDER, LONG_TERM]);

/**
 * Long-term tasks are untimed. start/end still hold the day they were added so the stored
 * shape never changes, but nothing reads them: no due label, no rollover, no calendar.
 */
export function isLongTerm(t: Task): boolean {
  return t.tags.includes(LONG_TERM);
}

export function isOpen(t: Task): boolean {
  return !t.deleted && !t.resolvedAt;
}

/** Open tasks never end before today: once the planned days are over, the task rolls forward. */
export function effectiveEnd(t: Task, today: ISODate): ISODate {
  return isOpen(t) && !isLongTerm(t) && t.end < today ? today : t.end;
}

export function overdueDays(t: Task, today: ISODate): number {
  return isOpen(t) && !isLongTerm(t) && t.end < today ? diffDays(today, t.end) : 0;
}

/**
 * Move a task into `group`: it becomes the first tag, and the old group is dropped.
 * Leaving the long-term group is the one case that needs dates, since it never had real ones.
 */
export function regroup(t: Task, group: string, today: ISODate): Partial<Task> | null {
  const from = groupOf(t);
  if (from === group) return null;
  // the old group goes; tags that merely rode along stay
  const tags = [group, ...t.tags.filter((x) => x !== group && x !== from && x !== LONG_TERM)];
  if (isLongTerm(t)) return { tags, start: today, end: today };
  return { tags };
}

/** aca, eca, msc, prs, then everything else, then lt at the very bottom. 0 = order by urgency. */
export function compareGroups(a: string, b: string): number {
  const rank = (g: string) => (g === LONG_TERM ? 2 : GROUP_ORDER.includes(g) ? 0 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return ra === 0 ? GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b) : 0;
}

/** The first tag, except that a long-term task always belongs to the long-term group. */
export function groupOf(t: Task): string {
  if (isLongTerm(t)) return LONG_TERM;
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

/** The fixed groups own their colors; everything else is hashed into PALETTE. */
const FIXED_RGB: Record<string, RGB> = {
  aca: [214, 92, 84], // red
  eca: [223, 176, 92], // golden
  msc: [224, 132, 176], // pink
  prs: [106, 196, 184], // teal
};

export function groupColor(group: string): RGB {
  if (group === INBOX) return INBOX_RGB;
  return FIXED_RGB[group] ?? PALETTE[hashString(group) % PALETTE.length];
}

export type DueKind = 'over' | 'today' | 'soon' | 'later' | 'future' | 'done' | 'lt';

export function dueLabel(t: Task, today: ISODate): { text: string; kind: DueKind } {
  if (t.resolvedAt) {
    const d = new Date(t.resolvedAt);
    return { text: `done ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`, kind: 'done' };
  }
  if (isLongTerm(t)) return { text: '', kind: 'lt' };
  const over = overdueDays(t, today);
  if (over) return { text: `${over}d over`, kind: 'over' };
  const left = diffDays(t.end, today);
  const future = t.start > today;
  let text: string;
  if (left === 0) text = 'Today';
  else if (left === 1) text = 'Tomorrow';
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


