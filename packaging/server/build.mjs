// Builds the on-prem Windows server payload into packaging/server/stage:
//   AventraITSM.exe            Node single-executable app (server + CLI)
//   AventraITSM-Service.exe    WinSW service wrapper (+ .xml)
//   pgsql\                     PostgreSQL binaries
//   public\, src\db\migrations\
// Then Inno Setup compiles AventraITSM-Server.iss into the installer.
// Runs on a Windows machine (GitHub Actions windows-latest). Needs: node 22, npm, network.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const stage = path.join(here, 'stage');
const build = path.join(here, 'build');
const version = process.env.ITSM_VERSION || JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
// EDB publishes PostgreSQL Windows zips at get.enterprisedb.com/postgresql/postgresql-<ver>-windows-x64-binaries.zip.
// Try a pinned list (newest first) so an EDB housekeeping change doesn't break the build; override with PG_ZIP_VERSION.
const PG_VERSIONS = process.env.PG_ZIP_VERSION ? [process.env.PG_ZIP_VERSION] : ['16.15-1', '16.10-1', '16.8-1', '16.4-1'];
const WINSW_URL = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';
// Run a real executable directly (no shell, so arguments with spaces/quotes are passed exactly)
const sh = (cmd, args, opts = {}) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', ...opts }); };
// npm is a .cmd on Windows, which needs a shell; its arguments here are simple tokens
const npm = (args) => { console.log('> npm', args.join(' ')); execFileSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: root }); };

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  console.log('download', url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(build, { recursive: true });

// Build tools, used through their JS APIs (no shell quoting problems)
npm(['install', '--no-save', '--no-audit', '--no-fund', '--omit=dev', 'esbuild@0.24.0', 'rcedit@4', 'postject@1.0.0-alpha.6']);
const { build: esbuild } = await import('esbuild');
const rcMod = await import('rcedit');
const rcedit = rcMod.rcedit || rcMod.default; // v4 named export, v3 default export
const postject = await import('postject');

// 1. Bundle the app (ESM source -> one CommonJS file, as Node SEA requires)
await esbuild({
  entryPoints: [path.join(root, 'src', 'cli.js')], outfile: path.join(build, 'app.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['pg-native'], logLevel: 'warning',
  define: { __ITSM_BUNDLED__: 'true', 'process.env.ITSM_VERSION': JSON.stringify(version) },
});

// 2. Single executable: copy node.exe, brand it, inject the app blob
fs.writeFileSync(path.join(build, 'sea-config.json'), JSON.stringify({
  main: path.join(build, 'app.cjs'), output: path.join(build, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}));
sh(process.execPath, ['--experimental-sea-config', path.join(build, 'sea-config.json')]);
const exe = path.join(stage, 'AventraITSM.exe');
fs.copyFileSync(process.execPath, exe);
await rcedit(exe, {
  icon: path.join(here, '..', 'assets', 'icon.ico'),
  'version-string': { ProductName: 'Aventra ITSM Server', FileDescription: 'Aventra ITSM Server', CompanyName: 'Aventra Tech', LegalCopyright: '© Aventra Tech', OriginalFilename: 'AventraITSM.exe' },
  'file-version': version, 'product-version': version,
});
await (postject.inject || postject.default.inject)(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(build, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', overwrite: true,
});

// 3. App files that live next to the exe
fs.cpSync(path.join(root, 'public'), path.join(stage, 'public'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'db', 'migrations'), path.join(stage, 'src', 'db', 'migrations'), { recursive: true });

// 4. PostgreSQL binaries (trimmed)
let pgZip = null;
for (const v of PG_VERSIONS) {
  try { pgZip = await download(`https://get.enterprisedb.com/postgresql/postgresql-${v}-windows-x64-binaries.zip`, path.join(build, `pg-${v}.zip`)); console.log(`PostgreSQL ${v}`); break; } catch (e) { console.log(`  not available: ${e.message}`); }
}
if (!pgZip) throw new Error('Could not download PostgreSQL Windows binaries — set PG_ZIP_VERSION to a current version from https://www.enterprisedb.com/download-postgresql-binaries');
const pgTmp = path.join(build, 'pg');
fs.rmSync(pgTmp, { recursive: true, force: true });
sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${pgZip}' -DestinationPath '${pgTmp}' -Force`]);
const pgsql = path.join(pgTmp, 'pgsql');
for (const d of ['pgAdmin 4', 'doc', 'StackBuilder', 'symbols', 'include']) fs.rmSync(path.join(pgsql, d), { recursive: true, force: true });
fs.cpSync(pgsql, path.join(stage, 'pgsql'), { recursive: true });

// 5. Windows service wrapper
await download(WINSW_URL, path.join(build, 'WinSW-x64.exe'));
fs.copyFileSync(path.join(build, 'WinSW-x64.exe'), path.join(stage, 'AventraITSM-Service.exe'));
fs.copyFileSync(path.join(here, 'AventraITSM-Service.xml'), path.join(stage, 'AventraITSM-Service.xml'));
fs.copyFileSync(path.join(here, 'README.txt'), path.join(stage, 'README.txt'));

// 6. Visual C++ runtime needed by PostgreSQL (installer runs it silently; no-op if present)
await download('https://aka.ms/vs/17/release/vc_redist.x64.exe', path.join(build, 'vc_redist.x64.exe'));

// 7. Smoke test the executable
sh(exe, ['version']);
console.log(`stage ready: ${stage}`);
