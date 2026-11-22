# 打包与发布手册

面向维护者。目标：从一份干净的代码，稳定产出三种可分发形态，并以可回滚的方式发布到 GitHub / npm / 浏览器。

## 一、发布物与来源

| 发布物 | 文件 | 分发渠道 | 安装方式 |
|---|---|---|---|
| 油猴脚本 | `dist/dsx.user.js` | GitHub Release 资产 | Tampermonkey 点 URL 安装，靠 `@updateURL` 自动更新 |
| MV3 扩展 | `dist/dsx-<ver>-mv3.zip` | GitHub Release 资产 / 内部分享 | 解压后"加载已解压"；或 Chrome `--pack-extension` 出 crx |
| CLI | `dist/dsx-cli.mjs` + `deepseek-session-manager-<ver>.tgz` | GitHub Release 资产 / npm | `node dsx-cli.mjs`，或 `npm i -g` |
| 源码 | git tag | GitHub | `pnpm install && pnpm build` |

**`dist/` 永不入库**（`.gitignore` 已覆盖），因此所有构建产物只能由 Release 资产或 npm 承载；仓库里没有可直接下载的成品。

## 二、版本号：只有一处

版本号唯一来源是 `package.json` 的 `version`，构建时自动写进：

- `dist/dsx.user.js` 的 `@version`
- `dist/extension/manifest.json` 的 `version`

发版流程固定为：改 `package.json` → 构建校验 → 提交 → 打 tag → 发 Release。**不要**手工改 dist 里的版本，也不要让 tag 名与 version 不一致（`v0.2.0` ↔ `0.2.0`）。

## 三、前置检查

```powershell
node -v                 # >= 18，建议 22
pnpm -v
gh auth status          # 需要 repo 权限；发布 Release 用
git status --short      # 必须为空
```

Chrome 路径（打包校验用）：

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## 四、构建与验证

```powershell
cd D:\Project\my\vibe-work\dsx
pnpm install
pnpm typecheck          # tsc --noEmit，必须 0 错
pnpm test               # vitest，必须全绿
pnpm build              # 产出三类产物
```

构建后的硬性校验：

```powershell
# 1) 产物齐全
Get-ChildItem dist\dsx.user.js, dist\dsx-cli.mjs, dist\extension\manifest.json |
  Select-Object Name, Length

# 2) 油猴头完整（版本、更新地址都要在）
Get-Content dist\dsx.user.js -TotalCount 14 | Select-String '@(version|downloadURL|updateURL|match)'

# 3) MV3 里的 js 不能残留 UserScript 头
(Select-String -Path dist\extension\dsx.js -Pattern '==UserScript==' -SimpleMatch).Count   # 期望 0

# 4) 语法
node --check dist\dsx-cli.mjs
node --check dist\extension\dsx.js

# 5) manifest 真的被 Chrome 接受（最有效的一项）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --pack-extension="$PWD\dist\extension"
# 成功会在 dist 同级生成 extension.crx；失败会弹错误对话框
```

`extension.pem` 是签名私钥：**不入库、不外传、不丢**。丢了就只能换新扩展 ID。

## 五、打三个包

```powershell
# MV3（manifest 必须在压缩包根目录，不能套一层 extension/）
Compress-Archive -Path dist\extension\* -DestinationPath "dist\dsx-0.2.0-mv3.zip" -Force

# npm 包（先 build，tgz 才含 dist）
npm pack
# → deepseek-session-manager-0.2.0.tgz

# CLI 单文件分发不需要额外打包，直接给 dist/dsx-cli.mjs
```

资产命名必须固定，因为用户脚本头里的更新地址是写死的：

```
https://github.com/libai4hao/deepseek-session-manager/releases/latest/download/dsx.user.js
```

所以 Release 里油猴资产的**文件名只能是 `dsx.user.js`**，改名等于断掉所有已安装用户的自动更新。同理建议 CLI 资产保持 `dsx-cli.mjs`、MV3 包保持 `dsx-<ver>-mv3.zip`。

## 六、发 GitHub Release

```powershell
# 提交（若还有未提交改动）
git add -A
git commit -m "release: v0.2.0"
git push origin main

# 打 tag 并发布，资产一次挂上
gh release create v0.2.0 `
  dist/dsx.user.js `
  dist/dsx-cli.mjs `
  dist/dsx-0.2.0-mv3.zip `
  --title "DSX v0.2.0" `
  --notes "油猴/MV3/CLI 三形态；新增 --export-only、--resume、快照加密（scrypt + AES-256-GCM）、progress.json 账本。44 例单测通过。"
```

要点：

- `--notes` 写“用户能感知的变化”，不要贴 commit 列表；
- Release 不要勾 Draft，否则 `latest/download` 解析不到；
- 发完 `latest` 会自动指向这个 Release，`@updateURL` 立即生效。

## 七、发 npm（可选）

```powershell
pnpm build
npm pack --dry-run     # 先看清单：dist/docs/README/LICENSE，约 12 个文件
npm publish --access public
```

- 包名 `deepseek-session-manager`，`bin` 为 `dsx → dist/dsx-cli.mjs`；
- 发布前确认 tgz 里 `dist/` 存在（`files` 字段包含 `dist`，但 dist 不入库，必须先 build）；
- 撤销窗口只有 24 小时：`npm unpublish deepseek-session-manager@0.2.0`。

## 八、发布后验收（四项，缺一不可）

```powershell
# 1) 资产可达（HTTP 200，且大小非 0）
curl.exe -sI https://github.com/libai4hao/deepseek-session-manager/releases/latest/download/dsx.user.js |
  Select-String 'HTTP/|content-length'

# 2) 下载回来的脚本版本号正确
curl.exe -sL https://github.com/libai4hao/deepseek-session-manager/releases/latest/download/dsx.user.js |
  Select-String '@version'

# 3) Release 资产清单
gh release view v0.2.0 --json tagName,isDraft,assets

# 4) 真机冒烟：Tampermonkey 用 URL 安装 → 打开 chat.deepseek.com 见悬浮球；
#    或 chrome://extensions 加载 dist\extension → 刷新页面见悬浮球
```

第 4 项必须做。前 3 项只能证明“文件传上去了”，证明不了“脚本在新环境能跑”。

## 九、回滚

```powershell
# 撤 Release（保留 tag 时可只删 Release）
gh release delete v0.2.0 --yes

# 连 tag 一起撤
git push origin :refs/tags/v0.2.0
git tag -d v0.2.0

# npm
npm unpublish deepseek-session-manager@0.2.0
```

回滚后旧的 `latest/download` 会指向更早的 Release，已安装用户的自动更新会“降级”回旧版——这是 `@updateURL` 的固有行为，必要时在 Release notes 里说明。

## 十、安全清单（发版前逐条过）

- [ ] `git status` 无 `auth.json` / `storage-state*.json` / `*.pem` / `dsx-out/`
- [ ] 仓库与 Release 资产里没有本机绝对路径（`C:\Users\...`、`D:\Project\...`）
- [ ] 没有任何 token / cookie 出现在代码、报告、Release notes 中
- [ ] `extension.pem` 未提交；本地单独保管
- [ ] `DSX_SNAPSHOT_PASSWORD` 只存在于运行环境，不在文档示例里写真实口令
- [ ] 公开仓库的 Release notes 不包含账号信息、会话标题、会话数量

## 十一、发布为浏览器脚本（Greasy Fork / OpenUserJS）

目标：让用户不用碰命令行，点一次链接就能装。

| 渠道 | 是否需要账号 | 更新方式 | 建议用途 |
|---|---|---|---|
| GitHub Release 资产 | 仓库维护者 | `@updateURL` 自动检查 | 自用、内部分享、给已有用户兜底 |
| Greasy Fork | 需要（免费） | 在站点更新脚本页，站点负责分发 | **公开分发的首选**，能被搜到 |
| OpenUserJS | 需要（免费） | 同上 | 补充渠道，流量较小 |

### 11.1 发布前体检

```powershell
pnpm build
Get-Content dist\dsx.user.js -TotalCount 18
```

必须全部满足：

- `@name` / `@description` / `@version` / `@license MIT` / `@match` 齐全
- `@grant none`（本脚本只用页面 API，声明 none 可以避免多余权限提示）
- `@noframes`（避免在 iframe 里重复挂面板）
- `@homepageURL` / `@supportURL` 指向仓库与 issues
- 文件里没有 token、cookie、本机绝对路径
- `node --check dist\dsx.user.js` 通过（IIFE，可被 Node 解析）

### 11.2 Greasy Fork 上架步骤

1. 注册并登录 Greasy Fork（用 GitHub 账号登录最省事）
2. 右上角用户名 → **Post a new script**
3. 语言选“中文”，粘贴 `dist/dsx.user.js` 全文（或先填 GitHub Release 直链让站点抓取；粘贴更可控）
4. 填元数据（见 11.3 的现成文案），许可证选 **MIT**
5. 截图：悬浮球 + 面板“待删/归属校验通过”那一屏，1～2 张即可
6. 提交后进入审核/待发布状态，页面出现 `greasyfork.org/scripts/<id>` 链接
7. 用无痕窗口打开该链接 → 点“安装此脚本”→ 确认 Tampermonkey 装上 → 打开 `chat.deepseek.com` 看悬浮球

### 11.3 上架文案（可直接复制）

```
名称：DSX - DeepSeek 会话管家
英文名：DSX - DeepSeek Session Manager
简介：粘贴 DeepSeek 会话链接，校验归属后快照并删除；默认预演，全程可审计。
分类：实用工具 / 生产力
标签：deepseek, chat, session, backup, audit, privacy
许可证：MIT
源码：https://github.com/libai4hao/deepseek-session-manager
支持：https://github.com/libai4hao/deepseek-session-manager/issues
```

详细描述：

```
把一条会话链接变成可校验、可留档、可审计的删除动作。

· 只对本人账号生效：必须在本账号会话列表命中，未命中直接拒绝，不盲删
· 默认预演：不调删除接口、不写快照；确认后才执行
· 删除前快照：整段对话先落盘，快照失败即中止
· 置顶保护、串行限速、失败重试、删后复核
· 每次操作留一行审计，凭证不落盘

另有命令行版（批量、断点续跑、加密快照），见仓库 README。
非官方工具，调用网页端内部接口，可能随前端改版失效。
```

### 11.4 更新与版本同步

Greasy Fork 会用自己托管的副本分发，并在安装时把 `@downloadURL`/`@updateURL` 指向站点自身——所以：

- **从 Greasy Fork 安装的用户，只会跟着 Greasy Fork 的脚本页更新**；
- **从 GitHub Release 安装的用户，跟着 `releases/latest` 更新**；
- 两个渠道各自独立，发版时必须同时更新，且版本号一致，否则同一版本号不会触发更新。

标准发版动作：改 `package.json` → `pnpm build` → 提交打 tag → `gh release create` 上传资产 → Greasy Fork 脚本页“更新脚本”粘贴新文件 → 无痕窗口验证一次。

> Greasy Fork 是否提供“从 GitHub 自动同步”的入口以其当前站点 UI 为准；没有的话就手动粘贴，别假设会自动同步。

### 11.5 公开分发的风险提示

- 脚本调用的是网页端内部接口，公开传播会放大被平台注意的概率；描述里不要写“批量删除任意会话”“绕过限制”这类措辞。
- 删除不可撤销，**必须在描述首屏说清**，并保留“仅管理本人数据”的限定。
- 若收到站点下架通知，先撤 Greasy Fork 页面，再评估是否保留 GitHub 分发。

## 十二、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `@updateURL` 404 | Release 是 Draft，或资产名不是 `dsx.user.js` | 取消 Draft；资产改名 |
| 油猴装完版本仍旧 | Tampermonkey 缓存了旧版 | 脚本管理页点“检查更新”，或删掉重装 |
| 扩展加载报 manifest 错 | zip 里多套了一层目录 | 重打：`Compress-Archive dist\extension\*`，保持根目录 |
| 扩展 ID 变了 | 换了 pem 或没带 pem 打包 | 用同一把 pem；或接受新 ID 并重新授权站点 |
| `npm pack` 里没有 dist | 忘了 build | 先 `pnpm build`，再 `npm pack --dry-run` 确认 |
| 发布后 CLI 跑不起来 | 目标机 Node < 18 | 文档已标 `engines`，必要时提示升级 |
