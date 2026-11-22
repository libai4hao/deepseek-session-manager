# DSX · DeepSeek 会话管家

把一条会话链接，变成一个**可校验、可留档、可审计**的删除动作。

DeepSeek 网页版没有"给个链接就把这条会话处理掉"的能力：侧栏翻找靠肉眼，删除靠手点，删了什么没人记得。DSX 把这件事拆成六步——解析、归属校验、快照、确认、删除、审计——并做成油猴面板与命令行两端，共用同一套核心逻辑。

> 非官方工具，基于网页端内部接口；只对**本人账号**的会话生效，不做多账号代操作。

## 功能清单

| 功能 | 油猴 | CLI | 说明与边界 |
|---|---|---|---|
| 链接解析 | ✅ | ✅ | 分 session / share / foreign / bad 四类；仿冒域名按 hostname 全等判定 |
| 裸 uuid 输入 | ✅ | ✅ | 无标题可核对，批量时仍逐条展示命中标题 |
| 分享页拒绝 | ✅ | ✅ | `/share/` 只读，无接口权限 |
| 归属校验 | ✅ | ✅ | 必须在本账号列表命中；未命中即拒绝，不盲删 |
| 置顶保护 | ✅ 固定开启 | ✅ `--include-pinned` 可关 | 置顶会话默认跳过 |
| 删除前快照 | ✅ 下载 JSON | ✅ `snapshots/` | 仅实际执行时生成；失败即中止删除 |
| 预演（dry-run） | ✅ 默认勾选 | ✅ 默认开启 | 预演只读：不写快照、不调删除接口 |
| 串行限速 | ✅ 500ms / 20 条 / 10s | ✅ 三个参数可配 | 不并发，宁可慢 |
| 删除形态自适应 | ✅ | ✅ | 422 → 单数体切数组体 |
| 鉴权失效中止 | ✅ | ✅ | `401` / `code 40003` → 余下标 `ABORTED` |
| 失败重试 | ✅ 2 次 | ✅ `--retries` | 5xx/429 退避 1/2/4s；403 冷却 30s |
| 删后复核 | ✅ | ✅ | 重拉列表看是否仍在 |
| 审计 | ✅ 本地存储 + 下载 | ✅ `audit.jsonl` | 脱敏，账号只存 sha256 前 8 字节 |
| 批量确认 | ✅ >5 条输入 `DELETE` | ✅ `--yes` | 单次硬上限 50 条 |
| 标题打码 | — | ✅ `--mask-title` | 只影响报告，不改变快照内容 |
| 断点续跑 | — | — | 见 roadmap M3 |

## 快速开始

```bash
pnpm install
pnpm build        # 产出 dist/dsx.user.js 与 dist/dsx-cli.mjs
pnpm test         # 25 个单测
```

### 油猴端

1. 浏览器安装 Tampermonkey / Violentmonkey
2. 把 `dist/dsx.user.js` 拖进扩展的脚本管理页安装
3. 打开 `chat.deepseek.com` 任意会话，右下角出现 `DSX` 悬浮球
4. 粘贴会话链接 → **解析并预览** → 看清标题与时间 → 取消"仅预演" → 执行删除

### CLI 端

```bash
# 一次性导出登录态（cookie + localStorage.userToken）
npx playwright open --save-storage=auth.json https://chat.deepseek.com

# 预演：只列清单，不调删除接口
node dist/dsx-cli.mjs --state auth.json \
  --url "https://chat.deepseek.com/a/chat/s/<session-id>"

# 批量：链接清单一行一条
node dist/dsx-cli.mjs --state auth.json --file links.txt --apply --yes
```

也可用环境变量 `DSX_TOKEN` / `DSX_COOKIE` 代替 `--state`。常用选项见 `node dist/dsx-cli.mjs --help`；输出（`report.json`、`report.md`、`audit.jsonl`、`snapshots/`）默认写到 `./dsx-out`。

退出码：`0` 成功，`2` 部分失败或被拒绝，`3` 鉴权/接口失败。

## 安全模型

删除在 DeepSeek 侧**不可撤销**，所以工具把"阻止误删"放在"删得快"前面：

| 闸门 | 行为 |
|---|---|
| Dry-run 默认开 | CLI 不加 `--apply` 不调删除接口、也不写快照；油猴默认勾选"仅预演" |
| 归属校验 | 列表未命中即拒绝，返回 `NOT_FOUND`，不会试着删一下看看 |
| 快照前置 | 实际删除前先拉全文落盘；快照失败即中止整批 |
| 批量确认 | 超过 5 条需 `--yes`；单次硬上限 50 条 |
| 置顶保护 | `pinned` 会话默认跳过，`--include-pinned` 才处理 |
| 审计与脱敏 | 只记会话 id/标题/时间/结果；token、cookie 从不落盘；错误文本过 `redactSecrets` |

**数据落在哪**：快照是明文全文，CLI 写在 `dsx-out/snapshots/`，油猴走浏览器下载目录；审计在 CLI 是 `audit.jsonl`，在油猴是 `chat.deepseek.com` 域下的 `localStorage`（只含会话 id、标题、时间、结果，不含凭证）。两处都由 `.gitignore` 或站点隔离兜住，但需要自己定期清理。

## 已知边界

- **接口非官方**，字段与参数会变。列表分页存在 `before_seq_id` 与 `lte_cursor.updated_at` 两套写法，删除 body 存在单数与数组两种形态；本工具运行时探测并缓存，但仍需以线上实测为准（见 [docs/api-notes.md](docs/api-notes.md)）。
- **分享页只读**，`/share/...` 无接口权限，只能定位与提取。
- **不承诺可还原**：快照留档用于查证；从快照重建会话需要逐条 completion 与 PoW，成本高且顺序难还原，未实现。
- **风控**：高频删除可能触发验证码或临时限制；工具默认串行与分批，但不保证零风险。
- **侧栏只渲染百余条**：实测同一账号接口返回千级会话、侧栏 DOM 只有百级（虚拟列表）。所以存在性判定只认 `fetch_page`，不认 DOM。
- **明文留存**：快照与审计是明文落盘，`--mask-title` 只作用于报告；涉密会话请自行加密或删档。

## 仓库结构

```
src/core/        纯逻辑：parser / http / repository / guard / executor / snapshot / audit
src/userscript/  油猴面板（Shadow DOM，单文件产物）
src/cli/         命令行：参数、storageState 解析、报告
tests/           vitest 单测
docs/            方案、接口、选型、开源对照、开发计划
scripts/build.mjs  esbuild 构建脚本
```

## 文档

- [架构与状态机](docs/architecture.md)
- [接口现状与错误码](docs/api-notes.md)
- [开源项目对照](docs/open-source-comparison.md)
- [技术选型](docs/tech-selection.md)
- [开发计划与验收](docs/roadmap.md)

## 开发

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # esbuild 双产物
```

## 免责声明

本项目与 DeepSeek 官方无关，调用的是网页端内部接口，可能随前端改版失效。请仅用于管理本人账号的自有数据，自行承担账号与数据风险；因误删造成的内容丢失无法恢复。

## English

DSX is a link-driven session manager for DeepSeek's web chat. Paste a conversation link, verify it belongs to your account, snapshot it, then delete it — with rate limiting, dry-run by default, and a JSONL audit trail. Ships as a userscript and a CLI sharing one TypeScript core. Unofficial; self-hosted; your own account only.
