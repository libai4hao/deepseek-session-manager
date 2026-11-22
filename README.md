# DSX · DeepSeek 会话管家

[![CI](https://github.com/libai4hao/deepseek-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/libai4hao/deepseek-session-manager/actions/workflows/ci.yml)
[![Release](https://github.com/libai4hao/deepseek-session-manager/actions/workflows/release.yml/badge.svg)](https://github.com/libai4hao/deepseek-session-manager/actions/workflows/release.yml)

一个给 DeepSeek 网页版打的增强补丁，只做两件事：

1. **定位当前会话**：你正在读的这条会话，在左侧会话栏里高亮出来并滚到可见位置——长列表里翻找自己刚才那条，本来要靠肉眼。
2. **删除指定链接的会话**：粘贴一条本人会话链接，校验归属后删除这条个人聊天会话。

预演、快照、审计、限速不是目的，是第 2 件事的安全护栏。两端共用一套核心：油猴面板管单条、要人眼核对标题；CLI 管批量、要留档。

> 非官方增强，基于网页端内部接口；只对**本人账号**的会话生效，不做多账号代操作。

## 功能清单

| 功能 | 油猴 | CLI | 说明与边界 |
|---|---|---|---|
| 定位当前会话 | ✅ 进页自动高亮，按钮可重定位 | — | 侧栏只加载常用约百条；范围内可定位，范围外只提示，不阻断删除 |
| 定位指定链接 | ✅ 点预览行 / 点「定位侧栏」 | — | CLI 没有 UI，只按 session id 处理 |
| 删除指定链接会话 | ✅ | ✅ | 归属校验 + 快照 + 审计，见下方各闸门 |
| 链接解析 | ✅ | ✅ | 分 session / share / foreign / bad 四类；仿冒域名按 hostname 全等判定 |
| 裸 uuid 输入 | ✅ | ✅ | 无标题可核对，批量时仍逐条展示命中标题 |
| 分享页拒绝 | ✅ | ✅ | `/share/` 只读，无接口权限 |
| 归属校验 | ✅ | ✅ | 必须在本账号列表命中；未命中即拒绝，不盲删 |
| 置顶保护 | ✅ 固定开启 | ✅ `--include-pinned` 可关 | 置顶会话默认跳过 |
| 删除前快照 | ✅ 下载 JSON | ✅ `snapshots/` | 仅实际执行时生成；失败即中止删除 |
| 快照加密 | — | ✅ `--snapshot-encrypt` | scrypt + AES-256-GCM；口令只从 `DSX_SNAPSHOT_PASSWORD` 读 |
| 仅导出（不删） | — | ✅ `--export-only` | 与 `--apply` 互斥；适合先备份后决定 |
| 预演（dry-run） | ✅ 默认勾选 | ✅ 默认开启 | 不拉消息、不写快照、不调删除接口；只写报告与审计 |
| 串行限速 | ✅ 500ms / 20 条 / 10s | ✅ 三个参数可配 | 不并发，宁可慢 |
| 删除形态自适应 | ✅ | ✅ | 422 → 单数体切数组体 |
| 鉴权失效中止 | ✅ | ✅ | `401` / `code 40003` → 余下标 `ABORTED` |
| 失败重试 | ✅ 2 次 | ✅ `--retries` | 5xx/429 退避 1/2/4s；403 冷却 30s |
| 删后复核 | ✅ | ✅ | 重拉列表看是否仍在 |
| 审计 | ✅ 本地存储 + 下载 | ✅ `audit.jsonl` | 脱敏，账号只存 sha256 前 8 字节 |
| 批量确认 | ✅ >5 条输入 `DELETE` | ✅ `--yes` | 单次硬上限 50 条 |
| 断点续跑 | — | ✅ `--resume` | 读 `<out>/progress.json`：跳过已完成、复用已有快照 |
| 持久安装 | ✅ 油猴 / MV3 壳 | — | 刷新不失效；MV3 产物在 `dist/extension/` |
| 标题打码 | — | ✅ `--mask-title` | 同时作用于报告与审计；不改变快照内容 |

## 快速开始

```bash
pnpm install
pnpm build        # 产出 dist/dsx.user.js、dist/dsx-cli.mjs、dist/extension/
pnpm test         # 47 个单测
```

### 三种安装方式

| 方式 | 步骤 | 适用 |
|---|---|---|
| 一键安装 | 浏览器打开 `https://github.com/libai4hao/deepseek-session-manager/releases/latest/download/dsx.user.js`，Tampermonkey 弹安装页确认 | 普通用户，装完自动更新 |
| MV3 扩展（推荐自用） | `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展 → 选 `dist/extension` | 刷新不失效，权限最小 |
| 油猴脚本（本地） | 装 Tampermonkey / Violentmonkey，把 `dist/dsx.user.js` 拖进脚本管理页 | 改脚本方便 |
| 临时注入 | 开发者工具粘 `dist/dsx.user.js` 全文执行 | 只做一次验证 |

MV3 壳没有额外权限：`content_scripts` 只匹配 `chat.deepseek.com`，不加 `host_permissions`，脚本走页面同源请求。

### 油猴端

1. 浏览器安装 Tampermonkey / Violentmonkey
2. 把 `dist/dsx.user.js` 拖进扩展的脚本管理页安装
3. 打开 `chat.deepseek.com` 任意会话，当前会话会在左侧会话栏自动高亮，右下角出现 `DSX` 悬浮球
4. 粘贴会话链接 → **解析并预览**（单条会自动滚到侧栏对应条目并高亮）→ 看清标题与时间 → 取消"仅预演" → 执行删除

### CLI 端

```bash
# 一次性导出登录态（cookie + localStorage.userToken）
npx playwright open --save-storage=auth.json https://chat.deepseek.com

# 预演：只列清单，不调删除接口
node dist/dsx-cli.mjs --state auth.json \
  --url "https://chat.deepseek.com/a/chat/s/<session-id>"

# 只导出快照，不删除
node dist/dsx-cli.mjs --state auth.json --url "<link>" --export-only

# 批量：链接清单一行一条
node dist/dsx-cli.mjs --state auth.json --file links.txt --apply --yes

# 中断后续跑：跳过已完成、复用已有快照
node dist/dsx-cli.mjs --state auth.json --file links.txt --apply --yes --resume

# 加密快照（口令不进命令行、不进报告）
DSX_SNAPSHOT_PASSWORD='...' node dist/dsx-cli.mjs --state auth.json --file links.txt --apply --yes --snapshot-encrypt
```

也可用环境变量 `DSX_TOKEN` / `DSX_COOKIE` 代替 `--state`。常用选项见 `node dist/dsx-cli.mjs --help`；输出（`report.json`、`report.md`、`audit.jsonl`、`snapshots/`、`progress.json`）默认写到 `./dsx-out`。

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

**数据落在哪**：快照是明文全文，CLI 写在 `dsx-out/snapshots/`，油猴走浏览器下载目录；加 `--snapshot-encrypt` 后落盘的是 `*.enc.json`（scrypt 派生密钥 + AES-256-GCM，口令只存在环境变量）。审计在 CLI 是 `audit.jsonl`，在油猴是 `chat.deepseek.com` 域下的 `localStorage`（只含会话 id、标题、时间、结果，不含凭证）。两处都由 `.gitignore` 或站点隔离兜住，但需要自己定期清理。

## 已知边界

- **接口非官方**，字段与参数会变。列表分页存在 `before_seq_id` 与 `lte_cursor.updated_at` 两套写法，删除 body 存在单数与数组两种形态；本工具运行时探测并缓存，但仍需以线上实测为准（见 [docs/api-notes.md](docs/api-notes.md)）。
- **分享页只读**，`/share/...` 无接口权限，只能定位与提取。
- **不承诺可还原**：快照留档用于查证；从快照重建会话需要逐条 completion 与 PoW，成本高且顺序难还原，未实现。
- **风控**：高频删除可能触发验证码或临时限制；工具默认串行与分批，但不保证零风险。
- **侧栏不是无限列表**：实测只加载约 100 条，滚动未观察到追加加载，更早的会话可能只在接口里有。所以定位只在已加载范围内有效，找不到时提示“侧栏未加载”，存在性仍只认 `fetch_page`，不影响删除。
- **默认明文**：快照与审计默认是明文落盘；`--snapshot-encrypt` 只加密快照，审计仍明文（但只有 id、标题、时间、结果）。涉密会话建议开启加密并定期清档。
- **加密口令不可找回**：`DSX_SNAPSHOT_PASSWORD` 丢了，`*.enc.json` 就解不开；文件头只有 KDF 参数，没有校验位以外的线索。
- **MV3 壳不自动更新**：`dist/extension` 是本地加载的目录，代码更新后要在 `chrome://extensions` 点重新加载。

## 仓库结构

```
src/core/        纯逻辑：parser / http / repository / guard / executor / snapshot / audit（双端可用，不含 node: 导入）
src/userscript/  油猴面板与 MV3 content script 共用（Shadow DOM，单文件产物）
src/cli/         命令行：参数、storageState 解析、快照加密、断点续跑、报告（可用 node: 能力）
tests/           vitest 单测
docs/            方案、接口、选型、开源对照、开发计划、打包发布
scripts/build.mjs  esbuild 构建 + MV3 打包（dist/extension/）
```

## 文档

- [架构与状态机](docs/architecture.md)
- [接口现状与错误码](docs/api-notes.md)
- [开源项目对照](docs/open-source-comparison.md)
- [技术选型](docs/tech-selection.md)
- [开发计划与验收](docs/roadmap.md)
- [打包与发布手册](docs/release.md)

## 开发

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run（47 例）
pnpm build        # esbuild + MV3 打包
```

## 免责声明

本项目与 DeepSeek 官方无关，调用的是网页端内部接口，可能随前端改版失效。请仅用于管理本人账号的自有数据，自行承担账号与数据风险；因误删造成的内容丢失无法恢复。

## English

DSX is a small enhancement layer for DeepSeek's web chat with exactly two jobs: highlight the conversation you are currently reading in the left sidebar, and delete the personal session behind a given chat URL — with ownership checks, dry-run by default, snapshots, rate limiting and a JSONL audit trail. Ships as a userscript, an MV3 extension shell, and a CLI sharing one TypeScript core. Also supports `--export-only`, `--resume`, and AES-GCM encrypted snapshots. Unofficial; self-hosted; your own account only.
