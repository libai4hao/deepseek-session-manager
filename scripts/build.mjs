import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

mkdirSync(resolve(root, 'dist'), { recursive: true });

const header = `// ==UserScript==
// @name         DSX - DeepSeek 会话管家
// @name:en      DSX - DeepSeek Session Manager
// @namespace    https://github.com/libai4hao/deepseek-session-manager
// @version      ${pkg.version}
// @description  输入 DeepSeek 会话链接，自动定位、快照、删除并审计
// @author       libai4hao
// @license      MIT
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @icon         https://www.deepseek.com/favicon.ico
// ==/UserScript==
`;

await build({
  entryPoints: [resolve(root, 'src/userscript/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: resolve(root, 'dist/dsx.user.js'),
  banner: { js: header },
  legalComments: 'none',
});

await build({
  entryPoints: [resolve(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  outfile: resolve(root, 'dist/dsx-cli.mjs'),
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});

// MV3 shell: the userscript body already works as a content script (no GM_* APIs used),
// so packaging is just "strip the ==UserScript== header, ship a manifest".
const extensionDir = resolve(root, 'dist/extension');
mkdirSync(extensionDir, { recursive: true });

const userScriptBody = readFileSync(resolve(root, 'dist/dsx.user.js'), 'utf8').replace(
  /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/,
  '',
);
writeFileSync(resolve(extensionDir, 'dsx.js'), userScriptBody, 'utf8');
writeFileSync(
  resolve(extensionDir, 'manifest.json'),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'DSX - DeepSeek 会话管家',
      version: pkg.version,
      description: '输入 DeepSeek 会话链接，自动定位、快照、删除并审计',
      content_scripts: [
        {
          matches: ['https://chat.deepseek.com/*'],
          js: ['dsx.js'],
          run_at: 'document_idle',
        },
      ],
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log('[build] dist/dsx.user.js, dist/dsx-cli.mjs, dist/extension/');
