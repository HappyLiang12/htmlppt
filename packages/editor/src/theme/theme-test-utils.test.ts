import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18n } from '../i18n/index';
import { withProviders } from '../i18n/test-utils';
import { useTheme } from './index';

interface ProbeValues {
  theme: ReturnType<typeof useTheme>;
  i18n: ReturnType<typeof useI18n>;
}

function Probe({ onRender }: { onRender: (values: ProbeValues) => void }) {
  const theme = useTheme();
  const i18n = useI18n();
  onRender({ theme, i18n });
  return createElement(
    'span',
    { 'data-testid': 'probe' },
    `${i18n.locale}:${theme.mode}:${theme.resolved}`
  );
}

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  );
}

let container: HTMLDivElement;
let root: Root;
let current: ProbeValues;

async function render(ui: ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
  document.documentElement.style.colorScheme = '';
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
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
  document.documentElement.style.colorScheme = '';
  document.documentElement.lang = '';
});

describe('withProviders', () => {
  it('defaults to zh-Hant and dark regardless of storage and the OS', async () => {
    localStorage.setItem('htmlppt.locale', 'en');
    localStorage.setItem('htmlppt.theme', 'light');
    stubMatchMedia(false);

    await render(
      withProviders(
        createElement(Probe, {
          onRender: (values) => {
            current = values;
          }
        })
      )
    );

    expect(current.theme.mode).toBe('dark');
    expect(current.theme.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    expect(current.i18n.locale).toBe('zh-Hant');
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(current.i18n.t('common.close')).toBe('關閉');
    expect(container.textContent).toBe('zh-Hant:dark:dark');
  });

  it('applies explicit locale and theme overrides together', async () => {
    stubMatchMedia(true);

    await render(
      withProviders(
        createElement(Probe, {
          onRender: (values) => {
            current = values;
          }
        }),
        { locale: 'en', theme: 'light' }
      )
    );

    expect(current.theme.mode).toBe('light');
    expect(current.theme.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');

    expect(current.i18n.locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(current.i18n.t('common.close')).toBe('Close');
    expect(container.textContent).toBe('en:light:light');
  });
});
