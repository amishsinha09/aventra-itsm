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
const PG_VERSION = process.env.PG_ZIP_VERSION || '16.4-1';
const WINSW_URL = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';
const sh = (cmd, args, opts = {}) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts }); };

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

// 1. Bundle the app (ESM source -> one CommonJS file, as Node SEA requires)
sh('npx', ['--yes', 'esbuild@0.24.0', path.join(root, 'src', 'cli.js'), '--bundle', '--platform=node', '--target=node22', '--format=cjs',
  `--outfile=${path.join(build, 'app.cjs')}`, '--external:pg-native', '--define:__ITSM_BUNDLED__=true',
  `--define:process.env.ITSM_VERSION="${version}"`, '--log-level=warning']);

// 2. Single executable: copy node.exe, brand it, inject the app blob
fs.writeFileSync(path.join(build, 'sea-config.json'), JSON.stringify({
  main: path.join(build, 'app.cjs'), output: path.join(build, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}));
sh(process.execPath, ['--experimental-sea-config', path.join(build, 'sea-config.json')]);
const exe = path.join(stage, 'AventraITSM.exe');
fs.copyFileSync(process.execPath, exe);
try { sh('signtool', ['remove', '/s', exe]); } catch { console.log('(signtool not available; continuing)'); }
sh('npx', ['--yes', 'rcedit@4.0.1', exe, '--set-icon', path.join(here, '..', 'assets', 'icon.ico'),
  '--set-version-string', 'ProductName', 'Aventra ITSM Server', '--set-version-string', 'FileDescription', 'Aventra ITSM Server',
  '--set-version-string', 'CompanyName', 'Aventra Tech', '--set-version-string', 'LegalCopyright', '© Aventra Tech',
  '--set-file-version', version, '--set-product-version', version]);
sh('npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);

// 3. App files that live next to the exe
fs.cpSync(path.join(root, 'public'), path.join(stage, 'public'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'db', 'migrations'), path.join(stage, 'src', 'db', 'migrations'), { recursive: true });

// 4. PostgreSQL binaries (trimmed)
const pgZip = await download(`https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`, path.join(build, `pg-${PG_VERSION}.zip`));
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
