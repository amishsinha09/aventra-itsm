// Encrypts integration secrets (AD service-account password, Entra client secret) at rest with AES-256-GCM.
// The key is derived from JWT_SECRET, so rotating JWT_SECRET means re-entering these secrets.
import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => Buffer.from(crypto.hkdfSync('sha256', config.jwtSecret, 'aventra-itsm', 'integration-secrets-v1', 32));

export function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  try { return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'); } catch {
    throw new Error('Stored secret could not be decrypted (was JWT_SECRET changed?). Re-enter it in Settings → Sign-in.');
  }
}
