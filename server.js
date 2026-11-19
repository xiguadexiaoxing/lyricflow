'use strict';

/*
 * LyricFlow server
 * - Local media detection (Windows SMTC first, window-title fallback)
 * - Synced lyric lookup: local .lrc index -> LRCLIB -> NetEase
 * - HTTP + HTTPS + WebSocket live page
 *
 * Runtime knobs (env):
 *   PORT=3721          HTTP port
 *   HTTPS_PORT=3722    HTTPS port (PORT + 1 by default)
 *   MUSIC_DIR=...      folder scanned for local .lrc files
 *   LF_HTTPS=0         disable the HTTPS listener
 *   LF_NO_LISTEN=1     load the module without listening (tests)
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

let WebSocketServer;
try {
    WebSocketServer = require('ws').WebSocketServer;
} catch (e) {
    console.error('  Missing dependency: ws. Run: npm install');
    process.exit(1);
}

const PORT = Number(process.env.PORT) || 3721;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || PORT + 1;
const MUSIC_DIR = process.env.MUSIC_DIR || '';
const PLAT = os.platform();
const BOOT_TIME = Date.now();
const MAX_LYRICS_BYTES = 512 * 1024;
const WS_MAX_PAYLOAD = 1024 * 1024;
const STANDALONE = require.main === module;
const OPEN_CONSOLE = process.env.LF_NO_OPEN !== '1';

/* Media player process names recognized by the window-title fallback.
 * Extend with LF_PLAYERS="kwmusic,someplayer" without editing the code. */
const DEFAULT_PLAYERS = [
    'cloudmusic', 'qqmusic', 'spotify', 'foobar2000', 'musicbee', 'vlc',
    'aimp', 'itunes', 'wmplayer', 'kugou', 'kwmusic', 'migu', 'ttplayer', 'potplayer',
];
const PLAYER_NAMES = (function () {
    const extra = String(process.env.LF_PLAYERS || '')
        .split(/[,;]+/)
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
    const result = [];
    DEFAULT_PLAYERS.concat(extra).forEach((name) => {
        if (name && result.indexOf(name) === -1) result.push(name);
    });
    return result;
})();
const PLAYER_PATTERN = PLAYER_NAMES
    .map((name) => name.replace(/[^a-z0-9_-]/g, ''))
    .filter(Boolean)
    .join('|');

/* ═══ State ═══ */
const S = {
    connected: false,
    title: '',
    artist: '',
    position: 0,
    duration: 0,
    isPlaying: false,
    lyrics: null,
    lyricsSource: '',
    trackKey: '',
    lastTick: Date.now(),
    lastBridgeAt: 0,
    bridgeMode: '',
    noneSince: 0,
    candidateKey: '',
    candidateCount: 0,
    smtc: false,
};
const NONE_GRACE_MS = 2500;   // ignore short "no player" gaps
const TRACK_CONFIRM_TICKS = 1; // commit a new title immediately
let allowExternal = false; // false = LAN only, true = allow internet clients

const clients = new Set();
const lyricsCache = new Map(); // key -> {value, at} (small LRU)
const pendingLyrics = new Map();
const localLRC = new Map();
const logs = [];

const CACHE_MAX = 400;
const CACHE_NULL_TTL = 10 * 60 * 1000;
const LOG_FILE = process.env.LF_LOG_FILE || '';

/* Writable runtime directory.
 * %TEMP% can be blocked in sandboxed/service contexts. Prefer a folder next to
 * the server, then the user profile, then temp, and remember the first one that
 * accepts a test write. */
let runtimeDir = null;

function isWritableDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.lf-write-test');
        fs.writeFileSync(probe, String(process.pid), 'utf8');
        fs.unlinkSync(probe);
        return true;
    } catch (e) {
        return false;
    }
}

function getRuntimeDir() {
    if (runtimeDir) return runtimeDir;
    const candidates = [];
    if (process.env.LF_RUNTIME_DIR) candidates.push(process.env.LF_RUNTIME_DIR);
    if (__dirname.indexOf('.asar') === -1) candidates.push(path.join(__dirname, '.lyricflow-runtime'));
    try { candidates.push(path.join(os.homedir(), '.lyricflow-runtime')); } catch (e) { /* ignore */ }
    candidates.push(path.join(os.tmpdir(), 'lyricflow-runtime'));
    candidates.push(process.cwd());
    for (const dir of candidates) {
        if (isWritableDir(dir)) {
            runtimeDir = dir;
            return dir;
        }
    }
    runtimeDir = os.tmpdir();
    return runtimeDir;
}

/* ═══ Helpers ═══ */
function log(message) {
    const line = '[' + new Date().toLocaleTimeString() + '] ' + message;
    console.log('  ' + line);
    logs.push(line);
    if (logs.length > 300) logs.shift();
    if (LOG_FILE) {
        try { fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8'); } catch (e) { /* ignore */ }
    }
    broadcast('log', { message: line });
}

function broadcast(type, data) {
    if (clients.size === 0) return;
    const msg = JSON.stringify({ type, data });
    clients.forEach((ws) => {
        if (ws.readyState === 1) {
            try { ws.send(msg); } catch (e) { /* client went away */ }
        }
    });
}

function normalizeAddr(addr) {
    if (!addr) return '';
    let a = String(addr);
    if (a.startsWith('::ffff:')) a = a.substring(7);
    return a;
}

/**
 * True for loopback/LAN addresses. IPv4-mapped IPv6 and IPv6 ULA/link-local
 * addresses are handled too, so a phone on the same Wi-Fi keeps working.
 */
function isLocalAddr(addr) {
    const a = normalizeAddr(addr);
    if (!a) return true;
    if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true;
    if (/^127\./.test(a)) return true;
    if (a.startsWith('192.168.')) return true;
    if (a.startsWith('10.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
    if (/^169\.254\./.test(a)) return true;
    const lower = a.toLowerCase();
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower === '::' ) return true;
    return false;
}

function isLoopback(addr) {
    const a = normalizeAddr(addr);
    return !a || a === '127.0.0.1' || a === '::1' || /^127\./.test(a);
}

/* ═══ LRC parser ═══ */
function timeTagToSeconds(inner) {
    const match = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(inner);
    if (!match) return NaN;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    let ms = 0;
    if (match[3]) {
        const frac = match[3];
        if (frac.length === 1) ms = parseInt(frac, 10) * 100;
        else if (frac.length === 2) ms = parseInt(frac, 10) * 10;
        else ms = parseInt(frac, 10);
    }
    return minutes * 60 + seconds + ms / 1000;
}

/**
 * Parse LRC text into { lyrics: [{time, text}], meta }.
 * Handles multiple timestamps per line, [mm:ss.xx], [mm:ss:xx] and
 * metadata tags including [offset:...].
 */
function parseLRC(text) {
    if (!text || typeof text !== 'string') return { lyrics: [], meta: {} };
    if (text.length > MAX_LYRICS_BYTES) text = text.slice(0, MAX_LYRICS_BYTES);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const meta = {};
    const lyrics = [];
    const lines = text.split(/\r?\n|\r/);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw) continue;

        let cursor = 0;
        let sawTime = false;
        const times = [];

        while (raw.charCodeAt(cursor) === 91 /* [ */) {
            const close = raw.indexOf(']', cursor + 1);
            if (close === -1) break;
            const inner = raw.slice(cursor + 1, close).trim();

            if (/^\d{1,3}:\d{1,2}([.:]\d{1,3})?$/.test(inner)) {
                const t = timeTagToSeconds(inner);
                if (!isNaN(t)) { times.push(t); sawTime = true; }
                cursor = close + 1;
                continue;
            }

            const colon = inner.indexOf(':');
            if (colon > 0 && /^[A-Za-z#]+$/.test(inner.slice(0, colon))) {
                const key = inner.slice(0, colon).toLowerCase();
                meta[key] = inner.slice(colon + 1).trim();
                cursor = close + 1;
                continue;
            }
            break;
        }

        if (!sawTime || times.length === 0) continue;
        const body = raw.slice(cursor).trim();
        if (!body) continue;
        for (let t = 0; t < times.length; t++) {
            lyrics.push({ time: Math.round(times[t] * 1000) / 1000, text: body });
        }
    }

    // [offset:+250] means "show lyrics 250ms earlier" in most players.
    const offset = parseInt(meta.offset, 10);
    if (offset && !isNaN(offset)) {
        for (let i = 0; i < lyrics.length; i++) {
            lyrics[i].time = Math.max(0, Math.round((lyrics[i].time - offset / 1000) * 1000) / 1000);
        }
    }

    lyrics.sort((a, b) => a.time - b.time);
    return { lyrics, meta };
}

/* ═══ HTTP client ═══ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function requestJson(url, options) {
    const opts = options || {};
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        let parsed;
        try { parsed = new URL(url); } catch (e) { return done({ status: 0, data: null }); }
        const transport = parsed.protocol === 'http:' ? http : https;

        timer = setTimeout(() => done({ status: 0, data: null }), opts.timeout || 10000);

        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: parsed.pathname + parsed.search,
            method: opts.method || 'GET',
            headers: Object.assign({
                'User-Agent': UA,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Encoding': 'gzip, deflate',
            }, opts.headers || {}),
        }, (res) => {
            if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, parsed).toString();
                if ((opts.redirects || 0) >= 3) return done({ status: res.statusCode, data: null });
                return requestJson(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })).then(done);
            }

            let stream = res;
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

            const chunks = [];
            let size = 0;
            stream.on('data', (chunk) => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) { req.destroy(); return done({ status: 0, data: null }); }
                chunks.push(chunk);
            });
            stream.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = JSON.parse(text); } catch (e) { data = null; }
                done({ status: res.statusCode, data });
            });
            stream.on('error', () => done({ status: 0, data: null }));
        });

        req.on('error', () => done({ status: 0, data: null }));
        req.on('timeout', () => { req.destroy(); done({ status: 0, data: null }); });
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

/* ═══ Providers ═══ */
async function fetchLRCLIB(title, artist) {
    log('LRCLIB: ' + (artist || '?') + ' - ' + title);
    let query = 'track_name=' + encodeURIComponent(title);
    if (artist) query += '&artist_name=' + encodeURIComponent(artist);

    let res = await requestJson('https://lrclib.net/api/get?' + query);
    if (res.status === 200 && res.data && res.data.syncedLyrics) {
        const parsed = parseLRC(res.data.syncedLyrics);
        if (parsed.lyrics.length) {
            log('LRCLIB: ' + parsed.lyrics.length + ' lines');
            return { lyrics: parsed.lyrics, meta: parsed.meta, source: 'lrclib' };
        }
    }

    res = await requestJson('https://lrclib.net/api/search?' + query);
    if (res.status === 200 && Array.isArray(res.data)) {
        for (let i = 0; i < res.data.length; i++) {
            if (!res.data[i].syncedLyrics) continue;
            const parsed = parseLRC(res.data[i].syncedLyrics);
            if (parsed.lyrics.length) return { lyrics: parsed.lyrics, meta: parsed.meta, source: 'lrclib' };
        }
    }
    return null;
}

async function fetchNetEase(title, artist) {
    const keyword = (artist ? artist + ' ' : '') + title;
    log('NetEase: ' + keyword);
    const body = 's=' + encodeURIComponent(keyword) + '&type=1&limit=5&offset=0';
    const search = await requestJson('https://music.163.com/api/search/get', {
        method: 'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            'Referer': 'https://music.163.com',
        },
    });
    const songs = search.status === 200 && search.data && search.data.result && search.data.result.songs;
    if (!songs || !songs.length) return null;

    const wanted = title.toLowerCase();
    let best = songs[0];
    for (let i = 0; i < songs.length; i++) {
        if (songs[i].name && songs[i].name.toLowerCase() === wanted) { best = songs[i]; break; }
    }

    const lyric = await neteaseLyricGet(best.id);
    if (!lyric) return null;
    const parsed = parseLRC(lyric);
    if (!parsed.lyrics.length) return null;
    const artists = best.artists ? best.artists.map((a) => a.name).join(', ') : artist;
    return { lyrics: parsed.lyrics, meta: { ti: title, ar: artists }, source: 'netease' };
}

function neteaseLyricGet(id) {
    const url = 'https://music.163.com/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=1&kv=1&tv=-1';
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => done(null), 10000);
        const req = https.get(url, {
            headers: {
                'User-Agent': UA,
                'Referer': 'https://music.163.com',
                'Accept': '*/*',
                'Cookie': 'os=pc; appver=2.9.7',
                'Accept-Encoding': 'gzip, deflate',
            },
            timeout: 9000,
        }, (res) => {
            let stream = res;
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    for (const key of ['lrc', 'klyric', 'tlyric']) {
                        const value = json[key];
                        if (value && typeof value === 'object' && value.lyric && value.lyric.trim().length > 5) {
                            return done(value.lyric);
                        }
                    }
                    done(null);
                } catch (e) { done(null); }
            });
            stream.on('error', () => done(null));
        });
        req.on('error', () => done(null));
        req.on('timeout', () => { req.destroy(); done(null); });
    });
}

async function searchLRCLIB(track, artist) {
    let query = 'track_name=' + encodeURIComponent(track);
    if (artist) query += '&artist_name=' + encodeURIComponent(artist);
    const res = await requestJson('https://lrclib.net/api/search?' + query);
    return res.status === 200 && Array.isArray(res.data) ? res.data : [];
}

async function searchNetEase(track, artist) {
    const keyword = (artist ? artist + ' ' : '') + track;
    const body = 's=' + encodeURIComponent(keyword) + '&type=1&limit=8&offset=0';
    const search = await requestJson('https://music.163.com/api/search/get', {
        method: 'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            'Referer': 'https://music.163.com',
        },
    });
    const songs = search.status === 200 && search.data && search.data.result && search.data.result.songs;
    if (!songs || !songs.length) return [];

    const results = await Promise.all(songs.map(async (song) => {
        const lyric = await neteaseLyricGet(song.id);
        return {
            trackName: song.name || '',
            artistName: (song.artists || []).map((a) => a.name).join(', '),
            albumName: song.album ? song.album.name : '',
            duration: song.duration ? Math.round(song.duration / 1000) : 0,
            hasSynced: !!lyric,
            syncedLyrics: lyric,
            plainLyrics: null,
        };
    }));
    return results.filter((r) => r.hasSynced);
}

/* ═══ Local .lrc index ═══ */
function lrcKey(artist, title) {
    return ((artist || '') + '|||' + (title || '')).toLowerCase().trim();
}

async function buildLRCIndex(dir) {
    if (!dir) return;
    let count = 0;
    const stack = [[dir, 0]];

    while (stack.length) {
        const [current, depth] = stack.pop();
        let entries;
        try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch (e) { continue; }

        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (depth < 5 && !entry.name.startsWith('.')) stack.push([full, depth + 1]);
                continue;
            }
            if (!/\.lrc$/i.test(entry.name)) continue;
            const base = entry.name.replace(/\.lrc$/i, '');
            const sep = base.indexOf(' - ');
            const artist = sep > 0 ? base.slice(0, sep).trim() : '';
            const title = sep > 0 ? base.slice(sep + 3).trim() : base;
            localLRC.set(lrcKey(artist, title), full);
            count++;
        }
        // Keep the event loop responsive while indexing a big library.
        await new Promise((resolve) => setImmediate(resolve));
    }
    log('lrc index: ' + count + ' files');
}

function findLocalLRC(title, artist) {
    if (!title) return null;
    const titleKey = title.toLowerCase().trim();
    const artistKey = (artist || '').toLowerCase().trim();

    const direct = localLRC.get(lrcKey(artistKey, titleKey)) || localLRC.get(lrcKey('', titleKey));
    if (direct) {
        try { return fs.readFileSync(direct, 'utf8'); } catch (e) { /* ignore */ }
    }
    for (const [key, file] of localLRC) {
        if (key.indexOf(titleKey) !== -1) {
            try { return fs.readFileSync(file, 'utf8'); } catch (e) { /* ignore */ }
        }
    }
    return null;
}

/* ═══ Lyrics manager ═══ */
function cacheSet(key, value) {
    lyricsCache.delete(key);
    lyricsCache.set(key, { value, at: Date.now() });
    while (lyricsCache.size > CACHE_MAX) {
        const oldest = lyricsCache.keys().next().value;
        lyricsCache.delete(oldest);
    }
}

function cacheGet(key) {
    const item = lyricsCache.get(key);
    if (!item) return undefined;
    if (item.value === null && Date.now() - item.at > CACHE_NULL_TTL) {
        lyricsCache.delete(key);
        return undefined;
    }
    // Refresh recency.
    lyricsCache.delete(key);
    lyricsCache.set(key, item);
    return item.value;
}

function ensureLyrics(title, artist) {
    const key = lrcKey(artist, title);
    const cached = cacheGet(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (pendingLyrics.has(key)) return pendingLyrics.get(key);

    broadcast('lyrics', { lyrics: null, source: 'loading' });

    const task = (async () => {
        if (MUSIC_DIR) {
            const raw = findLocalLRC(title, artist);
            if (raw) {
                const parsed = parseLRC(raw);
                if (parsed.lyrics.length) {
                    const result = { lyrics: parsed.lyrics, meta: parsed.meta, source: 'local' };
                    cacheSet(key, result);
                    return result;
                }
            }
        }
        const fromLrclib = await fetchLRCLIB(title, artist);
        if (fromLrclib && fromLrclib.lyrics.length) { cacheSet(key, fromLrclib); return fromLrclib; }

        const fromNetEase = await fetchNetEase(title, artist);
        if (fromNetEase && fromNetEase.lyrics.length) { cacheSet(key, fromNetEase); return fromNetEase; }

        // Window titles from browsers or unusual players often mis-parse the
        // artist. Retry with the song title alone before giving up.
        if (artist) {
            const titleOnlyLrclib = await fetchLRCLIB(title, '');
            if (titleOnlyLrclib && titleOnlyLrclib.lyrics.length) { cacheSet(key, titleOnlyLrclib); return titleOnlyLrclib; }

            const titleOnlyNetEase = await fetchNetEase(title, '');
            if (titleOnlyNetEase && titleOnlyNetEase.lyrics.length) { cacheSet(key, titleOnlyNetEase); return titleOnlyNetEase; }
        }

        cacheSet(key, null);
        return null;
    })();

    pendingLyrics.set(key, task);
    task.then(() => pendingLyrics.delete(key), () => pendingLyrics.delete(key));
    return task;
}

/* ═══ Media bridge ═══ */
let bridgeProc = null;
let bridgeRestartDelay = 1000;
let bridgeRestartTimer = null;
let bridgeScriptPath = '';
let bridgeOutFile = '';
let bridgePollTimer = null;
let bridgeReadOffset = 0;
let bridgeLineBuf = '';
let bridgeReading = false;
// Pipes are the fast path; restricted environments (some sandboxes/services)
// deny pipe creation, so fall back to a file that Node polls.
let bridgeTransport = process.env.LF_BRIDGE_FILE === '1' ? 'file' : 'pipe';

function bridgeScript(fileMode) {
    const head = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    ];
    if (fileMode) {
        head.push('$outFile = "' + bridgeOutFile.replace(/"/g, '`"') + '"');
        head.push('$utf8 = New-Object System.Text.UTF8Encoding($false)');
        head.push('[System.IO.File]::WriteAllText($outFile, "", $utf8)');
    }
    const tail = [
        '  $line = $obj | ConvertTo-Json -Compress -Depth 4',
    ];
    if (fileMode) {
        tail.push('  [System.IO.File]::AppendAllText($outFile, $line + "`r`n", $utf8)');
        tail.push('  if (($loop % 500) -eq 0) {');
        tail.push('    try { if ((Get-Item -LiteralPath $outFile).Length -gt 1048576) { [System.IO.File]::WriteAllText($outFile, "", $utf8) } } catch {}');
        tail.push('  }');
    } else {
        tail.push('  Write-Output $line');
    }
    tail.push('  Start-Sleep -Milliseconds 300');
    tail.push('}');

    return head.concat([
        '$ok = $true',
        'try {',
        '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
        '  $asTask = $null',
        '  foreach ($m in [System.WindowsRuntimeSystemExtensions].GetMethods()) {',
        "    if ($m.Name -eq 'AsTask') {",
        '      $p = $m.GetParameters()',
        "      if ($p.Count -eq 1 -and $p[0].ParameterType.Name -eq 'IAsyncOperation`1') { $asTask = $m; break }",
        '    }',
        '  }',
        '  if ($null -eq $asTask) { $ok = $false }',
        '  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null',
        '} catch { $ok = $false }',
        '',
        'function Await($t, $r) {',
        '  $g = $asTask.MakeGenericMethod($r)',
        '  return $g.Invoke($null, @($t)).GetAwaiter().GetResult()',
        '}',
        '',
        '$manager = $null',
        '$sid = ""',
        '$title = ""',
        '$artist = ""',
        '$loop = 0',
        '$winObj = $null',
        "$players = '^(" + PLAYER_PATTERN + ")$'",
        'while ($true) {',
        '  $obj = $null',
        '  if ($ok) {',
        '    try {',
        '      if ($null -eq $manager) {',
        '        $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
        '      }',
        '      $session = $manager.GetCurrentSession()',
        '      if ($null -ne $session) {',
        '        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
        '        if ($null -ne $props) { $title = $props.Title; $artist = $props.Artist }',
        '        $sid = $session.SourceAppUserModelId',
        '        $playback = $session.GetPlaybackInfo()',
        '        $timeline = $session.GetTimelineProperties()',
        '        $obj = [ordered]@{',
        "          src = 'smtc'",
        '          st = $playback.PlaybackStatus.ToString()',
        '          t = $title',
        '          a = $artist',
        '          p = [math]::Round($timeline.Position.TotalSeconds, 2)',
        '          d = [math]::Round($timeline.EndTime.TotalSeconds, 2)',
        '        }',
        '      }',
        '    } catch { $manager = $null; $sid = "" }',
        '  }',
        '  $loop = $loop + 1',
        '  if ($null -eq $obj) {',
        '    if (($loop % 2) -eq 0) {',
        '      $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object {',
        '        ($_.Name -match $players) -and $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 2',
        '      } | Select-Object -First 1',
        '      if ($null -ne $proc) {',
        '        $winObj = [ordered]@{ src = "win"; st = "Unknown"; t = $proc.MainWindowTitle; a = ""; p = -1; d = 0; smtc = $ok }',
        '      } else {',
        '        $winObj = $null',
        '      }',
        '    }',
        '    if ($null -ne $winObj) { $obj = $winObj }',
        '    if ($null -eq $obj) { $obj = [ordered]@{ e = "none"; smtc = $ok } }',
        '  }',
    ].concat(tail)).join('\r\n');
}

function stopBridge() {
    if (bridgeRestartTimer) { clearTimeout(bridgeRestartTimer); bridgeRestartTimer = null; }
    stopBridgeFilePoll();
    if (bridgeProc) {
        const proc = bridgeProc;
        bridgeProc = null;
        try { proc.kill(); } catch (e) { /* ignore */ }
    }
    if (bridgeScriptPath) {
        try { fs.unlinkSync(bridgeScriptPath); } catch (e) { /* ignore */ }
        bridgeScriptPath = '';
    }
    if (bridgeOutFile) {
        try { fs.unlinkSync(bridgeOutFile); } catch (e) { /* ignore */ }
        bridgeOutFile = '';
    }
}

function markDisconnected(reason) {
    if (!S.connected && !S.title) return;
    S.connected = false;
    S.isPlaying = false;
    S.position = 0;
    S.duration = 0;
    S.trackKey = '';
    S.title = '';
    S.artist = '';
    S.lyrics = null;
    S.lyricsSource = '';
    S.noneSince = 0;
    S.candidateKey = '';
    S.candidateCount = 0;
    broadcast('status', { connected: false });
    broadcast('track', { title: '', artist: '' });
    if (reason) log('Media lost: ' + reason);
}

function scheduleBridgeRestart() {
    if (bridgeRestartTimer) return;
    const delay = bridgeRestartDelay;
    bridgeRestartDelay = Math.min(bridgeRestartDelay * 2, 30000);
    log('Bridge restart in ' + Math.round(delay / 1000) + 's');
    bridgeRestartTimer = setTimeout(() => {
        bridgeRestartTimer = null;
        startBridge();
    }, delay);
    if (bridgeRestartTimer.unref) bridgeRestartTimer.unref();
}

function handleBridgeLine(line) {
    if (!line || line.charAt(0) !== '{') return;
    let message;
    try { message = JSON.parse(line); } catch (e) { return; }
    bridgeRestartDelay = 1000;
    S.lastBridgeAt = Date.now();
    handleMediaUpdate(message);
}

function startBridge() {
    if (process.env.LF_NO_BRIDGE === '1') {
        log('Media bridge disabled (LF_NO_BRIDGE=1)');
        return;
    }
    if (PLAT !== 'win32' && PLAT !== 'linux') {
        log('Media bridge: unsupported platform ' + PLAT);
        return;
    }
    if (bridgeProc) return;
    if (PLAT === 'win32' && bridgeTransport === 'file') return startFileBridge();
    return startPipeBridge();
}

function startPipeBridge() {
    let command;
    let args;
    try {
        if (PLAT === 'win32') {
            bridgeScriptPath = path.join(getRuntimeDir(), 'lyricflow_bridge_' + process.pid + '.ps1');
            fs.writeFileSync(bridgeScriptPath, '\uFEFF' + bridgeScript(false), 'utf8');
            command = 'powershell.exe';
            args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgeScriptPath];
        } else {
            bridgeScriptPath = path.join(getRuntimeDir(), 'lyricflow_bridge_' + process.pid + '.sh');
            fs.writeFileSync(bridgeScriptPath, [
                '#!/bin/bash',
                'while true; do',
                '  T=$(playerctl metadata xesam:title 2>/dev/null)',
                '  A=$(playerctl metadata xesam:artist 2>/dev/null)',
                '  if [ -n "$T" ]; then',
                '    printf \'{"src":"win","st":"Unknown","t":"%s","a":"%s","p":-1,"d":0}\\n\' "$T" "$A"',
                '  else',
                '    echo \'{"e":"none"}\'',
                '  fi',
                '  sleep 0.7',
                'done',
            ].join('\n'), 'utf8');
            command = 'bash';
            args = [bridgeScriptPath];
        }
    } catch (e) {
        log('Bridge script failed: ' + e.message);
        scheduleBridgeRestart();
        return;
    }

    let proc;
    try {
        proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        // Some restricted environments deny pipe creation; use the file channel.
        log('Bridge pipes unavailable: ' + e.message);
        if (PLAT === 'win32') {
            bridgeTransport = 'file';
            log('Switching media bridge to file mode');
            startBridge();
        } else {
            scheduleBridgeRestart();
        }
        return;
    }

    bridgeProc = proc;
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).replace(/^\uFEFF/, '').trim();
            buffer = buffer.slice(index + 1);
            handleBridgeLine(line);
        }
    });
    proc.stderr.on('data', () => { /* PowerShell noise; ignored on purpose */ });
    proc.on('error', (err) => {
        if (bridgeProc === proc) bridgeProc = null;
        log('Bridge error: ' + err.message);
        if (PLAT === 'win32' && err && (err.code === 'EPERM' || err.code === 'EACCES')) {
            bridgeTransport = 'file';
            log('Switching media bridge to file mode');
            startBridge();
            return;
        }
        scheduleBridgeRestart();
    });
    proc.on('close', (code) => {
        if (bridgeProc !== proc) return;
        bridgeProc = null;
        log('Bridge exited (' + code + ')');
        markDisconnected('bridge exited');
        scheduleBridgeRestart();
    });

    log('Media bridge started (pipe mode)');
}

/* File fallback: PowerShell appends one JSON line per tick, Node polls it. */
function startBridgeFilePoll() {
    stopBridgeFilePoll();
    bridgeReadOffset = 0;
    bridgeLineBuf = '';
    bridgeReading = false;
    bridgePollTimer = setInterval(readBridgeFile, 250);
    if (bridgePollTimer.unref) bridgePollTimer.unref();
}

function stopBridgeFilePoll() {
    if (bridgePollTimer) {
        clearInterval(bridgePollTimer);
        bridgePollTimer = null;
    }
    bridgeReading = false;
}

function readBridgeFile() {
    if (bridgeReading || !bridgeOutFile) return;
    bridgeReading = true;
    fs.stat(bridgeOutFile, (err, stat) => {
        if (err || !stat.size) { bridgeReading = false; return; }
        if (stat.size < bridgeReadOffset) {
            // File was rotated/truncated by the writer.
            bridgeReadOffset = 0;
            bridgeLineBuf = '';
        }
        if (stat.size === bridgeReadOffset) { bridgeReading = false; return; }

        const chunks = [];
        const stream = fs.createReadStream(bridgeOutFile, { start: bridgeReadOffset, end: stat.size - 1 });
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', () => { bridgeReading = false; });
        stream.on('end', () => {
            bridgeReadOffset = stat.size;
            bridgeLineBuf += Buffer.concat(chunks).toString('utf8');
            let index;
            while ((index = bridgeLineBuf.indexOf('\n')) !== -1) {
                const line = bridgeLineBuf.slice(0, index).replace(/^\uFEFF/, '').trim();
                bridgeLineBuf = bridgeLineBuf.slice(index + 1);
                handleBridgeLine(line);
            }
            if (bridgeLineBuf.length > 65536) bridgeLineBuf = '';
            bridgeReading = false;
        });
    });
}

function startFileBridge() {
    bridgeOutFile = path.join(getRuntimeDir(), 'lyricflow_bridge_' + process.pid + '.jsonl');
    bridgeScriptPath = path.join(getRuntimeDir(), 'lyricflow_bridge_' + process.pid + '.ps1');
    try {
        fs.writeFileSync(bridgeScriptPath, '\uFEFF' + bridgeScript(true), 'utf8');
    } catch (e) {
        log('Bridge script failed: ' + e.message);
        scheduleBridgeRestart();
        return;
    }
    try { fs.unlinkSync(bridgeOutFile); } catch (e) { /* first run */ }

    let proc;
    try {
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgeScriptPath], {
            windowsHide: true,
            stdio: 'ignore',
        });
    } catch (e) {
        log('Bridge could not start: ' + e.message);
        scheduleBridgeRestart();
        return;
    }

    bridgeProc = proc;
    startBridgeFilePoll();

    proc.on('error', (err) => {
        if (bridgeProc === proc) bridgeProc = null;
        stopBridgeFilePoll();
        log('Bridge error: ' + err.message);
        scheduleBridgeRestart();
    });
    proc.on('close', (code) => {
        if (bridgeProc !== proc) return;
        bridgeProc = null;
        stopBridgeFilePoll();
        log('Bridge exited (' + code + ')');
        markDisconnected('bridge exited');
        scheduleBridgeRestart();
    });

    log('Media bridge started (file mode)');
}

function cleanWindowTitle(raw) {
    let title = String(raw || '').trim();
    const suffixes = [
        ' - 网易云音乐', ' - QQ音乐', ' - Spotify', ' - VLC media player', ' - foobar2000',
        ' - MusicBee', ' - AIMP', ' - Microsoft Edge', ' - Google Chrome', ' - Mozilla Firefox',
        ' - Brave', ' - Opera', ' - Vivaldi', ' - YouTube', ' - 哔哩哔哩', ' - bilibili',
    ];
    for (const suffix of suffixes) {
        if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
    return title;
}

function resetCandidate() {
    S.candidateKey = '';
    S.candidateCount = 0;
}

/** Commit a track change, reset the lyrics view and start the lookup. */
function applyTrack(title, artist, key, position, duration) {
    S.trackKey = key;
    S.title = title;
    S.artist = artist;
    S.position = typeof position === 'number' && position >= 0 ? position : 0;
    S.duration = typeof duration === 'number' && duration > 0 ? duration : 0;
    S.lyrics = null;
    S.lyricsSource = '';
    log('Track: ' + (artist || '?') + ' - ' + title);
    broadcast('track', { title, artist });

    ensureLyrics(title, artist).then((result) => {
        // Ignore a slow answer if the user already switched songs.
        if (S.trackKey !== key) return;
        if (result && result.lyrics.length) {
            S.lyrics = result.lyrics;
            S.lyricsSource = result.source;
            const lastLine = result.lyrics[result.lyrics.length - 1].time;
            if (!S.duration) S.duration = lastLine + 15;
            broadcast('lyrics', { lyrics: result.lyrics, source: result.source });
            log('Lyrics: ' + result.source + ' ' + result.lyrics.length + ' lines');
        } else {
            broadcast('lyrics', { lyrics: null, source: 'not_found' });
        }
    });
}

function handleMediaUpdate(message) {
    if (!message || typeof message !== 'object') return;

    if (message.e === 'none') {
        if (typeof message.smtc === 'boolean') S.smtc = message.smtc;
        if (!S.connected) {
            S.noneSince = 0;
            resetCandidate();
            return;
        }
        // A single missed poll is normal (window scans run every few ticks);
        // only report "no player" after a short grace period.
        if (!S.noneSince) S.noneSince = Date.now();
        if (Date.now() - S.noneSince >= NONE_GRACE_MS) markDisconnected('no active player');
        return;
    }
    S.noneSince = 0;

    let title = typeof message.t === 'string' ? message.t : '';
    let artist = typeof message.a === 'string' ? message.a : '';
    if (!artist) {
        // Window titles from Chinese players use "song - artist".
        const raw = cleanWindowTitle(title);
        const sep = raw.indexOf(' - ');
        if (sep > 0 && sep < raw.length - 3) {
            title = raw.slice(0, sep).trim();
            artist = raw.slice(sep + 3).trim();
        } else {
            title = raw;
            artist = '';
        }
    } else {
        title = cleanWindowTitle(title);
    }
    if (!title) return;

    const now = Date.now();
    const elapsed = Math.min((now - S.lastTick) / 1000, 5);
    S.lastTick = now;

    const status = String(message.st || '').toLowerCase();
    const playing = status === 'playing' || status === 'unknown' || status === '';
    const key = lrcKey(artist, title);
    const wasConnected = S.connected;

    S.connected = true;
    S.isPlaying = playing;
    S.bridgeMode = message.src === 'smtc' ? 'smtc' : 'window';
    if (typeof message.smtc === 'boolean') S.smtc = message.smtc;
    else if (message.src === 'smtc') S.smtc = true;
    if (!wasConnected) broadcast('status', { connected: true });

    if (key === S.trackKey) {
        resetCandidate();
        if (S.title !== title) S.title = title;
        if (S.artist !== artist) S.artist = artist;
        if (typeof message.p === 'number' && message.p >= 0) {
            S.position = message.p;
        } else if (playing) {
            S.position += elapsed;
        }
        if (typeof message.d === 'number' && message.d > 0) S.duration = message.d;
    } else if (S.candidateKey === key) {
        S.candidateCount += 1;
        if (!S.trackKey || S.candidateCount >= TRACK_CONFIRM_TICKS) {
            resetCandidate();
            applyTrack(title, artist, key, message.p, message.d);
        }
    } else {
        S.candidateKey = key;
        S.candidateCount = 1;
        if (S.candidateCount >= TRACK_CONFIRM_TICKS) {
            resetCandidate();
            applyTrack(title, artist, key, message.p, message.d);
        }
    }

    broadcast('position', {
        position: Math.round(S.position * 100) / 100,
        isPlaying: S.isPlaying,
        duration: Math.round(S.duration * 100) / 100,
    });
}

/* ═══ Media keys ═══ */
const MEDIA_VK = { toggle: 179, next: 176, prev: 177 };
let keyProc = null;

function keyHelperScript() {
    return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -TypeDefinition @'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class LFKey {',
        '    [DllImport("user32.dll")]',
        '    public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);',
        '    public static void Press(byte vk) {',
        '        keybd_event(vk, 0, 0, 0);',
        '        keybd_event(vk, 0, 2, 0);',
        '    }',
        '}',
        "'@",
        'while ($true) {',
        '  $line = [Console]::In.ReadLine()',
        '  if ($null -eq $line) { break }',
        '  $line = $line.Trim()',
        '  switch ($line) {',
        "    'toggle' { [LFKey]::Press([byte]179) }",
        "    'next'   { [LFKey]::Press([byte]176) }",
        "    'prev'   { [LFKey]::Press([byte]177) }",
        '  }',
        '}',
    ].join('\r\n');
}

function ensureKeyHelper() {
    if (PLAT !== 'win32' || keyProc) return keyProc;
    const file = path.join(getRuntimeDir(), 'lyricflow_keys_' + process.pid + '.ps1');
    try {
        fs.writeFileSync(file, '\uFEFF' + keyHelperScript(), 'utf8');
    } catch (e) {
        return null;
    }
    let proc;
    try {
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
    } catch (e) {
        return null;
    }
    proc.on('error', () => { if (keyProc === proc) keyProc = null; });
    proc.on('close', () => {
        if (keyProc === proc) keyProc = null;
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    });
    keyProc = proc;
    return proc;
}

function sendMediaKeyLegacy(vk) {
    const script = "Add-Type @'\r\nusing System;\r\nusing System.Runtime.InteropServices;\r\npublic class K {\r\n    [DllImport(\"user32.dll\")]\r\n    public static extern void keybd_event(byte b, byte s, int f, int e);\r\n}\r\n'@\r\n[K]::keybd_event(" + vk + ",0,0,0)\r\n[K]::keybd_event(" + vk + ",0,2,0)";
    const file = path.join(getRuntimeDir(), 'lyricflow_key_' + process.pid + '_' + (++sendMediaKeyLegacy.counter) + '.ps1');
    try {
        fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
        const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
            windowsHide: true,
            stdio: 'ignore',
        });
        proc.on('close', () => { try { fs.unlinkSync(file); } catch (e) { /* ignore */ } });
        proc.on('error', () => { try { fs.unlinkSync(file); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
}
sendMediaKeyLegacy.counter = 0;

function sendMediaKey(key) {
    const vk = MEDIA_VK[key];
    if (!vk) return false;
    if (PLAT === 'win32') {
        const helper = ensureKeyHelper();
        if (helper && helper.stdin && helper.stdin.writable) {
            try { helper.stdin.write(key + '\n'); return true; }
            catch (e) { /* helper died; fall through */ }
        }
        sendMediaKeyLegacy(vk);
        return true;
    }
    if (PLAT === 'linux') {
        const map = { toggle: 'play-pause', next: 'next', prev: 'previous' };
        spawn('playerctl', [map[key]], { stdio: 'ignore' }).on('error', () => {});
        return true;
    }
    return false;
}

/* ═══ HTTP server ═══ */
let HTML = '';
let ADMIN_HTML = null;
let HTML_GZIP = null;
let GUI_HTML = null;
let GUI_GZIP = null;
let VENDOR_JS = null;
let VENDOR_JS_GZIP = null;
try { HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); }
catch (e) { console.error('  index.html not found'); process.exit(1); }
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch (e) { /* optional */ }
try { GUI_HTML = fs.readFileSync(path.join(__dirname, 'gui.html'), 'utf8'); } catch (e) { /* optional */ }
try { HTML_GZIP = zlib.gzipSync(Buffer.from(HTML, 'utf8')); } catch (e) { /* ignore */ }
try { if (GUI_HTML) GUI_GZIP = zlib.gzipSync(Buffer.from(GUI_HTML, 'utf8')); } catch (e) { /* ignore */ }
try {
    VENDOR_JS = fs.readFileSync(path.join(__dirname, 'vendor', 'opencc-t2cn.js'));
    VENDOR_JS_GZIP = zlib.gzipSync(VENDOR_JS);
} catch (e) { /* optional */ }

const MUTATING_ENDPOINTS = new Set(['/api/key', '/api/shutdown', '/api/clear-cache', '/api/ext', '/api/manual-track']);

function normalizeHost(parsed) {
    return String(parsed.hostname || '').replace(/^\[|\]$/g, '');
}

function corsOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return null;
    if (origin === 'null') return 'null'; // file:// (Electron GUI) or sandboxed page
    try {
        const parsed = new URL(origin);
        if (parsed.protocol === 'file:') return 'null';
        const host = normalizeHost(parsed);
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || isLocalAddr(host)) return origin;
    } catch (e) { /* ignore */ }
    return null;
}

function isTrustedReferer(value) {
    if (!value) return true;
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'file:') return true;
        const host = normalizeHost(parsed);
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || isLocalAddr(host);
    } catch (e) {
        return false;
    }
}

function answer(res, status, type, body, extra) {
    const headers = Object.assign({
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    }, extra || {});
    res.writeHead(status, headers);
    res.end(body);
}

function answerJson(res, status, value) {
    answer(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function answerHtml(req, res, html, gzipBody) {
    const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Vary': 'Accept-Encoding',
    };
    const wantsGzip = gzipBody && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (wantsGzip) {
        headers['Content-Encoding'] = 'gzip';
        answer(res, 200, 'text/html; charset=utf-8', gzipBody, headers);
    } else {
        answer(res, 200, 'text/html; charset=utf-8', html, headers);
    }
}

let cachedAddresses = null;

function getAddresses() {
    if (cachedAddresses) return cachedAddresses;
    const httpsEnabled = String(process.env.LF_HTTPS || '') !== '0';
    const list = [
        { tag: '本机', url: 'http://localhost:' + PORT },
        { tag: '本机', url: 'http://127.0.0.1:' + PORT },
    ];
    if (httpsEnabled) list.push({ tag: 'HTTPS', url: 'https://localhost:' + HTTPS_PORT });

    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach((name) => {
        (interfaces[name] || []).forEach((iface) => {
            if (iface.internal) return;
            if (iface.family === 'IPv4') {
                list.push({ tag: name, url: 'http://' + iface.address + ':' + PORT });
                if (httpsEnabled) list.push({ tag: name + ' S', url: 'https://' + iface.address + ':' + HTTPS_PORT });
            } else if (iface.family === 'IPv6') {
                const address = String(iface.address).split('%')[0];
                list.push({ tag: name + ' v6', url: 'http://[' + address + ']:' + PORT });
                if (httpsEnabled && iface.address.indexOf('%') === -1) {
                    list.push({ tag: name + ' v6s', url: 'https://[' + address + ']:' + HTTPS_PORT });
                }
            }
        });
    });
    cachedAddresses = list;
    return list;
}

function handleRequest(req, res) {
    const clientIp = req.socket.remoteAddress || '';
    if (!allowExternal && !isLocalAddr(clientIp)) {
        return answer(res, 403, 'text/plain; charset=utf-8', 'External access disabled');
    }

    const origin = corsOrigin(req);
    const corsHeaders = {};
    if (origin) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
        corsHeaders['Access-Control-Max-Age'] = '600';
        corsHeaders['Vary'] = 'Origin';
    }
    if (req.method === 'OPTIONS') {
        return answer(res, 204, 'text/plain', '', corsHeaders);
    }

    const url = String(req.url || '/').split('?')[0];
    let query = null;
    try { query = new URL(req.url, 'http://localhost').searchParams; } catch (e) { /* ignore */ }

    if (MUTATING_ENDPOINTS.has(url)) {
        if (!isLoopback(clientIp)) {
            return answer(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'loopback only' }), corsHeaders);
        }
        if (req.headers.origin && !origin) {
            return answer(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'bad origin' }), corsHeaders);
        }
        if (!req.headers.origin && !isTrustedReferer(req.headers.referer)) {
            return answer(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'bad referer' }), corsHeaders);
        }
    }

    const withCors = (fn) => {
        const writeHead = res.writeHead;
        res.writeHead = function (status, headers) {
            const merged = Object.assign({}, headers || {}, corsHeaders);
            if (headers && headers.Vary && corsHeaders.Vary) {
                merged.Vary = headers.Vary + ', ' + corsHeaders.Vary;
            }
            return writeHead.call(res, status, merged);
        };
        fn();
    };

    return withCors(() => {
        if (url === '/' || url === '/index.html') {
            return answerHtml(req, res, HTML, HTML_GZIP);
        }
        if (url === '/admin' && ADMIN_HTML) {
            return answerHtml(req, res, ADMIN_HTML, null);
        }
        if ((url === '/gui' || url === '/gui.html' || url === '/console') && GUI_HTML) {
            return answerHtml(req, res, GUI_HTML, GUI_GZIP);
        }
        if (url === '/vendor/opencc-t2cn.js' && VENDOR_JS) {
            const headers = {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'public, max-age=86400',
                'Vary': 'Accept-Encoding',
            };
            if (VENDOR_JS_GZIP && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
                headers['Content-Encoding'] = 'gzip';
                return answer(res, 200, 'application/javascript; charset=utf-8', VENDOR_JS_GZIP, headers);
            }
            return answer(res, 200, 'application/javascript; charset=utf-8', VENDOR_JS, headers);
        }
        if (url === '/api/status') {
            const mem = process.memoryUsage();
            return answerJson(res, 200, {
                uptime: Math.floor((Date.now() - BOOT_TIME) / 1000),
                connected: S.connected,
                title: S.title,
                artist: S.artist,
                position: Math.round(S.position * 100) / 100,
                isPlaying: S.isPlaying,
                estDur: Math.round((S.duration || 0) * 100) / 100,
                duration: Math.round((S.duration || 0) * 100) / 100,
                lyricsSource: S.lyricsSource,
                lyricsCount: S.lyrics ? S.lyrics.length : 0,
                clients: clients.size,
                cacheSize: lyricsCache.size,
                lrcIndexSize: localLRC.size,
                memMB: (mem.rss / 1048576).toFixed(1),
                platform: PLAT,
                musicDir: MUSIC_DIR || '(none)',
                port: PORT,
                httpsPort: String(process.env.LF_HTTPS || '') === '0' ? 0 : HTTPS_PORT,
                addresses: getAddresses(),
                allowExternal: allowExternal,
                bridge: {
                    mode: S.bridgeMode || 'none',
                    transport: bridgeTransport,
                    alive: !!bridgeProc,
                    lastUpdateAgo: S.lastBridgeAt ? Math.round((Date.now() - S.lastBridgeAt) / 1000) : null,
                    smtc: !!S.smtc,
                    players: PLAYER_NAMES,
                },
                node: process.version,
            });
        }
        if (url === '/api/lyrics') {
            if (S.lyrics && S.lyrics.length) {
                return answerJson(res, 200, { lyrics: S.lyrics, source: S.lyricsSource, title: S.title, artist: S.artist });
            }
            return answerJson(res, 200, { lyrics: null });
        }
        if (url === '/api/logs') {
            const limit = Math.min(Math.max(parseInt(query && query.get('limit'), 10) || 100, 1), 300);
            return answerJson(res, 200, logs.slice(-limit));
        }
        if (url === '/api/clear-cache') {
            lyricsCache.clear();
            log('Cache cleared');
            return answerJson(res, 200, { ok: true });
        }
        if (url === '/api/manual-track') {
            // Fallback for players the window-title scanner cannot see: the
            // native console polls a user-selected window and pushes its title.
            const title = query ? String(query.get('title') || '').slice(0, 300) : '';
            const artist = query ? String(query.get('artist') || '').slice(0, 200) : '';
            if (title) {
                handleMediaUpdate({ src: 'win', st: 'Unknown', t: title, a: artist, p: -1, d: 0 });
            }
            return answerJson(res, 200, { ok: !!title });
        }
        if (url === '/api/key') {
            const key = query ? query.get('key') : null;
            const ok = key ? sendMediaKey(key) : false;
            return answerJson(res, 200, { ok: !!ok });
        }
        if (url === '/api/shutdown') {
            answerJson(res, 200, { ok: true });
            log('Shutdown requested');
            setTimeout(shutdown, 200);
            return;
        }
        if (url === '/api/ext') {
            if (query) {
                const value = query.get('val');
                if (value === '1') { allowExternal = true; log('External access: on'); }
                else if (value === '0') { allowExternal = false; log('External access: off'); }
            }
            return answerJson(res, 200, { allowExternal });
        }
        return answer(res, 404, 'text/plain; charset=utf-8', 'Not found');
    });
}

const server = http.createServer(handleRequest);

/* ═══ WebSocket ═══ */
function sendTo(ws, type, data) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type, data })); } catch (e) { /* ignore */ }
}

function initPayload() {
    return {
        connected: S.connected,
        title: S.title,
        artist: S.artist,
        position: Math.round(S.position * 100) / 100,
        isPlaying: S.isPlaying,
        lyrics: S.lyrics,
        lyricsSource: S.lyricsSource,
        duration: Math.round((S.duration || 0) * 100) / 100,
        estDur: Math.round((S.duration || 0) * 100) / 100,
    };
}

function attachWebSocket(wss) {
    wss.on('connection', function (ws, req) {
        const wsIp = req.socket ? req.socket.remoteAddress : '';
        if (!allowExternal && !isLocalAddr(wsIp)) {
            ws.close();
            return;
        }
        clients.add(ws);
        log('Browser connected');
        sendTo(ws, 'init', initPayload());
        sendTo(ws, 'logs', logs.slice(-50));

        let lastSearch = 0;
        ws.on('message', function (raw) {
            let message;
            try { message = JSON.parse(raw.toString()); } catch (e) { return; }
            if (!message || typeof message.type !== 'string') return;

            if (message.type === 'lrc' || message.type === 'applyLyrics') {
                if (typeof message.data !== 'string') return;
                const parsed = parseLRC(message.data);
                if (parsed.lyrics.length) {
                    S.lyrics = parsed.lyrics;
                    S.lyricsSource = 'manual';
                    if (!S.duration) S.duration = parsed.lyrics[parsed.lyrics.length - 1].time + 15;
                    broadcast('lyrics', { lyrics: parsed.lyrics, source: 'manual' });
                    log('Manual lyrics applied (' + parsed.lyrics.length + ' lines)');
                }
                return;
            }

            if (message.type === 'key') {
                sendMediaKey(message.data);
                return;
            }

            if (message.type === 'search') {
                const now = Date.now();
                if (now - lastSearch < 1500) return; // simple abuse guard
                lastSearch = now;
                const data = message.data || {};
                const track = typeof data.track === 'string' ? data.track.slice(0, 200) : '';
                const artist = typeof data.artist === 'string' ? data.artist.slice(0, 200) : '';
                if (!track) return;
                (async () => {
                    let results = await searchLRCLIB(track, artist);
                    let mapped = results.map((r) => ({
                        trackName: r.trackName,
                        artistName: r.artistName,
                        albumName: r.albumName,
                        duration: r.duration,
                        hasSynced: !!r.syncedLyrics,
                        syncedLyrics: r.syncedLyrics || null,
                        plainLyrics: r.plainLyrics || null,
                    }));
                    if (mapped.length === 0) mapped = await searchNetEase(track, artist);
                    sendTo(ws, 'searchResults', mapped.slice(0, 10));
                })().catch(() => sendTo(ws, 'searchResults', []));
            }
        });

        ws.on('close', function (code, reason) {
            clients.delete(ws);
            let why = '';
            try { why = reason ? reason.toString() : ''; } catch (e) { why = ''; }
            log('Browser disconnected (' + code + (why ? ' ' + why : '') + ')');
        });
        ws.on('error', function () { clients.delete(ws); });
    });
}

const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD });
attachWebSocket(wss);

/* ═══ HTTPS ═══ */
let httpsServer = null;

function certPath() {
    return path.join(getRuntimeDir(), 'lyricflow-cert.json');
}

function loadCachedCert() {
    try {
        const data = JSON.parse(fs.readFileSync(certPath(), 'utf8'));
        if (data && data.key && data.cert && data.created && Date.now() - data.created < 300 * 24 * 3600 * 1000) return data;
    } catch (e) { /* ignore */ }
    return null;
}

function generateCert(callback) {
    let forge;
    try { forge = require('node-forge'); }
    catch (e) { return callback(new Error('node-forge not installed')); }

    log('Generating HTTPS certificate (one time)...');
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, keypair) => {
        if (err) return callback(err);
        try {
            const cert = forge.pki.createCertificate();
            cert.publicKey = keypair.publicKey;
            cert.serialNumber = '01' + Date.now().toString(16);
            cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
            cert.validity.notAfter = new Date(Date.now() + 300 * 24 * 3600 * 1000);
            const attrs = [{ name: 'commonName', value: 'LyricFlow' }];
            cert.setSubject(attrs);
            cert.setIssuer(attrs);
            cert.sign(keypair.privateKey, forge.md.sha256.create());

            const data = {
                key: forge.pki.privateKeyToPem(keypair.privateKey),
                cert: forge.pki.certificateToPem(cert),
                created: Date.now(),
            };
            try { fs.writeFileSync(certPath(), JSON.stringify(data), 'utf8'); } catch (e) { /* cache is optional */ }
            callback(null, data);
        } catch (e) {
            callback(e);
        }
    });
}

function startHttps(credentials) {
    try {
        httpsServer = https.createServer({ key: credentials.key, cert: credentials.cert }, handleRequest);
        const secureWss = new WebSocketServer({ server: httpsServer, maxPayload: WS_MAX_PAYLOAD });
        attachWebSocket(secureWss);
        httpsServer.on('error', (e) => log('HTTPS error: ' + e.message));
        try {
            httpsServer.listen({ port: HTTPS_PORT, host: '::', ipv6Only: false }, () => {
                console.log('');
                console.log('  HTTPS (battery API):');
                console.log('    https://localhost:' + HTTPS_PORT);
                const interfaces = os.networkInterfaces();
                Object.keys(interfaces).forEach((name) => {
                    (interfaces[name] || []).forEach((iface) => {
                        if (!iface.internal && iface.family === 'IPv4') {
                            console.log('    https://' + iface.address + ':' + HTTPS_PORT + '  (' + name + ')');
                        }
                    });
                });
                console.log('  Self-signed certificate: accept it once in the browser.');
                console.log('');
            });
        } catch (e) {
            log('HTTPS listen failed: ' + e.message);
        }
    } catch (e) {
        log('HTTPS failed: ' + e.message);
    }
}

function bringUpHttps() {
    if (String(process.env.LF_HTTPS || '') === '0') {
        log('HTTPS disabled (LF_HTTPS=0)');
        return;
    }
    const cached = loadCachedCert();
    if (cached) {
        startHttps(cached);
        return;
    }
    generateCert((err, data) => {
        if (err) { log('HTTPS skipped: ' + err.message); return; }
        startHttps(data);
    });
}

/* ═══ Lifecycle ═══ */
let shuttingDown = false;

function killChildren() {
    if (keyProc) { try { keyProc.kill(); } catch (e) { /* ignore */ } keyProc = null; }
    if (bridgeProc) { try { bridgeProc.kill(); } catch (e) { /* ignore */ } bridgeProc = null; }
    stopBridgeFilePoll();
    if (bridgeScriptPath) {
        try { fs.unlinkSync(bridgeScriptPath); } catch (e) { /* ignore */ }
        bridgeScriptPath = '';
    }
    if (bridgeOutFile) {
        try { fs.unlinkSync(bridgeOutFile); } catch (e) { /* ignore */ }
        bridgeOutFile = '';
    }
}

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Stopping');
    try { wss.close(); } catch (e) { /* ignore */ }
    try { if (httpsServer) httpsServer.close(); } catch (e) { /* ignore */ }
    try { server.close(); } catch (e) { /* ignore */ }
    stopBridge();
    killChildren();
    setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', killChildren);
process.on('uncaughtException', (err) => {
    // Some Node versions surface a failed listen as a thrown async error
    // instead of an 'error' event; report it the same way either path.
    if (err && err.code === 'EADDRINUSE') {
        onListenError(err);
        return;
    }
    console.error('  Uncaught: ' + (err && err.stack ? err.stack : err));
    log('Uncaught: ' + (err && err.message ? err.message : String(err)));
});

/* Stale bridge watchdog: a dead/hung PowerShell must not leave a fake "playing" state. */
setInterval(() => {
    if (!S.connected || !S.lastBridgeAt) return;
    if (Date.now() - S.lastBridgeAt > 20000) {
        markDisconnected('bridge timed out');
        if (bridgeProc) { try { bridgeProc.kill(); } catch (e) { /* ignore */ } }
    }
}, 5000).unref();

function printAddresses() {
    const interfaces = os.networkInterfaces();
    console.log('');
    console.log('  ===========================================================');
    console.log('  Pages:');
    console.log('    http://localhost:' + PORT);
    Object.keys(interfaces).forEach((name) => {
        (interfaces[name] || []).forEach((iface) => {
            if (iface.internal) return;
            if (iface.family === 'IPv4') console.log('    http://' + iface.address + ':' + PORT + '  (' + name + ')');
            else if (iface.family === 'IPv6' && !iface.address.startsWith('fe80')) {
                console.log('    http://[' + iface.address.split('%')[0] + ']:' + PORT + '  (' + name + ' v6)');
            }
        });
    });
    console.log('');
    console.log('  ===========================================================');
    console.log('');
}

function onListenError(err) {
    if (err.code === 'EADDRINUSE') {
        console.error('  Port ' + PORT + ' is already in use. Is LyricFlow already running?');
        console.error('  Tip: PORT=3723 node server.js');
        log('Port ' + PORT + ' already in use');
        // When embedded in Electron another instance may own the port;
        // only a standalone server process should exit.
        if (require.main === module) process.exit(1);
        return;
    }
    console.error('  Server error: ' + err.message);
    log('Server error: ' + err.message);
}

function openConsoleWindow() {
    const url = 'http://localhost:' + PORT + '/gui';
    try {
        if (PLAT === 'win32') {
            spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' })
                .on('error', () => {});
        } else if (PLAT === 'darwin') {
            spawn('open', [url], { stdio: 'ignore' }).on('error', () => {});
        } else {
            spawn('xdg-open', [url], { stdio: 'ignore' }).on('error', () => {});
        }
        log('Console: ' + url);
    } catch (e) {
        log('Could not open console: ' + e.message);
    }
}

function bootstrap() {
    console.log('\n  LyricFlow ' + (process.env.npm_package_version || '') + '\n');

    if (LOG_FILE) {
        try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (e) { /* ignore */ }
        try {
            if (fs.statSync(LOG_FILE).size > 4 * 1024 * 1024) fs.truncateSync(LOG_FILE);
        } catch (e) { /* first run */ }
    }
    log('Runtime dir: ' + getRuntimeDir());

    if (MUSIC_DIR) buildLRCIndex(MUSIC_DIR).catch((e) => log('lrc index failed: ' + e.message));
    startBridge();

    server.on('error', onListenError);

    try {
        server.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
            log('Ready: http://localhost:' + PORT);
            printAddresses();
            bringUpHttps();
            if (STANDALONE && OPEN_CONSOLE) setTimeout(openConsoleWindow, 700);
        });
    } catch (err) {
        onListenError(err);
    }
}

if (process.env.LF_NO_LISTEN !== '1') {
    bootstrap();
}

module.exports = { parseLRC, isLocalAddr, isLoopback, handleMediaUpdate, S, PORT };