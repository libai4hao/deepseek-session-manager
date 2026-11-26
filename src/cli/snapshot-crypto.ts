import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { validateSnapshot, type Snapshot } from '../core/snapshot';
import type { SessionMeta } from '../core/types';

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

export function validateEncryptedSnapshot(value: unknown): EncryptedSnapshot {
  const envelope = value as Partial<EncryptedSnapshot> | null;
  if (
    !envelope ||
    envelope.schema !== 'dsx.snapshot.enc.v1' ||
    !envelope.kdf ||
    envelope.kdf.name !== 'scrypt' ||
    typeof envelope.kdf.salt !== 'string' ||
    !envelope.kdf.salt ||
    !Number.isSafeInteger(envelope.kdf.N) ||
    !Number.isSafeInteger(envelope.kdf.r) ||
    !Number.isSafeInteger(envelope.kdf.p) ||
    !envelope.cipher ||
    envelope.cipher.name !== 'aes-256-gcm' ||
    typeof envelope.cipher.iv !== 'string' ||
    !envelope.cipher.iv ||
    typeof envelope.cipher.tag !== 'string' ||
    !envelope.cipher.tag ||
    typeof envelope.data !== 'string' ||
    !envelope.data
  ) {
    throw new Error('加密快照结构无效');
  }
  return envelope as EncryptedSnapshot;
}

export function decryptSnapshot(envelope: EncryptedSnapshot, password: string): Snapshot {
  const validEnvelope = validateEncryptedSnapshot(envelope);
  const salt = Buffer.from(validEnvelope.kdf.salt, 'base64');
  const iv = Buffer.from(validEnvelope.cipher.iv, 'base64');
  const tag = Buffer.from(validEnvelope.cipher.tag, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(validEnvelope.data, 'base64')), decipher.final()]);

  return validateSnapshot(JSON.parse(plaintext.toString('utf8')));
}

/** `<yyyyMMdd>_<id>.enc.json` keeps encrypted backups free of title metadata. */
export function encryptedSnapshotFileName(meta: SessionMeta): string {
  const safeId = meta.id.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'unknown';
  const date = new Date(meta.updatedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `${date}_${safeId}.enc.json`;
}

export function encryptedFileName(plainName: string): string {
  return plainName.replace(/\.json$/, '.enc.json');
}
