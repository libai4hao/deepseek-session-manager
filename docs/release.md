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

## 十一、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `@updateURL` 404 | Release 是 Draft，或资产名不是 `dsx.user.js` | 取消 Draft；资产改名 |
| 油猴装完版本仍旧 | Tampermonkey 缓存了旧版 | 脚本管理页点“检查更新”，或删掉重装 |
| 扩展加载报 manifest 错 | zip 里多套了一层目录 | 重打：`Compress-Archive dist\extension\*`，保持根目录 |
| 扩展 ID 变了 | 换了 pem 或没带 pem 打包 | 用同一把 pem；或接受新 ID 并重新授权站点 |
| `npm pack` 里没有 dist | 忘了 build | 先 `pnpm build`，再 `npm pack --dry-run` 确认 |
| 发布后 CLI 跑不起来 | 目标机 Node < 18 | 文档已标 `engines`，必要时提示升级 |
