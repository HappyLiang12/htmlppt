import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

export interface ChromiumLocation {
  executablePath: string;
  source: 'env' | 'chrome' | 'edge' | 'chromium';
}

async function executable(file: string): Promise<boolean> {
  if (!file.trim()) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findChromium(env: NodeJS.ProcessEnv = process.env): Promise<ChromiumLocation | null> {
  if (env.HTMLPPT_CHROMIUM !== undefined) {
    return await executable(env.HTMLPPT_CHROMIUM)
      ? { executablePath: path.resolve(env.HTMLPPT_CHROMIUM), source: 'env' }
      : null;
  }

  const candidates: ChromiumLocation[] = [];
  const add = (file: string, source: ChromiumLocation['source']) => candidates.push({ executablePath: file, source });
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const os = platform();
  if (os === 'win32') {
    for (const root of [env.PROGRAMFILES ?? 'C:/Program Files', env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', env.LOCALAPPDATA]) {
      if (root) add(path.join(root, 'Google/Chrome/Application/chrome.exe'), 'chrome');
    }
    for (const root of [env.PROGRAMFILES ?? 'C:/Program Files', env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', env.LOCALAPPDATA]) {
      if (root) add(path.join(root, 'Microsoft/Edge/Application/msedge.exe'), 'edge');
    }
    if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Chromium/Application/chrome.exe'), 'chromium');
  } else if (os === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      add(path.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'), 'chrome');
      add(path.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'edge');
      add(path.join(root, 'Chromium.app/Contents/MacOS/Chromium'), 'chromium');
    }
  } else {
    for (const file of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']) add(file, 'chrome');
    for (const file of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']) add(file, 'edge');
    for (const file of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) add(file, 'chromium');
  }
  for (const candidate of candidates) if (await executable(candidate.executablePath)) return candidate;

  const cacheRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    os === 'win32' ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData/Local'), 'ms-playwright')
      : os === 'darwin' ? path.join(home, 'Library/Caches/ms-playwright')
        : path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright')
  ];
  for (const root of cacheRoots) {
    if (!root || root === '0') continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const revisions = entries.filter(entry => entry.isDirectory() && /^chromium(?:_headless_shell)?-\d+$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const revision of revisions) {
      for (const suffix of [
        'chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium', 'chrome-headless-shell-win64/headless_shell.exe',
        'chrome-headless-shell-linux64/headless_shell', 'chrome-headless-shell-mac-arm64/headless_shell',
        'chrome-headless-shell-mac-x64/headless_shell'
      ]) {
        const file = path.join(root, revision.name, suffix);
        if (await executable(file)) return { executablePath: file, source: 'chromium' };
      }
    }
  }
  return null;
}
