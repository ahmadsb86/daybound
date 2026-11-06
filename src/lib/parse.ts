import {
  addDays,
  daysInMonth,
  diffDays,
  dow,
  fmtDay,
  iso,
  ISODate,
  isValidISO,
  maxISO,
  MONTHS_SHORT,
  startOfWeek,
  ymd,
} from './dates.js';
import { AUTO_TAGS, LONG_TERM } from './tasks.js';

/*
 * Grammar, roughly:
 *
 *   phrase  := [from|on|by|due] atom [connector atom]
 *            | period                       (this week, next week, weekend, this month, ...)
 *            | atom-atom                    (mon-fri, 12th-20th as one token)
 *   atom    := today | tom | mon..sun | this fri | next fri | nov 12 | 12 nov | 11/12 | 12th
 *            | 2026-11-12 | in 3d | in 2 weeks
 *
 * A lone atom means "from today through that day" (a deadline). "on fri" means that day only.
 * Ranges whose words repeat (weekdays, month days) pick the occurrence that has not ended yet,
 * so "mon to fri" typed on a Wednesday is the week in progress, and on Saturday it is next week.
 * If several date phrases appear, the last one counts and the others stay in the name.
 * A word in ALL CAPS, a word starting with a backslash, or anything in "quotes" is never a date.
 *
 * Tags are '#foo', plus the AUTO_TAGS (aca, eca, msc, prs, lt) written as a bare word.
 * The same ALL CAPS / backslash / "quotes" escapes keep those words as plain text.
 * 'lt' marks the task untimed: no date is read, so date words stay in the name.
 */

export type Atom =
  | { k: 'fixed'; d: ISODate }
  | { k: 'dow'; dow: number }
  | { k: 'yearly'; m: number; d: number }
  | { k: 'monthly'; d: number };

export interface DateSpan {
  start: ISODate;
  end: ISODate;
}

export interface ParsedInput {
  title: string;
  tags: string[];
  span?: DateSpan;
  /** the words that produced the span */
  dateText?: string;
  /** date-like phrases that were ignored because a later one won */
  extraDates: string[];
  /** the 'lt' tag was used: the task carries no dates and none were read */
  untimed: boolean;
  error?: string;
}

interface Tok {
  raw: string;
  norm: string;
  lit: boolean;
  caps: boolean;
}

type AtomMatch = { atom: Atom; len: number } | { err: string; len: number };

interface Seg {
  from: number;
  to: number;
  span?: DateSpan;
  err?: string;
}

const DOW: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const TOMORROW = new Set(['tom', 'tmr', 'tmrw', 'tmw', 'tomorrow']);
const CONNECTORS = new Set(['to', '-', '–', '—', 'until', 'till', 'til', 'thru', 'through']);
const PREFIXES = new Set(['from', 'on', 'by', 'due']);
const UNIT_RE = /^(d|days?|w|wks?|weeks?)$/;
const DAYNUM_RE = /^(\d{1,2})(st|nd|rd|th)?$/;
const ORDINAL_RE = /^(\d{1,2})(st|nd|rd|th)$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAG_RE = /^#([\p{L}\p{N}_-]+)[.,;:!?]*$/u;

// Longest month length, using a leap year so Feb 29 is allowed.
const MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) {
      if (m[1].trim()) out.push({ raw: m[1].trim(), norm: '', lit: true, caps: false });
      continue;
    }
    const raw = m[2];
    if (raw.length > 1 && raw.startsWith('\\')) {
      out.push({ raw: raw.slice(1), norm: '', lit: true, caps: false });
      continue;
    }
    const letters = raw.replace(/[^A-Za-z]/g, '');
    out.push({
      raw,
      norm: raw.toLowerCase().replace(/[.,;:!?]+$/, ''),
      lit: false,
      caps: letters.length >= 2 && letters === letters.toUpperCase(),
    });
  }
  return out;
}

/** a word token (ALL CAPS words are never treated as date words) */
function W(t: Tok[], i: number): string | null {
  const x = t[i];
  return x && !x.lit && !x.caps ? x.norm : null;
}

/** a numeric-ish token */
function N(t: Tok[], i: number): string | null {
  const x = t[i];
  return x && !x.lit ? x.norm : null;
}

const fixed = (d: ISODate): Atom => ({ k: 'fixed', d });

function monthDay(m: number, d: number, yearTok: string | null): { atom?: Atom; err?: string; usedYear: boolean } {
  if (d < 1 || d > MAX_DAY[m - 1]) return { err: `${MONTHS_SHORT[m - 1]} ${d} isn’t a date`, usedYear: false };
  if (yearTok && /^20\d{2}$/.test(yearTok)) {
    const y = Number(yearTok);
    if (d > daysInMonth(y, m)) return { err: `${MONTHS_SHORT[m - 1]} ${d} ${y} isn’t a date`, usedYear: true };
    return { atom: fixed(iso(y, m, d)), usedYear: true };
  }
  return { atom: { k: 'yearly', m, d }, usedYear: false };
}

function unitDays(u: string): number {
  return u.startsWith('w') ? 7 : 1;
}

function matchAtom(t: Tok[], i: number, today: ISODate): AtomMatch | null {
  const w0 = W(t, i);
  const w1 = W(t, i + 1);
  const n0 = N(t, i);
  const n1 = N(t, i + 1);
  const n2 = N(t, i + 2);

  if (w0 === 'in') {
    const glued = n1?.match(/^(\d{1,4})(d|days?|w|wks?|weeks?)$/);
    if (glued) return { atom: fixed(addDays(today, Number(glued[1]) * unitDays(glued[2]))), len: 2 };
    if (n1 && /^\d{1,4}$/.test(n1) && n2 && UNIT_RE.test(n2)) {
      return { atom: fixed(addDays(today, Number(n1) * unitDays(n2))), len: 3 };
    }
    const w2 = W(t, i + 2);
    if (w1 === 'a' && w2 && /^(day|week)$/.test(w2)) return { atom: fixed(addDays(today, unitDays(w2))), len: 3 };
  }

  if (w0 === 'next' && w1 !== null && w1 in DOW) {
    return { atom: fixed(addDays(startOfWeek(today), 7 + DOW[w1])), len: 2 };
  }
  if (w0 === 'this' && w1 !== null && w1 in DOW) return { atom: { k: 'dow', dow: DOW[w1] }, len: 2 };
  if (w0 === 'today') return { atom: fixed(today), len: 1 };
  if (w0 !== null && TOMORROW.has(w0)) return { atom: fixed(addDays(today, 1)), len: 1 };
  if (w0 !== null && w0 in DOW) return { atom: { k: 'dow', dow: DOW[w0] }, len: 1 };

  // nov 12, nov 12th, november 12 2027
  if (w0 !== null && w0 in MONTHS && n1) {
    const dm = n1.match(DAYNUM_RE);
    if (dm) {
      const r = monthDay(MONTHS[w0], Number(dm[1]), n2);
      const len = r.usedYear ? 3 : 2;
      return r.atom ? { atom: r.atom, len } : { err: r.err!, len };
    }
  }
  // 12 nov, 12th nov 2027
  if (n0 && w1 !== null && w1 in MONTHS) {
    const dm = n0.match(DAYNUM_RE);
    if (dm) {
      const r = monthDay(MONTHS[w1], Number(dm[1]), n2);
      const len = r.usedYear ? 3 : 2;
      return r.atom ? { atom: r.atom, len } : { err: r.err!, len };
    }
  }

  if (n0) {
    // 11/12, 11/12/26, 11/12/2026 (month first)
    const sm = n0.match(SLASH_RE);
    if (sm) {
      const m = Number(sm[1]);
      const d = Number(sm[2]);
      if (m < 1 || m > 12) return { err: `${n0} isn’t a date (month comes first)`, len: 1 };
      const yearTok = sm[3] ? (sm[3].length === 2 ? `20${sm[3]}` : sm[3]) : null;
      const r = monthDay(m, d, yearTok);
      return r.atom ? { atom: r.atom, len: 1 } : { err: r.err!, len: 1 };
    }
    if (ISO_RE.test(n0)) {
      return isValidISO(n0) ? { atom: fixed(n0), len: 1 } : { err: `${n0} isn’t a date`, len: 1 };
    }
    const om = n0.match(ORDINAL_RE);
    if (om) {
      const d = Number(om[1]);
      if (d < 1 || d > 31) return { err: `${n0} isn’t a day of the month`, len: 1 };
      return { atom: { k: 'monthly', d }, len: 1 };
    }
  }
  return null;
}

function matchPeriod(t: Tok[], i: number, today: ISODate): { span: DateSpan; len: number } | null {
  const w0 = W(t, i);
  const w1 = W(t, i + 1);
  const mon = startOfWeek(today);
  const weekend = (k: number): DateSpan => {
    const sat = addDays(mon, 5 + 7 * k);
    return { start: k === 0 ? maxISO(sat, today) : sat, end: addDays(sat, 1) };
  };
  const [y, m] = ymd(today);
  if (w0 === 'this' && w1 === 'week') return { span: { start: today, end: addDays(mon, 6) }, len: 2 };
  if (w0 === 'next' && w1 === 'week') return { span: { start: addDays(mon, 7), end: addDays(mon, 13) }, len: 2 };
  if (w0 === 'this' && w1 === 'weekend') return { span: weekend(0), len: 2 };
  if (w0 === 'next' && w1 === 'weekend') return { span: weekend(1), len: 2 };
  if (w0 === 'weekend') return { span: weekend(0), len: 1 };
  if (w0 === 'this' && w1 === 'month') return { span: { start: today, end: iso(y, m, daysInMonth(y, m)) }, len: 2 };
  if (w0 === 'next' && w1 === 'month') {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return { span: { start: iso(ny, nm, 1), end: iso(ny, nm, daysInMonth(ny, nm)) }, len: 2 };
  }
  return null;
}

export function earliestOnOrAfter(a: Atom, ref: ISODate): ISODate | null {
  switch (a.k) {
    case 'fixed':
      return a.d;
    case 'dow':
      return addDays(ref, (a.dow - dow(ref) + 7) % 7);
    case 'yearly': {
      const [y0] = ymd(ref);
      for (let y = y0; y <= y0 + 8; y++) {
        if (a.d > daysInMonth(y, a.m)) continue;
        const c = iso(y, a.m, a.d);
        if (c >= ref) return c;
      }
      return null;
    }
    case 'monthly': {
      let [y, m] = ymd(ref);
      for (let k = 0; k < 25; k++) {
        if (a.d <= daysInMonth(y, m)) {
          const c = iso(y, m, a.d);
          if (c >= ref) return c;
        }
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
      return null;
    }
  }
}

export function latestOnOrBefore(a: Atom, ref: ISODate): ISODate | null {
  switch (a.k) {
    case 'fixed':
      return a.d;
    case 'dow':
      return addDays(ref, -((dow(ref) - a.dow + 7) % 7));
    case 'yearly': {
      const [y0] = ymd(ref);
      for (let y = y0; y >= y0 - 8; y--) {
        if (a.d > daysInMonth(y, a.m)) continue;
        const c = iso(y, a.m, a.d);
        if (c <= ref) return c;
      }
      return null;
    }
    case 'monthly': {
      let [y, m] = ymd(ref);
      for (let k = 0; k < 25; k++) {
        if (a.d <= daysInMonth(y, m)) {
          const c = iso(y, m, a.d);
          if (c <= ref) return c;
        }
        m--;
        if (m < 1) {
          m = 12;
          y--;
        }
      }
      return null;
    }
  }
}

export function resolveRange(a: Atom, b: Atom, today: ISODate): { span?: DateSpan; err?: string } {
  const starts: ISODate[] = [];
  if (a.k === 'fixed') starts.push(a.d);
  else {
    const before = latestOnOrBefore(a, today);
    const after = earliestOnOrAfter(a, today);
    if (before) starts.push(before);
    if (after && after !== before) starts.push(after);
  }
  let best: DateSpan | null = null;
  for (const s of starts) {
    const e = b.k === 'fixed' ? b.d : earliestOnOrAfter(b, s);
    if (!e || e < s || e < today) continue;
    if (!best || e < best.end || (e === best.end && s > best.start)) best = { start: s, end: e };
  }
  if (best && b.k === 'yearly' && diffDays(best.end, today) > 300 && recentlyPassed(b, today)) {
    return { err: 'That range is already over (add a year to mean next year)' };
  }
  if (best) return { span: best };
  if (a.k === 'fixed' && b.k === 'fixed' && a.d > b.d) return { err: 'That range ends before it starts' };
  return { err: 'That range is already over' };
}

/** A month-day like "nov 1" typed a few days after Nov 1 almost always means a mistake, not next year. */
function recentlyPassed(a: Atom, today: ISODate): ISODate | null {
  const prev = latestOnOrBefore(a, addDays(today, -1));
  return prev && diffDays(today, prev) <= 31 ? prev : null;
}

export function resolveSingle(a: Atom, today: ISODate, exactDay: boolean): { span?: DateSpan; err?: string } {
  if (a.k === 'yearly') {
    const prev = recentlyPassed(a, today);
    if (prev) return { err: `${fmtDay(prev, today)} has already passed (add a year to mean next year)` };
  }
  const end = earliestOnOrAfter(a, today);
  if (!end) return { err: 'Couldn’t find that date' };
  if (end < today) return { err: `${fmtDay(end, today)} has already passed` };
  return { span: { start: exactDay ? end : today, end } };
}

function matchCompound(t: Tok[], i: number, today: ISODate): { span?: DateSpan; err?: string } | null {
  const x = t[i];
  if (!x || x.lit || x.caps || ISO_RE.test(x.norm)) return null;
  const parts = x.norm.split(/[-–—]/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const mk = (s: string): Tok[] => [{ raw: s, norm: s, lit: false, caps: false }];
  const a = matchAtom(mk(parts[0]), 0, today);
  const b = matchAtom(mk(parts[1]), 0, today);
  if (!a || !b || a.len !== 1 || b.len !== 1) return null;
  if ('err' in a) return { err: a.err };
  if ('err' in b) return { err: b.err };
  return resolveRange(a.atom, b.atom, today);
}

function matchDateAt(t: Tok[], i: number, today: ISODate): Seg | null {
  let p = i;
  const w = W(t, i);
  const prefix = w !== null && PREFIXES.has(w) ? w : null;
  if (prefix) p = i + 1;

  const period = matchPeriod(t, p, today);
  if (period) return { from: prefix ? i : p, to: p + period.len, span: period.span };

  const comp = matchCompound(t, p, today);
  if (comp) return { from: prefix ? i : p, to: p + 1, ...comp };

  const a = matchAtom(t, p, today);
  if (!a) return null;
  if ('err' in a) return { from: prefix ? i : p, to: p + a.len, err: a.err };

  const q = p + a.len;
  const c = N(t, q);
  if (c !== null && CONNECTORS.has(c)) {
    const b = matchAtom(t, q + 1, today);
    if (b) {
      const from = prefix ? i : p;
      if ('err' in b) return { from, to: q + 1 + b.len, err: b.err };
      return { from, to: q + 1 + b.len, ...resolveRange(a.atom, b.atom, today) };
    }
  }
  // "from fri" without an end: leave "from" in the name and treat fri as a deadline
  const usePrefix = prefix !== null && prefix !== 'from';
  return { from: usePrefix ? i : p, to: q, ...resolveSingle(a.atom, today, prefix === 'on') };
}

/**
 * The tag a token carries, if any: '#foo', or one of AUTO_TAGS written as a bare word.
 * An ALL CAPS or escaped word is never a tag, the same escape hatch dates use.
 */
function tagOf(tok: Tok): string | null {
  if (tok.lit) return null;
  const tm = tok.raw.match(TAG_RE);
  if (tm) return tm[1].toLowerCase();
  return !tok.caps && AUTO_TAGS.has(tok.norm) ? tok.norm : null;
}

export function parseInput(input: string, today: ISODate): ParsedInput {
  const toks = tokenize(input);
  // 'lt' makes the whole line untimed, so no date is read at all and date words stay in the name.
  const untimed = toks.some((tok) => tagOf(tok) === LONG_TERM);

  const segs: Seg[] = [];
  if (!untimed) {
    for (let i = 0; i < toks.length; ) {
      const s = matchDateAt(toks, i, today);
      if (s) {
        segs.push(s);
        i = s.to;
      } else i++;
    }
  }

  const chosen = segs.length ? segs[segs.length - 1] : null;
  const inChosen = (i: number) => chosen !== null && i >= chosen.from && i < chosen.to;

  const tags: string[] = [];
  const words: string[] = [];
  toks.forEach((tok, i) => {
    if (inChosen(i)) return;
    const tag = tagOf(tok);
    if (tag) {
      if (!tags.includes(tag)) tags.push(tag);
      return;
    }
    words.push(tok.raw);
  });

  const segText = (s: Seg) => toks.slice(s.from, s.to).map((x) => x.raw).join(' ');
  const result: ParsedInput = {
    title: words.join(' '),
    tags,
    extraDates: segs.slice(0, -1).map(segText),
    untimed,
  };
  if (chosen) {
    result.dateText = segText(chosen);
    if (chosen.err) result.error = chosen.err;
    else result.span = chosen.span;
  }
  if (!result.error && !result.title) result.error = 'Add a name for the task';
  if (!result.error && !result.span && !untimed) result.error = 'Add dates, like fri or mon to fri';
  return result;
}
