import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  applyTheme,
  isThemeMode,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode
} from './theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function ThemeProvider({
  children,
  initialMode
}: {
  children: ReactNode;
  initialMode?: ThemeMode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(
    () => initialMode ?? readStoredTheme()
  );
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved = resolveTheme(mode, systemDark);

  const setMode = useCallback((next: ThemeMode) => {
    if (!isThemeMode(next)) return;
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable in private or sandboxed contexts.
    }
  }, []);

  useLayoutEffect(() => {
    applyTheme(resolved, mode);
  }, [resolved, mode]);

  useEffect(() => {
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode]
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
