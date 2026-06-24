'use strict';
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

let WebSocketServer;
try { WebSocketServer = require('ws').WebSocketServer; }
catch (e) { console.error('npm install ws'); process.exit(1); }

const PORT = 3721;
const MUSIC_DIR = process.env.MUSIC_DIR || '';
const PLAT = os.platform();

var allowExternal = false; // false=仅局域网 true=允许外网

function isLocalAddr(addr) {
    if (!addr) return true;
    if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
    if (addr.startsWith('::ffff:')) addr = addr.substring(7);
    if (addr.startsWith('192.168.')) return true;
    if (addr.startsWith('10.')) return true;
    if (addr.startsWith('172.')) {
        var s = parseInt(addr.split('.')[1]);
        if (s >= 16 && s <= 31) return true;
    }
    if (addr.startsWith('fe80')) return true;
    return false;
}

const S = { connected: false, title: '', artist: '', position: 0, isPlaying: false, lyrics: null, lyricsSource: '', trackKey: '', lastTick: Date.now(), estDur: 0 };
const clients = new Set();
const lyricsCache = new Map();
const localLRC = new Map();
const logs = [];
const startTime = Date.now();

function log(m) {
    const l = '[' + new Date().toLocaleTimeString() + '] ' + m;
    console.log('  ' + l);
    logs.push(l);
    if (logs.length > 200) logs.shift();
    broadcast('log', { message: l });
}

function broadcast(type, data) {
    var msg = JSON.stringify({ type: type, data: data });
    clients.forEach(function(ws) { if (ws.readyState === 1) ws.send(msg); });
}

/* ═══ LRC Parser ═══ */
function parseLRC(text) {
    if (!text || typeof text !== 'string') return { lyrics: [], meta: {} };
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var result = [], meta = {};
    var lines = text.split(/[\r\n]+/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line.length < 3) continue;
        var times = [];
        var pos = 0;
        var lastTimeEnd = 0;
        while (pos < line.length && line.charCodeAt(pos) === 91) {
            var close = -1;
            for (var c = pos + 1; c < line.length; c++) {
                if (line.charCodeAt(c) === 93) { close = c; break; }
            }
            if (close === -1) break;
            var inner = line.substring(pos + 1, close);
            var colonIdx = -1;
            for (var c2 = 0; c2 < inner.length; c2++) {
                if (inner.charCodeAt(c2) === 58) { colonIdx = c2; break; }
            }
            if (colonIdx > 0) {
                var min = parseInt(inner.substring(0, colonIdx), 10);
                var rest = inner.substring(colonIdx + 1);
                var sec = 0, ms = 0;
                var dotIdx = -1;
                for (var c3 = 0; c3 < rest.length; c3++) {
                    var cc = rest.charCodeAt(c3);
                    if (cc === 46 || cc === 58) { dotIdx = c3; break; }
                }
                if (dotIdx === -1) { sec = parseInt(rest, 10); }
                else {
                    sec = parseInt(rest.substring(0, dotIdx), 10);
                    var frac = rest.substring(dotIdx + 1);
                    if (frac.length === 1) ms = parseInt(frac, 10) * 100;
                    else if (frac.length === 2) ms = parseInt(frac, 10) * 10;
                    else ms = parseInt(frac.substring(0, 3), 10);
                }
                if (!isNaN(min) && !isNaN(sec)) {
                    times.push(min * 60 + sec + ms / 1000);
                    lastTimeEnd = close + 1;
                } else { break; }
            } else { break; }
            pos = close + 1;
        }
        if (times.length > 0) {
            var txt = line.substring(lastTimeEnd).trim();
            if (txt.length > 0) {
                for (var t = 0; t < times.length; t++) {
                    result.push({ time: Math.round(times[t] * 1000) / 1000, text: txt });
                }
            }
        }
    }
    result.sort(function(a, b) { return a.time - b.time; });
    return { lyrics: result, meta: meta };
}

/* ═══ HTTP ═══ */
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function httpGet(url, redir) {
    redir = redir === undefined ? 3 : redir;
    return new Promise(function(resolve) {
        var timer = setTimeout(function() { resolve({ status: 0, data: null }); }, 12000);
        https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 10000 }, function(res) {
            if ([301, 302, 307].indexOf(res.statusCode) !== -1 && res.headers.location && redir > 0) {
                clearTimeout(timer); httpGet(res.headers.location, redir - 1).then(resolve); return;
            }
            var d = '';
            res.on('data', function(c) { d += c.toString('utf8'); });
            res.on('end', function() {
                clearTimeout(timer);
                try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
                catch (e) { resolve({ status: res.statusCode, data: null }); }
            });
            res.on('error', function() { clearTimeout(timer); resolve({ status: 0, data: null }); });
        }).on('error', function() { clearTimeout(timer); resolve({ status: 0, data: null }); });
    });
}

function httpPost(url, body) {
    return new Promise(function(resolve) {
        var u = new URL(url);
        var timer = setTimeout(function() { resolve({ status: 0, data: null }); }, 12000);
        var req = https.request({
            hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Referer': 'https://music.163.com' }
        }, function(res) {
            var d = '';
            res.on('data', function(c) { d += c.toString('utf8'); });
            res.on('end', function() {
                clearTimeout(timer);
                try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
                catch (e) { resolve({ status: res.statusCode, data: null }); }
            });
        });
        req.on('error', function() { clearTimeout(timer); resolve({ status: 0, data: null }); });
        req.write(body); req.end();
    });
}

/* ═══ LRCLIB ═══ */
async function fetchLRCLIB(title, artist) {
    log('LRCLIB: ' + (artist || '?') + ' - ' + title);
    var q = 'track_name=' + encodeURIComponent(title); if (artist) q += '&artist_name=' + encodeURIComponent(artist);
    var r = await httpGet('https://lrclib.net/api/get?' + q);
    if (r.status === 200 && r.data && r.data.syncedLyrics) {
        var p = parseLRC(r.data.syncedLyrics);
        if (p.lyrics.length) { log('LRCLIB: ' + p.lyrics.length); return { lyrics: p.lyrics, meta: p.meta, source: 'lrclib' }; }
    }
    r = await httpGet('https://lrclib.net/api/search?' + q);
    if (r.status === 200 && Array.isArray(r.data)) {
        for (var i = 0; i < r.data.length; i++) {
            if (r.data[i].syncedLyrics) {
                var p2 = parseLRC(r.data[i].syncedLyrics);
                if (p2.lyrics.length) return { lyrics: p2.lyrics, meta: p2.meta, source: 'lrclib' };
            }
        }
    }
    return null;
}

/* ═══ NetEase ═══ */
async function fetchNetEase(title, artist) {
    var keyword = (artist ? artist + ' ' : '') + title;
    log('NetEase: ' + keyword);
    var body = 's=' + encodeURIComponent(keyword) + '&type=1&limit=5&offset=0';
    var sr = await httpPost('https://music.163.com/api/search/get', body);
    if (sr.status !== 200 || !sr.data || !sr.data.result || !sr.data.result.songs || !sr.data.result.songs.length) return null;
    var songs = sr.data.result.songs;
    var tl = title.toLowerCase();
    var best = songs[0];
    for (var i = 0; i < songs.length; i++) { if (songs[i].name && songs[i].name.toLowerCase() === tl) { best = songs[i]; break; } }
    var lyric = await neteaseLyricGet(best.id);
    if (lyric) {
        var p = parseLRC(lyric);
        if (p.lyrics.length) {
            var ar = best.artists ? best.artists.map(function(a) { return a.name; }).join(', ') : artist;
            return { lyrics: p.lyrics, meta: { ti: title, ar: ar }, source: 'netease' };
        }
    }
    return null;
}

function neteaseLyricGet(id) {
    return new Promise(function(resolve) {
        var url = 'https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1';
        var timer = setTimeout(function() { resolve(null); }, 12000);
        https.get(url, {
            headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com', 'Accept': '*/*', 'Cookie': 'os=pc; appver=2.9.7' },
            timeout: 10000
        }, function(res) {
            var d = '';
            res.on('data', function(c) { d += c.toString('utf8'); });
            res.on('end', function() {
                clearTimeout(timer);
                try {
                    var j = JSON.parse(d);
                    for (var key of ['lrc', 'klyric', 'tlyric']) {
                        if (j[key] && typeof j[key] === 'object' && j[key].lyric && j[key].lyric.trim().length > 5) {
                            resolve(j[key].lyric); return;
                        }
                    }
                    resolve(null);
                } catch (e) { resolve(null); }
            });
            res.on('error', function() { clearTimeout(timer); resolve(null); });
        }).on('error', function() { clearTimeout(timer); resolve(null); });
    });
}

async function searchLRCLIB(track, artist) {
    var q = 'track_name=' + encodeURIComponent(track); if (artist) q += '&artist_name=' + encodeURIComponent(artist);
    var r = await httpGet('https://lrclib.net/api/search?' + q);
    return (r.status === 200 && Array.isArray(r.data)) ? r.data : [];
}

async function searchNetEase(track, artist) {
    var keyword = (artist ? artist + ' ' : '') + track;
    var body = 's=' + encodeURIComponent(keyword) + '&type=1&limit=8&offset=0';
    var sr = await httpPost('https://music.163.com/api/search/get', body);
    if (sr.status !== 200 || !sr.data || !sr.data.result || !sr.data.result.songs) return [];
    var songs = sr.data.result.songs;
    var results = await Promise.all(songs.map(async function(s) {
        var lyric = await neteaseLyricGet(s.id);
        return {
            trackName: s.name || '', artistName: (s.artists || []).map(function(a) { return a.name; }).join(', '),
            albumName: s.album ? s.album.name : '', duration: s.duration ? Math.round(s.duration / 1000) : 0,
            hasSynced: !!lyric, syncedLyrics: lyric, plainLyrics: null
        };
    }));
    return results.filter(function(r) { return r.hasSynced; });
}

/* ═══ Local LRC ═══ */
function buildLRCIndex(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    var c = 0;
    (function scan(d, depth) {
        if (depth > 5) return;
        try {
            fs.readdirSync(d, { withFileTypes: true }).forEach(function(e) {
                var fp = path.join(d, e.name);
                if (e.isDirectory()) { scan(fp, depth + 1); return; }
                if (!/\.lrc$/i.test(e.name)) return;
                var base = e.name.replace(/\.lrc$/i, '');
                var sep = base.indexOf(' - ');
                var ar = '', ti = base;
                if (sep > 0) { ar = base.substring(0, sep).trim(); ti = base.substring(sep + 3).trim(); }
                localLRC.set((ar + '|||' + ti).toLowerCase(), fp);
                c++;
            });
        } catch (ex) {}
    })(dir, 0);
    log('LRC index: ' + c);
}

function findLocalLRC(title, artist) {
    if (!title) return null;
    var tl = title.toLowerCase(), al = (artist || '').toLowerCase();
    var keys = [al + '|||' + tl, '|||' + tl];
    for (var i = 0; i < keys.length; i++) {
        var fp = localLRC.get(keys[i]);
        if (fp) try { return fs.readFileSync(fp, 'utf8'); } catch (e) {}
    }
    for (var entry of localLRC) {
        if (entry[0].includes(tl)) try { return fs.readFileSync(entry[1], 'utf8'); } catch (e) {}
    }
    return null;
}

/* ═══ Lyrics Manager ═══ */
async function ensureLyrics(title, artist) {
    var key = ((artist || '') + '|||' + title).toLowerCase();
    if (lyricsCache.has(key)) return lyricsCache.get(key);
    broadcast('lyrics', { lyrics: null, source: 'loading' });

    if (MUSIC_DIR) {
        var raw = findLocalLRC(title, artist);
        if (raw) { var p = parseLRC(raw); if (p.lyrics.length) { var r = { lyrics: p.lyrics, meta: p.meta, source: 'local' }; lyricsCache.set(key, r); return r; } }
    }
    var lr = await fetchLRCLIB(title, artist);
    if (lr && lr.lyrics.length) { lyricsCache.set(key, lr); return lr; }
    var ne = await fetchNetEase(title, artist);
    if (ne && ne.lyrics.length) { lyricsCache.set(key, ne); return ne; }
    lyricsCache.set(key, null);
    return null;
}

/* ═══ Bridge ═══ */
var bridgeProc = null;
var psCounter = 0;

function startSMTCPoll() {
    if (PLAT !== 'win32') return;
    var smtcScript = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
        "$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()",
        "$asTask = $null",
        "foreach ($m in $methods) {",
        "  if ($m.Name -eq 'AsTask') {",
        "    $p = $m.GetParameters()",
        "    if ($p.Count -eq 1 -and $p[0].ParameterType.Name -eq 'IAsyncOperation`1') {",
        "      $asTask = $m; break",
        "    }",
        "  }",
        "}",
        "function Await($t, $r) {",
        "  $g = $asTask.MakeGenericMethod($r)",
        "  return $g.Invoke($null, @($t)).GetAwaiter().GetResult()",
        "}",
        "[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null",
        "",
        "$lastState = 'Unknown'",
        "while ($true) {",
        "  try {",
        "    $async = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()",
        "    $manager = Await $async ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
        "    $session = $manager.GetCurrentSession()",
        "    if ($null -ne $session) {",
        "      $pb = $session.GetPlaybackInfo()",
        "      $st = $pb.PlaybackStatus.ToString()",
        "      if ($st -ne $lastState) {",
        "        $lastState = $st",
        "        Write-Output $st",
        "      }",
        "    }",
        "  } catch {}",
        "  Start-Sleep -Milliseconds 1500",
        "}",
    ].join('\r\n');
    var smtcPath = path.join(os.tmpdir(), 'lyricflow_smtc.ps1');
    fs.writeFileSync(smtcPath, '\uFEFF' + smtcScript, 'utf8');
    var smtcProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', smtcPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    var smtcBuf = '';
    smtcProc.stdout.setEncoding('utf8');
    smtcProc.stdout.on('data', function(chunk) {
        smtcBuf += chunk;
        var idx;
        while ((idx = smtcBuf.indexOf('\n')) !== -1) {
            var line = smtcBuf.substring(0, idx).trim();
            smtcBuf = smtcBuf.substring(idx + 1);
            if (!line) continue;
            var playing = (line === 'Playing');
            if (S.isPlaying !== playing) {
                S.isPlaying = playing;
                log('State: ' + (playing ? 'Play' : 'Pause'));
                broadcast('position', { position: S.position, isPlaying: S.isPlaying, duration: S.estDur });
            }
        }
    });
    smtcProc.stderr.on('data', function() {});
    smtcProc.on('close', function() { setTimeout(startSMTCPoll, 5000); });
    smtcProc.on('error', function() {});
    log('SMTC poll started');
}

function startBridge() {
    log('Starting bridge...');
    if (PLAT === 'win32') {
        var lines = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
            "",
            "$pl = @('cloudmusic','QQMusic','Spotify','foobar2000','MusicBee','vlc','AIMP','iTunes','wmplayer')",
            "while ($true) {",
            "  $fnd = $false; $pn = ''; $wt = ''",
            "  foreach ($n in $pl) {",
            "    $p = Get-Process -Name $n -EA SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select -First 1",
            "    if ($p -and $p.MainWindowTitle.Length -gt 2) { $pn = $n; $wt = $p.MainWindowTitle; $fnd = $true; break }",
            "  }",
            "  if (-not $fnd) { Write-Output '{\"e\":\"none\"}' }",
            "  else { @{p=$pn;t=$wt} | ConvertTo-Json -Compress }",
            "  Start-Sleep -Milliseconds 500",
            "}",
        ];
        var psPath = path.join(os.tmpdir(), 'lyricflow_bridge.ps1');
        fs.writeFileSync(psPath, '\uFEFF' + lines.join('\r\n'), 'utf8');
        bridgeProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (PLAT === 'linux') {
        var sh = path.join(os.tmpdir(), 'lf_bridge.sh');
        fs.writeFileSync(sh, '#!/bin/bash\nwhile true; do\n  T=$(playerctl metadata xesam:title 2>/dev/null)\n  A=$(playerctl metadata xesam:artist 2>/dev/null)\n  if [ -n "$T" ]; then\n    echo "{\"p\":\"playerctl\",\"t\":\"$T\",\"a\":\"$A\"}"\n  else\n    echo \'{"e":"none"}\'\n  fi\n  sleep 0.5\ndone', 'utf8');
        bridgeProc = spawn('bash', [sh], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else { log('Unsupported platform'); return; }

    var buf = '';
    bridgeProc.stdout.setEncoding('utf8');
    bridgeProc.stdout.on('data', function(chunk) {
        buf += chunk;
        var idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            var line = buf.substring(0, idx).trim();
            buf = buf.substring(idx + 1);
            if (!line.startsWith('{')) continue;
            try { handleMediaUpdate(JSON.parse(line)); } catch (e) {}
        }
    });
    bridgeProc.stderr.on('data', function() {});
    bridgeProc.on('close', function(code) { log('Bridge exit(' + code + ')'); setTimeout(startBridge, 5000); });
    bridgeProc.on('error', function(e) { log('Bridge err: ' + e.message); });
    log('Bridge started');
}

/* ═══ Media Update ═══ */
var pendingKey = '';
function handleMediaUpdate(d) {
    if (d.e === 'none') { if (S.connected) { S.connected = false; S.isPlaying = false; broadcast('status', { connected: false }); } return; }
    if (!S.connected) { S.connected = true; log('Detected: ' + d.p); broadcast('status', { connected: true }); }

    var song, artist;
    if (d.a) { song = d.t; artist = d.a; }
    else { var raw = d.t || ''; var sep = raw.indexOf(' - '); if (sep > 0 && sep < raw.length - 3) { song = raw.substring(0, sep).trim(); artist = raw.substring(sep + 3).trim(); } else { song = raw; artist = ''; } }
    if (!song || song.length < 1) return;

    var now = Date.now(), elapsed = (now - S.lastTick) / 1000;
    S.lastTick = now;
    var newKey = ((artist || '') + '|||' + song).toLowerCase();

    if (newKey !== S.trackKey && newKey !== pendingKey) {
        S.trackKey = newKey; S.title = song; S.artist = artist; S.position = 0; S.isPlaying = true; pendingKey = newKey;
        log('Track: ' + (artist || '?') + ' - ' + song);
        broadcast('track', { title: song, artist: artist });
        ensureLyrics(song, artist).then(function(result) {
            if (result && result.lyrics.length) {
                S.lyrics = result.lyrics; S.lyricsSource = result.source;
                S.estDur = result.lyrics[result.lyrics.length - 1].time + 15;
                broadcast('lyrics', { lyrics: result.lyrics, source: result.source });
                log('Lyrics: ' + result.source + ' ' + result.lyrics.length + ' lines');
            } else { S.lyrics = null; S.lyricsSource = ''; broadcast('lyrics', { lyrics: null, source: 'not_found' }); }
            pendingKey = '';
        });
    } else if (S.isPlaying && elapsed < 2 && newKey === S.trackKey) {
        S.position += elapsed;
    }
    broadcast('position', { position: S.position, isPlaying: S.isPlaying, duration: S.estDur });
}

/* ═══ Media Keys ═══ */
var VK = { toggle: 179, next: 176, prev: 177 };
function sendMediaKey(key) {
    var vk = VK[key]; if (!vk) return;
    if (PLAT === 'win32') {
        var script = "Add-Type @'\r\nusing System;\r\nusing System.Runtime.InteropServices;\r\npublic class K {\r\n    [DllImport(\"user32.dll\")]\r\n    public static extern void keybd_event(byte b, byte s, int f, int e);\r\n}\r\n'@\r\n[K]::keybd_event(" + vk + ",0,0,0)\r\n[K]::keybd_event(" + vk + ",0,2,0)";
        var f = path.join(os.tmpdir(), 'lf_k' + (psCounter++) + '.ps1');
        fs.writeFileSync(f, '\uFEFF' + script, 'utf8');
        var p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true });
        p.on('close', function() { try { fs.unlinkSync(f); } catch (e) {} });
    } else if (PLAT === 'linux') {
        var m = { toggle: 'play-pause', next: 'next', prev: 'previous' };
        if (m[key]) spawn('playerctl', [m[key]], { stdio: 'ignore' });
    }
}

/* ═══ HTTP Server ═══ */
var HTML;
try { HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); }
catch (e) { console.error('  index.html not found'); process.exit(1); }

var ADMIN_HTML = null;
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch(e) {}

var server = http.createServer(function(req, res) {
        // 外网访问控制
    var clientIp = req.socket.remoteAddress || '';
    if (!allowExternal && !isLocalAddr(clientIp)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('External access disabled');
        return;
    }
    var url = req.url.split('?')[0];
    var qs = null;
    try { qs = new URL(req.url, 'http://localhost').searchParams; } catch(e) {}

    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
    }
    else if (url === '/admin' && ADMIN_HTML) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ADMIN_HTML);
    }
    else if (url === '/api/status') {
        var uptime = Math.floor((Date.now() - startTime) / 1000);
        var mem = process.memoryUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            uptime: uptime, connected: S.connected, title: S.title, artist: S.artist,
            position: S.position, isPlaying: S.isPlaying, estDur: S.estDur,
            lyricsSource: S.lyricsSource, lyricsCount: S.lyrics ? S.lyrics.length : 0,
            clients: clients.size, cacheSize: lyricsCache.size, lrcIndexSize: localLRC.size,
            memMB: (mem.rss / 1048576).toFixed(1), platform: PLAT,
            musicDir: MUSIC_DIR || '(none)', port: PORT
        }));
    }
    else if (url === '/api/lyrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (S.lyrics && S.lyrics.length) {
            res.end(JSON.stringify({ lyrics: S.lyrics, source: S.lyricsSource, title: S.title, artist: S.artist }));
        } else {
            res.end(JSON.stringify({ lyrics: null }));
        }
    }
    else if (url === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs.slice(-80)));
    }
    else if (url === '/api/clear-cache') {
        lyricsCache.clear();
        log('Cache cleared');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
    else if (url === '/api/key') {
        var key = qs ? qs.get('key') : null;
        if (key) sendMediaKey(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
    else if (url === '/api/shutdown') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        log('Shutdown');
        setTimeout(function() { process.exit(0); }, 500);
    }
        else if (url === '/api/ext') {
        if (qs) {
            var val = qs.get('val');
            if (val === '1') { allowExternal = true; log('外网访问: 开启'); }
            else if (val === '0') { allowExternal = false; log('外网访问: 关闭'); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowExternal: allowExternal }));
    }
    else {
        res.writeHead(404);
        res.end();
    }
});

var wss = new WebSocketServer({ server: server });
wss.on('connection', function(ws) {
        var wsIp = ws._socket ? ws._socket.remoteAddress : '';
    if (!allowExternal && !isLocalAddr(wsIp)) {
        ws.close();
        return;
    }
    clients.add(ws);
    log('Browser connected');
    ws.send(JSON.stringify({ type: 'init', data: { connected: S.connected, title: S.title, artist: S.artist, position: S.position, isPlaying: S.isPlaying, lyrics: S.lyrics, lyricsSource: S.lyricsSource, duration: S.estDur } }));
    ws.send(JSON.stringify({ type: 'logs', data: logs.slice(-50) }));
    ws.on('message', function(raw) {
        try {
            var msg = JSON.parse(raw.toString());
            if (msg.type === 'lrc' || msg.type === 'applyLyrics') {
                var p = parseLRC(msg.data);
                if (p.lyrics.length) { S.lyrics = p.lyrics; S.lyricsSource = 'manual'; S.estDur = p.lyrics[p.lyrics.length - 1].time + 15; broadcast('lyrics', { lyrics: p.lyrics, source: 'manual' }); }
            } else if (msg.type === 'search') {
                (async function() {
                    var results = await searchLRCLIB(msg.data.track, msg.data.artist);
                    var mapped = results.map(function(r) { return { trackName: r.trackName, artistName: r.artistName, albumName: r.albumName, duration: r.duration, hasSynced: !!r.syncedLyrics, syncedLyrics: r.syncedLyrics || null, plainLyrics: r.plainLyrics || null }; });
                    if (mapped.length === 0) mapped = await searchNetEase(msg.data.track, msg.data.artist);
                    ws.send(JSON.stringify({ type: 'searchResults', data: mapped.slice(0, 10) }));
                })();
            } else if (msg.type === 'key') { sendMediaKey(msg.data); }
        } catch(e) {}
    });
    ws.on('close', function() { clients.delete(ws); log('Browser disconnected'); });
});

/* ═══ Start ═══ */
console.log('\n  LyricFlow\n');
if (MUSIC_DIR) buildLRCIndex(MUSIC_DIR);
startSMTCPoll();
startBridge();
/* ═══ 启动 ═══ */
/* ═══ 启动 ═══ */
console.log('\n  LyricFlow\n');
if (MUSIC_DIR) buildLRCIndex(MUSIC_DIR);
startSMTCPoll();
startBridge();
server.listen({ port: PORT, host: '::', ipv6Only: false }, function() {
    log('Ready: http://localhost:' + PORT);
    var ifaces = os.networkInterfaces();
    console.log('');
    console.log('  ===========================================================');
    console.log('  Pages:');
    console.log('    http://localhost:' + PORT);
    Object.keys(ifaces).forEach(function(name) {
        ifaces[name].forEach(function(iface) {
            if (!iface.internal && iface.family === 'IPv4') console.log('    http://' + iface.address + ':' + PORT + '  (' + name + ')');
        });
    });
    console.log('');
    console.log('  ===========================================================');
    console.log('');
});

/* ═══ HTTPS ═══ */
(function() {
    var forge;
    try { forge = require('node-forge'); } catch(e) {
        console.log('  node-forge not installed, skipping HTTPS');
        return;
    }
    try {
        console.log('  Generating HTTPS certificate...');
        var kp = forge.pki.rsa.generateKeyPair(2048);
        var crt = forge.pki.createCertificate();
        crt.publicKey = kp.publicKey;
        crt.serialNumber = '01';
        crt.validity.notBefore = new Date();
        crt.validity.notAfter = new Date();
        crt.validity.notAfter.setFullYear(crt.validity.notBefore.getFullYear() + 1);
        crt.setSubject([{ name: 'commonName', value: 'LyricFlow' }]);
        crt.setIssuer([{ name: 'commonName', value: 'LyricFlow' }]);
        crt.sign(kp.privateKey, forge.md.sha256.create());

        var HTTPS_PORT = PORT + 1;
        var hs = https.createServer({
            key: forge.pki.privateKeyToPem(kp.privateKey),
            cert: forge.pki.certificateToPem(crt)
        }, function(req, res) {
            var u = req.url.split('?')[0];
            if (u === '/' || u === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(HTML);
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        var w2 = new WebSocketServer({ server: hs });
        w2.on('connection', function(ws) {
                        var wsIp2 = ws._socket ? ws._socket.remoteAddress : '';
            if (!allowExternal && !isLocalAddr(wsIp2)) { ws.close(); return; }
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'init', data: { connected: S.connected, title: S.title, artist: S.artist, position: S.position, isPlaying: S.isPlaying, lyrics: S.lyrics, lyricsSource: S.lyricsSource, duration: S.estDur } }));
            ws.send(JSON.stringify({ type: 'logs', data: logs.slice(-50) }));
            ws.on('message', function(raw) {
                try {
                    var msg = JSON.parse(raw.toString());
                    if (msg.type === 'lrc' || msg.type === 'applyLyrics') {
                        var p = parseLRC(msg.data);
                        if (p.lyrics.length) { S.lyrics = p.lyrics; S.lyricsSource = 'manual'; S.estDur = p.lyrics[p.lyrics.length - 1].time + 15; broadcast('lyrics', { lyrics: p.lyrics, source: 'manual' }); }
                    } else if (msg.type === 'search') {
                        (async function() {
                            var results = await searchLRCLIB(msg.data.track, msg.data.artist);
                            var mapped = results.map(function(r) { return { trackName: r.trackName, artistName: r.artistName, albumName: r.albumName, duration: r.duration, hasSynced: !!r.syncedLyrics, syncedLyrics: r.syncedLyrics || null, plainLyrics: r.plainLyrics || null }; });
                            if (mapped.length === 0) mapped = await searchNetEase(msg.data.track, msg.data.artist);
                            ws.send(JSON.stringify({ type: 'searchResults', data: mapped.slice(0, 10) }));
                        })();
                    } else if (msg.type === 'key') { sendMediaKey(msg.data); }
                } catch(e) {}
            });
            ws.on('close', function() { clients.delete(ws); });
        });

        hs.on('error', function(e) { console.log('  HTTPS error: ' + e.message); });

hs.listen({ port: HTTPS_PORT, host: '::', ipv6Only: false }, function() {
            console.log('');
            console.log('  ===========================================================');
            console.log('  HTTPS (battery):');
            console.log('    https://localhost:' + HTTPS_PORT);
            var nf = os.networkInterfaces();
            Object.keys(nf).forEach(function(n) {
                nf[n].forEach(function(i) {
                    if (!i.internal && i.family === 'IPv4') console.log('    https://' + i.address + ':' + HTTPS_PORT + '  (' + n + ')');
                });
            });
            console.log('  First visit: Advanced -> Continue');
            console.log('  ===========================================================');
            console.log('');
        });

        console.log('  HTTPS starting on port ' + HTTPS_PORT);
    } catch(e) {
        console.log('  HTTPS failed: ' + e.message);
    }
})();

process.on('SIGINT', function() { if (bridgeProc) bridgeProc.kill(); process.exit(0); });