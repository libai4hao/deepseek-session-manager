import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { snapshotIdForFileName, validateSnapshot, type Snapshot } from '../core/snapshot';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64(value: unknown, expectedBytes: number | undefined, field: string): Buffer {
  if (typeof value !== 'string' || !value) throw new Error(`加密快照 ${field} 无效`);
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value ||
    decoded.length === 0 ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new Error(`加密快照 ${field} 无效`);
  }
  return decoded;
}

export function encryptSnapshot(
  snapshot: Snapshot,
  password: string,
  salt: Buffer = randomBytes(16),
): EncryptedSnapshot {
  if (!password) throw new Error('快照加密需要口令');
  if (salt.length !== 16) throw new Error('快照加密 salt 必须为 16 字节');

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
  const envelope = isRecord(value) ? value : null;
  const kdf = isRecord(envelope?.['kdf']) ? envelope['kdf'] : null;
  const cipher = isRecord(envelope?.['cipher']) ? envelope['cipher'] : null;
  if (
    !envelope ||
    envelope['schema'] !== 'dsx.snapshot.enc.v1' ||
    !kdf ||
    kdf['name'] !== 'scrypt' ||
    kdf['N'] !== SCRYPT.N ||
    kdf['r'] !== SCRYPT.r ||
    kdf['p'] !== SCRYPT.p ||
    !cipher ||
    cipher['name'] !== 'aes-256-gcm'
  ) {
    throw new Error('加密快照结构无效');
  }

  decodeBase64(kdf['salt'], 16, 'salt');
  decodeBase64(cipher['iv'], 12, 'iv');
  decodeBase64(cipher['tag'], 16, 'tag');
  decodeBase64(envelope['data'], undefined, 'data');
  return envelope as unknown as EncryptedSnapshot;
}

export function decryptSnapshot(envelope: EncryptedSnapshot, password: string): Snapshot {
  const validEnvelope = validateEncryptedSnapshot(envelope);
  const salt = decodeBase64(validEnvelope.kdf.salt, 16, 'salt');
  const iv = decodeBase64(validEnvelope.cipher.iv, 12, 'iv');
  const tag = decodeBase64(validEnvelope.cipher.tag, 16, 'tag');
  const data = decodeBase64(validEnvelope.data, undefined, 'data');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);

  return validateSnapshot(JSON.parse(plaintext.toString('utf8')));
}

/** `<yyyyMMdd>_<id>.enc.json` keeps encrypted backups free of title metadata. */
export function encryptedSnapshotFileName(meta: SessionMeta): string {
  const safeId = snapshotIdForFileName(meta.id);
  const date = new Date(meta.updatedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `${date}_${safeId}.enc.json`;
}

export function encryptedFileName(plainName: string): string {
  return plainName.replace(/\.json$/, '.enc.json');
}
