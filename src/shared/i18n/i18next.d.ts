import 'i18next';
import type { enUS } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    returnNull: false;
    resources: (typeof enUS)['translation'];
  }
}

