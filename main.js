'use strict';

/*
 * LyricFlow Electron entry.
 * Startup milestones are appended to %TEMP%\lyricflow-main.log so a silent
 * exit can be diagnosed without attaching a debugger.
 */

const electronModule = require('electron');

// `require('electron')` returns a path string when ELECTRON_RUN_AS_NODE=1.
if (typeof electronModule === 'string') {
    console.error('[LyricFlow] Electron is running in Node mode (ELECTRON_RUN_AS_NODE=1).');
    console.error('[LyricFlow] Clear it first: Remove-Item Env:ELECTRON_RUN_AS_NODE');
    process.exit(1);
}

const { app, BrowserWindow, ipcMain, shell } = electronModule;
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3721;
const TRACE_FILE = path.join(os.tmpdir(), 'lyricflow-main.log');

function trace(message) {
    const line = new Date().toISOString() + ' ' + message;
    try { fs.appendFileSync(TRACE_FILE, line + '\r\n'); } catch (e) { /* ignore */ }
    console.log('[LyricFlow] ' + message);
}

trace('boot pid=' + process.pid + ' electron=' + process.versions.electron);

let mainWindow = null;

/* ═══ Single instance ═══ */
if (!app.requestSingleInstanceLock()) {
    trace('another instance already owns the lock, exiting');
    app.quit();
} else {
    app.on('second-instance', function () {
        trace('second instance attempted');
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
    start();
}

/* ═══ Server probe ═══ */
function probeServer(callback) {
    let settled = false;
    const finish = function (ok) {
        if (settled) return;
        settled = true;
        callback(ok);
    };
    const req = http.get('http://127.0.0.1:' + PORT + '/api/status', function (res) {
        res.resume();
        finish(true);
    });
    req.on('error', function () { finish(false); });
    req.setTimeout(1200, function () { req.destroy(); finish(false); });
}

function waitForServer(retries, callback) {
    probeServer(function (ok) {
        if (ok) return callback(true);
        if (retries <= 0) return callback(false);
        setTimeout(function () { waitForServer(retries - 1, callback); }, 800);
    });
}

/* ═══ Window ═══ */
function createWindow() {
    trace('creating window');
    mainWindow = new BrowserWindow({
        width: 540,
        height: 700,
        minWidth: 420,
        minHeight: 500,
        frame: false,
        backgroundColor: '#0a0a0c',
        resizable: true,
        show: false,
        autoHideMenuBar: true,
        title: 'LyricFlow',
        webPreferences: {
            // gui.html is a local, trusted page and uses Node/Electron APIs directly.
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            spellcheck: false,
        },
    });

    mainWindow.webContents.on('did-finish-load', function () { trace('gui loaded'); });
    mainWindow.webContents.on('did-fail-load', function (event, code, description, url) {
        trace('gui load failed ' + code + ' ' + description + ' ' + url);
    });
    mainWindow.once('ready-to-show', function () {
        trace('window ready');
        mainWindow.show();
    });
    mainWindow.on('closed', function () {
        trace('window closed');
        mainWindow = null;
    });

    mainWindow.loadFile(path.join(__dirname, 'gui.html'), { query: { port: String(PORT) } })
        .catch(function (e) { trace('loadFile failed: ' + e.message); });
}

/* ═══ IPC ═══ */
ipcMain.on('minimize', function () { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('maximize', function () {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('close', function () { if (mainWindow) mainWindow.close(); });
ipcMain.on('open-url', function (event, url) {
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    shell.openExternal(url).catch(function () {});
});
ipcMain.on('shutdown', function () {
    const req = http.get('http://127.0.0.1:' + PORT + '/api/shutdown', function (res) { res.resume(); });
    req.on('error', function () {});
    setTimeout(function () { app.quit(); }, 900);
});

/* ═══ Start ═══ */
function start() {
    app.setAppUserModelId('com.lyricflow.app');

    app.on('window-all-closed', function () {
        trace('all windows closed');
        app.quit();
    });
    app.on('child-process-gone', function (event, details) {
        trace('child-process-gone ' + JSON.stringify(details));
    });
    app.on('render-process-gone', function (event, contents, details) {
        trace('render-process-gone ' + JSON.stringify(details));
    });
    app.on('before-quit', function () { trace('before-quit'); });

    app.whenReady().then(function () {
        trace('app ready');
        try {
            require('./server.js');
            trace('server module loaded');
        } catch (e) {
            trace('server load failed: ' + e.message);
        }

        waitForServer(20, function (ok) {
            trace('server reachable=' + ok);
            createWindow();
        });
    }).catch(function (e) {
        trace('whenReady failed: ' + e.message);
    });
}