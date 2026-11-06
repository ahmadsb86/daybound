// Calendar dates as 'YYYY-MM-DD' strings. All arithmetic goes through UTC day
// numbers so daylight saving never shifts a date.

export type ISODate = string;

const DAY_MS = 86_400_000;

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function iso(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function ymd(s: ISODate): [number, number, number] {
  return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
}

export function toDays(s: ISODate): number {
  const [y, m, d] = ymd(s);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDays(n: number): ISODate {
  const t = new Date(n * DAY_MS);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function addDays(s: ISODate, n: number): ISODate {
  return fromDays(toDays(s) + n);
}

/** a minus b, in days */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDays(a) - toDays(b);
}

/** 0 = Monday ... 6 = Sunday */
export function dow(s: ISODate): number {
  return (((toDays(s) + 3) % 7) + 7) % 7;
}

export function startOfWeek(s: ISODate): ISODate {
  return addDays(s, -dow(s));
}

/** m is 1-12 */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = ymd(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function minISO(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxISO(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function todayLocal(now = new Date()): ISODate {
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function todayInTz(tz: string, now = new Date()): ISODate {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return iso(get('year'), get('month'), get('day'));
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Mon, Nov 9" (year added when it differs from today's) */
export function fmtDay(s: ISODate, today: ISODate): string {
  const [y, m, d] = ymd(s);
  const year = y !== ymd(today)[0] ? ` ${y}` : '';
  return `${WEEKDAYS[dow(s)]}, ${MONTHS_SHORT[m - 1]} ${d}${year}`;
}

/** Compact range: "Nov 9 to 13", "Nov 28 to Dec 3", "Fri, Nov 13" */
export function fmtRange(start: ISODate, end: ISODate, today: ISODate): string {
  const [ys, ms, ds] = ymd(start);
  const [ye, me, de] = ymd(end);
  const [yt] = ymd(today);
  if (start === end) return fmtDay(start, today);
  const yr = (y: number) => (y !== yt ? ` ${y}` : '');
  if (ys === ye && ms === me) return `${MONTHS_SHORT[ms - 1]} ${ds} to ${de}${yr(ys)}`;
  if (ys === ye) return `${MONTHS_SHORT[ms - 1]} ${ds} to ${MONTHS_SHORT[me - 1]} ${de}${yr(ys)}`;
  return `${MONTHS_SHORT[ms - 1]} ${ds} ${ys} to ${MONTHS_SHORT[me - 1]} ${de} ${ye}`;
}

/** "Mon, Nov 9 to Fri, Nov 13" */
export function fmtRangeLong(start: ISODate, end: ISODate, today: ISODate): string {
  if (start === end) return fmtDay(start, today);
  return `${fmtDay(start, today)} to ${fmtDay(end, today)}`;
}
