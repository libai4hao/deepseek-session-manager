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

关键约束：`src/core` 不 import 任何浏览器或 Node 专属 API（除 `fetch` / `crypto.subtle` 这类双端可用能力），Node 专属能力（`node:crypto`、`node:fs`）只允许出现在 `src/cli`。CLI 入口会用 `node:crypto.webcrypto` 补齐 Node 18 默认缺失的全局 WebCrypto；油猴端使用浏览器原生能力。两端行为因此不会漂移——同一个 `runQueue` 决定了油猴和 CLI 的删除语义。

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
| `src/cli/snapshot-crypto.ts` | 快照加密/解密（Node `crypto`，仅 CLI） | `encryptSnapshot`、`decryptSnapshot`、`encryptedSnapshotFileName` |
| `src/cli/progress.ts` | 断点续跑账本 | `readProgress`、`completedIds`、`checkResumeAccount`、`reusableSnapshots`、`mergeResults` |
| `src/cli/report.ts` | 报告结构与 Markdown 渲染 | `renderMarkdown`、`ReportMode` |
| `src/userscript/sidebar.ts` | 侧栏滚动定位与高亮（仅油猴） | `locateSession`、`sessionIdFromHref` |

## 状态机

```
输入
 │
 ├─ 非法 / 分享页 / 外站 ──→ 拒绝（不进队列，报告里标 reject）
 │
 ▼ 本人会话链接
侧栏定位（仅油猴）：已加载条目内滚动 + 高亮；找不到只提示，不阻断
 ▼
归属校验 guardLink
 │  ├─ 列表未命中 ──→ NOT_FOUND（跳过，不盲删）
 │  └─ 置顶且保护 ──→ PINNED_PROTECTED
 ▼
快照 buildSnapshot → snapshots/*.json
 │  └─ 失败 ──→ 中止整批（除非显式 --no-snapshot）
 │  └─ 油猴 ──→ 用户确认文件已保存，否则取消
 ▼
预演 / 用户确认
 │  ├─ dry-run ──→ 输出清单后结束（不拉消息、不写快照）
 │  ├─ export-only ──→ 拉全文写快照后结束（永不调删除接口）
 │  └─ apply：>5 条需 --yes，>50 条直接拒绝
 ▼
每次实际 POST（含重试/形态切换）前：列表校验 + 快照版本匹配（目标变化即中止）
 ▼
执行 runQueue（串行）
 ├─ deleted       成功
 ├─ failed        重试耗尽 / 业务错误
 ├─ aborted       token 失效 → 余下全部 skipped(ABORTED)
 └─ shape switch  422 → 单数体换数组体重试
 ▼
复核 verifyDeleted（重新拉列表，看是否还在）
 │  └─ deleted/noop 未通过复核 ──→ failed(VERIFY_*)
 ▼
审计 audit.jsonl（追加写）+ report.json/md + progress.json（断点续跑账本）
```

## 几个刻意的设计决定

**1. 不并发。** 删除是破坏性写操作，并发只省几秒，却显著提高触发风控与乱序失败的概率。`runQueue` 是 `for` 循环，不是 `Promise.all`。

**2. token 失效即中止，不是逐条跳过。** token 挂了还继续跑，只会产生一堆 `failed` 掩盖真正原因。`401` / `code 40003` 直接把状态打成 `aborted`，剩余任务标 `skipped(ABORTED)`。

**3. 删除参数形态靠 422 探，不靠猜。** 接口返回 `{detail:[{loc:"body.xxx"}]}` 时会指出字段名。先在 `auto` 模式用单数体试一次，`schema` 类错误即切数组体，并在本次运行内缓存（`onShapeDetected`）。形态探测不消耗失败重试预算，因此 `--retries 0` 也至少会发送一次数组体请求。

**4. 快照失败即中止。** 快照是唯一的事后证据。为了让"省一点磁盘"而放行一个无留档的删除，不划算；需要时可以 `--no-snapshot` 显式承担。快照生成或用户确认保存后，CLI 与油猴会在每次实际 POST（包括重试与删除体形态切换）前再拉一次列表并核对归属、置顶状态和 `updatedAt`；版本变化就中止后续删除。油猴无法直接观察浏览器下载结果，因此要求用户明确输入 `SAVED` 确认文件已保存。

**5. 侧栏不拆 DOM。** 删除后前端状态仍持有节点，手工 `remove()` 会导致列表错乱；油猴端删完只重拉列表，不碰 React 的节点。

**6. 定位是 UI 增强，判定仍以数据为准。** 油猴端做两件事：进会话页自动把当前会话在侧栏高亮；解析链接后滚动定位目标条目，点行或点按钮可重定位。实测侧栏只加载约 100 条，滚动未观察到追加加载，所以老会话可能根本不在 DOM 里：定位失败只提示“侧栏未加载”，绝不阻断删除；会话到底在不在，只认 `fetch_page`。定位只滚动与高亮，不 `remove()`、不点击跳转。

## 三种运行模式

| 模式 | 触发 | 拉消息 | 写快照 | 调删除接口 | 写 progress |
|---|---|---|---|---|---|
| preflight | 默认 | 否 | 否 | 否 | 否 |
| export | `--export-only` | 是 | 是 | **否** | 是 |
| delete | `--apply` | 是（除非 `--no-snapshot`） | 是 | 是 | 是 |

`--export-only` 与 `--apply` 互斥，参数解析阶段就拒绝；它存在的意义是让"只想备份、不敢删"的用户也能用同一条链路验证快照是否完整。

## 断点续跑

`progress.json`（`dsx.progress.v1`）按 session id 记账：

- `deleted` + `verifiedAt` → 视为完成，下次 `--resume` 直接跳过；旧版只有 `deleted`、没有复核证据的条目不再信任，会重新走校验；
- `failed` / `aborted` → 仍会重试；鉴权中止的 `skipped(ABORTED)` 持久化为 `aborted`，不会误判完成；
- `snapshotted` + `snapshot` 文件名 → 下次运行复用已有快照，不再拉一次全文。

三个防误删约束：

1. **账号隔离。** 账本写入当前账号指纹（`accountHash`）。`--resume` 时当前指纹与账本不一致、任一方缺失，都直接 `exit 3`，不给"换账号接着删"留口子。
2. **快照复用要过完整性与新鲜度。** 文件名必须留在 `snapshots/` 内（拒绝 `../`），明文快照必须通过完整结构校验；加密快照必须通过固定 scrypt 参数、规范 Base64、salt/IV/完整 16 字节 GCM tag 校验并成功解密。两种快照的 `id` 与 `updatedAt` 都必须匹配当前会话，否则重新抓取，不拿旧文件当证据。
3. **原子落盘。** 先写 `progress.json.tmp-<pid>`（`wx` 独占），再 `rename` 覆盖；进程中途崩溃最多丢本轮，不会留下半截账本。

账本损坏时 `readProgress` 返回 `undefined`；但 `--resume` 下"文件存在却读不出"按失败处理（`exit 3`），避免把损坏账本当成全新任务而重复删除。

## 分页完整性

会话列表是删除目标与归属判定的唯一来源，宁可报错也不返回半份列表：

- 新接口用 `next_cursor` 翻页，旧接口用 `updated_at` 时间游标；
- 达到 `maxPages`（200）仍 `has_more=true` → 抛"会话列表未完整遍历"，不进入删除阶段；
- `has_more` 缺失/非布尔值，或 `has_more=true` 但返回空页 → 直接抛错；
- `has_more=true` 但这一页拿不到任何可用游标 → 直接抛错；
- 游标与上一次相同 → 抛"游标未推进"，防止服务端重复返回同一页时空转到触顶；
- 已声明但非法的 `next_cursor` / `seq_id` / `updated_at` → 直接抛错，不静默回退到另一套游标方言；
- 旧接口的时间游标不再附加 `pinned=false`：该过滤会漏掉置顶会话，而"置顶会话是否存在"直接影响归属校验与置顶保护。置顶由 `guardLink` 单独拦截，分页只负责把列表取全。

## 请求超时

`createFetchTransport` 支持 `timeoutMs`（CLI 用 `--timeout` 配置，默认 30s）：每次请求挂 `AbortController`，超时即 abort 并在 `finally` 清理定时器。执行器把超时记为 `TIMEOUT: ...`，与普通网络错误区分，避免"连接挂死"被当成可无限重试。

响应解析同样失败关闭：非 JSON、空正文或缺少数值 `code` 都不会被补成 `code: 0`；非 JSON 响应仍保留 HTTP 状态，因此 401 会中止队列、403 仍走冷却重试。会话 id、布尔 `pinned`、数值 `updated_at`、已声明的 `seq_id` 以及消息的 `message_id`、`role`、`inserted_at` 和 fragment 字段都必须符合类型；不再把非法值静默补成 `0`、`UNKNOWN`、空字符串或 `pinned=false`。`chat_messages` 与 `fragments` 必须明确为数组，避免把网关页面或改版响应当成成功删除/空快照。

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
