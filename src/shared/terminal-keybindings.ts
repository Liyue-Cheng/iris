/**
 * @file src/shared/terminal-keybindings.ts
 * @purpose Terminal keybinding authority table — ported from Marina
 *   (search bindings dropped until Iris grows a search bar).
 *
 * The TerminalView keyboard handler is "scan table → dispatch action";
 * every key, guard and action lives here so it stays unit-testable
 * without mocking xterm or the DOM.
 *
 * Invariants (Marina KBD-1):
 * 1. Any keydown that matches a binding must be consumed (return false to
 *    xterm) — except 'copy-or-sigint' with no selection, which passes ^C
 *    through to the PTY as SIGINT.
 * 2. Paste actions only consume the keyboard event; the actual paste runs
 *    in the capture-phase 'paste' DOM listener (Marina PASTE-1), so every
 *    paste source (keys, context menu, voice input) shares one path.
 * 3. Callers must guard IME composition (isComposing || keyCode===229)
 *    before matching — this module never reads those fields.
 */

export type KeybindingAction =
  /** Selection → copy + clear selection (consume); none → pass ^C as SIGINT */
  | 'copy-or-sigint'
  /** Selection → copy + clear selection; always consume */
  | 'copy-and-clear'
  /** Consume the keydown; the capture-phase paste listener does the work */
  | 'consume-for-paste';

export interface KeybindingMatcher {
  /** Ctrl or Cmd (treated as equivalent) */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** ev.key.toLowerCase() — letters / 'insert' / ... */
  key: string;
}

export interface Keybinding {
  id: string;
  /** Human-readable spec (Windows/Linux notation). */
  spec: string;
  description: string;
  match: KeybindingMatcher;
  action: KeybindingAction;
}

export const TERMINAL_KEYBINDINGS: readonly Keybinding[] = [
  {
    id: 'copy-ctrl-c',
    spec: 'Ctrl+C',
    description: '有选区时复制并清选区；无选区时透传 SIGINT',
    match: { mod: true, shift: false, alt: false, key: 'c' },
    action: 'copy-or-sigint',
  },
  {
    id: 'copy-shift-c',
    spec: 'Ctrl+Shift+C',
    description: '复制（有选区时；无选区时静默 consume）',
    match: { mod: true, shift: true, alt: false, key: 'c' },
    action: 'copy-and-clear',
  },
  {
    id: 'copy-insert',
    spec: 'Ctrl+Insert',
    description: '复制（经典 Windows 兼容键位）',
    match: { mod: true, shift: false, alt: false, key: 'insert' },
    action: 'copy-and-clear',
  },
  {
    id: 'paste-ctrl-v',
    spec: 'Ctrl+V',
    description: '粘贴（真正动作由 capture-phase paste listener 执行）',
    match: { mod: true, shift: false, alt: false, key: 'v' },
    action: 'consume-for-paste',
  },
  {
    id: 'paste-shift-v',
    spec: 'Ctrl+Shift+V',
    description: '粘贴',
    match: { mod: true, shift: true, alt: false, key: 'v' },
    action: 'consume-for-paste',
  },
  {
    id: 'paste-shift-insert',
    spec: 'Shift+Insert',
    description: '粘贴（经典 Windows 兼容键位）',
    match: { mod: false, shift: true, alt: false, key: 'insert' },
    action: 'consume-for-paste',
  },
];

/** Only the KeyboardEvent fields the matcher needs — easy to mock. */
export interface KeyEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/** Linear scan, first match wins. Returns null when nothing matches. */
export function matchKeybinding(ev: KeyEventLike): Keybinding | null {
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  for (const b of TERMINAL_KEYBINDINGS) {
    if (b.match.mod !== mod) continue;
    if (b.match.shift !== ev.shiftKey) continue;
    if (b.match.alt !== ev.altKey) continue;
    if (b.match.key !== key) continue;
    return b;
  }
  return null;
}
