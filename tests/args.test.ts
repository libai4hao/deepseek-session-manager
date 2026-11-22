import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/args';

describe('cli args', () => {
  it('keeps preflight as the default mode', () => {
    const args = parseArgs(['--url', 'https://chat.deepseek.com/a/chat/s/abc']);
    expect(args.apply).toBe(false);
    expect(args.exportOnly).toBe(false);
    expect(args.resume).toBe(false);
    expect(args.snapshot).toBe(true);
  });

  it('accepts the new switches', () => {
    const args = parseArgs(['--url', 'x', '--export-only', '--snapshot-encrypt', '--resume']);
    expect(args.exportOnly).toBe(true);
    expect(args.snapshotEncrypt).toBe(true);
    expect(args.resume).toBe(true);
  });

  it('refuses export + apply', () => {
    expect(() => parseArgs(['--url', 'x', '--export-only', '--apply'])).toThrow(/互斥/);
  });

  it('refuses export without snapshots', () => {
    expect(() => parseArgs(['--url', 'x', '--export-only', '--no-snapshot'])).toThrow(/不能同时/);
  });

  it('requires integer bounded execution parameters', () => {
    expect(() => parseArgs(['--url', 'x', '--batch-size', '0'])).toThrow(/batch-size/);
    expect(() => parseArgs(['--url', 'x', '--batch-size', '1.5'])).toThrow(/整数/);
    expect(() => parseArgs(['--url', 'x', '--retries', '1.5'])).toThrow(/整数/);
    expect(() => parseArgs(['--url', 'x', '--retries', '21'])).toThrow(/不能超过/);
  });

  it('refuses encryption without snapshots', () => {
    expect(() => parseArgs(['--url', 'x', '--snapshot-encrypt', '--no-snapshot'])).toThrow(/不能同时/);
  });

  it('bounds the request timeout', () => {
    expect(parseArgs(['--url', 'x', '--timeout', '5000']).timeoutMs).toBe(5000);
    expect(() => parseArgs(['--url', 'x', '--timeout', '999'])).toThrow(/timeout/);
    expect(() => parseArgs(['--url', 'x', '--timeout', '600001'])).toThrow(/timeout/);
  });
});
