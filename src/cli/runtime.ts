import { webcrypto } from 'node:crypto';

export function ensureWebCrypto(): void {
  if (globalThis.crypto?.subtle) return;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
}
