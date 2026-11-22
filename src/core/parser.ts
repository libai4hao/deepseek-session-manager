import type { ParsedLink } from './types';

const HOST = 'chat.deepseek.com';
const SESSION_PATH = /^\/a\/chat\/s\/([0-9A-Za-z_-]{8,64})\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_NOISE = /[)\]}>，。；、"'`）】」』》]+$/;

/** Strip whitespace and punctuation left behind by copy/paste from chat bubbles. */
export function stripNoise(raw: string): string {
  let text = raw.trim();
  while (text && TRAILING_NOISE.test(text)) text = text.replace(TRAILING_NOISE, '').trim();
  return text;
}

export function parseLink(raw: string, base = `https://${HOST}`): ParsedLink {
  const text = stripNoise(raw);
  if (!text) return { raw, kind: 'bad', reason: '空输入' };
  if (UUID.test(text)) return { raw, kind: 'session', id: text.toLowerCase() };

  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return { raw, kind: 'bad', reason: '不是合法 URL' };
  }

  const host = url.hostname.toLowerCase();
  if (host !== HOST) return { raw, kind: 'foreign', reason: `非目标站点：${host}` };
  if (url.pathname.startsWith('/share/')) {
    return { raw, kind: 'share', reason: '分享页只读，无删除权限' };
  }

  const matched = SESSION_PATH.exec(url.pathname);
  if (!matched) return { raw, kind: 'bad', reason: `不认识的路径：${url.pathname}` };

  return { raw, kind: 'session', id: matched[1].toLowerCase() };
}

export function parseLinks(lines: string[], base?: string): ParsedLink[] {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseLink(line, base));
}

export function dedupeLinks(links: ParsedLink[]): ParsedLink[] {
  const seen = new Set<string>();
  const output: ParsedLink[] = [];

  for (const link of links) {
    const key = link.kind === 'session' && link.id ? `session:${link.id}` : `raw:${link.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(link);
  }

  return output;
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map(line => line.trim())
    .filter(Boolean);
}
