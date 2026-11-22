export interface CliArgs {
  urls: string[];
  file?: string;
  state?: string;
  apply: boolean;
  yes: boolean;
  out: string;
  intervalMs: number;
  batchSize: number;
  batchPauseMs: number;
  retries: number;
  protectPinned: boolean;
  maskTitle: boolean;
  snapshot: boolean;
  snapshotEncrypt: boolean;
  resume: boolean;
  exportOnly: boolean;
  help: boolean;
}

const DEFAULTS: Omit<CliArgs, 'urls'> = {
  apply: false,
  yes: false,
  out: './dsx-out',
  intervalMs: 500,
  batchSize: 20,
  batchPauseMs: 10_000,
  retries: 2,
  protectPinned: true,
  maskTitle: false,
  snapshot: true,
  snapshotEncrypt: false,
  resume: false,
  exportOnly: false,
  help: false,
};

export const USAGE = `DSX - DeepSeek 会话管家 (CLI)

用法:
  dsx --url <链接> [--url <链接> ...] [选项]
  dsx --file <链接清单.txt> [选项]

输入:
  --url <link>          会话链接或裸 session id，可重复
  --file <path>         文本文件，每行一个链接

登录态:
  --state <path>        Playwright storageState JSON（含 cookie 与 localStorage.userToken）
                        生成方式: npx playwright open --save-storage=auth.json https://chat.deepseek.com
                        或环境变量 DSX_TOKEN / DSX_COOKIE

执行:
  --apply               真正执行删除（默认只预演，不调删除接口）
  --export-only         只导出快照，不删除（与 --apply 互斥）
  --yes                 批量超过 5 条时必须显式确认
  --no-snapshot         不做删除前快照（默认做）
  --snapshot-encrypt    快照加密（口令取环境变量 DSX_SNAPSHOT_PASSWORD）
  --resume              断点续跑：跳过已完成项、复用已有快照（读 <out>/progress.json）
  --include-pinned      连置顶会话一起删（默认跳过）
  --mask-title          报告与审计中隐去标题

节奏:
  --interval <ms>       每条之间的间隔，默认 500
  --batch-size <n>      每批条数，默认 20
  --batch-pause <ms>    批间暂停，默认 10000
  --retries <n>         失败重试次数，默认 2

输出:
  --out <dir>           报告/快照/审计输出目录，默认 ./dsx-out

退出码:
  0 成功   2 部分失败或被拒绝   3 鉴权/接口失败
`;

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 需要一个值`);
  return value;
}

function toNumber(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`参数 ${flag} 需要非负数字`);
  return parsed;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { ...DEFAULTS, urls: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    switch (flag) {
      case '--url': {
        args.urls.push(takeValue(argv, index + 1, flag));
        index += 1;
        break;
      }
      case '--file': {
        args.file = takeValue(argv, index + 1, flag);
        index += 1;
        break;
      }
      case '--state': {
        args.state = takeValue(argv, index + 1, flag);
        index += 1;
        break;
      }
      case '--out': {
        args.out = takeValue(argv, index + 1, flag);
        index += 1;
        break;
      }
      case '--interval': {
        args.intervalMs = toNumber(takeValue(argv, index + 1, flag), flag);
        index += 1;
        break;
      }
      case '--batch-size': {
        args.batchSize = toNumber(takeValue(argv, index + 1, flag), flag);
        index += 1;
        break;
      }
      case '--batch-pause': {
        args.batchPauseMs = toNumber(takeValue(argv, index + 1, flag), flag);
        index += 1;
        break;
      }
      case '--retries': {
        args.retries = toNumber(takeValue(argv, index + 1, flag), flag);
        index += 1;
        break;
      }
      case '--apply':
        args.apply = true;
        break;
      case '--yes':
        args.yes = true;
        break;
      case '--no-snapshot':
        args.snapshot = false;
        break;
      case '--include-pinned':
        args.protectPinned = false;
        break;
      case '--mask-title':
        args.maskTitle = true;
        break;
      case '--snapshot-encrypt':
        args.snapshotEncrypt = true;
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--export-only':
        args.exportOnly = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }

  if (args.exportOnly && args.apply) {
    throw new Error('--export-only 与 --apply 互斥：要么只导出，要么删除。');
  }
  if (args.exportOnly && !args.snapshot) {
    throw new Error('--export-only 的唯一产出就是快照，不能同时用 --no-snapshot。');
  }
  if (args.snapshotEncrypt && !args.snapshot) {
    throw new Error('--snapshot-encrypt 需要开启快照，不能同时用 --no-snapshot。');
  }

  return args;
}
