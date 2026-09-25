// Where the app's files live. Normal installs: the repo root. Packaged Windows executable:
// the build defines __ITSM_BUNDLED__ and files sit next to AventraITSM.exe. ITSM_APP_DIR overrides both.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* global __ITSM_BUNDLED__ */
export const isBundled = typeof __ITSM_BUNDLED__ !== 'undefined' && __ITSM_BUNDLED__;

export const APP_ROOT = process.env.ITSM_APP_DIR
  || (isBundled ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const MIGRATIONS_DIR = path.join(APP_ROOT, 'src', 'db', 'migrations');

// True when a module is being run directly (`node src/server.js`), never inside the bundle.
export function isMain(metaUrl) {
  if (isBundled || !metaUrl || !process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === fileURLToPath(metaUrl); } catch { return false; }
}
