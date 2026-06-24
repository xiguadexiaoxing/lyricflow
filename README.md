<img width="4816" height="4120" alt="1781583643828" src="https://github.com/user-attachments/assets/09056c01-a775-4925-a347-7e3c3a42d022" />

安装与启动

```bash
npm init -y
npm install ws
npm install node-forge
```

启动命令

```bash
node server.js
```
随后它会在电脑的3721端口开放
你可以用 [本地链接](http://localhost:3721)打开
或者访问远程链接的3721端口打开

可选：扫描本地 .lrc 文件目录：

```bash
MUSIC_DIR="D:\Music" node server.js
```
关闭外网访问后，ipv6和外网地址不可用
