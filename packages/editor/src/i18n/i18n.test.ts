import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectLocale,
  LocaleProvider,
  LOCALE_STORAGE_KEY,
  resolveInitialLocale,
  useI18n,
  type Locale,
  type MessageKey
} from './index';
import { en } from './messages/en';
import { zhHant } from './messages/zh-Hant';
import { zhHans } from './messages/zh-Hans';

type I18n = ReturnType<typeof useI18n>;

let container: HTMLDivElement;
let root: Root;
let current: I18n;

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe({ onRender }: { onRender: (value: I18n) => void }) {
  const value = useI18n();
  onRender(value);
  return createElement('span', { 'data-testid': 'locale' }, value.locale);
}

async function renderProvider(initialLocale?: Locale): Promise<void> {
  const onRender = (value: I18n) => {
    current = value;
  };
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        initialLocale,
        children: createElement(Probe, { onRender })
      })
    );
  });
}

describe('detectLocale', () => {
  it.each([
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
    ['zh-Hant-CN', 'zh-Hant'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh', 'zh-Hans'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr-FR', 'en']
  ])('%s maps to %s', (language, expected) => {
    expect(detectLocale(language)).toBe(expected);
  });
});

describe('resolveInitialLocale', () => {
  it('uses a valid stored locale', () => {
    expect(resolveInitialLocale({ getItem: () => 'zh-Hans' })).toBe('zh-Hans');
  });

  it('falls back to detection for a missing or invalid value', () => {
    expect(resolveInitialLocale({ getItem: () => null })).toBe(
      detectLocale(navigator.language)
    );
    expect(resolveInitialLocale({ getItem: () => 'fr' })).toBe(
      detectLocale(navigator.language)
    );
  });

  it('falls back to detection when storage throws', () => {
    expect(
      resolveInitialLocale({
        getItem: () => {
          throw new Error('storage blocked');
        }
      })
    ).toBe(detectLocale(navigator.language));
  });

  it('does not require localStorage to exist', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => resolveInitialLocale()).not.toThrow();
    expect(resolveInitialLocale()).toBe(detectLocale(navigator.language));
  });
});

it('keeps every dictionary key-aligned', () => {
  expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  expect(Object.keys(zhHans).sort()).toEqual(Object.keys(en).sort());
});

it('keeps interpolation placeholders aligned across dictionaries', () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  for (const key of Object.keys(en) as MessageKey[]) {
    expect(placeholders(zhHant[key])).toEqual(placeholders(en[key]));
    expect(placeholders(zhHans[key])).toEqual(placeholders(en[key]));
  }
});

describe('LocaleProvider', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    document.documentElement.lang = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.lang = '';
  });

  it('applies an explicit locale and translates with its dictionary', async () => {
    await renderProvider('zh-Hant');
    expect(current.locale).toBe('zh-Hant');
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(current.t('common.close')).toBe('關閉');
  });

  it('restores a valid stored locale when no initial locale is given', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-Hans');
    await renderProvider();
    expect(current.locale).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(current.t('common.close')).toBe('关闭');
  });

  it('persists setLocale and updates the document language', async () => {
    await renderProvider('en');
    await act(async () => {
      current.setLocale('zh-Hant');
    });
    expect(current.locale).toBe('zh-Hant');
    expect(current.t('common.close')).toBe('關閉');
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-Hant');
  });

  it('still renders and switches when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    await renderProvider();
    expect(document.documentElement.lang).toBe(detectLocale(navigator.language));
    await act(async () => {
      current.setLocale('zh-Hans');
    });
    expect(current.locale).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(current.t('common.close')).toBe('关闭');
  });

  it('interpolates count and name variables', async () => {
    await renderProvider('en');
    expect(
      current.t('export.exported', { count: 2, files: 'a.html, b.html' })
    ).toBe('Exported 2 files: a.html, b.html');
    expect(current.t('export.downloaded', { name: 'deck.html' })).toBe(
      'Downloaded deck.html.'
    );
    expect(current.t('a11y.selectedCount', { count: 3 })).toBe(
      'Selected 3 objects'
    );
  });

  it('leaves missing interpolation variables untouched', async () => {
    await renderProvider('en');
    expect(current.t('export.exported', { count: 3 })).toBe(
      'Exported 3 files: {files}'
    );
    expect(current.t('export.downloaded')).toBe('Downloaded {name}.');
  });

  it('returns the key for an unknown message', async () => {
    await renderProvider('en');
    expect(current.t('common.missing' as MessageKey)).toBe('common.missing');
  });
});
