import type { ExecResult } from '../core/types';

export interface PlanItem {
  link: string;
  kind: string;
  id?: string;
  title?: string;
  updatedAt?: number;
  pinned?: boolean;
  action: 'delete' | 'reject';
  code?: string;
  detail?: string;
}

export interface Report {
  schema: 'dsx.report.v1';
  generatedAt: string;
  dryRun: boolean;
  accountHash?: string;
  total: number;
  deletable: number;
  rejected: number;
  items: PlanItem[];
  results?: ExecResult[];
  verify?: Array<{ id: string; stillThere: boolean }>;
  summary?: {
    deleted: number;
    failed: number;
    aborted: number;
    skipped: number;
    stillThere: number;
  };
}

function fmtTime(updatedAt?: number): string {
  if (!updatedAt) return '-';
  return new Date(updatedAt * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push('# DSX 执行报告');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 模式：${report.dryRun ? '预演（未删除）' : '实际执行'}`);
  lines.push(`- 账号指纹：${report.accountHash ?? '未取到'}`);
  lines.push(`- 链接数：${report.total}，可删：${report.deletable}，拒绝：${report.rejected}`);
  lines.push('');
  lines.push('| 结果 | 标题 | 更新时间 | 会话 ID | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const item of report.items) {
    const result = report.results?.find(entry => entry.id === item.id);
    const status = result ? `${result.status}${result.reason ? ` (${result.reason})` : ''}` : item.action === 'delete' ? 'planned' : `reject: ${item.code ?? '-'}`;
    lines.push(`| ${status} | ${item.title ?? '-'} | ${fmtTime(item.updatedAt)} | ${item.id ?? '-'} | ${item.detail ?? '-'} |`);
  }

  if (report.summary) {
    lines.push('');
    lines.push(
      `汇总：删除 ${report.summary.deleted}，失败 ${report.summary.failed}，鉴权中止 ${report.summary.aborted}，跳过 ${report.summary.skipped}，删除后仍存在 ${report.summary.stillThere}`,
    );
  }

  return lines.join('\n') + '\n';
}
