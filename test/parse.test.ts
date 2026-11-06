import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/lib/parse';
import { fuzzy } from '../src/lib/fuzzy';

const WED = '2026-11-04'; // a Wednesday
const SAT = '2026-11-07';
const SUN = '2026-11-08';

function span(input: string, today = WED) {
  const p = parseInput(input, today);
  return p.span ? `${p.span.start}..${p.span.end}` : `ERR ${p.error}`;
}

describe('ranges', () => {
  it('weekday range picks the week in progress, or next week once it has ended', () => {
    expect(span('essay mon to fri')).toBe('2026-11-02..2026-11-06');
    expect(span('essay mon to fri', SAT)).toBe('2026-11-09..2026-11-13');
    expect(span('essay mon-fri')).toBe('2026-11-02..2026-11-06');
    expect(span('essay mon - fri')).toBe('2026-11-02..2026-11-06');
    expect(span('essay from mon until fri')).toBe('2026-11-02..2026-11-06');
  });
  it('wrapping weekday ranges', () => {
    expect(span('trip fri to mon')).toBe('2026-11-06..2026-11-09');
    expect(span('trip fri to mon', SUN)).toBe('2026-11-06..2026-11-09');
  });
  it('month days and ordinals', () => {
    expect(span('x nov 1 to nov 20')).toBe('2026-11-01..2026-11-20');
    expect(span('x dec 20 to jan 5')).toBe('2026-12-20..2027-01-05');
    expect(span('x 28th to 3rd')).toBe('2026-11-28..2026-12-03');
    expect(span('x nov 12 to 20th')).toBe('2026-11-12..2026-11-20');
    expect(span('x 11/12-11/20')).toBe('2026-11-12..2026-11-20');
    expect(span('x today to nov 20')).toBe('2026-11-04..2026-11-20');
    expect(span('x next mon to fri')).toBe('2026-11-09..2026-11-13');
  });
  it('rejects nonsense', () => {
    expect(span('x nov 31')).toMatch(/^ERR/);
    expect(span('x 13/2')).toMatch(/^ERR/);
    expect(span('x nov 1 to nov 3')).toMatch(/^ERR/);
    expect(span('x 2026-11-10 to 2026-11-01')).toMatch(/^ERR/);
  });
});

describe('single dates are deadlines unless "on"', () => {
  it('works', () => {
    expect(span('milk fri')).toBe('2026-11-04..2026-11-06');
    expect(span('milk by fri')).toBe('2026-11-04..2026-11-06');
    expect(span('call mom on fri')).toBe('2026-11-06..2026-11-06');
    expect(span('x today')).toBe('2026-11-04..2026-11-04');
    expect(span('x tom')).toBe('2026-11-04..2026-11-05');
    expect(span('x wed')).toBe('2026-11-04..2026-11-04');
    expect(span('x next mon')).toBe('2026-11-04..2026-11-09');
    expect(span('x nov 12')).toBe('2026-11-04..2026-11-12');
    expect(span('x 12 nov')).toBe('2026-11-04..2026-11-12');
    expect(span('x 11/12')).toBe('2026-11-04..2026-11-12');
    expect(span('x 12th')).toBe('2026-11-04..2026-11-12');
    expect(span('x 3rd')).toBe('2026-11-04..2026-12-03');
    expect(span('x in 3d')).toBe('2026-11-04..2026-11-07');
    expect(span('x in 2 weeks')).toBe('2026-11-04..2026-11-18');
    expect(span('x jan 5 2027')).toBe('2026-11-04..2027-01-05');
    expect(span('x nov 1')).toMatch(/^ERR .*passed/);
  });
  it('periods', () => {
    expect(span('x this week')).toBe('2026-11-04..2026-11-08');
    expect(span('x next week')).toBe('2026-11-09..2026-11-15');
    expect(span('x weekend')).toBe('2026-11-07..2026-11-08');
    expect(span('x weekend', SUN)).toBe('2026-11-08..2026-11-08');
    expect(span('x next weekend')).toBe('2026-11-14..2026-11-15');
    expect(span('x this month')).toBe('2026-11-04..2026-11-30');
  });
});

describe('names and tags', () => {
  it('strips tags and dates from the name', () => {
    const p = parseInput('essay draft #school mon to fri #cs', WED);
    expect(p.title).toBe('essay draft');
    expect(p.tags).toEqual(['school', 'cs']);
  });
  it('ALL CAPS, backslash and quotes keep words as text', () => {
    expect(parseInput('SAT prep #school sat', WED).title).toBe('SAT prep');
    expect(parseInput('\\sat practice fri', WED).title).toBe('sat practice');
    expect(parseInput('"march madness" fri', WED).title).toBe('march madness');
  });
  it('last date wins, earlier ones stay in the name', () => {
    const p = parseInput('wear sun hat fri', WED);
    expect(p.title).toBe('wear sun hat');
    expect(p.span?.end).toBe('2026-11-06');
    expect(p.extraDates).toEqual(['sun']);
  });
  it('does not eat ordinary words', () => {
    expect(parseInput('talk to sam fri', WED).title).toBe('talk to sam');
    expect(parseInput('may need 2 eggs fri', WED).title).toBe('may need 2 eggs');
    expect(parseInput('fri to do list', WED).title).toBe('to do list');
  });
  it('needs a name and dates', () => {
    expect(parseInput('#school fri', WED).error).toMatch(/name/);
    expect(parseInput('just a thought', WED).error).toMatch(/dates/);
  });
});

describe('fuzzy', () => {
  const titles = ['essay draft', 'math homework 7', 'buy groceries', 'email professor about lab', 'pay rent'];
  const best = (q: string) =>
    titles
      .map((t) => ({ t, r: fuzzy(q, t) }))
      .filter((x) => x.r)
      .sort((a, b) => b.r!.score - a.r!.score)[0]?.t;

  it('matches from the middle', () => {
    expect(best('rocer')).toBe('buy groceries');
    expect(best('fess')).toBe('email professor about lab');
  });
  it('forgives one typo, including swapped letters', () => {
    expect(best('esay')).toBe('essay draft');
    expect(best('esasy')).toBe('essay draft');
    expect(best('homewrok')).toBe('math homework 7');
    expect(best('grocxries')).toBe('buy groceries');
  });
  it('multiple words in any order', () => {
    expect(best('lab email')).toBe('email professor about lab');
  });
  it('short words must be exact', () => {
    expect(fuzzy('zz', 'pay rent')).toBeNull();
    expect(best('ren')).toBe('pay rent');
  });
});
