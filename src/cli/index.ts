import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApiFailure, authHeaders, classifyResult } from '../core/http';
import { createFetchTransport } from '../core/transport';
import { dedupeLinks, parseLinks, splitLines } from '../core/parser';
import { buildIndex, guardLink } from '../core/guard';
import { getAccountId, getMessages, listSessions, verifyDeleted } from '../core/repository';
import { runQueue } from '../core/executor';
import { buildSnapshot, snapshotFileName } from '../core/snapshot';
import { encryptSnapshot, encryptedFileName } from '../core/snapshot-crypto';
import { execResultToAudit, hashId, toAuditLine, type AuditEvent } from '../core/audit';
import type { ExecResult, SessionMeta } from '../core/types';
import { parseArgs, USAGE, type CliArgs } from './args';
import { completedIds, markSnapshots, mergeResults, progressPath, readProgress, reusableSnapshots, writeProgress } from './progress';
import { readStorageState, type AccountState } from './state';
import { renderMarkdown, type PlanItem, type Report, type ReportMode } from './report';

const BASE_URL = 'https://chat.deepseek.com';
const HARD_BATCH_LIMIT = 50;
const CONFIRM_THRESHOLD = 5;

function loadState(args: CliArgs): AccountState {
  if (args.state) return readStorageState(args.state);
  return {
    source: 'env',
    token: process.env.DSX_TOKEN,
    cookieHeader: process.env.DSX_COOKIE,
  };
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width;
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function formatTime(updatedAt?: number): string {
  if (!updatedAt) return '-';
  return new Date(updatedAt * 1000).toLocaleString('zh-CN', { hour12: false });
}

function maskTitle(title: string, masked: boolean): string {
  if (!masked) return title;
  return title.length <= 2 ? '***' : `${title.slice(0, 2)}***`;
}

function printPlan(items: PlanItem[]): void {
  console.log('');
  console.log(padRight('结果', 8) + padRight('标题', 34) + padRight('更新时间', 20) + '会话 ID');
  console.log('-'.repeat(104));
  for (const item of items) {
    const status = item.action === 'delete' ? '待删除' : item.action === 'skip' ? '已跳过' : '已拒绝';
    console.log(
      padRight(status, 8) +
        padRight(item.title ?? item.id ?? '-', 34) +
        padRight(formatTime(item.updatedAt), 20) +
        (item.id ?? '-'),
    );
    if (item.detail && item.action !== 'delete') console.log(`        └ ${item.detail}`);
  }
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const snapshotPassword = args.snapshotEncrypt ? process.env.DSX_SNAPSHOT_PASSWORD : undefined;
  if (args.snapshotEncrypt && !snapshotPassword) {
    console.error('--snapshot-encrypt 需要口令：请设置环境变量 DSX_SNAPSHOT_PASSWORD 后重试。');
    return 2;
  }

  const rawLinks: string[] = [...args.urls];
  if (args.file) {
    if (!existsSync(args.file)) {
      console.error(`找不到链接文件：${args.file}`);
      return 2;
    }
    rawLinks.push(...splitLines(readFileSync(args.file, 'utf8')));
  }

  if (rawLinks.length === 0) {
    console.error('没有输入链接：用 --url 或 --file 指定。');
    console.error(USAGE);
    return 2;
  }

  const state = loadState(args);
  if (!state.token) {
    console.error('缺少登录凭证：用 --state 指向 Playwright storageState，或设置 DSX_TOKEN。');
    return 3;
  }

  const transport = createFetchTransport({
    baseUrl: BASE_URL,
    headers: {
      ...authHeaders(state.token),
      ...(state.cookieHeader ? { cookie: state.cookieHeader } : {}),
    },
    credentials: 'omit',
  });

  const accountId = await getAccountId(transport).catch(() => undefined);
  const accountHash = accountId ? await hashId(accountId) : undefined;

  let sessions: SessionMeta[];
  try {
    sessions = await listSessions(transport);
  } catch (error) {
    if (error instanceof ApiFailure) {
      const kind = classifyResult(error.result);
      console.error(`读取会话列表失败：${error.message} [${kind}]`);
      if (kind === 'auth') console.error('token 可能已失效：重新导出 storageState 后再试。');
    } else {
      console.error(`读取会话列表失败：${String(error)}`);
    }
    return 3;
  }

  console.log(`已读取本账号会话 ${sessions.length} 条，账号指纹 ${accountHash ?? '未取到'}`);

  const index = buildIndex(sessions);
  const metaById = new Map(sessions.map(session => [session.id, session]));
  const links = dedupeLinks(parseLinks(rawLinks));

  const mode: ReportMode = args.exportOnly ? 'export' : args.apply ? 'delete' : 'preflight';
  const writing = mode !== 'preflight';
  const outDir = args.out;

  const storedProgress = args.resume && writing ? readProgress(progressPath(outDir)) : undefined;
  const doneIds = completedIds(storedProgress);

  const plan: PlanItem[] = links.map(link => {
    const outcome = guardLink(link, index, { protectPinned: args.protectPinned });

    if (outcome.ok && outcome.meta) {
      const base = {
        link: link.raw,
        kind: link.kind,
        id: outcome.meta.id,
        title: maskTitle(outcome.meta.title, args.maskTitle),
        updatedAt: outcome.meta.updatedAt,
        pinned: outcome.meta.pinned,
      };

      if (doneIds.has(outcome.meta.id)) {
        return {
          ...base,
          action: 'skip',
          code: 'RESUME_DONE',
          detail: '断点续跑：该会话已完成，跳过',
        };
      }

      return { ...base, action: 'delete', detail: '归属校验通过' };
    }

    return {
      link: link.raw,
      kind: link.kind,
      id: link.id,
      title: link.id,
      action: 'reject',
      code: outcome.code,
      detail: outcome.detail,
    };
  });

  printPlan(plan);

  const deletable = plan.filter(item => item.action === 'delete');
  const ids = deletable.map(item => item.id as string);
  const resumeSkipped = plan.filter(item => item.action === 'skip').length;

  if (resumeSkipped > 0) console.log(`断点续跑：跳过 ${resumeSkipped} 条已完成项`);

  if (writing && ids.length > HARD_BATCH_LIMIT) {
    console.error(`\n待处理 ${ids.length} 条，超过单次上限 ${HARD_BATCH_LIMIT}，请拆分成多次执行。`);
    return 2;
  }

  if (mode === 'preflight') {
    console.log(
      `\n预演完成：${deletable.length} 条可删、${plan.filter(item => item.action === 'reject').length} 条被拒绝` +
        `${resumeSkipped > 0 ? `、${resumeSkipped} 条已完成跳过` : ''}。未调用删除接口，也未写快照。`,
    );
  } else if (mode === 'delete' && ids.length > CONFIRM_THRESHOLD && !args.yes) {
    console.error(`\n待删除 ${ids.length} 条（> ${CONFIRM_THRESHOLD}），需要 --yes 显式确认。`);
    return 2;
  } else if (mode === 'export') {
    console.log(`\n仅导出模式：${deletable.length} 条会话将写入快照，不会调用删除接口。`);
  }


  mkdirSync(outDir, { recursive: true });

  const now = new Date().toISOString();
  const auditEvents: AuditEvent[] = deletable.map(item => ({
    ts: now,
    event: 'plan',
    sessionId: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    sourceLink: item.link,
    accountHash,
    status: 'planned',
  }));

  const snapshotFiles = new Map<string, string>();
  const exportFailures = new Set<string>();
  const reusable = args.resume && writing ? reusableSnapshots(storedProgress, join(outDir, 'snapshots')) : new Map<string, string>();

  // Snapshots are generated only on a real run: preflight must stay read-only.
  if (writing && args.snapshot && ids.length > 0) {
    const snapshotDir = join(outDir, 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });

    for (const id of ids) {
      const meta = metaById.get(id);
      if (!meta) continue;

      const reused = reusable.get(id);
      if (reused) {
        snapshotFiles.set(id, reused);
        console.log(`[snapshot] 复用 ${reused}`);
        continue;
      }

      try {
        const messages = await getMessages(transport, id);
        const snapshot = buildSnapshot(meta, messages);
        const plainName = snapshotFileName(meta);
        const fileName = snapshotPassword ? encryptedFileName(plainName) : plainName;
        const body = snapshotPassword
          ? JSON.stringify(encryptSnapshot(snapshot, snapshotPassword), null, 2)
          : JSON.stringify(snapshot, null, 2);

        writeFileSync(join(snapshotDir, fileName), body, 'utf8');
        snapshotFiles.set(id, fileName);
        console.log(`[snapshot] ${fileName}（${snapshot.messageCount} 段${snapshotPassword ? '，已加密' : ''}）`);
      } catch (error) {
        console.error(`[snapshot] ${id} 快照失败：${String(error)}`);
        if (mode === 'delete') {
          console.error('删除前快照失败，已中止。确认无需快照时可加 --no-snapshot。');
          writeFileSync(join(outDir, 'report.json'), JSON.stringify({ error: 'snapshot-failed', id }, null, 2));
          return 3;
        }
        exportFailures.add(id);
      }
    }
  }

  if (mode === 'export') {
    for (const item of plan) {
      if (item.action !== 'delete' || !item.id) continue;
      const file = snapshotFiles.get(item.id);
      item.detail = file ? `已导出 ${file}` : exportFailures.has(item.id) ? '导出失败' : '未导出';
      if (file) console.log(`[export] ${file}`);
    }
  }

  let results: ExecResult[] = [];

  if (mode === 'delete' && ids.length > 0) {
    console.log('');
    results = await runQueue(
      transport,
      ids,
      {
        intervalMs: args.intervalMs,
        batchSize: args.batchSize,
        batchPauseMs: args.batchPauseMs,
        retries: args.retries,
        shape: 'auto',
      },
      {
        onStart: (id, position, total) => {
          process.stdout.write(`[${position + 1}/${total}] ${id.slice(0, 8)} … `);
        },
        onResult: result => {
          console.log(result.status + (result.reason ? ` (${result.reason})` : ''));
          auditEvents.push(
            execResultToAudit(result, {
              accountHash,
              sourceLink: deletable.find(item => item.id === result.id)?.link,
              snapshot: snapshotFiles.get(result.id),
            }),
          );
        },
        onShapeDetected: shape => console.log(`[dsx] 删除参数形态探测为 ${shape}`),
      },
    );
  }

  let verify: Array<{ id: string; stillThere: boolean }> | undefined;
  if (mode === 'delete' && ids.length > 0) {
    try {
      verify = await verifyDeleted(transport, ids);
      for (const entry of verify) {
        auditEvents.push({
          ts: new Date().toISOString(),
          event: 'verify',
          sessionId: entry.id,
          accountHash,
          status: entry.stillThere ? 'failed' : 'deleted',
          note: entry.stillThere ? '删除后仍在列表中' : '已从列表消失',
        });
      }
    } catch (error) {
      console.error(`[verify] 复核失败：${String(error)}`);
    }
  }

  const failed = results.filter(result => result.status === 'failed' || result.status === 'aborted');
  const stillThere = verify?.filter(entry => entry.stillThere) ?? [];

  if (writing) {
    let progress = storedProgress;
    if (snapshotFiles.size > 0) progress = markSnapshots(progress, snapshotFiles);
    if (results.length > 0) progress = mergeResults(progress, results, snapshotFiles);
    if (progress) {
      if (accountHash && !progress.accountHash) progress.accountHash = accountHash;
      writeProgress(progressPath(outDir), progress);
    }
  }

  const report: Report = {
    schema: 'dsx.report.v1',
    generatedAt: new Date().toISOString(),
    mode,
    dryRun: mode === 'preflight',
    accountHash,
    total: plan.length,
    deletable: deletable.length,
    rejected: plan.filter(item => item.action === 'reject').length,
    items: plan,
    results: results.length > 0 ? results : undefined,
    verify,
    summary: {
      deleted: results.filter(result => result.status === 'deleted').length,
      failed: failed.filter(result => result.status === 'failed').length,
      aborted: failed.filter(result => result.status === 'aborted').length,
      skipped: results.filter(result => result.status === 'skipped').length,
      stillThere: stillThere.length,
      exported: mode === 'export' ? snapshotFiles.size : undefined,
      exportFailed: mode === 'export' ? exportFailures.size : undefined,
    },
  };

  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report), 'utf8');
  writeFileSync(join(outDir, 'audit.jsonl'), auditEvents.map(toAuditLine).join('\n') + '\n', 'utf8');

  if (mode === 'export') {
    console.log(`\n汇总：导出 ${snapshotFiles.size} 条，失败 ${exportFailures.size} 条；未删除任何会话。`);
  } else if (results.length > 0) {
    console.log(
      `\n汇总：删除 ${report.summary?.deleted ?? 0}，失败 ${report.summary?.failed ?? 0}，中止 ${report.summary?.aborted ?? 0}，删除后仍存在 ${report.summary?.stillThere ?? 0}`,
    );
  }
  console.log(`报告与审计已写入 ${outDir}`);

  if (mode === 'export') return exportFailures.size > 0 ? 2 : plan.length > 0 && deletable.length === 0 ? 2 : 0;
  if (mode === 'delete' && plan.length > 0 && deletable.length === 0) return 2;
  return failed.length > 0 || stillThere.length > 0 ? 2 : 0;
}

const exitCode = await main();
process.exit(exitCode);
