import type { ReactElement, ReactNode } from 'react';
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
