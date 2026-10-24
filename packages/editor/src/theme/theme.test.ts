import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  isThemeMode,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode
} from './theme';
import { ThemeProvider, useTheme } from './index';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
  document.documentElement.style.colorScheme = '';
});

describe('theme helpers', () => {
  it('validates modes and resolves system', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('sepia')).toBe(false);
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads a valid stored mode and falls back to system', () => {
    const stored = (value: string | null) => ({ getItem: () => value });
    expect(readStoredTheme(stored('light'))).toBe('light');
    expect(readStoredTheme(stored('dark'))).toBe('dark');
    expect(readStoredTheme(stored('bogus'))).toBe('system');
    expect(readStoredTheme(stored(null))).toBe('system');
  });

  it('reads the literal htmlppt.theme storage key', () => {
    const getItem = vi.fn(() => null);
    readStoredTheme({ getItem });
    expect(getItem).toHaveBeenCalledWith('htmlppt.theme');
  });

  it('falls back to system when storage throws', () => {
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('storage blocked');
        }
      })
    ).toBe('system');
  });

  it('does not require localStorage to exist', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => readStoredTheme()).not.toThrow();
    expect(readStoredTheme()).toBe('system');
    vi.unstubAllGlobals();
  });

  it('writes the resolved theme and color scheme', () => {
    applyTheme('light', 'system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');
    expect(document.documentElement.style.colorScheme).toBe('light');

    applyTheme('dark', 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});

interface FakeMatchMedia {
  matchMedia: ReturnType<typeof vi.fn>;
  query: {
    matches: boolean;
    media: string;
  };
  emit: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMatchMedia {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      }
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      }
    ),
    dispatchEvent: vi.fn(() => true)
  };
  const matchMedia = vi.fn(() => query as unknown as MediaQueryList);
  vi.stubGlobal('matchMedia', matchMedia);

  return {
    matchMedia,
    query,
    emit: (matches) => {
      query.matches = matches;
      for (const listener of [...listeners]) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size
  };
}

type Theme = ReturnType<typeof useTheme>;

let container: HTMLDivElement;
let root: Root;
let current: Theme;
let mounted: boolean;

function Probe({ onRender }: { onRender: (value: Theme) => void }) {
  const value = useTheme();
  onRender(value);
  return createElement('span', { 'data-testid': 'theme' }, value.resolved);
}

async function renderThemeProvider(initialMode?: ThemeMode): Promise<void> {
  mounted = true;
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        initialMode,
        children: createElement(Probe, {
          onRender: (value) => {
            current = value;
          }
        })
      })
    );
  });
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-mode');
    document.documentElement.style.colorScheme = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (mounted) {
      await act(async () => {
        root.unmount();
      });
      mounted = false;
    }
    container.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-mode');
    document.documentElement.style.colorScheme = '';
  });

  it('applies an explicit initial mode', async () => {
    await renderThemeProvider('dark');
    expect(current.mode).toBe('dark');
    expect(current.resolved).toBe('dark');
    expect(container.textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it.each(['light', 'dark'] as const)(
    'restores a stored %s mode when no initial mode is given',
    async (stored) => {
      localStorage.setItem(THEME_STORAGE_KEY, stored);
      await renderThemeProvider();
      expect(current.mode).toBe(stored);
      expect(current.resolved).toBe(stored);
      expect(document.documentElement.dataset.theme).toBe(stored);
    }
  );

  it('falls back to system for an invalid stored value', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    await renderThemeProvider();
    expect(current.mode).toBe('system');
    expect(current.resolved).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');
  });

  it('persists setMode and re-applies the document attributes', async () => {
    await renderThemeProvider('light');
    await act(async () => {
      current.setMode('dark');
    });
    expect(current.mode).toBe('dark');
    expect(current.resolved).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('ignores an invalid setMode value', async () => {
    await renderThemeProvider('dark');
    await act(async () => {
      current.setMode('sepia' as ThemeMode);
    });
    expect(current.mode).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('follows system preference changes and cleans up its listener', async () => {
    const media = installMatchMedia(true);
    await renderThemeProvider('system');
    expect(media.matchMedia).toHaveBeenCalledWith(
      '(prefers-color-scheme: dark)'
    );
    expect(media.listenerCount()).toBe(1);
    expect(current.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await act(async () => {
      media.emit(false);
    });
    expect(current.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');

    await act(async () => {
      root.unmount();
    });
    mounted = false;
    expect(media.listenerCount()).toBe(0);
  });

  it('does not subscribe to system changes outside system mode', async () => {
    const media = installMatchMedia(true);
    await renderThemeProvider('light');
    expect(media.listenerCount()).toBe(0);
    expect(current.resolved).toBe('light');
  });

  it('still renders and switches when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    await renderThemeProvider();
    expect(current.mode).toBe('system');
    await act(async () => {
      current.setMode('dark');
    });
    expect(current.mode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
