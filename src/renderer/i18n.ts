import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { AppLocale, LocalePreference } from '@shared/types';
import { FALLBACK_LOCALE, resolveLocale } from '@shared/i18n/locale';
import { I18N_RESOURCES } from '@shared/i18n/resources';

export const rendererI18n = i18next.createInstance();

export async function initializeRendererI18n(preference: LocalePreference): Promise<AppLocale> {
  const locale = resolveLocale(preference, navigator.language);
  if (!rendererI18n.isInitialized) {
    await rendererI18n.use(initReactI18next).init({
      resources: I18N_RESOURCES,
      lng: locale,
      fallbackLng: FALLBACK_LOCALE,
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else {
    await rendererI18n.changeLanguage(locale);
  }
  document.documentElement.lang = locale;
  return locale;
}

export function translate(...args: Parameters<typeof rendererI18n.t>): string {
  return rendererI18n.t(...args);
}

