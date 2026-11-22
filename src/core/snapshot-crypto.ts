import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type { Snapshot } from './snapshot';

export interface EncryptedSnapshot {
  schema: 'dsx.snapshot.enc.v1';
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  /** base64 of the AES-GCM ciphertext carrying the JSON-encoded snapshot */
  data: string;
}

const KEY_LENGTH = 32;
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

export function encryptSnapshot(
  snapshot: Snapshot,
  password: string,
  salt: Buffer = randomBytes(16),
): EncryptedSnapshot {
  if (!password) throw new Error('快照加密需要口令');

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    schema: 'dsx.snapshot.enc.v1',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), ...SCRYPT },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    data: ciphertext.toString('base64'),
  };
}

export function decryptSnapshot(envelope: EncryptedSnapshot, password: string): Snapshot {
  if (envelope.schema !== 'dsx.snapshot.enc.v1') throw new Error('不是 dsx 加密快照');

  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  const iv = Buffer.from(envelope.cipher.iv, 'base64');
  const tag = Buffer.from(envelope.cipher.tag, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);

  return JSON.parse(plaintext.toString('utf8')) as Snapshot;
}

/** `<yyyyMMdd>_<slug>_<id8>.enc.json` keeps encrypted and plain files distinguishable. */
export function encryptedFileName(plainName: string): string {
  return plainName.replace(/\.json$/, '.enc.json');
}
