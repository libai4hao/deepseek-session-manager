# DSX · DeepSeek 会话管家

把一条会话链接，变成一个**可校验、可留档、可审计**的删除动作。

DeepSeek 网页版没有"给个链接就把这条会话处理掉"的能力：侧栏翻找靠肉眼，删除靠手点，删了什么没人记得。DSX 把这件事拆成六步——解析、归属校验、快照、确认、删除、审计——并做成油猴面板与命令行两端，共用同一套核心逻辑。

> 非官方工具，基于网页端内部接口；只对**本人账号**的会话生效，不做多账号代操作。

## 能力

- **链接解析**：`/a/chat/s/<id>`、裸 uuid 都认；分享页 `/share/`、外站域名、疑似钓鱼域名直接拒绝
- **归属校验**：必须在本账号会话列表中命中才允许删除；未命中一律跳过，绝不"盲删试探"
- **删除前快照**：整段对话落盘为 JSON；快照失败则中止删除
- **串行限速删除**：默认 500ms 间隔、20 条一批、批间暂停 10s，不做并发
- **参数形态自适应**：删除接口的 `chat_session_id` / `chat_session_ids` 两种写法用 422 响应自动探测
- **审计**：每次操作一行 JSONL，token 不落盘，账号只存哈希前缀
- **双端**：油猴面板（单条、人眼确认）+ CLI（批量、无人值守）

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
| Dry-run 默认开 | CLI 不加 `--apply` 不调删除接口；油猴默认勾选"仅预演" |
| 归属校验 | 列表未命中即拒绝，返回 `NOT_FOUND`，不会试着删一下看看 |
| 快照前置 | 删除前先拉全文落盘；快照失败即中止 |
| 批量确认 | 超过 5 条需 `--yes`；单次硬上限 50 条 |
| 置顶保护 | `pinned` 会话默认跳过，`--include-pinned` 才处理 |
| 审计与脱敏 | 只记会话 id/标题/时间/结果；token、cookie 从不落盘 |

## 已知边界

- **接口非官方**，字段与参数会变。列表分页存在 `before_seq_id` 与 `lte_cursor.updated_at` 两套写法，删除 body 存在单数与数组两种形态；本工具运行时探测并缓存，但仍需以线上实测为准（见 [docs/api-notes.md](docs/api-notes.md)）。
- **分享页只读**，`/share/...` 无接口权限，只能定位与提取。
- **不承诺可还原**：快照留档用于查证；从快照重建会话需要逐条 completion 与 PoW，成本高且顺序难还原，未实现。
- **风控**：高频删除可能触发验证码或临时限制；工具默认串行与分批，但不保证零风险。

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
