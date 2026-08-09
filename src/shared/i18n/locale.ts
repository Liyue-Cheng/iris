import type { AppLocale, LocalePreference } from '../types';

export const APP_LOCALES: readonly AppLocale[] = ['zh-CN', 'en-US'];
export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['system', ...APP_LOCALES];
export const FALLBACK_LOCALE: AppLocale = 'en-US';

export function normalizeSystemLocale(locale: string | null | undefined): AppLocale {
  return locale?.trim().toLowerCase().startsWith('zh') ? 'zh-CN' : FALLBACK_LOCALE;
}

export function resolveLocale(
  preference: LocalePreference,
  systemLocale: string | null | undefined,
): AppLocale {
  return preference === 'system' ? normalizeSystemLocale(systemLocale) : preference;
}

