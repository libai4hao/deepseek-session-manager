/**
 * Sidebar locating: given a session id, bring the matching conversation item in the
 * left sidebar into view and highlight it.
 *
 * Reality check (measured 2026-11): the sidebar renders ~100 items inside a scrollable
 * area and no additional items appeared while scrolling. Older sessions exist in the API
 * but are absent from the DOM, so locating can only work inside the loaded window. We
 * therefore stop as soon as two consecutive probes see the same anchor set, instead of
 * scrolling dozens of screens for nothing.
 *
 * Locating is a UI affordance only. Existence is still decided by the API list.
 */

const ANCHOR_SELECTOR = 'a[href*="/a/chat/s/"]';
const SCROLL_STEP = 220;
const MAX_STEPS = 60;
const SETTLE_MS = 110;
const HIGHLIGHT_MS = 2600;
export function sessionIdFromHref(href: string): string | null {
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://chat.deepseek.com';
    const url = new URL(href, base);
    const match = url.pathname.match(/\/a\/chat\/s\/([0-9a-z-]+)/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface LocateResult {
  found: boolean;
  /** true when we had to scroll the sidebar before finding (or exhausting) it */
  scrolled: boolean;
  steps: number;
}

function findAnchor(id: string): HTMLAnchorElement | null {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(ANCHOR_SELECTOR));
  for (const anchor of anchors) {
    const sessionId = sessionIdFromHref(anchor.getAttribute('href') ?? anchor.href);
    if (sessionId === id.toLowerCase()) return anchor;
  }
  return null;
}

function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;

  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);
    if (canScroll && current.scrollHeight > current.clientHeight + 4) return current;
    current = current.parentElement;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function highlight(anchor: HTMLAnchorElement): void {
  const previous = {
    outline: anchor.style.outline,
    outlineOffset: anchor.style.outlineOffset,
    borderRadius: anchor.style.borderRadius,
    background: anchor.style.background,
  };

  anchor.style.outline = '2px solid #f59e0b';
  anchor.style.outlineOffset = '2px';
  anchor.style.borderRadius = '8px';
  anchor.style.background = '#fef3c7';

  setTimeout(() => {
    anchor.style.outline = previous.outline;
    anchor.style.outlineOffset = previous.outlineOffset;
    anchor.style.borderRadius = previous.borderRadius;
    anchor.style.background = previous.background;
  }, HIGHLIGHT_MS);
}

function anchorSignature(): string {
  const anchors = document.querySelectorAll<HTMLAnchorElement>(ANCHOR_SELECTOR);
  const first = anchors[0]?.getAttribute('href') ?? '';
  const last = anchors[anchors.length - 1]?.getAttribute('href') ?? '';
  return `${anchors.length}|${first}|${last}`;
}

export async function locateSession(id: string): Promise<LocateResult> {
  const direct = findAnchor(id);
  if (direct) {
    direct.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlight(direct);
    return { found: true, scrolled: false, steps: 0 };
  }

  const first = document.querySelector<HTMLAnchorElement>(ANCHOR_SELECTOR);
  const scroller = first ? scrollableAncestor(first) : null;
  if (!scroller) return { found: false, scrolled: false, steps: 0 };

  const startTop = scroller.scrollTop;
  let steps = 0;
  let stable = 0;
  let signature = anchorSignature();

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    scroller.scrollTop = startTop + step * SCROLL_STEP;
    await sleep(SETTLE_MS);
    steps = step;

    const hit = findAnchor(id);
    if (hit) {
      hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
      highlight(hit);
      return { found: true, scrolled: true, steps };
    }

    // No new anchors after scrolling means this list is not lazily loading: give up early.
    const next = anchorSignature();
    stable = next === signature ? stable + 1 : 0;
    signature = next;
    if (stable >= 2) break;

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;
  }

  // Not found: put the sidebar back where the user had it.
  scroller.scrollTop = startTop;
  return { found: false, scrolled: true, steps };
}
