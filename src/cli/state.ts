import { readFileSync } from 'node:fs';
import { tokenFromUserToken } from '../core/auth';

export interface AccountState {
  token?: string;
  cookieHeader?: string;
  source: string;
}

interface StateCookie {
  name?: string;
  value?: string;
  domain?: string;
}

interface StateOrigin {
  origin?: string;
  localStorage?: Array<{ name?: string; value?: string }>;
}

interface StorageStateFile {
  cookies?: StateCookie[];
  origins?: StateOrigin[];
}

/**
 * Playwright's storageState carries both halves of the web session:
 * cookies (session identity) and localStorage.userToken (bearer token).
 * Reading it directly keeps the CLI free of a Playwright runtime dependency.
 */
export function readStorageState(filePath: string): AccountState {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as StorageStateFile;

  const token = findToken(raw);
  const cookieHeader = buildCookieHeader(raw);

  return {
    token,
    cookieHeader: cookieHeader || undefined,
    source: filePath,
  };
}

function findToken(state: StorageStateFile): string | undefined {
  const origins = state.origins ?? [];

  for (const origin of origins) {
    const host = safeHost(origin.origin);
    if (!isDeepSeekHost(host)) continue;
    const entry = (origin.localStorage ?? []).find(item => item.name === 'userToken');
    const token = tokenFromUserToken(entry?.value);
    if (token) return token;
  }



  return undefined;
}

function buildCookieHeader(state: StorageStateFile): string {
  const cookies = (state.cookies ?? []).filter(cookie => {
    const domain = (cookie.domain ?? '').toLowerCase();
    return Boolean(cookie.name && cookie.value) && isDeepSeekCookieDomain(domain);
  });

  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function isDeepSeekHost(host: string): boolean {
  return host === 'deepseek.com' || host.endsWith('.deepseek.com');
}

function isDeepSeekCookieDomain(domain: string): boolean {
  const normalized = domain.replace(/^\./, '');
  return normalized === 'deepseek.com' || normalized.endsWith('.deepseek.com');
}

function safeHost(origin?: string): string {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}
