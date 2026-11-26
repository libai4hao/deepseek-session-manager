import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  files: string[];
  scripts: Record<string, string>;
};

describe('npm package boundary', () => {
  it('uses an exact dist file whitelist', () => {
    expect(pkg.files.filter(path => path.startsWith('dist'))).toEqual([
      'dist/dsx-cli.mjs',
      'dist/dsx.user.js',
      'dist/extension/dsx.js',
      'dist/extension/manifest.json',
    ]);
  });

  it('builds automatically before packing', () => {
    expect(pkg.scripts.prepack).toBe('node scripts/build.mjs');
  });
});
