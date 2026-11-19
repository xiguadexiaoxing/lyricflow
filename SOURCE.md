# LyricFlow 源码副本

这个目录是从 `D:\lyricflow-main` 整理出的**完整可编辑源码**，放在独立文件夹中，方便查看、修改或另存备份。

## 已包含

- 服务端：`server.js`
- 网页：`index.html`、`gui.html`
- Electron 旧入口：`main.js`、`console.js`
- 原生控制台源码：`tools/native-console.cs`
- 安装器/卸载器源码：`tools/installer.cs`
- 清单：`tools/app.manifest`、`tools/installer.manifest`
- 图标设计源与导出：`assets/icon.html`、`lyricflow.ico`、`lyricflow-256.png`
- 构建/测试脚本：`tools/make_icon.py`、`tools/smoke-test.js`、`tools/electron-smoke.js`
- 服务端运行依赖：`node_modules/ws`、`node_modules/node-forge`
- 第三方说明：`THIRD-PARTY.txt`、`vendor/OPENCC-LICENSE.txt`

## 未包含（构建产物/缓存）

- `dist\`、`dist-server\`、`dist-installer\`
- `build-electron-dist\`、`build-installer\`、`portable\`
- `node_modules` 中的 Electron / electron-builder 等开发依赖
- `node.exe`（100MB 二进制）
- `.lyricflow-runtime\`、日志、证书、`players.ini`、`manual.ini`

## 构建

见 [BUILD.md](BUILD.md)。

## 说明

`README.md` 是项目原始说明，里面提到的 `dist-installer/...`、`dist-server/...` 是打包产物路径，不在本源码副本中；需要时按 `BUILD.md` 重新生成。