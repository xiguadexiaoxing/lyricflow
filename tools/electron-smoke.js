'use strict';

/*
 * Headless Electron check: boots the embedded server, loads gui.html, and
 * verifies the dashboard can actually read /api/status (CORS + file:// origin).
 *
 * Run: node_modules\electron\dist\electron.exe tools\electron-smoke.js
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

process.env.PORT = process.env.PORT || '4810';
process.env.LF_NO_BRIDGE = '1';
process.env.LF_HTTPS = '0';
process.env.LF_NO_LISTEN = ''; // server must listen for this check

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const PORT = Number(process.env.PORT);

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
    let exitCode = 1;
    try {
        require('../server.js');
        await wait(1000);

        const win = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
        });
        await win.loadFile(path.join(__dirname, '..', 'gui.html'), { query: { port: String(PORT) } });
        await wait(2000);

        const result = await win.webContents.executeJavaScript(
            '(async () => {' +
            '  try {' +
            '    const res = await fetch("http://127.0.0.1:' + PORT + '/api/status");' +
            '    const body = await res.json();' +
            '    return { ok: res.ok, status: res.status, port: body.port };' +
            '  } catch (e) { return { ok: false, error: String(e) }; }' +
            '})()'
        );
        console.log('GUI smoke:', JSON.stringify(result));
        const title = await win.webContents.executeJavaScript('document.title');
        console.log('GUI title:', title);
        exitCode = result && result.ok && result.port === PORT ? 0 : 1;
    } catch (e) {
        console.error('GUI smoke failed:', e && e.message ? e.message : e);
    }
    app.exit(exitCode);
});