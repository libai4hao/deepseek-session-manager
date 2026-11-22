# 架构与状态机

## 分层

```
┌─────────────── 入口层 ────────────────┐
│ src/userscript  悬浮面板（Shadow DOM）  │
│ src/cli         参数 / 报告 / 退出码     │
└──────────────┬────────────────────────┘
               │  统一入参：ParsedLink[]
┌──────────────▼────────────────────────┐
│ core（纯逻辑，无 DOM、无 Node API）      │
│ parser → guard → snapshot → executor   │
│                    → verify → audit    │
└──────────────┬────────────────────────┘
               │  Transport 注入（fetch）
┌──────────────▼────────────────────────┐
│ transport.createFetchTransport         │
│ 浏览器：同源相对路径 + credentials       │
│ CLI：绝对 baseUrl + cookie / Bearer     │
└────────────────────────────────────────┘
```

关键约束：`src/core` 不 import 任何浏览器或 Node 专属 API（除 `fetch` / `crypto.subtle` 这类双端可用能力），Node 专属能力（`node:crypto`、`node:fs`）只允许出现在 `src/cli`。两端行为因此不会漂移——同一个 `runQueue` 决定了油猴和 CLI 的删除语义。

## 模块

| 文件 | 职责 | 对外契约 |
|---|---|---|
| `src/core/types.ts` | 全部共享类型 | `ParsedLink`、`SessionMeta`、`Transport`、`ExecOptions` |
| `src/core/parser.ts` | 文本 → 链接分类 | `parseLink`、`parseLinks`、`dedupeLinks`、`splitLines` |
| `src/core/http.ts` | 响应归一、错误分类、鉴权头 | `normalizeApiResult`、`classifyResult`、`authHeaders`、`ApiFailure` |
| `src/core/transport.ts` | fetch 封装 | `createFetchTransport` |
| `src/core/repository.ts` | 列表分页、消息、账号指纹、删后复核 | `listSessions`、`getMessages`、`getAccountId`、`verifyDeleted` |
| `src/core/guard.ts` | 归属与置顶校验 | `buildIndex`、`guardLink` |
| `src/core/executor.ts` | 串行删除、限速、分批、重试、形态探测 | `deleteSession`、`runQueue` |
| `src/core/snapshot.ts` | 删除前快照与文件命名 | `buildSnapshot`、`snapshotFileName` |
| `src/core/audit.ts` | 审计事件、脱敏、id 哈希 | `toAuditLine`、`hashId`、`execResultToAudit` |
| `src/core/auth.ts` | 从 `localStorage.userToken` 取 token | `tokenFromUserToken` |
| `src/cli/state.ts` | 解析 Playwright storageState | `readStorageState` |
| `src/cli/snapshot-crypto.ts` | 快照加密/解密（Node `crypto`，仅 CLI） | `encryptSnapshot`、`decryptSnapshot`、`encryptedFileName` |
| `src/cli/progress.ts` | 断点续跑账本 | `readProgress`、`completedIds`、`reusableSnapshots`、`mergeResults` |
| `src/cli/report.ts` | 报告结构与 Markdown 渲染 | `renderMarkdown`、`ReportMode` |

## 状态机

```
输入
 │
 ├─ 非法 / 分享页 / 外站 ──→ 拒绝（不进队列，报告里标 reject）
 │
 ▼ 本人会话链接
归属校验 guardLink
 │  ├─ 列表未命中 ──→ NOT_FOUND（跳过，不盲删）
 │  └─ 置顶且保护 ──→ PINNED_PROTECTED
 ▼
快照 buildSnapshot → snapshots/*.json
 │  └─ 失败 ──→ 中止整批（除非显式 --no-snapshot）
 ▼
预演 / 用户确认
 │  ├─ dry-run ──→ 输出清单后结束（不拉消息、不写快照）
 │  ├─ export-only ──→ 拉全文写快照后结束（永不调删除接口）
 │  └─ apply：>5 条需 --yes，>50 条直接拒绝
 ▼
执行 runQueue（串行）
 ├─ deleted       成功
 ├─ failed        重试耗尽 / 业务错误
 ├─ aborted       token 失效 → 余下全部 skipped(ABORTED)
 └─ shape switch  422 → 单数体换数组体重试
 ▼
复核 verifyDeleted（重新拉列表，看是否还在）
 ▼
审计 audit.jsonl + report.json/md + progress.json（断点续跑账本）
```

## 几个刻意的设计决定

**1. 不并发。** 删除是破坏性写操作，并发只省几秒，却显著提高触发风控与乱序失败的概率。`runQueue` 是 `for` 循环，不是 `Promise.all`。

**2. token 失效即中止，不是逐条跳过。** token 挂了还继续跑，只会产生一堆 `failed` 掩盖真正原因。`401` / `code 40003` 直接把状态打成 `aborted`，剩余任务标 `skipped(ABORTED)`。

**3. 删除参数形态靠 422 探，不靠猜。** 接口返回 `{detail:[{loc:"body.xxx"}]}` 时会指出字段名。先在 `auto` 模式用单数体试一次，`schema` 类错误即切数组体，并在本次运行内缓存（`onShapeDetected`）。

**4. 快照失败即中止。** 快照是唯一的事后证据。为了让"省一点磁盘"而放行一个无留档的删除，不划算；需要时可以 `--no-snapshot` 显式承担。

**5. 侧栏不拆 DOM。** 删除后前端状态仍持有节点，手工 `remove()` 会导致列表错乱；油猴端删完只重拉列表，不碰 React 的节点。

**6. "定位"分三档实现，但判定只认数据。** 批量场景完全不依赖 DOM：只要 `fetch_page` 里有这条会话就算存在。DOM 里的虚拟列表没渲染出某条，并不代表它不存在——拿 DOM 做存在性判断会误判。

## 三种运行模式

| 模式 | 触发 | 拉消息 | 写快照 | 调删除接口 | 写 progress |
|---|---|---|---|---|---|
| preflight | 默认 | 否 | 否 | 否 | 否 |
| export | `--export-only` | 是 | 是 | **否** | 是 |
| delete | `--apply` | 是（除非 `--no-snapshot`） | 是 | 是 | 是 |

`--export-only` 与 `--apply` 互斥，参数解析阶段就拒绝；它存在的意义是让"只想备份、不敢删"的用户也能用同一条链路验证快照是否完整。

## 断点续跑

`progress.json`（`dsx.progress.v1`）按 session id 记账：

- `deleted` / `skipped` → 视为完成，下次 `--resume` 直接跳过；
- `failed` / `aborted` → 仍会重试；
- `snapshotted` + `snapshot` 文件名 → 下次运行复用已有快照，不再拉一次全文。

文件损坏或手改坏了不会崩：`readProgress` 解析失败就当作没有账本，从零开始。

## MV3 打包

`dist/extension/` = `manifest.json` + 去掉 `==UserScript==` 头的 `dsx.js`。因为核心不依赖任何 `GM_*` API，油猴态与 content script 态是同一份代码；MV3 里 `localStorage` 与页面共享，`fetch` 走页面同源，不需要额外 `host_permissions`。代价是改代码后要手动"重新加载"扩展，没有自动更新。

## 数据流示例（CLI）

```
links.txt ──splitLines──▶ parseLink[] ──dedupe──▶ ParsedLink[]
                                                  │
fetch_page（分页，两套 cursor）─▶ SessionMeta[] ──┴─▶ buildIndex ─▶ guardLink
                                                                      │
                                            snapshot（history_messages）┘
                                                                      │
                                              runQueue（delete_session）│
                                                                      ▼
                                            verifyDeleted（再拉一次列表）
                                                                      │
                                     report.json / report.md / audit.jsonl / progress.json
```
