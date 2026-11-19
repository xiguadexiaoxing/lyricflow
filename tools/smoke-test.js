'use strict';

/*
 * End-to-end smoke test for a running LyricFlow server.
 * Usage: PORT=3722 node tools/smoke-test.js
 *
 * It only touches read endpoints plus "applyLyrics" on that test instance,
 * so point it at a scratch server, not at the instance you are watching.
 */

const http = require('http');

const PORT = Number(process.env.PORT) || 3722;
const HOST = '127.0.0.1';
const BASE = 'http://' + HOST + ':' + PORT;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log('  PASS  ' + name);
    } else {
        failed++;
        console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : ''));
    }
}

function request(path, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + path, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            timeout: 5000,
        }, (res) => {
            let stream = res;
            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(require('zlib').createGunzip());
            }
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

async function main() {
    console.log('\n  LyricFlow smoke test @ ' + BASE + '\n');

    const status = await request('/api/status');
    check('status 200', status.status === 200, status.status);
    let parsed = null;
    try { parsed = JSON.parse(status.body); } catch (e) { /* ignore */ }
    check('status is JSON with port', parsed && parsed.port === PORT, status.body.slice(0, 120));
    check('status includes bridge info', !!(parsed && parsed.bridge));
    check('lyrics cache counter present', !!(parsed && typeof parsed.cacheSize === 'number'));

    const plain = await request('/');
    check('index served', plain.status === 200 && plain.body.indexOf('<title>LyricFlow</title>') !== -1, plain.status);
    check('no-compression path works', !plain.headers['content-encoding']);

    const gz = await request('/', { headers: { 'Accept-Encoding': 'gzip' } });
    check('gzip HTML', gz.status === 200 && gz.headers['content-encoding'] === 'gzip', gz.headers['content-encoding']);
    check('gzip HTML is complete', gz.body.indexOf('</html>') !== -1);

    const logs = await request('/api/logs?limit=10');
    let logList = null;
    try { logList = JSON.parse(logs.body); } catch (e) { /* ignore */ }
    check('logs endpoint', Array.isArray(logList) && logList.length <= 10, logs.body.slice(0, 120));

    const cors = await request('/api/status', { headers: { 'Origin': 'null' } });
    check('CORS for file:// GUI', cors.headers['access-control-allow-origin'] === 'null', cors.headers['access-control-allow-origin']);

    const missing = await request('/nope');
    check('404 for unknown path', missing.status === 404, missing.status);

    const WebSocket = require('ws');
    const lyricsPromise = new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://' + HOST + ':' + PORT);
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('websocket timeout')); }, 5000);
        let sawInit = false;

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
            if (msg.type === 'init') {
                sawInit = true;
                check('websocket init payload', typeof msg.data === 'object' && 'connected' in msg.data);
                ws.send(JSON.stringify({
                    type: 'applyLyrics',
                    data: '[00:00.00]first line\n[00:02.50]second line\n[00:05.00]third line',
                }));
            }
            if (msg.type === 'lyrics' && msg.data && msg.data.source === 'manual') {
                clearTimeout(timer);
                check('manual lyrics broadcast', msg.data.lyrics.length === 3, msg.data.lyrics.length);
                check('timestamps parsed', msg.data.lyrics[1].time === 2.5, msg.data.lyrics[1].time);
                ws.close();
                resolve(sawInit);
            }
        });
        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    await lyricsPromise;

    const applied = await request('/api/lyrics');
    let appliedJson = null;
    try { appliedJson = JSON.parse(applied.body); } catch (e) { /* ignore */ }
    check('applied lyrics readable', !!(appliedJson && appliedJson.lyrics && appliedJson.lyrics.length === 3));
    check('source is manual', appliedJson && appliedJson.source === 'manual', appliedJson && appliedJson.source);

    console.log('\n  ' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('\n  Smoke test crashed: ' + e.message + '\n');
    process.exit(1);
});