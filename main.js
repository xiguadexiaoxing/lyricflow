'use strict';
var { app, BrowserWindow, ipcMain, shell } = require('electron');
var http = require('http');
var path = require('path');

var mainWindow = null;
var PORT = 3721;

/* ═══ Single Instance ═══ */
var gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }
app.on('second-instance', function() {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

/* ═══ Wait ═══ */
function waitForServer(retries, cb) {
    if (retries <= 0) { cb(false); return; }
    var req = http.get('http://localhost:' + PORT + '/api/status', { timeout: 1500 }, function(res) {
        res.resume();
        cb(true);
    });
    req.on('error', function() { setTimeout(function() { waitForServer(retries - 1, cb); }, 1000); });
    req.on('timeout', function() { req.destroy(); setTimeout(function() { waitForServer(retries - 1, cb); }, 1000); });
}

/* ═══ Window ═══ */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 540, height: 700,
        minWidth: 420, minHeight: 500,
        frame: false,
        backgroundColor: '#0a0a0c',
        resizable: true,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('gui.html');
    mainWindow.once('ready-to-show', function() { mainWindow.show(); });
    mainWindow.on('closed', function() { mainWindow = null; });
}

/* ═══ IPC ═══ */
ipcMain.on('minimize', function() { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('maximize', function() {
    if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); }
});
ipcMain.on('close', function() { if (mainWindow) mainWindow.close(); });
ipcMain.on('open-url', function(e, url) { shell.openExternal(url); });
ipcMain.on('shutdown', function() {
    var req = http.get('http://localhost:' + PORT + '/api/shutdown', { timeout: 1000 }, function() {});
    req.on('error', function() {});
    setTimeout(function() { app.quit(); }, 1500);
});

/* ═══ Start ═══ */
app.whenReady().then(function() {
    // 直接加载服务器模块
    try {
        require('./server.js');
    } catch(e) {
        console.error('Server load failed:', e.message);
    }

    // 等待服务器端口就绪
    waitForServer(20, function(ok) {
        if (ok) {
            console.log('Server ready on port ' + PORT);
        } else {
            console.error('Server did not start in time');
        }
        createWindow();
    });
});

app.on('window-all-closed', function() { app.quit(); });
app.on('quit', function() {
    try {
        http.get('http://localhost:' + PORT + '/api/shutdown', { timeout: 500 }, function() {}).on('error', function() {});
    } catch(e) {}
});