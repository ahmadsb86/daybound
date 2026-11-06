import type { Task } from '../lib/types';

export type Mode = 'add' | 'res' | 'del' | 'mv' | 'ren' | 'reopen' | 'filter';

export const PICKER_MODES: ReadonlySet<Mode> = new Set(['res', 'del', 'mv', 'ren', 'reopen']);

export const MODE_LABEL: Record<Mode, string> = {
  add: '',
  res: 'resolve',
  del: 'delete',
  mv: 'move',
  ren: 'rename',
  reopen: 'reopen',
  filter: 'filter',
};

export interface Suggestion {
  task: Task;
  ranges: Array<[number, number]>;
  score: number;
}

export const ui = {
  mode: 'add' as Mode,
  /** what was typed to enter the mode, restored if you backspace out of it */
  modeWord: '',
  value: '',
  suggestions: [] as Suggestion[],
  selected: 0,
  /** true once arrows/tab were used, so Enter on an empty query acts on the highlighted row */
  navigated: false,
  /** a query was typed or a row was picked, so Enter will act on the highlighted row */
  armed: false,
  /** locked filter from "/text" + Enter */
  filter: '',
  view: 'main' as 'main' | 'archive',
  calOffset: 0,
  help: false,
  flash: null as { text: string; kind: 'ok' | 'err' | 'info'; until: number } | null,
  historyIndex: -1,
  quick: false,
  shell: '',
  demo: false,
};

export function activeFilter(): string {
  return ui.mode === 'filter' ? ui.value.trim() : ui.filter;
}

export function highlightedTask(): Task | null {
  if (!PICKER_MODES.has(ui.mode) || !ui.armed) return null;
  return ui.suggestions[ui.selected]?.task ?? null;
}
