export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'htmlppt.theme';
const MODES = new Set<ThemeMode>(['light', 'dark', 'system']);

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && MODES.has(value as ThemeMode);
}

export function resolveTheme(
  mode: ThemeMode,
  systemDark: boolean
): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

function readDefaultStorage(): string | null {
  try {
    return typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readStoredTheme(
  storage?: Pick<Storage, 'getItem'>
): ThemeMode {
  let stored: string | null = null;
  try {
    stored = storage ? storage.getItem(THEME_STORAGE_KEY) : readDefaultStorage();
  } catch {
    stored = null;
  }
  return isThemeMode(stored) ? stored : 'system';
}

export function applyTheme(resolved: ResolvedTheme, mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
}
