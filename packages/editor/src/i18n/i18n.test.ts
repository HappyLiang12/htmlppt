import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectLocale,
  LocaleProvider,
  resolveInitialLocale,
  useI18n,
  type Locale,
  type MessageKey
} from './index';
import { en } from './messages/en';
import { zhHant } from './messages/zh-Hant';
import { zhHans } from './messages/zh-Hans';
import { PresenterView } from '../PresenterView';

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
    ['ZH-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
    ['zh-Hant-CN', 'zh-Hant'],
    ['zh-Hant-TW', 'zh-Hant'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-TW', 'zh-Hans'],
    ['zh', 'zh-Hans'],
    ['zh-twx', 'zh-Hans'],
    ['zh-hantish', 'zh-Hans'],
    ['zhx', 'en'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr-FR', 'en']
  ])('%s maps to %s', (language, expected) => {
    expect(detectLocale(language)).toBe(expected);
  });
});

describe('resolveInitialLocale', () => {
  it('reads the literal htmlppt.locale storage key', () => {
    const getItem = vi.fn(() => null);
    resolveInitialLocale({ getItem });
    expect(getItem).toHaveBeenCalledWith('htmlppt.locale');
  });

  it.each(['en', 'zh-Hant', 'zh-Hans'] as const)(
    'uses a valid stored %s locale',
    (stored) => {
      expect(resolveInitialLocale({ getItem: () => stored })).toBe(stored);
    }
  );

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

  it.each([
    ['en', 'Close'],
    ['zh-Hant', '關閉'],
    ['zh-Hans', '关闭']
  ] as const)(
    'restores a valid stored %s locale when no initial locale is given',
    async (stored, close) => {
      localStorage.setItem('htmlppt.locale', stored);
      await renderProvider();
      expect(current.locale).toBe(stored);
      expect(document.documentElement.lang).toBe(stored);
      expect(current.t('common.close')).toBe(close);
    }
  );

  it('does not write storage during initial detection', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem,
      clear: () => undefined
    });
    await renderProvider();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('persists setLocale and updates the document language', async () => {
    await renderProvider('en');
    await act(async () => {
      current.setLocale('zh-Hant');
    });
    expect(current.locale).toBe('zh-Hant');
    expect(current.t('common.close')).toBe('關閉');
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(localStorage.getItem('htmlppt.locale')).toBe('zh-Hant');
  });

  it('still switches locales when setItem throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage blocked');
      },
      clear: () => undefined
    });
    await renderProvider('en');
    await act(async () => {
      current.setLocale('zh-Hans');
    });
    expect(current.locale).toBe('zh-Hans');
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(current.t('common.close')).toBe('关闭');
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

  it.each(['toString', 'constructor', '__proto__'] as const)(
    'returns the key for inherited object member %s',
    async (key) => {
      await renderProvider('zh-Hant');
      expect(current.t(key as MessageKey)).toBe(key);
      expect(current.t(key as MessageKey, { count: 1 })).toBe(key);
    }
  );
});

describe('PresenterView locale', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders its chrome in English when the locale is English', async () => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          initialLocale: 'en',
          children: createElement(PresenterView, { sessionId: 'invalid' })
        })
      );
    });

    expect(container.querySelector('h1')?.textContent).toBe('Presenter view');
    expect(
      container.querySelector('[data-testid="presenter-status"]')?.textContent
    ).toBe('Disconnected');
    expect(
      Array.from(container.querySelectorAll('h2')).map((heading) =>
        heading.textContent
      )
    ).toContain('Notes');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Not connected to the main window. Reopen the presenter view from the editor.'
    );
  });
});
