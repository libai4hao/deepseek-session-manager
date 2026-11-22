# 开发计划与验收

## 阶段

| 阶段 | 目标 | 产出 | 状态 |
|---|---|---|---|
| M0 | 打掉四个不确定点（删除 body 形态、分页方言、count 上限、删后同步） | 控制台 dry-run 脚本 + 一份实测记录 | **已完成**：2026-11-22 真机删除成功（71ms），单数体可用、未出现 422、无 PoW |
| M1 | 单条链接：解析 → 归属校验 → 预览 → 删除 | 油猴面板 | **已完成** |
| M2 | 批量 + 快照 + 限速重试 + 审计 | CLI + 油猴批量 | **已完成**（审计为 JSONL/本地存储） |
| M3 | 本地索引与断点续跑 | `progress.json`、`--resume` | **已完成**（含快照复用；未做 IndexedDB） |
| M4 | 插件化（后台队列、多账号） | MV3 包 | **已完成 MV3 壳**（单账号前台模式）；后台队列/多账号未做 |

## 当前范围（v0.2.1）

已实现：

- 链接解析与拒绝分类（session / share / foreign / bad）
- 归属校验（列表命中 + 置顶保护），未命中不删
- 删除前快照（全文 JSON；仅 `--apply` 生成，失败中止）
- 串行删除：500ms 间隔、20 条/批、批间 10s、重试 2 次
- 删除参数形态自动探测（422 → 数组体）
- 鉴权失效即中止整批
- 删后复核（重拉列表）
- 报告：`report.json` / `report.md` / `audit.jsonl`
- 油猴面板：预演默认开、>5 条输入 `DELETE` 确认、审计下载
- 仅导出模式 `--export-only`（与 `--apply` 互斥，永不调删除接口）
- 断点续跑 `--resume`：跳过已完成、复用已有快照，账本在 `progress.json`
- 快照加密 `--snapshot-encrypt`：scrypt + AES-256-GCM，口令只走环境变量
- MV3 壳：`dist/extension/`，与油猴共用同一份产物

未实现（明确留白）：

- 侧栏逐条删除图标；从快照重建会话；多账号与后台队列；快照口令找回

## 验收标准

**功能**

- 链接样本 11 类（正常/带 query/hash/尾斜杠/share/外站/仿冒域名/裸 uuid/带标点/空行/多行混排）分类 100% 正确
- 非本账号或已删除的 id 拦截率 100%
- 单条删除成功率 ≥95%，20 条批量 ≥90%（正常网络）
- 同一 id 重复执行结果为 `skipped`/无副作用，不产生二次破坏
- `--export-only` 运行后 `audit.jsonl` 里不得出现 `event: delete`，服务端会话数不减
- `--resume` 二次运行不得重复拉取已快照会话（日志出现"复用"），且 `progress.json` 中 `deleted` 项不再进入队列
- 加密快照 `decryptSnapshot` 往返一致；错误口令必须抛错，不得返回半截明文

**安全**

- 快照缺失时不执行删除（除非 `--no-snapshot`）
- 批量 >5 无 `--yes` 拒绝执行；>50 直接拒绝
- `--export-only` 与 `--apply` 互斥，同时给出即退出 2
- 加密口令只从 `DSX_SNAPSHOT_PASSWORD` 读，不出现在 argv、报告与审计中
- 全目录检索无 token / cookie 明文；`auth.json`、`dsx-out/` 均在 `.gitignore`

**可观测**

- 每条操作在 `audit.jsonl` 有且仅有一行，字段齐全（ts/event/sessionId/status/attempts/ms）
- `progress.json` 损坏时按无账本处理，不中断运行
- 退出码语义正确：0 / 2 / 3

**工程**

- `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿
- 产物：`dist/dsx.user.js`、`dist/dsx-cli.mjs`、`dist/extension/`（manifest + 去头的 content script）

## 下一步优先级

1. **侧栏逐条删除图标**：列表项直接给入口，省掉复制粘贴；必须"点两次"（第一次变红、第二次才删），参考 Greasy Fork 599842 的交互
2. **从快照重建会话**：代价高（逐条 completion + PoW、顺序难还原），先评估是否值得
3. **多账号 / 后台队列**：MV3 `service_worker` + 账号隔离；当前单账号前台模式够用
4. **MV3 分发升级**：油猴自动更新已通过 Release `latest` 落地；MV3 壳仍是手动“重新加载”，若要走商店需 `update_url` 与审核

## 待决策

- 快照默认档位：全文（当前）还是元数据摘要？全文更安全，占用更大
- 单次批量上限：50 条是否合适
- 加密是否改为可配置默认（当前必须显式 `--snapshot-encrypt`）
- 是否把 Greasy Fork 作为唯一公开入口，GitHub 只留给自用
