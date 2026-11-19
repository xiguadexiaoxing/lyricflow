# LyricFlow

把桌面上正在播放的歌曲变成实时滚动的同步歌词，手机、平板、另一台电脑打开网页就能看。

- 自动识别播放器（Windows 系统媒体控制 SMTC 优先，窗口标题兜底；识别不到时可在原生控制台里手动选择播放器窗口）
- 歌词依次尝试：本地 `.lrc` 目录 → [LRCLIB](https://lrclib.net) → 网易云音乐
- 自动滚动、逐行高亮、手动偏移校准、一键复原歌词位置（`R` 或控制栏「↺ 复原」）、简繁切换、纯黑模式
- 网页端可直接搜索 / 粘贴 / 上传歌词，支持手机远程控制上一曲 / 播放暂停 / 下一曲
- 同时提供 HTTP 与 HTTPS（自签名）入口，HTTPS 下手机可读电量

## 运行

先安装依赖（只需一次）：

```bash
npm install
```

然后任选一种方式：

- **双击 `start-portable.bat`**：直接运行 `portable\LyricFlow\LyricFlow.exe`。这个目录是用旧版可执行文件里那套已验证可用的 Electron 运行时 + 当前源码重新组装的，兼容性最好，不依赖 `npm start` 和网络。
- **双击 `start-web.bat`**：只启动网页服务，不需要 Electron。服务就绪后会自动打开控制台；歌词页 <http://localhost:3721>，控制台 <http://localhost:3721/gui>。设置 `LF_NO_OPEN=1` 可关闭自动打开。
- **双击 `start-gui.bat`**：用 `node_modules` 里的 Electron 43 启动桌面版。
- 命令行等价写法：`node server.js` 或 `npm start`。

> 如果 Electron 在某些机器/终端上被拦截，直接用浏览器控制台即可：先运行 `start-web.bat`，再双击 `open-console.bat`（或访问 <http://localhost:3721/gui>）。仪表盘、播放控制、日志、清缓存、外网开关都在里面；其中控制类操作仅本机可用。

> 以上脚本都需要在 **Windows 资源管理器里双击**。如果从自动化工具/沙箱的终端里运行，Electron 可能无法创建窗口，表现为一闪而过（退出码 `0x80000003` / `0xC0000005`）。启动过程会写入 `%TEMP%\lyricflow-main.log`：有 `boot` 说明应用已开始执行，没有则说明 Electron 被宿主环境挡在启动之前。

打包 Windows 便携版：

```bash
npm run dist
```

`npm run dist` 会下载 Electron 运行时和 NSIS；在离线/受限网络里可以复用本地运行时只构建目录版，再自行压缩：

```powershell
electron-builder --win --dir --config.electronDist=D:\lyricflow-main\build-electron-dist --config.npmRebuild=false
```

本次已生成：

- `dist-installer/LyricFlow-Setup-1.1.0-r5.exe`：**安装程序**（需管理员权限）。安装位置可修改（直接输入或点「浏览...」），默认 `C:\Program Files\LyricFlow`；无论选择哪个目录，都会自动创建独立的 `LyricFlow` 子文件夹（若路径已以 `LyricFlow` 结尾则直接使用），避免文件散落。不会自动改名、不会弹“已有文件”提示，也不会在校验阶段创建目录。Windows 文件名不区分大小写，若已有同名不同大小写的目录，安装时会把该目录重命名为你指定的大小写；若该目录属于其他程序，会提示换一个文件夹名。启动器已设置窗口图标、任务栏图标和系统托盘图标。快捷方式、卸载登记信息和 `Uninstall.exe` 都会跟随最终安装目录。
- `dist-server/LyricFlow-Server-1.1.0-admin10.zip`：**便携版**（不含 Electron/WebView2），解压后双击 `LyricFlow-Server.exe`。
- `assets/icon.html` + `assets/lyricflow-256.png` + `assets/lyricflow.ico`：图标的 HTML/CSS 设计源与导出的多尺寸图标；启动器、安装器、卸载器均已嵌入。

图标设计使用 HTML/CSS 绘制（琥珀色渐变圆角方块 + 音符），导出为 16–256px 的 ICO。

> 安装包与 exe 均未做代码签名，首次运行 SmartScreen 可能提示，选择「更多信息 → 仍要运行」。单文件安装包由本仓库自带的 C# 安装器生成，卸载信息写入 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LyricFlow`。

> 构建产物未做代码签名，首次运行 SmartScreen 可能提示，选择「更多信息 → 仍要运行」。单文件安装包需要 NSIS，当前环境无法联网下载；网络可用时直接 `npm run dist` 即可生成 `dist/LyricFlow.exe`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3721` | HTTP 端口 |
| `HTTPS_PORT` | `PORT + 1` | HTTPS 端口 |
| `MUSIC_DIR` | 空 | 扫描本地 `.lrc` 的目录（最多 5 层） |
| `LF_HTTPS` | `1` | 设为 `0` 关闭 HTTPS 监听 |
| `LF_NO_BRIDGE` | `0` | 设为 `1` 关闭播放器检测（只做网页/歌词服务） |
| `LF_NO_OPEN` | `0` | 设为 `1` 启动后不自动打开控制台 |
| `LF_PLAYERS` | 空 | 额外播放器进程名，逗号分隔（补充内置名单） |
| `LF_RUNTIME_DIR` | 自动选择 | 存放桥脚本、证书与日志的可写目录 |
| `LF_LOG_FILE` | 空 | 额外把日志写入该文件 |
| `LF_BRIDGE_FILE` | `0` | 设为 `1` 强制播放器桥走文件通道（管道被限制的环境用） |
| `LF_NO_LISTEN` | `0` | 设为 `1` 只加载模块不监听（写测试用） |

PowerShell 示例：

```powershell
$env:MUSIC_DIR = 'D:\Music'
$env:PORT = '3721'
node server.js
```

本地 `.lrc` 文件名建议使用 `歌手 - 歌名.lrc`；也接受只有歌名的文件。

## 页面

- `/` 歌词显示页（手机 / 电视 / 副屏都适用）。顶栏的「歌词 / 控制台」可直接在同页切换，快捷键 `C`；切到控制台不会打断播放。
- `/gui` 独立控制台：当前歌曲与进度、播放/暂停/切歌、歌词预览、服务器状态、实时日志、清缓存、外网开关、访问地址复制。标题栏「歌词页」可切回歌词页。查看类功能局域网可用，**控制类操作仅本机**。
- `/api/status` 运行状态 JSON
- `/api/lyrics` 当前歌词 JSON
- `/api/logs?limit=100` 最近日志
- `/api/key?key=toggle|next|prev` 媒体键（仅本机）
- `/api/ext?val=0|1` 外网访问开关（仅本机）
- `/api/clear-cache` 清空歌词缓存（仅本机）
- `/api/shutdown` 停止服务（仅本机）

默认仅允许本机与局域网访问；外网访问需要手动开启。修改类接口（按键、关服、开关外网、清缓存）只接受本机请求，并校验来源页，避免被其它网页跨站调用。

## 目录

```
server.js         HTTP/HTTPS/WebSocket 服务、播放器桥、歌词抓取与缓存
index.html        歌词显示页（无构建，单文件）
gui.html          Electron 控制台（单文件）
main.js           Electron 主进程
console.js        旧版 PowerShell 控制台（可选，未打包）
vendor/           简繁转换组件（OpenCC t2cn，离线）
tools/smoke-test.js 对运行中的实例做端到端冒烟测试
```

## 本次优化

性能与稳定性：

- 合并「播放状态轮询」和「窗口标题桥」为**单个** PowerShell 进程，SMTC 一次拿到标题、歌手、播放状态、进度与总时长；原来的实现会启动两个常驻脚本，且启动代码重复了两遍，进程退出后还可能残留。
- 播放器桥退出采用指数退避重启，并有 20 秒心跳看门狗；桥挂掉会立刻回到「未连接」，不会再把上一首歌当成正在播放。
- 播放器桥在管道被禁止的环境（受限终端、服务模式）会自动切换到「PowerShell 写临时文件 + Node 轮询」的文件通道，不会再直接显示未连接。
- 空闲时不再跑 60fps 的歌词高亮循环：只有收到进度消息或调整偏移时才重算，并按窗口刷新受影响的歌词行。
- 歌词缓存加上 LRU 上限与空结果过期时间；同一首歌的并发请求会被合并。
- 本地 `.lrc` 索引改为异步扫描，音乐目录很大时也不会卡住事件循环。
- 媒体键改为常驻小助手进程，按键响应不再每次启动一个 PowerShell。
- HTTPS 证书异步生成并缓存到临时目录，第二次启动直接复用；不再阻塞启动。
- HTTP 响应支持 gzip，状态接口只发送必要字段。

正确性：

- 修复「简/繁」按钮：内置 OpenCC 转换组件（`vendor/opencc-t2cn.js`，离线可用），切换时保留原歌词不再被覆盖。
- 正确解析 `[mm:ss.xx]`、`[mm:ss:xx]`、一行多时间戳、`[offset:...]` 与 `ti/ar` 元数据。
- 进度条使用真实总时长（SMTC）而不是「最后一行歌词 + 15 秒」。
- 修复 Electron 控制台跨域读取失败（`file://` 打开时状态一直显示「服务器未响应」）、重复声明的变量/函数、嵌套卡片导致的布局错误。
- 修复窗口关闭后 PowerShell 子进程残留；`/api/shutdown`、`SIGINT` 都会清理子进程与临时脚本。

界面：

- 全新视觉：玻璃质感浮动顶栏 / 底部控制坞、渐变强调色、更清晰的层级和移动端布局，歌词高亮改为渐变文字。
- 歌词页内置控制台视图：顶栏「歌词 / 控制台」同页无刷新切换，快捷键 `C` 切换、`Esc` 返回；独立 `/gui` 与控制台视图可通过「独立打开 / 返回歌词 / 歌词页」互相跳转。

安全：

- 关闭、按键、清缓存、外网开关等接口仅限本机，并校验 `Origin` / `Referer`。
- WebSocket 限制单条消息 1MB，搜索请求有节流。
- 修复 `main.js` 启动探测可能重复回调的问题。

## 测试

```powershell
$env:PORT = '4722'
$env:LF_NO_BRIDGE = '1'
$env:LF_HTTPS = '0'
node server.js
```

另开一个终端：

```powershell
$env:PORT = '4722'
node tools/smoke-test.js
```

## 常见问题

- **端口被占用**：说明已经有一个 LyricFlow 在运行，先退出它，或用 `PORT=3723 node server.js`。
- **HTTPS 提示证书不安全**：自签名证书，首次访问选择「继续前往」即可。
- **检测不到播放器**：先在播放器里确认歌曲在播放；Windows 10 1809 以下没有 SMTC，只能依赖窗口标题，建议使用支持 SMTC 的播放器。
- **手机打不开**：确认在同一局域网、系统防火墙放行该端口；需要外网时在控制台开启「外网」。
- **换端口后控制台仍连 3721**：Electron 控制台会跟随 `PORT` 环境变量；旧版 `console.js` 的端口是固定值，改端口时需同步修改。
- **`npm start` 提示 `Electron failed to install correctly`**：Electron 的二进制没有下载完整。可先执行 `npm install` 重新安装；国内网络建议先设置镜像：
  ```powershell
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  npm install
  ```
  如果从某些自动化终端启动，还要确认没有继承 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会以 Node 模式运行并直接报错：
  ```powershell
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  npm start
  ```
- **`npm start` 回车后直接结束、没有窗口**：先看 `%TEMP%\lyricflow-main.log`。如果日志停在 `boot` 或根本没有生成，说明 Electron 被当前 shell 的权限策略挡住（受限沙箱无法创建 Chromium 所需的管道）；改用 `start-gui.bat` 双击启动，或只跑网页版 `start-web.bat`。
- **歌词偶尔闪回上一首 / 频繁切换**：服务端已加 2.5 秒断连容忍与「同一新标题连续出现两次才切换」的确认机制，避免播放器窗口标题短暂抖动触发重载。如果仍然出现，请打开页面右下角 `Log`，把「连接关闭 (代码)」和服务端日志发来，可据此定位是页面重连还是播放器检测抖动。
- **受限终端里检测不到播放器**：这类终端通常也看不到桌面窗口标题（`Get-Process` 的 `MainWindowTitle` 全为空），需要从资源管理器双击 `start-web.bat` / `start-gui.bat`，或在普通 PowerShell 里启动。

## License

GPL-3.0，见 [LICENSE](LICENSE)。