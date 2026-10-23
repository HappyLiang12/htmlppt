import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { en } from './messages/en';
import type { MessageKey } from './messages/en';
import { zhHant } from './messages/zh-Hant';
import { zhHans } from './messages/zh-Hans';

export type { MessageKey } from './messages/en';

export type Locale = 'en' | 'zh-Hant' | 'zh-Hans';
export type Translator = (
  key: MessageKey,
  vars?: Record<string, string | number>
) => string;

export const LOCALE_STORAGE_KEY = 'htmlppt.locale';

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-Hant': zhHant,
  'zh-Hans': zhHans
};

const VALID_LOCALES = new Set<Locale>(['en', 'zh-Hant', 'zh-Hans']);

function isLocale(value: string): value is Locale {
  return VALID_LOCALES.has(value as Locale);
}

export function detectLocale(language: string): Locale {
  const value = language.toLowerCase();
  const subtags = value.split('-');
  if (subtags[0] !== 'zh') {
    return 'en';
  }
  if (subtags.includes('hant')) {
    return 'zh-Hant';
  }
  if (subtags.includes('hans')) {
    return 'zh-Hans';
  }
  if (value === 'zh-tw' || value === 'zh-hk' || value === 'zh-mo') {
    return 'zh-Hant';
  }
  return 'zh-Hans';
}

function defaultStorage(): Pick<Storage, 'getItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function resolveInitialLocale(
  storage?: Pick<Storage, 'getItem'>
): Locale {
  const source = storage ?? defaultStorage();
  let stored: string | null = null;
  if (source) {
    try {
      stored = source.getItem(LOCALE_STORAGE_KEY);
    } catch {
      stored = null;
    }
  }
  if (stored && isLocale(stored)) {
    return stored;
  }
  return detectLocale(
    typeof navigator === 'undefined' ? 'en' : navigator.language
  );
}

function ownMessage(
  dictionary: Record<MessageKey, string>,
  key: MessageKey
): string | undefined {
  return Object.prototype.hasOwnProperty.call(dictionary, key)
    ? dictionary[key]
    : undefined;
}

function interpolate(
  template: string,
  vars?: Record<string, string | number>
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : match
  );
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  initialLocale
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? resolveInitialLocale()
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      }
    } catch {
      // Storage may be unavailable in private or sandboxed contexts.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback<Translator>(
    (key, vars) =>
      interpolate(
        ownMessage(DICTIONARIES[locale], key) ?? ownMessage(en, key) ?? key,
        vars
      ),
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useI18n(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) {
    throw new Error('useI18n must be used inside LocaleProvider');
  }
  return value;
}
