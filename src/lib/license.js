// On-prem license keys: AVL1.<base64url JSON payload>.<base64url Ed25519 signature>
// Payload: { id, licensee, email, plan: 'starter'|'pro', seats, issued, expires }
// Verified offline with the public key compiled into the app; only Aventra holds the private key.
import crypto from 'node:crypto';
import { LICENSE_PUBLIC_KEY } from '../licensing/public-key.js';

function publicKey() {
  const pem = process.env.LICENSE_PUBLIC_KEY || LICENSE_PUBLIC_KEY;
  if (!pem) return null;
  try { return crypto.createPublicKey(pem.includes('BEGIN') ? pem : { key: Buffer.from(pem, 'base64'), format: 'der', type: 'spki' }); } catch { return null; }
}

export const licensingConfigured = () => Boolean(publicKey());

export function verifyLicense(key) {
  try {
    const [ver, body, sig] = String(key).trim().split('.');
    if (ver !== 'AVL1' || !body || !sig) return { valid: false, error: 'This is not an Aventra license key.' };
    const pk = publicKey();
    if (!pk) return { valid: false, error: 'Licensing is not configured on this build.' };
    const ok = crypto.verify(null, Buffer.from(`${ver}.${body}`), pk, Buffer.from(sig, 'base64url'));
    if (!ok) return { valid: false, error: 'License signature is invalid.' };
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.expires || !Number.isInteger(payload.seats) || payload.seats < 1) return { valid: false, error: 'License is malformed.' };
    return { valid: true, payload };
  } catch { return { valid: false, error: 'This is not a valid license key.' }; }
}

// Used by scripts/license.js (and tests) — never shipped with a private key
export function signLicense(payload, privateKeyPem) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(`AVL1.${body}`), crypto.createPrivateKey(privateKeyPem)).toString('base64url');
  return `AVL1.${body}.${sig}`;
}
