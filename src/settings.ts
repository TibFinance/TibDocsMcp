// The settings: two environment variables, read strictly. A TIB_DOCS_* variable this program does not know stops
// the start with one sentence (it is a mistyped name). The site's address is not a setting.
import { join } from 'node:path';
import { languageOf } from './core/core.ts';
import type { Language } from './core/indexModel.ts';

export const LANGUAGE_SETTING = 'TIB_DOCS_LANGUAGE';
export const CACHE_SETTING = 'TIB_DOCS_CACHE';
const KNOWN = [LANGUAGE_SETTING, CACHE_SETTING];

export interface Settings {
  language: Language;
  cache: boolean;
}

export class SettingsError extends Error {}

export function readSettings(env: Record<string, string | undefined>): Settings {
  const unknown = Object.keys(env)
    .filter((name) => name.toUpperCase().startsWith('TIB_DOCS_') && !KNOWN.includes(name.toUpperCase()))
    .sort();
  if (unknown.length > 0) {
    throw new SettingsError(`tib-docs-mcp does not know the setting ${unknown[0]}: its settings are ${LANGUAGE_SETTING} (en or fr) and ${CACHE_SETTING} (off keeps no copy on disk).`);
  }
  const languageText = env[LANGUAGE_SETTING];
  const language = languageOf(languageText, 'eng');
  if (language === null) {
    throw new SettingsError(`${LANGUAGE_SETTING} is "en" or "fr", not ${JSON.stringify(languageText)}.`);
  }
  const cacheText = (env[CACHE_SETTING] ?? '').trim().toLowerCase();
  if (cacheText !== '' && cacheText !== 'off' && cacheText !== 'on') {
    throw new SettingsError(`${CACHE_SETTING} is "off" to keep no copy of the pages on disk, or not set; not ${JSON.stringify(env[CACHE_SETTING])}.`);
  }
  return { language, cache: cacheText !== 'off' };
}

/** The user's cache folder for this program. */
export function defaultCacheDir(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return local !== undefined && local !== '' ? join(local, 'TibDocsMcp') : join(home, 'AppData', 'Local', 'TibDocsMcp');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'TibDocsMcp');
  }
  const xdg = env['XDG_CACHE_HOME'];
  return xdg !== undefined && xdg.startsWith('/') ? join(xdg, 'tib-docs-mcp') : join(home, '.cache', 'tib-docs-mcp');
}
