import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport } from '../src/core/transport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetch transport response handling', () => {
  it('rejects a non-JSON HTTP 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })));
    const transport = createFetchTransport({ headers: {}, baseUrl: 'https://example.test' });

    await expect(transport.get('/delete')).rejects.toThrow(/不是合法 JSON/);
  });

  it('preserves HTTP status when an auth response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>', { status: 401 })));
    const transport = createFetchTransport({ headers: {}, baseUrl: 'https://example.test' });

    await expect(transport.get('/delete')).rejects.toMatchObject({
      name: 'ApiFailure',
      result: { http: 401, code: 401 },
    });
  });

  it('does not invent a success code when the payload has no numeric code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const transport = createFetchTransport({ headers: {}, baseUrl: 'https://example.test' });

    const result = await transport.get('/delete');
    expect(result.code).toBe(200);
  });

  it('aborts a request that exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createFetchTransport({ headers: {}, timeoutMs: 25 });
    const pending = transport.get('/slow');
    // Attach the rejection handler before timers fire, otherwise Node reports it as unhandled.
    const assertion = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
