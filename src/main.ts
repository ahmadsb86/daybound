import './styles.css';

import { fmtRange, fmtRangeLong, todayLocal, type ISODate } from './lib/dates';
import { fuzzy } from './lib/fuzzy';
import { parseInput, type DateSpan } from './lib/parse';
import {
  AUTO_TAGS,
  compareUrgency,
  dueLabel,
  groupOf,
  isLongTerm,
  isOpen,
  LONG_TERM,
  overdueDays,
  regroup,
  spanDays,
} from './lib/tasks';
import type { Task } from './lib/types';
import {
  colorVars,
  esc,
  HELP_HTML,
  highlightText,
  renderCalendar,
  renderFooter,
  renderList,
  visibleOpenTasks,
} from './app/render';
import { newId, store } from './app/store';
import {
  createPairCode,
  initSync,
  logout,
  onSyncStatus,
  redeemPairCode,
  syncNow,
  syncStatus,
} from './app/sync';
import { MODE_LABEL, PICKER_MODES, ui, type Mode, type Suggestion } from './app/ui';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const input = $<HTMLInputElement>('#cmd');
const field = $('#field');
const ghost = $('#ghost');
const modeEl = $('#mode');
const assist = $('#assist');
const picker = $('#picker');
const listEl = $('#list');
const calEl = $('#cal');
const footEl = $('#foot');
const helpEl = $('#help');

let today: ISODate = todayLocal();
let showErrors = false;
let viewBeforeReopen: 'main' | 'archive' = 'main';
let flashTimer: ReturnType<typeof setTimeout> | undefined;

const PREFIX: Record<string, Mode> = { res: 'res', del: 'del', mv: 'mv', ren: 'ren', reopen: 'reopen' };

const PLACEHOLDER: Record<Mode, string> = {
  add: 'Add a task: essay #school mon to fri',
  res: 'Which task did you finish?',
  del: 'Which task should go?',
  mv: 'Task name, then the new dates',
  ren: 'Task name > new name',
  reopen: 'Which task should come back?',
  filter: 'Filter by name or #group',
};

const COMMANDS: Record<string, string> = {
  u: 'Undo the last change',
  undo: 'Undo the last change',
  done: 'Show resolved tasks',
  login: 'Sign in with Google to sync and mirror to Google Calendar',
  logout: 'Sign out on this device',
  sync: 'Sync now',
  pair: 'Get a code to sign in on another device, like the desktop app',
  help: 'Show the keyboard reference',
};

/* ---------- state helpers ---------- */

function setInput(v: string): void {
  input.value = v;
  ui.value = v;
}

function clearInput(): void {
  setInput('');
  ui.selected = 0;
  ui.navigated = false;
  ui.historyIndex = -1;
  showErrors = false;
}

function setMode(m: Mode, word = ''): void {
  if (ui.mode === 'reopen' && m !== 'reopen') ui.view = viewBeforeReopen;
  if (m === 'reopen' && ui.mode !== 'reopen') {
    viewBeforeReopen = ui.view;
    ui.view = 'archive';
  }
  ui.mode = m;
  ui.modeWord = word;
  ui.selected = 0;
  ui.navigated = false;
  showErrors = false;
}

function flash(text: string, kind: 'ok' | 'err' | 'info' = 'ok', ms = 4500): void {
  ui.flash = { text, kind, until: Date.now() + ms };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    ui.flash = null;
    renderInputArea();
  }, ms);
  renderInputArea();
}

function shake(): void {
  field.classList.remove('shake');
  void field.offsetWidth;
  field.classList.add('shake');
}

function tagFrequency(): string[] {
  const count = new Map<string, number>();
  for (const t of store.all()) {
    if (t.deleted) continue;
    for (const tag of t.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
  }
  const used = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  // the built-in tags complete even before any task uses them
  return [...used, ...[...AUTO_TAGS].filter((t) => !count.has(t))];
}

/* ---------- picker ---------- */

function pickerQuery(): { text: string; tags: string[] } {
  let q = ui.value;
  if (ui.mode === 'ren' || ui.mode === 'mv') {
    const gt = q.indexOf('>');
    if (gt >= 0) q = q.slice(0, gt);
    else if (ui.mode === 'mv') {
      const p = parseInput(q, today);
      q = [p.title, ...p.tags.map((t) => `#${t}`)].join(' ');
    }
  }
  const words = q.trim().split(/\s+/).filter(Boolean);
  return {
    tags: words.filter((w) => w.startsWith('#') && w.length > 1).map((w) => w.slice(1).toLowerCase()),
    text: words.filter((w) => !w.startsWith('#')).join(' '),
  };
}

function isArmed(): boolean {
  const q = pickerQuery();
  return !!q.text || q.tags.length > 0 || ui.navigated;
}

function computeSuggestions(): void {
  if (!PICKER_MODES.has(ui.mode)) {
    ui.suggestions = [];
    ui.armed = false;
    return;
  }
  const { text, tags } = pickerQuery();
  const wantResolved = ui.mode === 'reopen';
  const pool = store
    .all()
    .filter((t) => !t.deleted && (wantResolved ? !!t.resolvedAt : !t.resolvedAt))
    .filter((t) => tags.every((tg) => t.tags.some((x) => x.startsWith(tg))));
  let out: Suggestion[];
  if (!text) {
    out = pool.map((task) => ({ task, ranges: [], score: 0 }));
    out.sort(
      wantResolved
        ? (a, b) => (b.task.resolvedAt ?? 0) - (a.task.resolvedAt ?? 0)
        : (a, b) => compareUrgency(a.task, b.task, today),
    );
  } else {
    out = [];
    for (const task of pool) {
      const r = fuzzy(text, task.title);
      if (r) out.push({ task, ranges: r.ranges, score: r.score });
    }
    out.sort((a, b) => b.score - a.score || compareUrgency(a.task, b.task, today));
  }
  ui.suggestions = out.slice(0, 8);
  if (ui.selected >= ui.suggestions.length) ui.selected = Math.max(0, ui.suggestions.length - 1);
  ui.armed = isArmed() && ui.suggestions.length > 0;
}

function moveSelection(delta: number): void {
  const n = ui.suggestions.length;
  if (!n) return;
  if (!ui.navigated && !isArmed()) ui.selected = delta > 0 ? 0 : n - 1;
  else ui.selected = (ui.selected + delta + n) % n;
  ui.navigated = true;
  renderAll();
}

function mvTarget(): { span?: DateSpan; err?: string } {
  const gt = ui.value.indexOf('>');
  const p = parseInput(gt >= 0 ? ui.value.slice(gt + 1) : ui.value, today);
  if (p.span) return { span: p.span };
  if (p.error && p.dateText) return { err: p.error };
  return { err: 'Add the new dates, like thu to sat' };
}

function renTarget(): { title: string; tags: string[] } | null {
  const gt = ui.value.indexOf('>');
  if (gt < 0) return null;
  const words = ui.value.slice(gt + 1).trim().split(/\s+/).filter(Boolean);
  const tags = words.filter((w) => /^#[\p{L}\p{N}_-]+$/u.test(w)).map((w) => w.slice(1).toLowerCase());
  const title = words.filter((w) => !/^#[\p{L}\p{N}_-]+$/u.test(w)).join(' ');
  if (!title && !tags.length) return null;
  return { title, tags };
}

/* ---------- rendering the input area ---------- */

function renderGhost(): void {
  const editable = ui.mode === 'add' || ui.mode === 'mv' || ui.mode === 'ren' || ui.mode === 'filter';
  let suffix = '';
  if (editable && input.selectionStart === input.value.length) {
    const m = input.value.match(/(?:^|\s)#([\p{L}\p{N}_-]+)$/u);
    if (m) {
      const partial = m[1].toLowerCase();
      const hit = tagFrequency().find((t) => t.startsWith(partial) && t !== partial);
      if (hit) suffix = hit.slice(partial.length);
    }
  }
  ghost.dataset.suffix = suffix;
  ghost.innerHTML =
    suffix && input.scrollWidth <= input.clientWidth
      ? `<span class="g-pre">${esc(input.value)}</span><span class="g-sfx">${esc(suffix)}</span>`
      : '';
}

function flashHtml(): string {
  if (!ui.flash || ui.flash.until < Date.now()) return '';
  return `<p class="flash f-${ui.flash.kind}">${esc(ui.flash.text)}</p>`;
}

function previewHtml(): string {
  const raw = ui.value.trim();
  const cmd = raw.toLowerCase();
  if (COMMANDS[cmd]) return `<p class="cmd-hint"><kbd>Enter</kbd> ${esc(COMMANDS[cmd])}</p>`;
  if (/^pair\s+\S+$/i.test(raw)) return `<p class="cmd-hint"><kbd>Enter</kbd> Sign in on this device with that code</p>`;
  const p = parseInput(ui.value, today);
  const tags = p.tags
    .map((t, i) => `<span class="pv-tag${i === 0 ? ' primary' : ''}" style="${colorVars(t)}">${esc(t)}</span>`)
    .join('');
  const title = p.title ? `<span class="pv-title">${esc(p.title)}</span>` : '';
  let when = '';
  if (p.untimed) {
    when = `<span class="pv-when">long term</span><span class="pv-len">no dates</span>`;
  } else if (p.span) {
    const n = spanDays(p.span.start, p.span.end);
    when = `<span class="pv-when">${esc(fmtRangeLong(p.span.start, p.span.end, today))}</span><span class="pv-len">${n} day${n === 1 ? '' : 's'}</span>`;
  } else if (p.error) {
    const hard = !!p.dateText || showErrors;
    when = `<span class="pv-err${hard ? ' hard' : ''}">${esc(p.error)}</span>`;
  }
  const note = p.extraDates.length
    ? `<p class="pv-note">${p.extraDates.map((d) => `“${esc(d)}”`).join(', ')} stays in the name. Only the last date counts.</p>`
    : '';
  return `<div class="preview">${title}${tags}${when}</div>${note}`;
}

function renderAssist(): void {
  let html = '';
  if (ui.mode === 'add') {
    if (!ui.value.trim()) {
      html =
        flashHtml() ||
        `<p class="idle">Type a task with its days. <kbd>#tag</kbd> groups it, <kbd>res</kbd> resolves, <kbd>?</kbd> shows everything.</p>`;
    } else html = previewHtml();
  } else if (ui.mode === 'filter') {
    const n = visibleOpenTasks().length;
    html = ui.value.trim()
      ? `<p class="cmd-hint">${n} open task${n === 1 ? '' : 's'} match. <kbd>Enter</kbd> keeps the filter.</p>`
      : `<p class="cmd-hint">Type part of a name or <kbd>#group</kbd>.</p>`;
  } else if (ui.mode === 'mv') {
    const t = mvTarget();
    const sel = ui.suggestions[ui.selected]?.task;
    html = t.span
      ? `<p class="cmd-hint">${sel && isArmed() ? `Move “${esc(sel.title)}” to` : 'New dates:'} <span class="pv-when">${esc(fmtRangeLong(t.span.start, t.span.end, today))}</span></p>`
      : `<p class="cmd-hint"><span class="pv-err${showErrors || ui.value.includes('>') ? ' hard' : ''}">${esc(t.err ?? '')}</span></p>`;
  } else if (ui.mode === 'ren') {
    const r = renTarget();
    const sel = ui.suggestions[ui.selected]?.task;
    html = r
      ? `<p class="cmd-hint">Rename ${sel && isArmed() ? `“${esc(sel.title)}”` : ''} to <span class="pv-title">${esc(r.title || sel?.title || '')}</span>${r.tags.map((t) => ` <span class="pv-tag" style="${colorVars(t)}">${esc(t)}</span>`).join('')}</p>`
      : `<p class="cmd-hint">Pick the task, then type <kbd>&gt;</kbd> and the new name.</p>`;
  } else {
    html = flashHtml();
  }
  assist.innerHTML = html;
}

function renderPicker(): void {
  if (!PICKER_MODES.has(ui.mode)) {
    picker.hidden = true;
    picker.innerHTML = '';
    return;
  }
  picker.hidden = false;
  const armed = isArmed();
  const verb: Record<string, string> = { res: 'resolves', del: 'deletes', mv: 'moves', ren: 'renames', reopen: 'reopens' };
  if (!ui.suggestions.length) {
    const q = pickerQuery();
    const what = ui.mode === 'reopen' ? 'resolved' : 'open';
    picker.innerHTML = `<p class="p-empty">${q.text || q.tags.length ? `No ${what} task matches.` : `No ${what} tasks.`}</p>`;
    return;
  }
  const rows = ui.suggestions
    .map((s, i) => {
      const due = dueLabel(s.task, today);
      return `<li class="${armed && i === ui.selected ? 'sel' : ''}" data-i="${i}" style="${colorVars(groupOf(s.task))}">
        <span class="dot"></span>
        <span class="p-title">${highlightText(s.task.title, s.ranges)}</span>
        <span class="p-group">${esc(groupOf(s.task))}</span>
        <span class="p-due k-${due.kind}">${esc(due.text)}</span>
      </li>`;
    })
    .join('');
  const hint = armed
    ? `<kbd>Enter</kbd> ${verb[ui.mode]} the highlighted task. <kbd>↑</kbd><kbd>↓</kbd> picks another.`
    : `Start typing any part of the name. <kbd>↓</kbd> picks from the list.`;
  picker.innerHTML = `<ul>${rows}</ul><p class="p-hint">${hint} <kbd>Esc</kbd> leaves.</p>`;
}

function renderInputArea(): void {
  computeSuggestions();
  modeEl.hidden = ui.mode === 'add';
  modeEl.textContent = MODE_LABEL[ui.mode];
  input.placeholder = PLACEHOLDER[ui.mode];
  renderGhost();
  renderAssist();
  renderPicker();
}

function renderAll(): void {
  today = todayLocal();
  renderInputArea();
  if (ui.quick) return;
  if (ui.help) {
    listEl.hidden = true;
    calEl.hidden = true;
    helpEl.hidden = false;
  } else {
    helpEl.hidden = true;
    listEl.hidden = false;
    calEl.hidden = false;
    renderList(listEl, today);
    renderCalendar(calEl, today);
  }
  renderFooter(footEl, today);
}

/* ---------- actions ---------- */

function hideQuick(): void {
  if (ui.shell === 'tauri') location.href = 'daybound://hide';
}

function afterAction(): void {
  if (ui.quick) setTimeout(hideQuick, 450);
}

function doUndo(): void {
  const label = store.undo();
  flash(label ? `Undid: ${label}` : 'Nothing to undo', label ? 'ok' : 'info');
}

async function runCommand(raw: string): Promise<boolean> {
  const cmd = raw.toLowerCase();
  const syncOff = () => flash(ui.demo ? 'Sync is off in this demo.' : 'Sign-in happens in the main window.', 'info');
  if (cmd === 'u' || cmd === 'undo') {
    clearInput();
    doUndo();
    return true;
  }
  if (cmd === 'help' || cmd === '?') {
    clearInput();
    ui.help = true;
    renderAll();
    return true;
  }
  if (cmd === 'done') {
    clearInput();
    ui.view = 'archive';
    renderAll();
    return true;
  }
  if (cmd === 'login') {
    clearInput();
    if (ui.demo || ui.quick) syncOff();
    else location.href = '/api/login';
    return true;
  }
  if (cmd === 'logout') {
    clearInput();
    if (ui.demo) return syncOff(), true;
    await logout();
    flash('Signed out on this device. Your tasks stay here.', 'info');
    return true;
  }
  if (cmd === 'sync') {
    clearInput();
    if (ui.demo) return syncOff(), true;
    await syncNow();
    flash(syncStatus.state === 'synced' ? 'Synced' : syncStatus.message || 'Couldn’t sync', syncStatus.state === 'synced' ? 'ok' : 'err');
    return true;
  }
  const pm = raw.match(/^pair(?:\s+(\S+))?$/i);
  if (pm) {
    clearInput();
    if (ui.demo) return syncOff(), true;
    try {
      if (pm[1]) {
        await redeemPairCode(pm[1]);
        flash('Signed in on this device.', 'ok');
      } else if (!store.signedIn) {
        flash('Sign in first with login, then pair gives you a code for another device.', 'info', 7000);
      } else {
        const code = await createPairCode();
        flash(`Pairing code ${code}. On the other device, type pair ${code} within 10 minutes.`, 'info', 60_000);
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'err', 7000);
    }
    return true;
  }
  return false;
}

async function submitAdd(): Promise<void> {
  const raw = ui.value.trim();
  if (!raw) return;
  if (await runCommand(raw)) return renderAll();
  const p = parseInput(raw, today);
  if (p.error || (!p.span && !p.untimed)) {
    showErrors = true;
    shake();
    renderInputArea();
    return;
  }
  const now = Date.now();
  // An untimed task still stores a day so the saved shape never varies; nothing reads it.
  const span = p.span ?? { start: today, end: today };
  const task: Task = {
    id: newId(),
    title: p.title,
    tags: p.tags,
    start: span.start,
    end: span.end,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    deleted: false,
  };
  store.pushHistory(raw);
  clearInput();
  store.commit(`added “${task.title}”`, [task]);
  flash(
    p.untimed
      ? `Added “${task.title}” to long term, with no dates. Type u to undo.`
      : `Added “${task.title}”, ${fmtRange(task.start, task.end, today)}. Type u to undo.`,
  );
  afterAction();
}

function submitPicker(): void {
  const s = ui.suggestions[ui.selected];
  if (!isArmed() || !s) {
    shake();
    return;
  }
  const t = s.task;
  switch (ui.mode) {
    case 'res':
      clearInput();
      store.commit(`resolved “${t.title}”`, [store.update(t, { resolvedAt: Date.now() })]);
      flash(`Resolved “${t.title}”. Type u to undo.`);
      break;
    case 'del':
      clearInput();
      store.commit(`deleted “${t.title}”`, [store.update(t, { deleted: true })]);
      flash(`Deleted “${t.title}”. Type u to undo.`);
      break;
    case 'reopen': {
      clearInput();
      const reopened = store.update(t, { resolvedAt: null });
      store.commit(`reopened “${t.title}”`, [reopened]);
      const over = overdueDays(reopened, today);
      flash(`Reopened “${t.title}”.${over ? ` Its days ended ${over}d ago, so it shows as overdue.` : ''}`);
      break;
    }
    case 'mv': {
      if (isLongTerm(t)) {
        shake();
        flash(`“${t.title}” is long term, so it has no dates to move. Use ren to drop its #lt tag first.`, 'err');
        renderInputArea();
        return;
      }
      const target = mvTarget();
      if (!target.span) {
        showErrors = true;
        shake();
        renderInputArea();
        return;
      }
      setMode('add');
      clearInput();
      store.commit(`moved “${t.title}”`, [store.update(t, { start: target.span.start, end: target.span.end })]);
      flash(`Moved “${t.title}” to ${fmtRange(target.span.start, target.span.end, today)}.`);
      break;
    }
    case 'ren': {
      const r = renTarget();
      if (!r) {
        showErrors = true;
        shake();
        renderInputArea();
        return;
      }
      setMode('add');
      clearInput();
      const patch: Partial<Task> = {};
      if (r.title) patch.title = r.title;
      if (r.tags.length) patch.tags = r.tags;
      store.commit(`renamed “${t.title}”`, [store.update(t, patch)]);
      flash(`Renamed to “${r.title || t.title}”.`);
      break;
    }
  }
  afterAction();
}

function submit(): void {
  if (ui.mode === 'add') {
    void submitAdd();
  } else if (ui.mode === 'filter') {
    ui.filter = ui.value.trim();
    setMode('add');
    clearInput();
    if (ui.filter) flash(`Filtering by “${ui.filter}”. Esc clears it.`, 'info');
    renderAll();
  } else submitPicker();
}

function leaveMode(restoreWord: boolean): void {
  const word = ui.modeWord;
  setMode('add');
  clearInput();
  if (restoreWord && word) setInput(word);
  renderAll();
}

function escape(): void {
  if (ui.help) ui.help = false;
  else if (ui.value) clearInput();
  else if (ui.mode !== 'add') return leaveMode(false);
  else if (ui.quick) return hideQuick();
  else if (ui.filter) {
    ui.filter = '';
    flash('Filter cleared', 'info');
  } else if (ui.view === 'archive') ui.view = 'main';
  else if (ui.calOffset !== 0) ui.calOffset = 0;
  else ui.flash = null;
  renderAll();
}

function moveCalendar(weeks: number): void {
  ui.calOffset = weeks === 0 ? 0 : ui.calOffset + weeks;
  renderAll();
}

/** Tap or click on a task: jump into resolve mode with it picked (reopen for resolved ones). */
function pickTask(id: string): void {
  const t = store.tasks[id];
  if (!t || t.deleted) return;
  const mode: Mode = t.resolvedAt ? 'reopen' : 'res';
  if (ui.mode !== mode) setMode(mode, mode);
  setInput(t.title);
  computeSuggestions();
  const i = ui.suggestions.findIndex((s) => s.task.id === id);
  ui.selected = Math.max(0, i);
  ui.navigated = true;
  renderAll();
  input.focus();
}

/* ---------- resolve button ---------- */

const RESOLVE_MS = 260;
/** ids mid-animation, so a second click can't resolve twice */
const resolving = new Set<string>();

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resolveTask(id: string, row: HTMLElement | null): void {
  const t = store.tasks[id];
  if (!t || !isOpen(t) || resolving.has(id)) return;
  const commit = () => {
    resolving.delete(id);
    const cur = store.tasks[id];
    if (!cur || !isOpen(cur)) return;
    store.commit(`resolved “${cur.title}”`, [store.update(cur, { resolvedAt: Date.now() })]);
    flash(`Resolved “${cur.title}”. Type u to undo.`);
  };
  if (!row || reducedMotion()) return commit();
  resolving.add(id);
  row.classList.add('resolving');
  setTimeout(commit, RESOLVE_MS);
}

/* ---------- dragging a task into another group ---------- */

let dragId: string | null = null;

function clearDropTargets(): void {
  for (const el of document.querySelectorAll('.group.drop')) el.classList.remove('drop');
}

/** Drop onto a group section: that group becomes the task's first tag. */
function moveToGroup(id: string, group: string): void {
  const t = store.tasks[id];
  if (!t || !isOpen(t)) return;
  const patch = regroup(t, group, today);
  if (!patch) return;
  const wasUntimed = isLongTerm(t);
  store.commit(`moved “${t.title}” to ${group}`, [store.update(t, patch)]);
  flash(
    group === LONG_TERM
      ? `“${t.title}” is now long term, with no dates.`
      : wasUntimed
        ? `“${t.title}” is now in ${group}, due today. Use mv to change that.`
        : `Moved “${t.title}” to ${group}. Type u to undo.`,
  );
}

listEl.addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.task[data-id]');
  if (!row?.dataset.id || !store.tasks[row.dataset.id]) return;
  const id = (dragId = row.dataset.id);
  e.dataTransfer?.setData('text/plain', id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  ui.dragging = true;
  // Deferred: redrawing the list inside dragstart would replace the node the browser is
  // still snapshotting for the drag image, which cancels the drag in some browsers.
  setTimeout(() => {
    if (dragId !== id) return;
    renderList(listEl, today);
    listEl.querySelector(`.task[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging');
  }, 0);
});

function endDrag(): void {
  dragId = null;
  clearDropTargets();
  if (!ui.dragging) return;
  ui.dragging = false;
  renderList(listEl, today);
}

listEl.addEventListener('dragend', endDrag);

listEl.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const section = (e.target as HTMLElement).closest<HTMLElement>('.group[data-group]');
  const over = section?.dataset.group;
  const t = store.tasks[dragId];
  if (!over || !t || groupOf(t) === over) return clearDropTargets();
  e.preventDefault(); // allows the drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (!section!.classList.contains('drop')) {
    clearDropTargets();
    section!.classList.add('drop');
  }
});

listEl.addEventListener('dragleave', (e) => {
  const section = (e.target as HTMLElement).closest<HTMLElement>('.group[data-group]');
  if (section && !section.contains(e.relatedTarget as Node | null)) section.classList.remove('drop');
});

listEl.addEventListener('drop', (e) => {
  const section = (e.target as HTMLElement).closest<HTMLElement>('.group[data-group]');
  const id = dragId ?? e.dataTransfer?.getData('text/plain') ?? '';
  const group = section?.dataset.group;
  e.preventDefault();
  endDrag();
  if (group && id) moveToGroup(id, group);
});

/* ---------- events ---------- */

input.addEventListener('input', () => {
  let v = input.value;
  if (ui.mode === 'add') {
    const m = v.match(/^(\S+)\s/);
    const word = m?.[1].toLowerCase();
    if (m && word && PREFIX[word]) {
      setMode(PREFIX[word], m[1]);
      v = v.slice(m[0].length);
      input.value = v;
    } else if (v.startsWith('/')) {
      setMode('filter', '/');
      v = v.slice(1);
      input.value = v;
    }
  }
  ui.value = v;
  ui.selected = 0;
  ui.navigated = false;
  ui.historyIndex = -1;
  showErrors = false;
  if (ui.mode === 'filter') renderAll();
  else {
    renderInputArea();
    if (PICKER_MODES.has(ui.mode) && !ui.quick) {
      renderList(listEl, today);
      renderCalendar(calEl, today);
    }
  }
});

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  const picking = PICKER_MODES.has(ui.mode);

  if (key === 'Enter') {
    e.preventDefault();
    submit();
    return;
  }
  if (key === 'Escape') {
    e.preventDefault();
    escape();
    return;
  }
  if (key === 'Tab') {
    e.preventDefault();
    if (picking) moveSelection(e.shiftKey ? -1 : 1);
    else if (ghost.dataset.suffix) {
      setInput(input.value + ghost.dataset.suffix + ' ');
      renderInputArea();
    }
    return;
  }
  if (picking && (key === 'ArrowDown' || key === 'ArrowUp')) {
    e.preventDefault();
    moveSelection(key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (picking && mod && /^[jknp]$/i.test(key)) {
    e.preventDefault();
    moveSelection(/^[jn]$/i.test(key) ? 1 : -1);
    return;
  }
  if (ui.mode === 'add' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const h = store.history;
    if (key === 'ArrowUp') {
      if (!h.length || (ui.value && ui.historyIndex === -1)) return;
      e.preventDefault();
      ui.historyIndex = Math.min(ui.historyIndex + 1, h.length - 1);
      setInput(h[h.length - 1 - ui.historyIndex]);
    } else {
      if (ui.historyIndex < 0) return;
      e.preventDefault();
      ui.historyIndex--;
      setInput(ui.historyIndex < 0 ? '' : h[h.length - 1 - ui.historyIndex]);
    }
    renderInputArea();
    return;
  }
  if (key === 'PageDown' || key === 'PageUp') {
    e.preventDefault();
    moveCalendar(key === 'PageDown' ? 4 : -4);
    return;
  }
  if (!ui.value && !mod && ui.mode === 'add') {
    if (key === '[' || key === ']') {
      e.preventDefault();
      moveCalendar(key === ']' ? 1 : -1);
      return;
    }
    if (key === '?') {
      e.preventDefault();
      ui.help = !ui.help;
      renderAll();
      return;
    }
  }
  if (mod && key.toLowerCase() === 'z' && !e.shiftKey && !ui.value) {
    e.preventDefault();
    doUndo();
    return;
  }
  if (key === 'Backspace' && !ui.value && ui.mode !== 'add') {
    e.preventDefault();
    leaveMode(true);
  }
});

// Any key typed while focus is elsewhere goes to the input.
document.addEventListener(
  'keydown',
  (e) => {
    if (document.activeElement !== input && !e.metaKey && !e.ctrlKey && !e.altKey) input.focus();
  },
  true,
);

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const cal = target.closest<HTMLElement>('[data-cal]');
  const check = target.closest<HTMLElement>('[data-resolve]');
  if (check?.dataset.resolve) {
    // the circle resolves directly; it must not also open resolve mode for the row
    e.stopPropagation();
    resolveTask(check.dataset.resolve, check.closest<HTMLElement>('.task'));
  } else if (cal) {
    moveCalendar(Number(cal.dataset.cal));
  } else if (target.closest('.help-hint')) {
    ui.help = !ui.help;
    renderAll();
  } else {
    const pick = target.closest<HTMLElement>('#picker li[data-i]');
    if (pick) {
      ui.selected = Number(pick.dataset.i);
      ui.navigated = true;
      submitPicker();
    } else {
      const row = target.closest<HTMLElement>('[data-id]');
      if (row?.dataset.id) pickTask(row.dataset.id);
    }
  }
  if (matchMedia('(pointer: fine)').matches && window.getSelection()?.isCollapsed !== false) {
    input.focus({ preventScroll: true });
  }
});

window.addEventListener('resize', () => renderGhost());

/* ---------- boot ---------- */

function scheduleMidnight(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    renderAll();
    scheduleMidnight();
  }, next.getTime() - now.getTime());
}

function boot(): void {
  const params = new URLSearchParams(location.search);
  ui.quick = params.get('quick') === '1';
  ui.shell = params.get('shell') ?? '';
  ui.demo = import.meta.env.VITE_DEMO === '1';
  if (ui.quick) document.body.classList.add('quick');

  helpEl.innerHTML = HELP_HTML;
  store.load();
  store.watchOtherWindows();
  store.subscribe(renderAll);
  onSyncStatus(() => renderFooter(footEl, today));

  const authError = params.get('auth_error');
  if (authError) flash(authError, 'err', 10_000);
  if (params.has('signed_in')) {
    store.signedIn = true;
    store.save();
    flash('Signed in. Syncing now.', 'ok');
  }
  if (authError || params.has('signed_in')) {
    params.delete('auth_error');
    params.delete('signed_in');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  if (ui.quick) {
    window.addEventListener('focus', () => {
      store.load();
      renderAll();
      input.focus();
    });
    window.addEventListener('blur', () => {
      setMode('add');
      clearInput();
      renderAll();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderAll();
  });

  initSync({ demo: ui.demo });
  renderAll();
  scheduleMidnight();
  input.focus();

  if (
    'serviceWorker' in navigator &&
    import.meta.env.PROD &&
    !ui.demo &&
    (location.protocol === 'https:' || location.hostname === 'localhost')
  ) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

boot();
