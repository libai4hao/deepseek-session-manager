import { describe, expect, it } from 'vitest';

import { renderMarkdown, resolveExitCode, type Report } from '../src/cli/report';

function report(code: string): Report {
  return {
    schema: 'dsx.report.v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'export',
    dryRun: false,
    total: 1,
    deletable: 1,
    rejected: 0,
    items: [{
      link: 'https://chat.deepseek.com/a/chat/s/a',
      kind: 'session',
      id: 'a',
      title: 'title',
      action: 'delete',
      code,
      detail: code === 'EXPORTED' ? '已导出 a.json' : '导出失败',
    }],
    summary: {
      deleted: 0,
      failed: 0,
      aborted: 0,
      skipped: 0,
      stillThere: 0,
      exported: code === 'EXPORTED' ? 1 : 0,
      exportFailed: code === 'EXPORTED' ? 0 : 1,
    },
  };
}

describe('resolveExitCode', () => {
  const base = {
    mode: 'delete' as const,
    rejected: 0,
    failed: 0,
    aborted: 0,
    stillThere: 0,
    exportFailed: 0,
    verifyFailed: false,
  };

  it('returns success when every deletion is verified or already complete', () => {
    expect(resolveExitCode(base)).toBe(0);
  });

  it('returns partial failure for rejected or unverified deletions', () => {
    expect(resolveExitCode({ ...base, rejected: 1 })).toBe(2);
    expect(resolveExitCode({ ...base, stillThere: 1 })).toBe(2);
  });

  it('returns interface failure for auth aborts and verification errors', () => {
    expect(resolveExitCode({ ...base, aborted: 1 })).toBe(3);
    expect(resolveExitCode({ ...base, verifyFailed: true })).toBe(3);
  });
});

describe('renderMarkdown', () => {
  it('renders successful exports as exported', () => {
    expect(renderMarkdown(report('EXPORTED'))).toContain('| exported |');
  });

  it('does not render failed exports as successful', () => {
    const markdown = renderMarkdown(report('EXPORT_FAILED'));
    expect(markdown).toContain('| export-failed |');
    expect(markdown).not.toContain('| exported |');
  });
});
