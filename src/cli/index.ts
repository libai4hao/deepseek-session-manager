import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApiFailure, authHeaders, classifyResult } from '../core/http';
import { createFetchTransport } from '../core/transport';
import { dedupeLinks, parseLinks, sanitizeLinkForReport, splitLines } from '../core/parser';
import { buildIndex, guardLink } from '../core/guard';
import { getAccountId, getMessages, listSessions, verifyDeleted } from '../core/repository';
import { runQueue } from '../core/executor';
import { buildSnapshot, snapshotFileName, snapshotMatchesMeta, validateSnapshot, assertUsableBackups } from '../core/snapshot';
import { decryptSnapshot, encryptSnapshot, encryptedSnapshotFileName, validateEncryptedSnapshot } from './snapshot-crypto';
import { execResultToAudit, hashId, toAuditLine, type AuditEvent } from '../core/audit';
import type { ExecResult, SessionMeta } from '../core/types';
import { parseArgs, USAGE, type CliArgs } from './args';
import { checkResumeAccount, completedIds, markSnapshots, mergeResults, progressPath, readProgress, reconcileDeletedResults, reusableSnapshots, writeProgress } from './progress';
import { HARD_BATCH_LIMIT, exceedsBatchLimit } from '../core/batch';
import { readStorageState, type AccountState } from './state';
import { renderMarkdown, resolveExitCode, type PlanItem, type Report, type ReportMode } from './report';
import { ensureWebCrypto } from './runtime';

const BASE_URL = 'https://chat.deepseek.com';
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
  ensureWebCrypto();

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
    try {
      rawLinks.push(...splitLines(readFileSync(args.file, 'utf8')));
    } catch (error) {
      console.error(`读取链接文件失败：${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (rawLinks.length === 0) {
    console.error('没有输入链接：用 --url 或 --file 指定。');
    console.error(USAGE);
    return 2;
  }
  const links = dedupeLinks(parseLinks(rawLinks));
  if (links.length === 0) {
    console.error('没有解析到可处理的会话链接：请检查输入格式。');
    return 2;
  }

  let state: AccountState;
  try {
    state = loadState(args);
  } catch (error) {
    console.error(`读取登录态失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
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
    timeoutMs: args.timeoutMs,
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

  const mode: ReportMode = args.exportOnly ? 'export' : args.apply ? 'delete' : 'preflight';
  const writing = mode !== 'preflight';
  const outDir = args.out;

  const progressFile = progressPath(outDir);
  const storedProgress = args.resume && writing ? readProgress(progressFile) : undefined;
  if (args.resume && writing) {
    if (existsSync(progressFile) && !storedProgress) {
      console.error('断点文件存在但格式损坏或不受支持；为避免误删，已拒绝续跑。请先备份并人工处理 progress.json。');
      return 3;
    }
    if (storedProgress) {
      const verdict = checkResumeAccount(storedProgress, accountHash);
      if (verdict !== 'ok') {
        const reason =
          verdict === 'no-current-hash'
            ? '当前账号指纹获取失败'
            : verdict === 'no-stored-hash'
              ? '历史进度没有账号指纹'
              : '当前账号与历史进度不一致';
        console.error(`断点续跑账号校验失败（${reason}）：为避免跨账号误删，已中止。`);
        return 3;
      }
    }
  }
  const doneIds = completedIds(storedProgress);

  const plan: PlanItem[] = links.map(link => {
    const reportLink = sanitizeLinkForReport(link);
    if (link.kind === 'session' && link.id && doneIds.has(link.id)) {
      const meta = metaById.get(link.id);
      return {
        link: reportLink,
        kind: link.kind,
        id: link.id,
        title: maskTitle(meta?.title ?? link.id, args.maskTitle),
        updatedAt: meta?.updatedAt,
        pinned: meta?.pinned,
        action: 'skip',
        code: 'RESUME_DONE',
        detail: '断点续跑：该会话已完成，跳过',
      };
    }

    const outcome = guardLink(link, index, { protectPinned: args.protectPinned });

    if (outcome.ok && outcome.meta) {
      return {
        link: reportLink,
        kind: link.kind,
        id: outcome.meta.id,
        title: maskTitle(outcome.meta.title, args.maskTitle),
        updatedAt: outcome.meta.updatedAt,
        pinned: outcome.meta.pinned,
        action: 'delete',
        detail: '归属校验通过',
      };
    }

    return {
      link: reportLink,
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

  if (writing && exceedsBatchLimit(ids.length)) {
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

  // Audit and progress are flushed per item from here on: a crash or a killed terminal
  // must not erase the record of deletions that already happened.
  const auditPath = join(outDir, 'audit.jsonl');
  const appendAudit = (events: AuditEvent[]): void => {
    if (events.length === 0) return;
    appendFileSync(auditPath, events.map(toAuditLine).join('\n') + '\n', 'utf8');
  };

  let progress = storedProgress;
  const persistProgress = (): void => {
    if (!progress) return;
    if (accountHash && !progress.accountHash) progress.accountHash = accountHash;
    writeProgress(progressFile, progress);
  };
  const recordSnapshots = (idToFile: Map<string, string>): void => {
    progress = markSnapshots(progress, idToFile);
    persistProgress();
  };

  const now = new Date().toISOString();
  appendAudit(
    deletable.map(item => ({
      ts: now,
      event: 'plan',
      sessionId: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      sourceLink: item.link,
      accountHash,
      status: 'planned',
    })),
  );

  const snapshotFiles = new Map<string, string>();
  const exportFailures = new Set<string>();
  const reusable = args.resume && writing
    ? reusableSnapshots(storedProgress, join(outDir, 'snapshots'), undefined, undefined, metaById)
    : new Map<string, string>();

  // Snapshots are generated only on a real run: preflight must stay read-only.
  if (writing && args.snapshot && ids.length > 0) {
    const snapshotDir = join(outDir, 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });

    for (const id of ids) {
      const meta = metaById.get(id);
      if (!meta) continue;

      const reused = reusable.get(id);
      const encryptionMatches = reused
        ? snapshotPassword
          ? reused.endsWith('.enc.json')
          : !reused.endsWith('.enc.json')
        : false;
      // `--mask-title` must not resurrect a snapshot file whose name still carries the title.
      const expectedName = !reused
        ? undefined
        : reused.endsWith('.enc.json')
          ? encryptedSnapshotFileName(meta)
          : snapshotFileName(meta, { maskTitle: args.maskTitle });
      const titleMatches = !args.maskTitle || !expectedName || reused === expectedName;
      if (reused && encryptionMatches && titleMatches) {
        try {
          if (snapshotPassword) {
            const envelope = validateEncryptedSnapshot(JSON.parse(readFileSync(join(snapshotDir, reused), 'utf8')));
            const snapshot = validateSnapshot(decryptSnapshot(envelope, snapshotPassword));
            if (!snapshotMatchesMeta(snapshot, meta)) throw new Error('快照不是当前会话版本');
          }
          snapshotFiles.set(id, reused);
          recordSnapshots(new Map([[id, reused]]));
          console.log(`[snapshot] 复用 ${reused}`);
          continue;
        } catch (error) {
          console.log(`[snapshot] 复用失败，将重新抓取 ${reused}：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      try {
        const messages = await getMessages(transport, id);
        const snapshot = buildSnapshot(meta, messages);
        const fileName = snapshotPassword ? encryptedSnapshotFileName(meta) : snapshotFileName(meta, { maskTitle: args.maskTitle });
        const body = snapshotPassword
          ? JSON.stringify(encryptSnapshot(snapshot, snapshotPassword), null, 2)
          : JSON.stringify(snapshot, null, 2);

        writeFileSync(join(snapshotDir, fileName), body, 'utf8');
        snapshotFiles.set(id, fileName);
        recordSnapshots(new Map([[id, fileName]]));
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
      item.code = file ? 'EXPORTED' : 'EXPORT_FAILED';
      if (file) console.log(`[export] ${file}`);
    }
  }

  let results: ExecResult[] = [];

  if (mode === 'delete' && ids.length > 0) {
    let savedSnapshots: Map<string, ReturnType<typeof validateSnapshot>>;
    try {
      savedSnapshots = new Map();
      for (const [id, snapshotName] of snapshotFiles) {
        savedSnapshots.set(id, snapshotName.endsWith('.enc.json')
          ? validateSnapshot(decryptSnapshot(validateEncryptedSnapshot(JSON.parse(readFileSync(join(outDir, 'snapshots', snapshotName), 'utf8'))), snapshotPassword!))
          : validateSnapshot(JSON.parse(readFileSync(join(outDir, 'snapshots', snapshotName), 'utf8'))));
      }
      if (args.snapshot) assertUsableBackups([...savedSnapshots.values()]);
    } catch (error) {
      console.error(`删除前快照校验失败，已中止：${error instanceof Error ? error.message : String(error)}`);
      return 3;
    }

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
        beforeDelete: async id => {
          const freshIndex = buildIndex(await listSessions(transport));
          const link = links.find(candidate => candidate.id === id);
          const outcome = link ? guardLink(link, freshIndex, { protectPinned: args.protectPinned }) : undefined;
          if (!outcome?.ok || !outcome.meta || outcome.meta.id !== id) {
            throw new Error(`${id} 已不存在、归属变化或不再允许删除`);
          }
          const snapshot = savedSnapshots.get(id);
          if (snapshot && !snapshotMatchesMeta(snapshot, outcome.meta)) {
            throw new Error(`${id} 在快照生成后已更新，需重新预览并备份`);
          }
        },
        onStart: (id, position, total) => {
          process.stdout.write(`[${position + 1}/${total}] ${id.slice(0, 8)} … `);
        },
        onResult: result => {
          console.log(result.status + (result.reason ? ` (${result.reason})` : ''));
          appendAudit([
            execResultToAudit(result, {
              accountHash,
              sourceLink: deletable.find(item => item.id === result.id)?.link,
              snapshot: snapshotFiles.get(result.id),
            }),
          ]);
          // Live flush: deletion is recorded but not yet verified, so a crash here
          // cannot produce a resumable "completed" entry.
          progress = mergeResults(progress, [result], snapshotFiles, new Date(), false);
          persistProgress();
        },
        onShapeDetected: shape => console.log(`[dsx] 删除参数形态探测为 ${shape}`),
      },
    );
  }

  let verify: Array<{ id: string; stillThere: boolean }> | undefined;
  let verifyFailed = false;
  if (mode === 'delete' && ids.length > 0) {
    try {
      verify = await verifyDeleted(transport, ids);
      appendAudit(
        verify.map(entry => ({
          ts: new Date().toISOString(),
          event: 'verify' as const,
          sessionId: entry.id,
          accountHash,
          status: entry.stillThere ? ('failed' as const) : ('deleted' as const),
          note: entry.stillThere ? '删除后仍在列表中' : '已从列表消失',
        })),
      );
    } catch (error) {
      verifyFailed = true;
      console.error(`[verify] 复核失败：${String(error)}`);
    }
  }

  if (mode === 'delete') {
    const reconciled = reconcileDeletedResults(results, verify);
    const corrections: AuditEvent[] = [];
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].status === reconciled[index].status) continue;
      corrections.push(execResultToAudit(reconciled[index], {
        accountHash,
        sourceLink: deletable.find(item => item.id === reconciled[index].id)?.link,
        snapshot: snapshotFiles.get(reconciled[index].id),
      }));
    }
    appendAudit(corrections);
    results = reconciled;
    if (writing) {
      progress = mergeResults(progress, reconciled, snapshotFiles, new Date(), true);
      persistProgress();
    }
  }

  const failed = results.filter(result => result.status === 'failed' || result.status === 'aborted');
  const stillThere = verify?.filter(entry => entry.stillThere) ?? [];

  // Everything above is already flushed item by item; this only closes the loop for
  // export-only runs and makes the last state on disk authoritative.
  persistProgress();

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

  if (mode === 'export') {
    console.log(`\n汇总：导出 ${snapshotFiles.size} 条，失败 ${exportFailures.size} 条；未删除任何会话。`);
  } else if (results.length > 0) {
    console.log(
      `\n汇总：删除 ${report.summary?.deleted ?? 0}，失败 ${report.summary?.failed ?? 0}，中止 ${report.summary?.aborted ?? 0}，删除后仍存在 ${report.summary?.stillThere ?? 0}`,
    );
  }
  console.log(`报告与审计已写入 ${outDir}`);

  const rejected = plan.filter(item => item.action === 'reject').length;
  return resolveExitCode({
    mode,
    rejected,
    failed: failed.length,
    aborted: results.filter(result => result.status === 'aborted').length,
    stillThere: stillThere.length,
    exportFailed: exportFailures.size,
    verifyFailed,
  });
}

let exitCode: number;
try {
  exitCode = await main();
} catch (error) {
  console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
  exitCode = 3;
}
process.exit(exitCode);
