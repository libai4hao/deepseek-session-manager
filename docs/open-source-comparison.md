# 开源项目对照

筛选标准：能在 `chat.deepseek.com` 上直接验证接口或 UI 范式，且许可清晰。**没有 fork 任何项目**，只拆成"接口层 / UI 层 / 快照层"参考，代码全部重写；MIT 项目仅在 README 或本文标注来源。

| 项目 | 形态 | 做了什么 | 许可 | 本项目的取用 | 没取的部分 |
|---|---|---|---|---|---|
| `hyrious/deepseek-batch-delete.user.js` | 油猴单文件 | Ctrl+X 删当前、Ctrl+Shift+X 删全部；分页遍历、`deleteChatSessions(ids)` | 未标注 | 删除端点与鉴权头的写法、分页 `seen` 去重思路 | 快捷键式无确认交互、直接跳转刷新 |
| `landexie/DeepSeekBatchDelete`（Greasy Fork 565691） | 油猴 | 侧栏 checkbox 批量、`credentials: include` 删除、删当前后自动新建 | MIT | 侧栏 DOM 结构（`.ds-scroll-area`、日期分组、`<a>` 即会话） | 全选/反选 UI、`display:none` 伪删除 |
| Greasy Fork 599842「会话一键删除」 | 油猴 | 每条会话注入删除图标、Ctrl+D 删当前、菜单可配 | MIT | "在列表上直接给出删除入口"的交互范式 | 快捷键默认值、无审计 |
| `FastNow/UserJs` → DeepSeekExporter | 油猴 | 接口优先拉全量历史（突破虚拟列表）、DOM 降级、六格式导出、诊断面板 | MIT | 快照的数据形状（消息片段）与"接口优先、DOM 兜底"原则 | 六种导出格式、悬浮球 UI 细节 |
| `tukuexe/deepseek-backup` | 文档型仓库 | `fetch_page` / `history_messages` 的真实响应字段 | 参考 | 字段名与分页链条的事实核对 | — |
| `ImranR98/deepseek-chat-exporter` | Python + Selenium | `before_seq_id` 翻页、按 `updated_at` 增量缓存 | 参考 | 增量/分页策略 | Selenium 驱动整条链路 |
| DeepSeek Conversation Search (DSCS) | 油猴 | IndexedDB 会话索引、请求队列、增量同步 | 参考 | "本地索引 + 队列"的架构方向（见 roadmap M3） | 搜索 UI |
| `3aKHP/deepseek-web-api` | Node 服务 | PoW 求解、headers 组合、错误码字典 | 参考 | 错误码分类、确认 PoW 只作用于 completion 系 | PoW 实现（本项目不需要） |
| `vite-plugin-monkey` / `bunblemonkey` | 构建工具 | TS 多文件 → 单文件 user.js、dev 热更 | MIT | 备选构建方案（最终未采用，理由见技术选型） | — |
| Playwright `storageState` / `browser-cookie-jar` | 工具/插件 | 登录态序列化与复用 | MIT / 参考 | storageState 的 JSON 结构（本项目直接读，不依赖运行时） | 浏览器自动化执行 |

## 对照结论

1. **"删会话"这件事已被验证可行**：三个独立脚本都用同一套 Bearer + `chat_session/delete`，说明接口稳定度至少跨了 8 个月。
2. **没人做"链接驱动 + 归属校验 + 审计"**：现有脚本都是"在页面里全选/快捷键"，缺少"外部给清单、删前确认标题、删后留证据"的闭环——这是 DSX 的位置。
3. **坑是共通的**：参数形态改版、分页方言、React 节点不能硬删。三个项目各自踩过，这里统一做成运行时探测。

## 许可注意

- 参考的脚本多为 MIT 或未标注。本项目**未复制其源码**，只依据公开行为与接口事实重写实现；未标注许可的项目尤其只做逻辑参考。
- 本项目自身为 MIT，引用他人项目时在文档中保留名称与链接。
