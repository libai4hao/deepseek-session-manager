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

const CHAT_HOST = 'chat.deepseek.com';

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
    if (safeHost(origin.origin) !== CHAT_HOST) continue;
    const entry = (origin.localStorage ?? []).find(item => item.name === 'userToken');
    const token = tokenFromUserToken(entry?.value);
    if (token) return token;
  }

  return undefined;
}

/**
 * Forward only what a browser would already attach to a chat.deepseek.com request:
 * the parent-domain cookie and cookies set on the chat host itself. Host-only cookies
 * from sibling subdomains (api./platform./share.) never belong on this request.
 */
function buildCookieHeader(state: StorageStateFile): string {
  const cookies = (state.cookies ?? []).filter(cookie => {
    const domain = (cookie.domain ?? '').toLowerCase();
    return Boolean(cookie.name && cookie.value) && isChatScopedCookieDomain(domain);
  });

  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function isChatScopedCookieDomain(domain: string): boolean {
  if (domain === '.deepseek.com') return true;
  return domain.replace(/^\./, '') === CHAT_HOST;
}

function safeHost(origin?: string): string {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}
