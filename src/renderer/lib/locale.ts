import type { AppLocale } from '@shared/types';
import { FALLBACK_LOCALE, normalizeSystemLocale } from '@shared/i18n/locale';
import { rendererI18n } from '@renderer/i18n';

const collators = new Map<AppLocale, Intl.Collator>();

export function currentLocale(): AppLocale {
  const locale = rendererI18n.resolvedLanguage ?? rendererI18n.language;
  return locale ? normalizeSystemLocale(locale) : FALLBACK_LOCALE;
}

export function displayCollator(locale = currentLocale()): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(locale, collator);
  }
  return collator;
}

export function compareDisplayText(a: string, b: string): number {
  return displayCollator().compare(a, b);
}

