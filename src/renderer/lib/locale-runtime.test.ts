import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeRendererI18n, rendererI18n } from '@renderer/i18n';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const documentElement = { lang: '' };

beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'zh-Hans-CN' },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement },
  });
});

afterAll(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
  else Reflect.deleteProperty(globalThis, 'document');
});

describe('renderer locale runtime', () => {
  it('resolves the system locale and updates html.lang', async () => {
    await initializeRendererI18n('system');
    expect(rendererI18n.resolvedLanguage).toBe('zh-CN');
    expect(documentElement.lang).toBe('zh-CN');
    expect(rendererI18n.t('app.quit')).toBe('退出');
  });

  it('switches immediately without changing canonical stored values', async () => {
    const storedStatus = 'In Progress';
    await initializeRendererI18n('en-US');
    expect(documentElement.lang).toBe('en-US');
    expect(rendererI18n.t('app.quit')).toBe('Quit');
    expect(storedStatus).toBe('In Progress');
  });
});
