import {
  addDays,
  diffDays,
  fmtRange,
  ISODate,
  maxISO,
  minISO,
  MONTHS_LONG,
  MONTHS_SHORT,
  startOfWeek,
  WEEKDAYS,
  ymd,
} from '../lib/dates';
import { fuzzy } from '../lib/fuzzy';
import {
  compareUrgency,
  dueLabel,
  effectiveEnd,
  groupColor,
  groupOf,
  isOpen,
  overdueDays,
  type RGB,
} from '../lib/tasks';
import type { Task } from '../lib/types';
import { store } from './store';
import { syncStatus } from './sync';
import { activeFilter, highlightedTask, ui } from './ui';

const WEEKS = 4;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function rgb(c: RGB, a = 1): string {
  return a === 1 ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${a})`;
}

export function colorVars(group: string): string {
  const c = groupColor(group);
  return `--c:${rgb(c)};--cb:${rgb(c, 0.15)};--cs:${rgb(c, 0.3)}`;
}

export function highlightText(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return esc(text);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(text.slice(pos));
}

export function matchesFilter(t: Task, f: string): boolean {
  if (!f) return true;
  const words = f.split(/\s+/).filter(Boolean);
  const tagWords = words.filter((w) => w.startsWith('#') && w.length > 1).map((w) => w.slice(1).toLowerCase());
  if (tagWords.length && !tagWords.every((tw) => t.tags.some((tag) => tag.startsWith(tw)))) return false;
  const text = words.filter((w) => !w.startsWith('#')).join(' ');
  if (!text) return true;
  return fuzzy(text, `${t.title} ${t.tags.join(' ')}`) !== null;
}

export function visibleOpenTasks(): Task[] {
  const f = activeFilter();
  return store.all().filter((t) => isOpen(t) && matchesFilter(t, f));
}

/* ---------- list ---------- */

function taskRow(t: Task, today: ISODate, hlId: string | null): string {
  const due = dueLabel(t, today);
  const extra = t.tags
    .slice(1)
    .map((x) => `<span class="tag">#${esc(x)}</span>`)
    .join('');
  return `<li class="task k-${due.kind}${t.id === hlId ? ' hl' : ''}" data-id="${esc(t.id)}">
    <span class="t-title">${esc(t.title)}${extra}</span>
    <span class="t-range">${esc(fmtRange(t.start, t.end, today))}</span>
    <span class="t-due">${esc(due.text)}</span>
  </li>`;
}

export function renderList(el: HTMLElement, today: ISODate): void {
  if (ui.view === 'archive') return renderArchive(el, today);
  const hl = highlightedTask()?.id ?? null;
  const tasks = visibleOpenTasks();
  const f = activeFilter();
  if (!tasks.length) {
    el.innerHTML = f
      ? `<p class="empty">Nothing matches “${esc(f)}”. Esc clears the filter.</p>`
      : `<p class="empty">Nothing planned. Type a task with its days, like <kbd>read ch. 4 #school mon to wed</kbd>, and press Enter.</p>`;
    return;
  }
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const g = groupOf(t);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(t);
  }
  for (const list of groups.values()) list.sort((a, b) => compareUrgency(a, b, today));
  const ordered = [...groups.entries()].sort(
    (a, b) => compareUrgency(a[1][0], b[1][0], today) || a[0].localeCompare(b[0]),
  );
  el.innerHTML =
    (f ? `<p class="filter-note">Filtered by “${esc(f)}”</p>` : '') +
    ordered
      .map(
        ([g, list]) => `<section class="group" style="${colorVars(g)}">
          <h2 class="group-head"><span class="dot"></span>${esc(g)}<span class="count">${list.length}</span></h2>
          <ul>${list.map((t) => taskRow(t, today, hl)).join('')}</ul>
        </section>`,
      )
      .join('');
}

function renderArchive(el: HTMLElement, today: ISODate): void {
  const hl = highlightedTask()?.id ?? null;
  const f = activeFilter();
  const done = store
    .all()
    .filter((t) => !t.deleted && t.resolvedAt && matchesFilter(t, f))
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, 300);
  const head = `<h2 class="archive-head">Resolved</h2><p class="hint">Type <kbd>reopen</kbd> to bring one back. Esc returns to your plan.</p>`;
  if (!done.length) {
    el.innerHTML = head + `<p class="empty">No resolved tasks yet.</p>`;
    return;
  }
  el.innerHTML =
    head +
    `<ul class="archive">${done
      .map(
        (t) => `<li class="task k-done${t.id === hl ? ' hl' : ''}" data-id="${esc(t.id)}" style="${colorVars(groupOf(t))}">
          <span class="t-title"><span class="dot"></span>${esc(t.title)}</span>
          <span class="t-range">${esc(fmtRange(t.start, t.end, today))}</span>
          <span class="t-due">${esc(dueLabel(t, today).text)}</span>
        </li>`,
      )
      .join('')}</ul>`;
}

/* ---------- calendar ---------- */

interface Seg {
  t: Task;
  lane: number;
  from: number; // column 0-6
  to: number; // inclusive
  over: boolean;
  label: boolean;
  contL: boolean;
  contR: boolean;
}

function weekSegments(tasks: Task[], ws: ISODate, today: ISODate): { segs: Seg[]; lanes: number } {
  const we = addDays(ws, 6);
  const items = tasks
    .map((t) => ({ t, s: t.start, e: effectiveEnd(t, today) }))
    .filter((x) => x.s <= we && x.e >= ws)
    .sort((a, b) => {
      const as = maxISO(a.s, ws);
      const bs = maxISO(b.s, ws);
      if (as !== bs) return as < bs ? -1 : 1;
      return diffDays(b.e, b.s) - diffDays(a.e, a.s) || compareUrgency(a.t, b.t, today);
    });
  const laneEnds: number[] = [];
  const segs: Seg[] = [];
  for (const { t, s, e } of items) {
    const from = diffDays(maxISO(s, ws), ws);
    const to = diffDays(minISO(e, we), ws);
    let lane = laneEnds.findIndex((end) => end < from);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(to);
    } else laneEnds[lane] = to;

    const parts: Array<{ from: number; to: number; over: boolean }> = [];
    // planned part
    if (t.end >= ws && t.start <= we) {
      parts.push({ from, to: diffDays(minISO(t.end, we), ws), over: false });
    }
    // overdue tail
    if (overdueDays(t, today) > 0) {
      const os = addDays(t.end, 1);
      if (os <= we && today >= ws) {
        parts.push({ from: diffDays(maxISO(os, ws), ws), to: diffDays(minISO(today, we), ws), over: true });
      }
    }
    parts.forEach((p, i) => {
      segs.push({
        t,
        lane,
        from: p.from,
        to: p.to,
        over: p.over,
        label: i === 0,
        contL: i > 0 || (p.from === 0 && s < ws),
        contR: i < parts.length - 1 || (p.to === 6 && e > we),
      });
    });
  }
  return { segs, lanes: laneEnds.length };
}

function calLabel(first: ISODate, last: ISODate): string {
  const [y1, m1] = ymd(first);
  const [y2, m2] = ymd(last);
  if (y1 === y2 && m1 === m2) return `${MONTHS_LONG[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${MONTHS_SHORT[m1 - 1]} to ${MONTHS_SHORT[m2 - 1]} ${y1}`;
  return `${MONTHS_SHORT[m1 - 1]} ${y1} to ${MONTHS_SHORT[m2 - 1]} ${y2}`;
}

export function renderCalendar(el: HTMLElement, today: ISODate): void {
  const first = addDays(startOfWeek(today), ui.calOffset * 7);
  const last = addDays(first, WEEKS * 7 - 1);
  const tasks = visibleOpenTasks();
  const hl = highlightedTask()?.id ?? null;

  let weeks = '';
  for (let w = 0; w < WEEKS; w++) {
    const ws = addDays(first, w * 7);
    const { segs, lanes } = weekSegments(tasks, ws, today);
    const rows = Math.max(lanes, 2);
    let days = '';
    for (let d = 0; d < 7; d++) {
      const date = addDays(ws, d);
      const [, m, dd] = ymd(date);
      const cls = ['day', date < today ? 'past' : '', date === today ? 'today' : '', d >= 5 ? 'wkend' : '']
        .filter(Boolean)
        .join(' ');
      const label = dd === 1 || (w === 0 && d === 0) ? `${MONTHS_SHORT[m - 1]} ${dd}` : String(dd);
      days += `<div class="${cls}" style="grid-column:${d + 1}"><span class="dnum">${label}</span></div>`;
    }
    const bars = segs
      .map((s) => {
        const cls = [
          'bar',
          s.over ? 'over' : '',
          s.contL ? 'cl' : '',
          s.contR ? 'cr' : '',
          s.t.start > today ? 'future' : '',
          s.t.id === hl ? 'hl' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const title = `${s.t.title}, ${fmtRange(s.t.start, s.t.end, today)}${s.over ? ` (${overdueDays(s.t, today)}d over)` : ''}`;
        return `<div class="${cls}" data-id="${esc(s.t.id)}" title="${esc(title)}" style="grid-column:${s.from + 1}/${s.to + 2};grid-row:${s.lane + 2};${colorVars(groupOf(s.t))}">${s.label ? `<span>${esc(s.t.title)}</span>` : ''}</div>`;
      })
      .join('');
    weeks += `<div class="week" style="grid-template-rows:1.6rem repeat(${rows},1.45rem) .5rem">${days}${bars}</div>`;
  }

  el.innerHTML = `
    <div class="cal-head">
      <h2>${calLabel(first, last)}</h2>
      <div class="cal-nav">
        <button type="button" tabindex="-1" data-cal="-1" aria-label="Previous week">‹</button>
        <button type="button" tabindex="-1" data-cal="0"${ui.calOffset === 0 ? ' disabled' : ''}>This week</button>
        <button type="button" tabindex="-1" data-cal="1" aria-label="Next week">›</button>
      </div>
    </div>
    <div class="weekdays">${WEEKDAYS.map((d, i) => `<span${i >= 5 ? ' class="wkend"' : ''}>${d}</span>`).join('')}</div>
    ${weeks}`;
}

/* ---------- footer ---------- */

function signedOutText(): string {
  // Google can refuse to sign in inside an app window, so the desktop app points at pairing too.
  return ui.shell === 'tauri'
    ? 'Not syncing. Type <kbd>login</kbd>, or <kbd>pair</kbd> on a signed-in device and enter the code here.'
    : 'Not syncing. Type <kbd>login</kbd> to sync across devices.';
}

export function renderFooter(el: HTMLElement, today: ISODate): void {
  const overdue = store.all().filter((t) => overdueDays(t, today) > 0).length;
  const pending = [...store.dirty].filter((id) => store.tasks[id]).length;
  let status = '';
  let cls = '';
  switch (syncStatus.state) {
    case 'demo':
      status = 'Demo: tasks stay in this browser';
      break;
    case 'signedout':
      status = signedOutText();
      break;
    case 'syncing':
      status = 'Syncing';
      break;
    case 'offline':
      status = pending ? `Offline. ${pending} change${pending === 1 ? '' : 's'} waiting.` : 'Offline';
      break;
    case 'error':
      status = esc(syncStatus.message || 'Sync failed');
      cls = 'err';
      break;
    case 'synced':
      if (syncStatus.gcal.error) {
        status = `Synced. Calendar: ${esc(syncStatus.gcal.error)}`;
        cls = 'err';
      } else status = syncStatus.gcal.connected ? 'Synced with Google Calendar' : 'Synced';
      break;
    default:
      status = store.signedIn === false ? signedOutText() : '';
  }
  el.innerHTML = `
    <span class="status ${cls}">${status}</span>
    <span class="overdue-count">${overdue ? `${overdue} overdue` : ''}</span>
    <span class="help-hint"><kbd>?</kbd> help</span>`;
}

/* ---------- help ---------- */

export const HELP_HTML = `
<div class="help-card" role="dialog" aria-label="Keyboard reference">
  <h2>Adding tasks</h2>
  <dl>
    <dt><kbd>essay #school fri</kbd></dt><dd>Today through Friday. The first #tag is the group.</dd>
    <dt><kbd>call mom on fri</kbd></dt><dd>Friday only</dd>
    <dt><kbd>mon to fri</kbd> <kbd>mon-fri</kbd></dt><dd>A range. If this week’s already ended, it means next week.</dd>
    <dt><kbd>today</kbd> <kbd>tom</kbd> <kbd>next mon</kbd></dt><dd>Single days</dd>
    <dt><kbd>nov 12</kbd> <kbd>11/12</kbd> <kbd>12th</kbd></dt><dd>Dates, month first</dd>
    <dt><kbd>in 3d</kbd> <kbd>in 2 weeks</kbd></dt><dd>Relative</dd>
    <dt><kbd>this week</kbd> <kbd>next week</kbd> <kbd>weekend</kbd></dt><dd>Whole periods</dd>
    <dt><kbd>\\sat</kbd> <kbd>"SAT prep"</kbd></dt><dd>Keep a word as text. ALL CAPS words are never dates.</dd>
  </dl>
  <h2>Commands</h2>
  <dl>
    <dt><kbd>res</kbd> name</dt><dd>Resolve. Stays in resolve mode so you can clear several.</dd>
    <dt><kbd>del</kbd> name</dt><dd>Delete without resolving</dd>
    <dt><kbd>mv</kbd> name thu to sat</dt><dd>Reschedule</dd>
    <dt><kbd>ren</kbd> name &gt; new name</dt><dd>Rename. Add #tags to regroup.</dd>
    <dt><kbd>/</kbd>text</dt><dd>Filter the list and calendar. <kbd>/#school</kbd> filters by group.</dd>
    <dt><kbd>done</kbd>, <kbd>reopen</kbd> name</dt><dd>See resolved tasks, bring one back</dd>
    <dt><kbd>u</kbd></dt><dd>Undo the last change</dd>
    <dt><kbd>login</kbd> <kbd>logout</kbd> <kbd>sync</kbd> <kbd>pair</kbd></dt><dd>Sync across devices. <kbd>pair</kbd> gives a code for the desktop app.</dd>
  </dl>
  <h2>Keys</h2>
  <dl>
    <dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Tab</kbd></dt><dd>Pick a match. In add mode, ↑ recalls earlier input and Tab completes a #tag.</dd>
    <dt><kbd>Esc</kbd></dt><dd>Clear, leave the mode, drop the filter, return to this week</dd>
    <dt><kbd>[</kbd> <kbd>]</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd></dt><dd>Move the calendar a week or four</dd>
    <dt><kbd>Ctrl Z</kbd></dt><dd>Undo, when the input is empty</dd>
  </dl>
</div>`;
