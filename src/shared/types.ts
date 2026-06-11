/**
 * @file src/shared/types.ts
 * @purpose Data models shared by main / preload / renderer.
 *
 * M0 scope: settings only. Session / document models arrive in M1/M3.
 */

/** v1 ships the three Rose Pine variants only (technical-design.md, 主题系统). */
export type ThemeId = 'rose-pine' | 'rose-pine-dawn' | 'rose-pine-moon';

export interface Settings {
  version: 1;
  appearance: {
    theme: ThemeId;
    /** UI font stack; LXGW WenKai inherited from the Marina design language. */
    uiFontFamily: string;
    /** Terminal font stack (consumed from M3 on, declared now for stability). */
    terminalFontFamily: string;
    terminalFontSize: number;
  };
}

/** Recursive partial, for settings updates. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface SettingsChangedEvent {
  settings: Settings;
  /** Dotted paths of changed fields, e.g. "appearance.theme". */
  changedKeys: string[];
}

export interface PingResult {
  pong: true;
  echo: unknown;
  /** ISO timestamp produced by the main process. */
  time: string;
  /** Main-process pid — proves the round trip crossed process boundaries. */
  pid: number;
}
