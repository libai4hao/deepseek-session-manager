/**
 * DeepSeek stores its web token as JSON in localStorage under `userToken`.
 * Shape observed: {"value":"<bearer>","__version":"0"}, but accept a raw string too.
 */
export function tokenFromUserToken(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed) return parsed;
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)['value'];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
