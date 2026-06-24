'use strict';
var spawn = require('child_process').spawn;
var http = require('http');
var os = require('os');
var path = require('path');
var fs = require('fs');

var PORT = 3721;

console.log('\n  LyricFlow Console\n');

function checkServer(cb) {
    var req = http.get('http://localhost:' + PORT + '/api/status', { timeout: 2000 }, function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { cb(true); });
    });
    req.on('error', function() { cb(false); });
    req.on('timeout', function() { req.destroy(); cb(false); });
}

checkServer(function(online) {
    if (!online) {
        console.log('  Server not running, starting...');
        var srv = spawn('node', [path.join(__dirname, 'server.js')], {
            cwd: __dirname, stdio: 'inherit', windowsHide: false
        });
        srv.on('error', function(e) { console.error('  Failed: ' + e.message); });
        setTimeout(function() { buildAndLaunch(); }, 4000);
    } else {
        console.log('  Server already running');
        buildAndLaunch();
    }
});

function buildAndLaunch() {
    console.log('  Building GUI script...\n');

    var L = [];
    function w(s) { L.push(s); }

    w('$ErrorActionPreference = "SilentlyContinue"');
    w('$PORT = ' + PORT);
    w('$BASE = "http://localhost:$PORT"');
    w('Add-Type -AssemblyName System.Windows.Forms');
    w('Add-Type -AssemblyName System.Drawing');
    w('[System.Windows.Forms.Application]::EnableVisualStyles()');

    // Colors
    w('$cBg=[System.Drawing.Color]::FromArgb(14,14,18)');
    w('$cPn=[System.Drawing.Color]::FromArgb(20,20,26)');
    w('$cTx=[System.Drawing.Color]::FromArgb(224,220,212)');
    w('$cMt=[System.Drawing.Color]::FromArgb(110,106,100)');
    w('$cAc=[System.Drawing.Color]::FromArgb(212,168,83)');
    w('$cGn=[System.Drawing.Color]::FromArgb(92,204,92)');
    w('$cRd=[System.Drawing.Color]::FromArgb(229,85,85)');
    w('$cBd=[System.Drawing.Color]::FromArgb(36,36,44)');
    w('$cIp=[System.Drawing.Color]::FromArgb(24,24,30)');
    w('$cHv=[System.Drawing.Color]::FromArgb(32,32,40)');
    w('$cDk=[System.Drawing.Color]::FromArgb(40,16,16)');

    // Fonts
    w('$fT=New-Object System.Drawing.Font("Segoe UI Semilight",13)');
    w('$fB=New-Object System.Drawing.Font("Segoe UI",9)');
    w('$fM=New-Object System.Drawing.Font("Consolas",8.5)');
    w('$fS=New-Object System.Drawing.Font("Segoe UI",7.5)');
    w('$fN=New-Object System.Drawing.Font("Segoe UI",8.5)');

    // Label helper
    w('function GL($t,$x,$y,$w,$f,$c){');
    w('  $l=New-Object System.Windows.Forms.Label');
    w('  $l.Text=$t;$l.Location=New-Object System.Drawing.Point($x,$y)');
    w('  if($w -gt 0){$l.Size=New-Object System.Drawing.Size($w,18)}else{$l.AutoSize=$true}');
    w('  $l.Font=$f;$l.ForeColor=$c;return $l');
    w('}');

    // Button helper
    w('function GB($t,$x,$y,$w,$h,$bg,$fg){');
    w('  $b=New-Object System.Windows.Forms.Button');
    w('  $b.Text=$t;$b.Location=New-Object System.Drawing.Point($x,$y)');
    w('  $b.Size=New-Object System.Drawing.Size($w,$h);$b.FlatStyle="Flat"');
    w('  $b.BackColor=$bg;$b.ForeColor=$fg');
    w('  $b.FlatAppearance.BorderSize=1;$b.FlatAppearance.BorderColor=$cBd');
    w('  $b.FlatAppearance.MouseOverBackColor=$cHv;$b.Font=$fN');
    w('  $b.Cursor=[System.Windows.Forms.Cursors]::Hand;return $b');
    w('}');

    // Time format
    w('function FT($s){');
    w('  if(-not [double]::IsFinite($s)-or $s -lt 0){$s=0}');
    w('  $m=[Math]::Floor($s/60);$sc=[Math]::Floor($s%60)');
    w('  return "$m"+":"+$sc.ToString("D2")');
    w('}');

    // Form
    w('$f=New-Object System.Windows.Forms.Form');
    w('$f.Text="LyricFlow Console"');
    w('$f.Size=New-Object System.Drawing.Size(520,660)');
    w('$f.StartPosition="CenterScreen"');
    w('$f.BackColor=$cBg;$f.ForeColor=$cTx');
    w('$f.FormBorderStyle="FixedSingle";$f.MaximizeBox=$false');
    w('$f.Font=$fB');

    // Status panel
    w('$p1=New-Object System.Windows.Forms.Panel');
    w('$p1.Location=New-Object System.Drawing.Point(10,10)');
    w('$p1.Size=New-Object System.Drawing.Size(496,34);$p1.BackColor=$cPn');
    w('$lblD=GL "..." 10 8 0 $fB $cRd');
    w('$lblS=GL "..." 28 9 160 $fB $cMt');
    w('$lblP=GL "" 220 9 0 $fS $cMt');
    w('$lblU=GL "" 350 9 0 $fS $cMt');
    w('$p1.Controls.Add($lblD);$p1.Controls.Add($lblS);$p1.Controls.Add($lblP);$p1.Controls.Add($lblU)');
    w('$f.Controls.Add($p1)');

    // Track panel
    w('$p2=New-Object System.Windows.Forms.Panel');
    w('$p2.Location=New-Object System.Drawing.Point(10,50)');
    w('$p2.Size=New-Object System.Drawing.Size(496,90);$p2.BackColor=$cPn');
    w('$lblT=GL "..." 16 10 464 $fT $cMt');
    w('$lblT.MaximumSize=New-Object System.Drawing.Size(464,28)');
    w('$lblA=GL "" 18 40 460 $fB $cMt');
    w('$p2.Controls.Add($lblT);$p2.Controls.Add($lblA)');
    w('$pBg=New-Object System.Windows.Forms.Panel');
    w('$pBg.Location=New-Object System.Drawing.Point(16,62);$pBg.Size=New-Object System.Drawing.Size(464,4);$pBg.BackColor=$cBd');
    w('$pFi=New-Object System.Windows.Forms.Panel');
    w('$pFi.Location=New-Object System.Drawing.Point(0,0);$pFi.Size=New-Object System.Drawing.Size(0,4);$pFi.BackColor=$cAc');
    w('$pBg.Controls.Add($pFi);$p2.Controls.Add($pBg)');
    w('$lblL=GL "0:00" 16 70 0 $fS $cMt');
    w('$lblR=GL "0:00" 430 70 0 $fS $cMt');
    w('$p2.Controls.Add($lblL);$p2.Controls.Add($lblR)');
    w('$f.Controls.Add($p2)');

    // Controls panel
    w('$p3=New-Object System.Windows.Forms.Panel');
    w('$p3.Location=New-Object System.Drawing.Point(10,146)');
    w('$p3.Size=New-Object System.Drawing.Size(496,42);$p3.BackColor=$cPn');

    w('$bPr=GB "Prev" 170 6 48 30 $cIp $cTx');
    w('$bPr.Add_Click({try{Invoke-WebRequest -Uri "$BASE/api/key?key=prev" -UseBasicParsing -TimeoutSec 1|Out-Null}catch{}})');
    w('$p3.Controls.Add($bPr)');

    w('$bPl=GB "Play" 224 6 48 30 $cAc $cBg');
    w('$bPl.FlatAppearance.BorderSize=0');
    w('$bPl.Add_Click({try{Invoke-WebRequest -Uri "$BASE/api/key?key=toggle" -UseBasicParsing -TimeoutSec 1|Out-Null}catch{}})');
    w('$p3.Controls.Add($bPl)');

    w('$bNx=GB "Next" 278 6 48 30 $cIp $cTx');
    w('$bNx.Add_Click({try{Invoke-WebRequest -Uri "$BASE/api/key?key=next" -UseBasicParsing -TimeoutSec 1|Out-Null}catch{}})');
    w('$p3.Controls.Add($bNx)');

    w('$lblC=GL "Clients: 0" 350 14 0 $fS $cMt');
    w('$p3.Controls.Add($lblC)');
    w('$f.Controls.Add($p3)');

    // Info panel
    w('$p4=New-Object System.Windows.Forms.Panel');
    w('$p4.Location=New-Object System.Drawing.Point(10,194)');
    w('$p4.Size=New-Object System.Drawing.Size(496,44);$p4.BackColor=$cPn');
    w('$lblLy=GL "Lyrics: -" 16 6 0 $fS $cMt');
    w('$lblCa=GL "" 16 24 0 $fS $cMt');
    w('$lblMm=GL "" 280 6 0 $fS $cMt');
    w('$lblDr=GL "" 280 24 200 $fS $cMt');
    w('$p4.Controls.Add($lblLy);$p4.Controls.Add($lblCa);$p4.Controls.Add($lblMm);$p4.Controls.Add($lblDr)');
    w('$f.Controls.Add($p4)');

    // Action buttons
    w('$p5=New-Object System.Windows.Forms.Panel');
    w('$p5.Location=New-Object System.Drawing.Point(10,244)');
    w('$p5.Size=New-Object System.Drawing.Size(496,34);$p5.BackColor=$cBg');

    w('$b1=GB "Page" 0 0 52 28 $cPn $cTx');
    w('$b1.Add_Click({Start-Process "http://localhost:$PORT"})');
    w('$p5.Controls.Add($b1)');

    w('$b2=GB "HTTPS" 58 0 58 28 $cPn $cTx');
    w('$b2.Add_Click({Start-Process "https://localhost:$($PORT+1)"})');
    w('$p5.Controls.Add($b2)');

    w('$b3=GB "Cache" 122 0 58 28 $cPn $cTx');
    w('$b3.Add_Click({try{Invoke-WebRequest -Uri "$BASE/api/clear-cache" -UseBasicParsing -TimeoutSec 2|Out-Null;[System.Windows.Forms.MessageBox]::Show("Cache cleared","OK")}catch{}})');
    w('$p5.Controls.Add($b3)');

    w('$b4=GB "EXIT" 384 0 112 28 $cDk $cRd');
    w('$b4.Add_Click({');
    w('  $r=[System.Windows.Forms.MessageBox]::Show("Stop server?","Confirm","YesNo","Warning")');
    w('  if($r -eq "Yes"){try{Invoke-WebRequest -Uri "$BASE/api/shutdown" -UseBasicParsing -TimeoutSec 2|Out-Null}catch{}}');
    w('})');
    w('$b4.FlatAppearance.BorderColor=[System.Drawing.Color]::FromArgb(60,24,24)');
    w('$p5.Controls.Add($b4)');
    w('$f.Controls.Add($p5)');

    // Log header
    w('$lblLG=GL "Logs" 12 284 0 $fS $cMt');
    w('$f.Controls.Add($lblLG)');

    // Log box
    w('$tLog=New-Object System.Windows.Forms.TextBox');
    w('$tLog.Location=New-Object System.Drawing.Point(10,300)');
    w('$tLog.Size=New-Object System.Drawing.Size(496,310)');
    w('$tLog.Multiline=$true;$tLog.ReadOnly=$true;$tLog.ScrollBars="Vertical"');
    w('$tLog.BackColor=$cPn;$tLog.ForeColor=$cMt;$tLog.Font=$fM');
    w('$tLog.BorderStyle="None";$tLog.WordWrap=$false');
    w('$f.Controls.Add($tLog)');

    // Timer
    w('$tm=New-Object System.Windows.Forms.Timer;$tm.Interval=2000');
    w('$tm.Add_Tick({');
    w('  try{');
    w('    $rp=Invoke-WebRequest -Uri "$BASE/api/status" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop');
    w('    $r=$rp.Content|ConvertFrom-Json');
    w('    if($r.connected){$lblD.ForeColor=$cGn;$lblS.Text="Connected";$lblS.ForeColor=$cGn}');
    w('    else{$lblD.ForeColor=$cAc;$lblS.Text="Waiting";$lblS.ForeColor=$cAc}');
    w('    $lblP.Text="Port: $($r.port)"');
    w('    $h=[Math]::Floor($r.uptime/3600);$mm=[Math]::Floor(($r.uptime%3600)/60);$ss=$r.uptime%60');
    w('    $lblU.Text="Up: $h`:$($mm.ToString("D2"))`:$($ss.ToString("D2"))"');
    w('    if($r.title){$lblT.Text=$r.title;$lblT.ForeColor=$cAc}else{$lblT.Text="Waiting...";$lblT.ForeColor=$cMt}');
    w('    $lblA.Text=if($r.artist){$r.artist}else{""}');
    w('    if($r.isPlaying){$bPl.Text="Pause"}else{$bPl.Text="Play"}');
    w('    if($r.estDur -gt 0){');
    w('      $pct=[Math]::Min(100,[Math]::Floor($r.position/$r.estDur*100))');
    w('      $pFi.Width=[Math]::Floor(464*$pct/100)');
    w('      $lblL.Text=FT $r.position;$lblR.Text=FT $r.estDur');
    w('    }else{$pFi.Width=0;$lblL.Text="0:00";$lblR.Text="0:00"}');
    w('    $lblC.Text="Clients: $($r.clients)"');
    w('    $lblLy.Text="Lyrics: $($r.lyricsSource) / $($r.lyricsCount) lines"');
    w('    $lblCa.Text="Cache: $($r.cacheSize) / LRC: $($r.lrcIndexSize)"');
    w('    $lblMm.Text="Mem: $($r.memMB) MB"');
    w('    $lblDr.Text=$r.musicDir');
    w('  }catch{');
    w('    $lblD.ForeColor=$cRd;$lblS.Text="No response";$lblS.ForeColor=$cRd');
    w('  }');
    w('  try{');
    w('    $lr=Invoke-WebRequest -Uri "$BASE/api/logs" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop');
    w('    $lg=$lr.Content|ConvertFrom-Json');
    w('    $tLog.Text=($lg -join [char]13+[char]10)');
    w('    $tLog.SelectionStart=$tLog.Text.Length;$tLog.ScrollToCaret()');
    w('  }catch{}');
    w('})');

    // Run
    w('$f.Add_Shown({$tm.Start()})');
    w('$f.Add_FormClosing({$tm.Stop();$tm.Dispose()})');
    w('[System.Windows.Forms.Application]::Run($f)');

    var script = L.join('\r\n');
    var psPath = path.join(os.tmpdir(), 'lf_console.ps1');
    fs.writeFileSync(psPath, '\uFEFF' + script, 'utf8');

    console.log('  Script: ' + psPath);
    console.log('  Launching...\n');

    var gui = spawn('cmd.exe', [
        '/c', 'start', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath
    ], { windowsHide: false, stdio: 'inherit' });

    gui.on('error', function(e) {
        console.error('  GUI failed: ' + e.message);
    });

    gui.unref();
    console.log('  Console window opened (PID: ' + gui.pid + ')');
    console.log('  Server running in background\n');
}