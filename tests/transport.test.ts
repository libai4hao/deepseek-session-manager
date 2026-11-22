import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport } from '../src/core/transport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetch transport timeout', () => {
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
