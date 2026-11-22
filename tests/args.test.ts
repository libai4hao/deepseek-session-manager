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

  it('refuses encryption without snapshots', () => {
    expect(() => parseArgs(['--url', 'x', '--snapshot-encrypt', '--no-snapshot'])).toThrow(/不能同时/);
  });
});
