import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/lib/parse';
import { fuzzy } from '../src/lib/fuzzy';
import {
  compareGroups,
  dueLabel,
  effectiveEnd,
  groupColor,
  groupOf,
  isLongTerm,
  LONG_TERM,
  overdueDays,
  PALETTE,
  regroup,
} from '../src/lib/tasks';
import type { Task } from '../src/lib/types';

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

describe('auto-recognized tags', () => {
  it('a bare aca/eca/msc/prs word becomes the group', () => {
    for (const tag of ['aca', 'eca', 'msc', 'prs']) {
      const p = parseInput(`essay draft ${tag} fri`, WED);
      expect(p.tags).toEqual([tag]);
      expect(p.title).toBe('essay draft');
      expect(p.span?.end).toBe('2026-11-06');
    }
  });
  it('works anywhere in the line and alongside #tags', () => {
    expect(parseInput('aca essay fri', WED).tags).toEqual(['aca']);
    expect(parseInput('essay #school aca fri', WED).tags).toEqual(['school', 'aca']);
    expect(parseInput('essay aca #hard fri', WED).tags).toEqual(['aca', 'hard']);
  });
  it('only as a separate word, and never in caps or escaped', () => {
    expect(parseInput('academy visit fri', WED).tags).toEqual([]);
    expect(parseInput('academy visit fri', WED).title).toBe('academy visit');
    expect(parseInput('read ACA report fri', WED).tags).toEqual([]);
    expect(parseInput('read \\aca fri', WED).tags).toEqual([]);
    expect(parseInput('read "aca" fri', WED).tags).toEqual([]);
  });
  it('does not duplicate a tag given both ways', () => {
    expect(parseInput('essay aca #aca fri', WED).tags).toEqual(['aca']);
  });
});

describe('long term (lt)', () => {
  it('needs no dates', () => {
    const p = parseInput('learn to sail lt', WED);
    expect(p.untimed).toBe(true);
    expect(p.tags).toEqual(['lt']);
    expect(p.title).toBe('learn to sail');
    expect(p.span).toBeUndefined();
    expect(p.error).toBeUndefined();
  });
  it('reads no date at all, so date words stay in the name', () => {
    const p = parseInput('call ammi on sun lt', WED);
    expect(p.untimed).toBe(true);
    expect(p.span).toBeUndefined();
    expect(p.title).toBe('call ammi on sun');
    expect(p.extraDates).toEqual([]);
  });
  it('still needs a name', () => {
    expect(parseInput('lt', WED).error).toMatch(/name/);
  });
  it('#lt works too, and caps still escapes', () => {
    expect(parseInput('read more #lt', WED).untimed).toBe(true);
    expect(parseInput('study for LT fri', WED).untimed).toBe(false);
    expect(parseInput('study for LT fri', WED).title).toBe('study for LT');
  });
  it('a dated task is not untimed', () => {
    expect(parseInput('essay aca fri', WED).untimed).toBe(false);
  });
});

describe('group order', () => {
  const sorted = (gs: string[]) => [...gs].sort((a, b) => compareGroups(a, b) || a.localeCompare(b));

  it('puts the fixed groups first in order, then the rest, then lt', () => {
    expect(sorted(['prs', 'zebra', 'lt', 'eca', 'apple', 'aca', 'msc'])).toEqual([
      'aca', 'eca', 'msc', 'prs', 'apple', 'zebra', 'lt',
    ]);
  });
  it('lt is last even on its own against an unknown group', () => {
    expect(sorted(['lt', 'aaaa'])).toEqual(['aaaa', 'lt']);
  });
  it('leaves two unknown groups to the caller to rank', () => {
    expect(compareGroups('school', 'work')).toBe(0);
  });
});

describe('group colors', () => {
  it('the fixed groups own their colors regardless of the hash', () => {
    expect(groupColor('aca')).toEqual([214, 92, 84]);
    expect(groupColor('eca')).toEqual([223, 176, 92]);
    expect(groupColor('msc')).toEqual([224, 132, 176]);
    expect(groupColor('prs')).toEqual([106, 196, 184]);
  });
  it('aca and prs are far apart, which hashing did not guarantee', () => {
    const [ar, ag, ab] = groupColor('aca');
    const [pr, pg, pb] = groupColor('prs');
    expect(Math.abs(ar - pr) + Math.abs(ag - pg) + Math.abs(ab - pb)).toBeGreaterThan(200);
  });
  it('other groups still hash into the palette', () => {
    expect(groupColor('school')).toEqual(groupColor('school'));
    expect(PALETTE).toContainEqual(groupColor('school'));
  });
});

describe('due labels', () => {
  const at = (end: string): Task => ({
    id: 'a', title: 'x', tags: [], start: WED, end,
    createdAt: 0, updatedAt: 0, resolvedAt: null, deleted: false,
  });

  it('capitalizes Today and Tomorrow', () => {
    expect(dueLabel(at(WED), WED).text).toBe('Today');
    expect(dueLabel(at('2026-11-05'), WED).text).toBe('Tomorrow');
  });
  it('leaves the other labels alone', () => {
    expect(dueLabel(at('2026-11-07'), WED).text).toBe('Sat');
    expect(dueLabel(at('2026-10-30'), WED).text).toBe('5d over');
  });
});

describe('long-term tasks are untimed', () => {
  const task = (tags: string[], end: string): Task => ({
    id: 'a', title: 'x', tags, start: '2026-11-01', end,
    createdAt: 0, updatedAt: 0, resolvedAt: null, deleted: false,
  });

  it('never roll forward or count as overdue', () => {
    const lt = task(['lt'], '2026-11-01');
    expect(isLongTerm(lt)).toBe(true);
    expect(overdueDays(lt, WED)).toBe(0);
    expect(effectiveEnd(lt, WED)).toBe('2026-11-01');
    expect(dueLabel(lt, WED)).toEqual({ text: '', kind: 'lt' });
  });
  it('an ordinary task with the same dates does roll forward', () => {
    const normal = task(['aca'], '2026-11-01');
    expect(overdueDays(normal, WED)).toBe(3);
    expect(effectiveEnd(normal, WED)).toBe(WED);
  });
  it('a resolved long-term task still shows when it was resolved', () => {
    const done = { ...task(['lt'], '2026-11-01'), resolvedAt: Date.parse('2026-11-04T12:00:00Z') };
    expect(dueLabel(done, WED).kind).toBe('done');
  });
});

describe('regroup (dragging a task into a group)', () => {
  const task = (tags: string[], patch: Partial<Task> = {}): Task => ({
    id: 'a', title: 'x', tags, start: '2026-10-01', end: '2026-10-01',
    createdAt: 0, updatedAt: 0, resolvedAt: null, deleted: false, ...patch,
  });

  it('makes the new group the first tag and drops the old one', () => {
    expect(regroup(task(['aca']), 'prs', WED)).toEqual({ tags: ['prs'] });
  });
  it('keeps the extra tags that are not groups', () => {
    expect(regroup(task(['aca', 'hard', 'lab']), 'msc', WED)).toEqual({ tags: ['msc', 'hard', 'lab'] });
  });
  it('promotes a tag the task already had rather than duplicating it', () => {
    expect(regroup(task(['aca', 'prs']), 'prs', WED)).toEqual({ tags: ['prs'] });
  });
  it('a long-term task is in the lt group whichever tag position lt sits in', () => {
    expect(groupOf(task(['school', 'lt']))).toBe(LONG_TERM);
    expect(regroup(task(['school', 'lt']), 'aca', WED)).toEqual({ tags: ['aca', 'school'], start: WED, end: WED });
  });
  it('is a no-op when the group is unchanged', () => {
    expect(regroup(task(['aca']), 'aca', WED)).toBeNull();
  });
  it('dates a task dragged out of long term to today, since it never had real dates', () => {
    expect(regroup(task(['lt']), 'aca', WED)).toEqual({ tags: ['aca'], start: WED, end: WED });
  });
  it('dragging into long term keeps the stored dates, which stop being read', () => {
    expect(regroup(task(['aca']), 'lt', WED)).toEqual({ tags: ['lt'] });
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
