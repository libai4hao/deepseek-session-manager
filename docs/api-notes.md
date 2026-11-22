# 接口现状与错误码

> 全部为网页端内部接口，非官方文档；以 2026-11 的多个独立项目实测与公开脚本为准。派生自前端改版会失效，本项目把不确定点做成运行时探测。

## 基础

- Base：`https://chat.deepseek.com/api/v0`
- 鉴权：`Authorization: Bearer <token>`，token 取自 `localStorage.userToken`（JSON，取 `.value`）
- 常见头：`content-type: application/json`、`x-client-platform: web`；带 `credentials: include` 更稳
- PoW：仅 `chat/completion`、`chat/edit_message`、`file/upload_file` 需要。**会话管理类接口不需要 PoW**，这省掉了 WASM 求解与每次请求重新计算

## 端点

| 用途 | 请求 | 关键参数 | 返回（`data.biz_data`） |
|---|---|---|---|
| 会话列表 | `GET /chat_session/fetch_page` | `count` / `before_seq_id` 或 `lte_cursor.updated_at` | `chat_sessions[{id,title,pinned,seq_id,updated_at,model_type}]`、`has_more`、`next_cursor` |
| 会话消息 | `GET /chat/history_messages` | `chat_session_id`、`cache_version=4` | `chat_messages[{message_id,role,inserted_at,fragments[{type,content}]}]` |
| 删除会话 | `POST /chat_session/delete` | `{chat_session_id}` 或 `{chat_session_ids:[...]}` | 空业务体 |
| 当前账号 | `GET /users/current` | — | 账号信息（字段未文档化，代码容错取 `id/user_id/uid/email`） |

响应外层统一为：

```json
{ "code": 0, "msg": "", "data": { "biz_code": 0, "biz_msg": "", "biz_data": { ... } } }
```

## 四个必须实测的不确定点

### 1. 删除 body：单数还是数组

公开脚本里两种写法都出现过（2026-02 用单数、2026-10 用数组），说明接口改过版。服务端参数校验失败会返回 `422 {"detail":[{"loc":"body.<field>"}]}`——这个 `loc` 就是免费的 schema 提示。

本项目处理：`shape: 'auto'` 先用单数体；遇到 `schema` 类错误自动切数组体并缓存（见 `src/core/executor.ts`）。首次真实运行建议先用一条无关紧要的会话确认形态。

### 2. 列表分页：两套 cursor

- 新：`?count=<n>&before_seq_id=<seq>`，响应带 `next_cursor` / `has_more`
- 老：`?lte_cursor.pinned=false&lte_cursor.updated_at=<ts>`

本项目处理：首页只发 `count`，从响应里推断方言（有 `next_cursor` 走 seq，否则按 `seq_id` 最小值，再否则按 `updated_at` 最小值回退时间游标），见 `listSessions`。

### 3. `count` 上限

未验证是否截断。代码只信 `has_more`，不信条数，并以 `seen` 去重防止翻页重复。

### 4. 删除后的前端同步

有公开脚本明确注释「不能直接 remove 节点，只能 `display:none`」——React 内部状态仍持有该节点。本项目删完只重拉列表，不手工拆 DOM。

## 实测观察（2026-11，单账号）

- **接口条数 ≫ 侧栏条数**：同一账号下 `fetch_page` 能返千级会话，侧栏 DOM 只渲染百级（虚拟列表只挂可视区附近）。结论：判断"这条会话在不在"必须问接口，DOM 命中与否只能当 UI 线索。
- **删除不做 PoW**：单条删除约 70ms 返回 `{"code":0}`，未出现 `pow_challenge` / 验证码。PoW 只在 completion / edit_message / upload_file 这类"耗算力"接口上。
- **删除后页面**：URL 退回 `/`，会话页提示"该对话不存在"，侧栏重载后条目消失；与"只重拉列表、不拆 DOM"的策略一致。



| 返回 | 分类 | 本项目动作 |
|---|---|---|
| HTTP 200 `code:0` `biz_code:0` | ok | 记 `deleted` |
| HTTP 200 `code:40003` | auth | 全队列中止，提示重新导出登录态 |
| HTTP 401 | auth | 同上 |
| HTTP 403 / 风控挑战页 | forbidden | 冷却 30s（`forbiddenCooldownMs`），仍失败则该条 `failed` |
| HTTP 422 | schema | 自动切换删除参数形态 |
| HTTP 429 | rate | 指数退避 1s/2s/4s |
| HTTP 5xx | server | 同上 |
| 网络异常 / 超时 | throw | 重试 `--retries` 次后记 `failed`，不让进程崩 |
| 其它非 200 | business | 记 `failed` 并保留 `biz_msg` |

## 官方兜底通道

网页端「设置 → 数据管理」自带两项能力，整账号清理时优先用它：

- **导出所有历史对话**：下载 zip（含账号信息与全部会话），下载链接有效期 7 天
- **删除所有对话**：一次清空

DSX 的价值不在替代它们，而在「按链接精确处理 + 留档 + 审计 + 可脚本化」。

## 证据来源

- 批量删除脚本（鉴权头、删除端点、分页遍历）：`github.com/hyrious/deepseek-batch-delete.user.js`
- 批量删除（`credentials: include`、侧栏 DOM）：`greasyfork.org/scripts/565691`
- 会话一键删除（侧栏图标 / 快捷键）：`greasyfork.org/scripts/599842`
- DeepSeekExporter（接口优先拉全量、DOM 降级）：`fastnow.github.io/DeepSeekExporter.html`
- 端点与分页字段实测：`github.com/tukuexe/deepseek-backup`、`github.com/ImranR98/deepseek-chat-exporter`
- headers / PoW / 错误码：`github.com/3aKHP/deepseek-web-api`
