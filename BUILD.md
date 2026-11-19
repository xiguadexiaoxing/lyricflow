# LyricFlow 源码构建说明

这个目录是 LyricFlow 的**完整可编辑源码**，不包含已经打包好的 exe/zip、Electron 构建产物和运行时缓存。

## 目录说明

| 路径 | 内容 |
| --- | --- |
| `server.js` | 主服务端（HTTP / HTTPS / WebSocket / 歌词源 / SMTC 桥） |
| `index.html`、`gui.html` | 网页歌词页与控制台页面 |
| `main.js` | Electron 旧入口（现在主要使用原生控制台，可选） |
| `console.js` | 早期 Node 控制台版本，保留作参考 |
| `assets/icon.html` | 图标 HTML/CSS 设计源 |
| `assets/lyricflow.ico`、`lyricflow-256.png` | 已导出的图标 |
| `tools/native-console.cs` | 原生 C# WinForms 控制台（无 Electron / WebView2） |
| `tools/installer.cs` | 安装器与卸载器源码 |
| `tools/app.manifest` | 控制台清单（`highestAvailable` + Common Controls） |
| `tools/installer.manifest` | 安装器/卸载器清单（`requireAdministrator`） |
| `tools/make_icon.py` | 用 Pillow 导出 PNG/ICO |
| `tools/smoke-test.js` | 服务端 HTTP/WS 冒烟测试 |
| `vendor/opencc-t2cn.js` | 简繁转换（OpenCC-js t2cn） |
| `node_modules/ws`、`node-forge` | 服务端运行依赖（已附带） |

## 环境要求

- Windows 10/11 x64
- Node.js 18+（构建安装包时需要 `node.exe`，源码目录不附带这个二进制）
- .NET Framework 4.8（使用系统自带的 `csc.exe` 编译 C#）
- Python 3 + Pillow（仅在重新生成图标时需要）

## 1. 直接运行服务端

```powershell
cd LyricFlow-Source
node server.js
```

服务默认监听 3721 端口，启动后自动打开 `http://localhost:3721/gui`。  
只启动服务、不打开浏览器：

```powershell
$env:LF_NO_OPEN='1'
node server.js
```

测试：

```powershell
$env:PORT='4890'
node tools/smoke-test.js
```

安装完整依赖（包含 Electron，仅开发 GUI 时需要）：

```powershell
npm install
```

## 2. 重新生成图标

```powershell
python tools/make_icon.py
```

读取 `assets/lyricflow-256.png` 和 `assets/lyricflow.ico` 的生成逻辑，输出 16–256px 多尺寸 ICO。

## 3. 编译原生控制台

```powershell
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$web = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'

New-Item -ItemType Directory -Force build

& $csc /nologo /platform:x64 /target:winexe /codepage:65001 `
  /win32icon:'assets\lyricflow.ico' `
  /win32manifest:'tools\app.manifest' `
  /out:'build\LyricFlow-Server.exe' `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$web" `
  'tools\native-console.cs'
```

控制台会：
- 启动/停止内置 Node 服务
- 显示当前歌曲、歌词、日志、播放器检测
- 设置窗口图标、任务栏图标和系统托盘图标

## 4. 组装服务端目录

新建一个打包目录（例如 `build\package`），放入：

```text
LyricFlow-Server.exe      ← 上一步编译
Uninstall.exe             ← 见第 5 步
node.exe                  ← 从 Node.js x64 安装目录复制
server.js
index.html
gui.html
vendor\
node_modules\ws
node_modules\node-forge
LyricFlow.ico
README.txt
THIRD-PARTY.txt
```

`node.exe` 不放进源码目录，避免把 100MB 二进制提交进源码。

## 5. 编译卸载器与安装器

### 5.1 先编译 Uninstall.exe

```powershell
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$zip = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.dll'
$zipfs = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.FileSystem.dll'

& $csc /nologo /platform:x64 /target:winexe /codepage:65001 `
  /define:UNINSTALLER `
  /win32icon:'assets\lyricflow.ico' `
  /win32manifest:'tools\installer.manifest' `
  /out:'build\package\Uninstall.exe' `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "/r:$zip" "/r:$zipfs" `
  'tools\installer.cs'
```

### 5.2 打包 payload.zip

在 `build\package` 目录内，把**目录内容**（不是外层文件夹）压成 `payload.zip`：

```powershell
cd build\package
& 'C:\Program Files\7-Zip\7z.exe' a -tzip -mx=5 ..\payload.zip '*'
```

### 5.3 编译 Setup

```powershell
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$zip = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.dll'
$zipfs = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.IO.Compression.FileSystem.dll'

& $csc /nologo /platform:x64 /target:winexe /codepage:65001 `
  /define:SETUP `
  /win32icon:'assets\lyricflow.ico' `
  /win32manifest:'tools\installer.manifest' `
  /resource:'build\payload.zip,LyricFlow.Payload.zip' `
  /out:'build\LyricFlow-Setup-1.1.0.exe' `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  "/r:$zip" "/r:$zipfs" `
  'tools\installer.cs'
```

安装器会把 payload 解压到 `Program Files\LyricFlow` 或用户指定目录，并写入：

```text
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LyricFlow
```

包含 `DisplayName`、`DisplayVersion`、`Publisher`、`InstallLocation`、`DisplayIcon`、`UninstallString` 等值，因此在「设置 → 应用 → 已安装的应用」中可见并可直接卸载。

## 6. 版本号与名称

- 应用版本：`tools/installer.cs` 中的 `AppVersion`
- 卸载注册表键：`UninstallKey`
- 安装目录默认值：`DefaultInstallDir`
- 服务端端口：`server.js` 的 `PORT`

修改版本号后重新编译安装器即可。