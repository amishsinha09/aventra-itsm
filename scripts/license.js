#!/usr/bin/env node
// Aventra license tool (keep the private key OFF the servers you ship to customers).
//
//   node scripts/license.js keygen
//       Creates keys/license-private.pem (keep secret — e.g. password manager / GitHub secret)
//       and writes the matching public key into src/licensing/public-key.js (commit this).
//
//   node scripts/license.js issue --licensee "Acme Dental" --email it@acme.com --plan pro --seats 25 --months 12
//       Prints a license key to send to the customer. Uses keys/license-private.pem or $LICENSE_PRIVATE_KEY.
//
//   node scripts/license.js verify <key>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

if (cmd === 'keygen') {
  const privFile = path.join(root, 'keys', 'license-private.pem');
  if (fs.existsSync(privFile) && !args.includes('--force')) { console.error(`${privFile} already exists (use --force to replace — existing licenses would stop verifying).`); process.exit(1); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(privFile), { recursive: true });
  fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();
  fs.writeFileSync(path.join(root, 'src', 'licensing', 'public-key.js'),
    `// Ed25519 public key that verifies on-prem license keys (generated ${new Date().toISOString().slice(0, 10)}).\nexport const LICENSE_PUBLIC_KEY = \`${pub}\`;\n`);
  console.log(`Private key: ${privFile}  <- keep secret, back it up, never commit it\nPublic key written to src/licensing/public-key.js  <- commit this and rebuild the installer`);
} else if (cmd === 'issue') {
  const { signLicense } = await import('../src/lib/license.js');
  const pem = process.env.LICENSE_PRIVATE_KEY || fs.readFileSync(path.join(root, 'keys', 'license-private.pem'), 'utf8');
  const months = parseInt(flag('months', '12'), 10);
  const expires = new Date(); expires.setMonth(expires.getMonth() + months);
  const payload = {
    id: crypto.randomUUID(), licensee: flag('licensee'), email: flag('email'), plan: flag('plan', 'pro'),
    seats: parseInt(flag('seats', '10'), 10), issued: new Date().toISOString(), expires: expires.toISOString(),
  };
  if (!payload.licensee) { console.error('--licensee is required'); process.exit(1); }
  if (!['starter', 'pro'].includes(payload.plan)) { console.error('--plan must be starter or pro'); process.exit(1); }
  console.log(JSON.stringify(payload, null, 2));
  console.log(`\nLicense key:\n${signLicense(payload, pem)}`);
} else if (cmd === 'verify') {
  const { verifyLicense } = await import('../src/lib/license.js');
  console.log(verifyLicense(args[0]));
} else {
  console.log('usage: node scripts/license.js keygen | issue --licensee NAME [--email E] [--plan pro] [--seats 10] [--months 12] | verify KEY');
}
