import type { ReactElement, ReactNode } from 'react';
import { ThemeProvider } from '../theme/index';
import type { ThemeMode } from '../theme/theme';
import { LocaleProvider, type Locale } from './index';

/** Renders a component inside a provider so its copy resolves in tests. */
export function withLocale(
  children: ReactNode,
  locale: Locale = 'zh-Hant'
): ReactElement {
  return (
    <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
  );
}

export interface ProviderOptions {
  locale?: Locale;
  theme?: ThemeMode;
}

/**
 * Renders a component inside both providers with explicit defaults so tests
 * do not depend on the host locale, stored preferences, or the OS setting.
 */
export function withProviders(
  children: ReactNode,
  { locale = 'zh-Hant', theme = 'dark' }: ProviderOptions = {}
): ReactElement {
  return (
    <LocaleProvider initialLocale={locale}>
      <ThemeProvider initialMode={theme}>{children}</ThemeProvider>
    </LocaleProvider>
  );
}
