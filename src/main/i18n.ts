import i18next from 'i18next';
import type { AppLocale, LocalePreference } from '@shared/types';
import { FALLBACK_LOCALE, resolveLocale } from '@shared/i18n/locale';
import { I18N_RESOURCES } from '@shared/i18n/resources';

const mainI18n = i18next.createInstance();
const mainI18nReady = mainI18n.init({
  resources: I18N_RESOURCES,
  lng: FALLBACK_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
});

export async function initializeMainI18n(
  preference: LocalePreference,
  systemLocale: string,
): Promise<AppLocale> {
  const locale = resolveLocale(preference, systemLocale);
  await mainI18nReady;
  await mainI18n.changeLanguage(locale);
  return locale;
}

export const mainT = mainI18n.t.bind(mainI18n);
