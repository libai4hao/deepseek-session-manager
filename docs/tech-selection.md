# 技术选型

## 一、形态：油猴 + CLI + MV3 壳

评分 1–5，5 最好。评分针对"个人自用、几十条量级、要能审计"这个具体场景，不代表通用优劣。

| 维度 | 油猴脚本 | 浏览器插件（MV3） | 本地 CLI / Playwright |
|---|---|---|---|
| 开发成本（相对） | 1 | 2.5–3 | 2 |
| 分发成本 | 5（单文件拖入） | 3（加载未打包扩展） | 2（要 Node 环境） |
| Token 获取 | 5（同源直接读 localStorage） | 4 | 3（storageState / 环境变量） |
| 批量能力 | 2（关页即断、无后台） | 4（service worker 队列） | 5（无人值守、可断点） |
| UI 空间 | 2（悬浮面板） | 4（侧栏/独立页） | 2（命令行输出） |
| 抗前端改版 | 3（判定走接口，UI 只展示） | 3 | 4（几乎不碰 DOM） |
| 登录态维护 | 5（跟随浏览器） | 5 | 2（Cookie/Token 会过期） |
| 风控暴露 | 4（与人工同指纹） | 4 | 2（无头指纹 + 高频最易被识别） |

**结论**：油猴负责"单条、要人眼看标题"的交互；CLI 负责"批量、要留档"的执行。插件最初判定"只在多账号/常驻后台/团队共用时才值得投入"，2026-11 补了 MV3 壳后发现**壳本身零成本**——核心不依赖 `GM_*`，去掉 UserScript 头即可当 content script 跑，于是补上它解决"刷新即失效"。多账号与后台队列仍然不做。

## 二、CLI 不引入 Playwright 运行时

`--state` 读的是 Playwright 导出的 `storageState` JSON，而它本身就是一个普通 JSON：`cookies[]` 提供会话 cookie，`origins[].localStorage` 里就有 `userToken`。因此 CLI 只需要 `fetch`（Node 18+ 内置）即可完成全部请求：

- 少一个重量级依赖（Playwright + 浏览器二进制约数百 MB）
- 少一层"无头浏览器指纹"，风控暴露面更小
- 登录态生成仍交给 Playwright 一条命令：`npx playwright open --save-storage=auth.json`

这是"用 Playwright 的能力，不用它的运行时"——把浏览器只当作**登录态生成器**。

## 三、构建链：esbuild 而非 vite-plugin-monkey

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| `vite-plugin-monkey` | 官方油猴模板、HMR、GM API 自动导入、社区成熟 | 多一层插件兼容面（vite 版本、插件 peer 依赖）；本项目不需要 HMR 与 GM API | 备选 |
| **esbuild 直出** | 单文件 IIFE、毫秒级构建、`banner` 直接注入 UserScript 头、零插件风险 | 无 HMR；改动需重新构建安装 | **采用** |

本项目的油猴端只有一个入口、不使用任何 `GM_*` API（同源 `fetch` + localStorage 足够），HMR 收益接近于零，稳定性优先。

CLI 同样是 esbuild 打包为单文件 ESM（`dist/dsx-cli.mjs`），banner 注入 shebang。

## 四、语言与测试

- **TypeScript strict**：`noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch` 全开。接口字段全部来自未文档化响应，`unknown` + 显式收窄比 `any` 安全得多。
- **vitest**：core 是纯逻辑，可直接对 `Transport` 打桩。58 个用例覆盖解析边界、归属校验、dry-run、形态切换、鉴权中止、5xx 重试、分页完整性、请求超时、storageState 解析、断点续跑账号隔离、快照加解密与参数守卫——这些正是"删错/删不动"的高发点。
- **不引 UI 框架**：面板用 Shadow DOM + 模板字符串，避免与站点样式互相污染，也避免为 300 行 UI 引入 React 运行时。代价是手写渲染函数，可接受。

## 五、依赖清单

运行时：零依赖（浏览器 `fetch` / Node 内置 `fetch`、`crypto.subtle`）。
开发期：`typescript`、`esbuild`、`vitest`、`@types/node`。

## 六、被否掉的方案

| 方案 | 否掉原因 |
|---|---|
| Selenium / Playwright 点按钮删除 | 慢、脆弱、与风控正面冲突；接口已够用 |
| 直接 `remove()` 侧栏节点做"删除" | 只是本地隐藏，服务端数据仍在，且破坏前端状态 |
| 并发删除提速 | 破坏性写操作，收益几秒、风险翻倍 |
| 全量导入 IndexedDB 做本地搜索 | v0.1 不需要；见 roadmap M3 |
| 消息级删除 | 网页端没有稳定的消息删除语义，超出"整会话删除"的需求边界 |
