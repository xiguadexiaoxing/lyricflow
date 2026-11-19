using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class NativeConsole
{
    static readonly Color BgColor = Color.FromArgb(9, 9, 13);
    static readonly Color CardColor = Color.FromArgb(19, 19, 26);
    static readonly Color Card2Color = Color.FromArgb(27, 27, 36);
    static readonly Color AccentColor = Color.FromArgb(255, 176, 84);
    static readonly Color TextColor = Color.FromArgb(235, 231, 223);
    static readonly Color MutedColor = Color.FromArgb(150, 148, 142);
    static readonly Color DangerColor = Color.FromArgb(228, 110, 100);
    static readonly Color BorderColor = Color.FromArgb(42, 42, 54);

    static Font fontBase;
    static Font fontSmall;
    static Font fontBold;
    static Font fontTitle;
    static Font fontPlay;

    static int port = 3721;
    static string baseDir;
    static string logFile;
    static bool elevated;
    static Process server;
    static bool startedByUs;
    static volatile bool ready;
    static volatile bool polling;
    static volatile bool lyricsDirty;
    static int tickCount;

    static Form form;
    static Icon appIcon;
    static NotifyIcon trayIcon;
    static System.Threading.Timer pollTimer;
    static Label lblStatus;
    static Label lblTitle;
    static Label lblArtist;
    static Label lblCur;
    static Label lblTotal;
    static ProgressBarEx progressBar;
    static PillButton btnPrev;
    static PillButton btnPlay;
    static PillButton btnNext;
    static PillButton btnPower;
    static PillButton btnRestart;
    static Panel contentHost;
    static FlowLayoutPanel navBar;
    static CaptionButton maxButton;
    static readonly List<Panel> pages = new List<Panel>();
    static readonly List<PillButton> navButtons = new List<PillButton>();
    static int currentPage;
    static ListBox lyricsList;
    static Label lyricsSource;
    static TextBox logBox;
    static CheckBox chkExternal;
    static TextBox txtPlayers;
    static ListBox addrList;
    static Label lblFoot;
    static Label lblDiag;
    static Label lblManual;
    static Label lblAddrHint;
    static int manualPid = 0;
    static string manualName = "";
    static string manualLastTitle = "";
    static string manualPending = "";
    static System.Threading.Timer manualTimer;

    static readonly Dictionary<string, Label> infoValues = new Dictionary<string, Label>();
    static readonly List<double> lyricTimes = new List<double>();
    static int lyricCurrent = -1;
    static volatile int loadedLyricsCount;
    static int lastPct = 0;
    static string lastTrackKey = "";
    static string lastAddressKey = "";
    static readonly List<string> lastLogs = new List<string>();
    static bool suppressExternalEvent;

    [STAThread]
    static void Main(string[] args)
    {
        baseDir = AppDomain.CurrentDomain.BaseDirectory;
        elevated = IsElevated();
        int parsed;
        if (int.TryParse(Environment.GetEnvironmentVariable("PORT"), out parsed) && parsed > 0 && parsed < 65536)
        {
            port = parsed;
        }
        logFile = Path.Combine(PickWritableDir("logs"), "lyricflow.log");

        if (args != null && args.Length > 0 && args[0] == "--headless")
        {
            RunHeadless(args);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
        {
            LogCrash(e.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
        {
            LogCrash(e.ExceptionObject as Exception);
        };
        BuildFonts();
        BuildUi();
        Application.Run(form);
    }

    static void BuildFonts()
    {
        fontBase = new Font("Microsoft YaHei UI", 9f);
        fontSmall = new Font("Microsoft YaHei UI", 8f);
        fontBold = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        fontTitle = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
        fontPlay = new Font("Segoe UI Symbol", 12f);
    }

    /* ---------- headless diagnostics ---------- */

    static void LogCrash(Exception exception)
    {
        try
        {
            string path = Path.Combine(baseDir, "console-crash.log");
            File.AppendAllText(path, DateTime.Now.ToString("s") + " " +
                (exception == null ? "unknown" : exception.ToString()) + "\r\n");
        }
        catch { }
    }

    static void RunHeadless(string[] args)
    {
        bool stop = false;
        for (int i = 0; i < args.Length; i++) if (args[i] == "--stop") stop = true;

        if (!Probe())
        {
            if (!StartServerProcess()) { Trace("start-failed"); return; }
        }
        for (int i = 0; i < 60; i++)
        {
            Thread.Sleep(500);
            if (Probe())
            {
                Trace("ready");
                if (stop) { ShutdownServer(); Thread.Sleep(600); }
                return;
            }
            if (server != null && server.HasExited) { Trace("exited " + server.ExitCode); return; }
        }
        Trace("timeout");
    }

    static void Trace(string text)
    {
        try { File.AppendAllText(Path.Combine(baseDir, "console-test.log"), DateTime.Now.ToString("s") + " " + text + "\r\n"); }
        catch { }
    }

    /* ---------- UI ---------- */

static void BuildUi()
    {
        form = new FramelessForm();
        form.Text = "LyricFlow 控制台";
        appIcon = LoadAppIcon();
        form.Icon = appIcon;
        form.MinimumSize = new Size(780, 660);
        form.StartPosition = FormStartPosition.CenterScreen;

        Rectangle work = Screen.PrimaryScreen.WorkingArea;
        form.Width = Math.Min(1000, Math.Max(780, work.Width - 80));
        form.Height = Math.Min(960, Math.Max(660, work.Height - 60));

        form.BackColor = BgColor;
        form.ForeColor = TextColor;
        form.Font = fontBase;

        TableLayoutPanel root = new TableLayoutPanel();
        root.Dock = DockStyle.Fill;
        root.ColumnCount = 1;
        root.RowCount = 5;
        root.BackColor = BgColor;
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36f));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 80f));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 202f));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30f));
        form.Controls.Add(root);

        root.Controls.Add(BuildTitleBar(), 0, 0);
        root.Controls.Add(BuildHeader(), 0, 1);
        root.Controls.Add(BuildNowPlaying(), 0, 2);
        root.Controls.Add(BuildContent(), 0, 3);
        root.Controls.Add(BuildFooter(), 0, 4);

        form.Resize += delegate
        {
            if (maxButton != null)
            {
                maxButton.Kind = form.WindowState == FormWindowState.Maximized
                    ? CaptionButton.ButtonKind.Restore
                    : CaptionButton.ButtonKind.Maximize;
                maxButton.Invalidate();
            }
        };

        btnPower.Text = "启动服务";
        btnPower.Accent = true;
        btnPower.Enabled = true;
        btnRestart.Enabled = false;
        SetPlayEnabled(false);

        form.Shown += delegate { BeginStartup(); };
        form.FormClosing += OnClosing;
        CreateTrayIcon();
    }

    static Icon LoadAppIcon()
    {
        try
        {
            Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            return icon != null ? icon : SystemIcons.Application;
        }
        catch
        {
            return SystemIcons.Application;
        }
    }

    static void CreateTrayIcon()
    {
        try
        {
            trayIcon = new NotifyIcon();
            trayIcon.Icon = appIcon != null ? appIcon : SystemIcons.Application;
            trayIcon.Text = "LyricFlow 控制台";
            trayIcon.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("显示控制台", null, delegate { ShowMainWindow(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { if (form != null) form.Close(); });
            trayIcon.ContextMenuStrip = menu;
            trayIcon.DoubleClick += delegate { ShowMainWindow(); };
        }
        catch { }
    }

    static void ShowMainWindow()
    {
        if (form == null) return;
        if (form.WindowState == FormWindowState.Minimized)
        {
            form.WindowState = FormWindowState.Normal;
        }
        form.Show();
        form.Activate();
        form.BringToFront();
    }

    static Panel BuildTitleBar()
    {
        Panel bar = new Panel();
        bar.Dock = DockStyle.Fill;
        bar.Margin = new Padding(0);
        bar.BackColor = BgColor;

        Label brand = new Label();
        if (appIcon != null)
        {
            PictureBox appIconBox = new PictureBox();
            appIconBox.SetBounds(22, 8, 20, 20);
            appIconBox.SizeMode = PictureBoxSizeMode.Zoom;
            appIconBox.BackColor = Color.Transparent;
            try { appIconBox.Image = appIcon.ToBitmap(); } catch { }
            bar.Controls.Add(appIconBox);
        }

        brand.Text = "LyricFlow";
        brand.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        brand.ForeColor = AccentColor;
        brand.BackColor = Color.Transparent;
        brand.SetBounds(50, 9, 70, 20);
        bar.Controls.Add(brand);

        Label subtitle = new Label();
        subtitle.Text = "控制台";
        subtitle.Font = fontSmall;
        subtitle.ForeColor = MutedColor;
        subtitle.BackColor = Color.Transparent;
        subtitle.SetBounds(124, 10, 80, 18);
        bar.Controls.Add(subtitle);

        FlowLayoutPanel buttons = new FlowLayoutPanel();
        buttons.Dock = DockStyle.Right;
        buttons.Width = 138;
        buttons.FlowDirection = FlowDirection.LeftToRight;
        buttons.WrapContents = false;
        buttons.BackColor = BgColor;
        buttons.Padding = new Padding(0, 4, 8, 0);

        CaptionButton minimize = new CaptionButton();
        minimize.Kind = CaptionButton.ButtonKind.Minimize;
        minimize.Width = 42;
        minimize.Height = 28;
        minimize.Margin = new Padding(0, 0, 2, 0);
        minimize.Click += delegate { form.WindowState = FormWindowState.Minimized; };
        buttons.Controls.Add(minimize);

        maxButton = new CaptionButton();
        maxButton.Kind = CaptionButton.ButtonKind.Maximize;
        maxButton.Width = 42;
        maxButton.Height = 28;
        maxButton.Margin = new Padding(0, 0, 2, 0);
        maxButton.Click += delegate { ToggleMaximize(); };
        buttons.Controls.Add(maxButton);

        CaptionButton close = new CaptionButton();
        close.Kind = CaptionButton.ButtonKind.Close;
        close.Width = 42;
        close.Height = 28;
        close.Margin = new Padding(0);
        close.Click += delegate { form.Close(); };
        buttons.Controls.Add(close);

        bar.Controls.Add(buttons);

        WindowDrag.Attach(bar, form);
        WindowDrag.Attach(brand, form);
        bar.DoubleClick += delegate { ToggleMaximize(); };
        brand.DoubleClick += delegate { ToggleMaximize(); };
        return bar;
    }

    static void ToggleMaximize()
    {
        if (form.WindowState == FormWindowState.Maximized) form.WindowState = FormWindowState.Normal;
        else form.WindowState = FormWindowState.Maximized;
    }

    static RoundPanel BuildHeader()
    {
        RoundPanel card = new RoundPanel();
        card.Dock = DockStyle.Fill;
        card.Margin = new Padding(18, 8, 18, 0);
        card.BackColor = CardColor;

        RoundPanel logo = new RoundPanel();
        logo.SetBounds(20, 15, 44, 44);
        logo.Radius = 14;
        logo.BackColor = AccentColor;
        logo.BorderColor = AccentColor;
        card.Controls.Add(logo);

        Label note = new Label();
        note.Text = "\u266B";
        note.Dock = DockStyle.Fill;
        note.TextAlign = ContentAlignment.MiddleCenter;
        note.Font = new Font("Segoe UI Symbol", 17f);
        note.ForeColor = Color.FromArgb(30, 20, 6);
        note.BackColor = Color.Transparent;
        logo.Controls.Add(note);

        Label title = new Label();
        title.Text = "LyricFlow 控制台";
        title.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
        title.ForeColor = TextColor;
        title.BackColor = Color.Transparent;
        title.SetBounds(80, 13, 280, 26);
        card.Controls.Add(title);

        lblStatus = new Label();
        lblStatus.Text = "\u25CF 正在启动服务...";
        lblStatus.ForeColor = MutedColor;
        lblStatus.Font = fontSmall;
        lblStatus.BackColor = Color.Transparent;
        lblStatus.SetBounds(82, 41, 300, 22);
        card.Controls.Add(lblStatus);

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Right;
        actions.Width = 360;
        actions.FlowDirection = FlowDirection.RightToLeft;
        actions.WrapContents = false;
        actions.BackColor = CardColor;
        actions.Padding = new Padding(0, 18, 16, 0);

        btnPower = MakeButton("停止服务", 106, 36);
        btnPower.Accent = false;
        btnPower.Click += delegate { TogglePower(); };
        actions.Controls.Add(btnPower);

        btnRestart = MakeButton("重启服务", 100, 36);
        btnRestart.Click += delegate { RestartServer(); };
        actions.Controls.Add(btnRestart);

        PillButton diag = MakeButton("播放器诊断", 110, 36);
        diag.Click += delegate { ShowDiagnostics(); };
        actions.Controls.Add(diag);

        card.Controls.Add(actions);
        return card;
    }

    static RoundPanel BuildNowPlaying()
    {
        RoundPanel card = new RoundPanel();
        card.Dock = DockStyle.Fill;
        card.Margin = new Padding(18, 12, 18, 0);
        card.BackColor = CardColor;

        lblTitle = new Label();
        lblTitle.Text = "等待播放...";
        lblTitle.Font = new Font("Microsoft YaHei UI", 17f, FontStyle.Bold);
        lblTitle.ForeColor = TextColor;
        lblTitle.AutoEllipsis = true;
        lblTitle.BackColor = Color.Transparent;
        lblTitle.SetBounds(24, 16, 100, 42);
        lblTitle.Anchor = AnchorStyles.None;
        card.Controls.Add(lblTitle);

        lblArtist = new Label();
        lblArtist.Text = "";
        lblArtist.Font = new Font("Microsoft YaHei UI", 9.5f);
        lblArtist.ForeColor = MutedColor;
        lblArtist.AutoEllipsis = true;
        lblArtist.BackColor = Color.Transparent;
        lblArtist.SetBounds(26, 60, 100, 22);
        lblArtist.Anchor = AnchorStyles.None;
        card.Controls.Add(lblArtist);

        progressBar = new ProgressBarEx();
        progressBar.SetBounds(26, 96, 100, 8);
        progressBar.Anchor = AnchorStyles.None;
        card.Controls.Add(progressBar);

        lblCur = new Label();
        lblCur.Text = "0:00";
        lblCur.ForeColor = MutedColor;
        lblCur.Font = fontSmall;
        lblCur.BackColor = Color.Transparent;
        lblCur.SetBounds(26, 110, 80, 20);
        card.Controls.Add(lblCur);

        lblTotal = new Label();
        lblTotal.Text = "0:00";
        lblTotal.ForeColor = MutedColor;
        lblTotal.Font = fontSmall;
        lblTotal.TextAlign = ContentAlignment.TopRight;
        lblTotal.BackColor = Color.Transparent;
        lblTotal.SetBounds(846, 110, 80, 20);
        lblTotal.Anchor = AnchorStyles.None;
        card.Controls.Add(lblTotal);

        btnPrev = MakeButton("\u23EE", 46, 42);
        btnPrev.Font = fontPlay;
        btnPrev.Click += delegate { SendKey("prev"); };
        card.Controls.Add(btnPrev);

        btnPlay = MakeButton("\u25B6", 58, 48);
        btnPlay.Font = fontPlay;
        btnPlay.Accent = true;
        btnPlay.Click += delegate { SendKey("toggle"); };
        card.Controls.Add(btnPlay);

        btnNext = MakeButton("\u23ED", 46, 42);
        btnNext.Font = fontPlay;
        btnNext.Click += delegate { SendKey("next"); };
        card.Controls.Add(btnNext);

        PillButton lyricsPage = MakeButton("歌词页", 92, 34);
        lyricsPage.Name = "btnLyricsPage";
        lyricsPage.Click += delegate { OpenUrl("http://localhost:" + port + "/"); };
        card.Controls.Add(lyricsPage);

        PillButton webConsole = MakeButton("网页控制台", 108, 34);
        webConsole.Name = "btnWebConsole";
        webConsole.Click += delegate { OpenUrl("http://localhost:" + port + "/gui"); };
        card.Controls.Add(webConsole);

        card.Resize += delegate { LayoutControls(card); };
        card.HandleCreated += delegate { LayoutControls(card); };
        return card;
    }

    static void LayoutControls(Panel card)
    {
        int width = card.Width;
        lblTitle.SetBounds(24, 16, Math.Max(100, width - 48), 42);
        lblArtist.SetBounds(26, 60, Math.Max(100, width - 52), 22);
        progressBar.SetBounds(26, 96, Math.Max(100, width - 52), 8);
        lblTotal.SetBounds(Math.Max(0, width - 106), 110, 80, 20);

        int center = width / 2;
        btnPlay.SetBounds(center - 29, 138, 58, 48);
        btnPrev.SetBounds(center - 89, 141, 46, 42);
        btnNext.SetBounds(center + 43, 141, 46, 42);

        Button lyricsPage = card.Controls["btnLyricsPage"] as Button;
        Button webConsole = card.Controls["btnWebConsole"] as Button;
        if (lyricsPage != null) lyricsPage.SetBounds(width - 236, 144, 92, 34);
        if (webConsole != null) webConsole.SetBounds(width - 132, 144, 108, 34);
    }

    static Panel BuildContent()
    {
        Panel area = new Panel();
        area.Dock = DockStyle.Fill;
        area.Margin = new Padding(18, 12, 18, 0);
        area.BackColor = BgColor;

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 2;
        layout.BackColor = BgColor;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        area.Controls.Add(layout);

        navBar = new FlowLayoutPanel();
        navBar.Dock = DockStyle.Fill;
        navBar.BackColor = BgColor;
        navBar.FlowDirection = FlowDirection.LeftToRight;
        navBar.WrapContents = false;
        navBar.Padding = new Padding(2, 4, 0, 0);
        layout.Controls.Add(navBar, 0, 0);

        string[] names = new string[] { "概览", "歌词", "日志", "设置" };
        for (int i = 0; i < names.Length; i++)
        {
            int index = i;
            PillButton button = MakeButton(names[i], 92, 34);
            button.Accent = i == 0;
            button.Margin = new Padding(0, 0, 8, 0);
            button.Click += delegate { SelectPage(index); };
            navBar.Controls.Add(button);
            navButtons.Add(button);
        }

        contentHost = new Panel();
        contentHost.Dock = DockStyle.Fill;
        contentHost.BackColor = BgColor;
        layout.Controls.Add(contentHost, 0, 1);

        pages.Add(BuildOverviewPage());
        pages.Add(BuildLyricsPage());
        pages.Add(BuildLogsPage());
        pages.Add(BuildSettingsPage());
        for (int i = 0; i < pages.Count; i++)
        {
            pages[i].Dock = DockStyle.Fill;
            pages[i].Visible = i == 0;
            contentHost.Controls.Add(pages[i]);
        }
        currentPage = 0;
        SelectPage(0);
        return area;
    }

    static void SelectPage(int index)
    {
        if (index < 0 || index >= pages.Count) return;
        currentPage = index;
        for (int i = 0; i < pages.Count; i++) pages[i].Visible = i == index;
        for (int i = 0; i < navButtons.Count; i++)
        {
            navButtons[i].Accent = i == index;
            navButtons[i].Invalidate();
        }
        contentHost.PerformLayout();
        pages[index].PerformLayout();
        WindowTheme.ApplyDarkScrollbars(pages[index]);
    }

    static Panel MakePage()
    {
        Panel page = new Panel();
        page.BackColor = BgColor;
        page.ForeColor = TextColor;
        page.Padding = new Padding(0, 8, 0, 0);
        return page;
    }

    static RoundPanel MakeCardPanel()
    {
        RoundPanel card = new RoundPanel();
        card.Dock = DockStyle.Fill;
        card.BackColor = CardColor;
        card.Padding = new Padding(18);
        return card;
    }

    static Panel BuildOverviewPage()
    {
        Panel page = MakePage();
        RoundPanel card = MakeCardPanel();
        page.Controls.Add(card);

        TableLayoutPanel grid = new TableLayoutPanel();
        grid.Dock = DockStyle.Fill;
        grid.ColumnCount = 2;
        grid.RowCount = 2;
        grid.BackColor = CardColor;
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 66f));

        RoundPanel playing = BuildStatCard("播放状态",
            new string[] { "connection", "track", "lyrics", "clients", "cache", "lrc", "mem" },
            new string[] { "连接状态", "当前歌曲", "歌词", "客户端", "歌词缓存", "LRC 索引", "内存占用" });
        playing.Margin = new Padding(0, 0, 10, 0);
        grid.Controls.Add(playing, 0, 0);

        RoundPanel bridge = BuildStatCard("服务与桥接",
            new string[] { "port", "bridgeMode", "bridgeTransport", "bridgeState", "bridgeAge", "smtc" },
            new string[] { "服务端口", "桥接模式", "桥接传输", "桥接状态", "最近更新", "SMTC 支持" });
        bridge.Margin = new Padding(10, 0, 0, 0);
        grid.Controls.Add(bridge, 1, 0);

        RoundPanel actionsCard = new RoundPanel();
        actionsCard.Dock = DockStyle.Fill;
        actionsCard.Margin = new Padding(0, 12, 0, 0);
        actionsCard.BackColor = Card2Color;

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.FlowDirection = FlowDirection.LeftToRight;
        actions.WrapContents = false;
        actions.BackColor = Card2Color;
        actions.Padding = new Padding(16, 12, 0, 0);

        PillButton clear = MakeButton("清空歌词缓存", 124, 34);
        clear.Click += delegate { HttpGet("/api/clear-cache", 1500); AppendUiLog("已请求清空缓存"); };
        actions.Controls.Add(clear);

        chkExternal = new CheckBox();
        chkExternal.Text = "允许外网访问";
        chkExternal.ForeColor = TextColor;
        chkExternal.BackColor = Card2Color;
        chkExternal.AutoSize = true;
        chkExternal.Margin = new Padding(16, 10, 0, 0);
        chkExternal.CheckedChanged += delegate
        {
            if (suppressExternalEvent) return;
            HttpGet("/api/ext?val=" + (chkExternal.Checked ? "1" : "0"), 1500);
        };
        actions.Controls.Add(chkExternal);

        PillButton openLyrics = MakeButton("打开歌词页", 108, 34);
        openLyrics.Click += delegate { OpenUrl("http://localhost:" + port + "/"); };
        actions.Controls.Add(openLyrics);

        PillButton openConsole = MakeButton("网页控制台", 108, 34);
        openConsole.Click += delegate { OpenUrl("http://localhost:" + port + "/gui"); };
        actions.Controls.Add(openConsole);

        actionsCard.Controls.Add(actions);
        grid.Controls.Add(actionsCard, 0, 1);
        grid.SetColumnSpan(actionsCard, 2);
        card.Controls.Add(grid);
        return page;
    }

    static RoundPanel BuildStatCard(string title, string[] keys, string[] labels)
    {
        RoundPanel card = new RoundPanel();
        card.Dock = DockStyle.Fill;
        card.BackColor = Card2Color;
        card.Padding = new Padding(18, 14, 18, 12);

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 2;
        layout.BackColor = Card2Color;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        card.Controls.Add(layout);

        Label head = new Label();
        head.Text = title;
        head.Font = fontBold;
        head.ForeColor = TextColor;
        head.Dock = DockStyle.Fill;
        head.BackColor = Color.Transparent;
        layout.Controls.Add(head, 0, 0);

        TableLayoutPanel table = new TableLayoutPanel();
        table.Dock = DockStyle.Fill;
        table.ColumnCount = 2;
        table.RowCount = keys.Length;
        table.BackColor = Card2Color;
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100f));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        for (int i = 0; i < keys.Length; i++)
        {
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 100f / keys.Length));
            AddInfoRow(table, i, labels[i], keys[i]);
        }
        layout.Controls.Add(table, 0, 1);
        return card;
    }

    static void AddInfoRow(TableLayoutPanel grid, int row, string label, string key)
    {
        Label name = new Label();
        name.Text = label;
        name.ForeColor = MutedColor;
        name.Font = fontSmall;
        name.Dock = DockStyle.Fill;
        name.TextAlign = ContentAlignment.MiddleLeft;
        name.BackColor = Color.Transparent;

        Label value = new Label();
        value.Text = "-";
        value.ForeColor = TextColor;
        value.Font = fontBase;
        value.Dock = DockStyle.Fill;
        value.TextAlign = ContentAlignment.MiddleLeft;
        value.AutoEllipsis = true;
        value.BackColor = Color.Transparent;

        grid.Controls.Add(name, 0, row);
        grid.Controls.Add(value, 1, row);
        infoValues[key] = value;
    }

    static Panel BuildLyricsPage()
    {
        Panel page = MakePage();
        RoundPanel card = MakeCardPanel();
        page.Controls.Add(card);

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 2;
        layout.BackColor = CardColor;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        card.Controls.Add(layout);

        lyricsSource = new Label();
        lyricsSource.Text = "暂无歌词";
        lyricsSource.Dock = DockStyle.Fill;
        lyricsSource.ForeColor = MutedColor;
        lyricsSource.Font = fontSmall;
        lyricsSource.BackColor = Color.Transparent;
        layout.Controls.Add(lyricsSource, 0, 0);

        lyricsList = new ListBox();
        lyricsList.Dock = DockStyle.Fill;
        lyricsList.BackColor = CardColor;
        lyricsList.ForeColor = TextColor;
        lyricsList.BorderStyle = BorderStyle.None;
        lyricsList.DrawMode = DrawMode.OwnerDrawFixed;
        lyricsList.ItemHeight = 30;
        lyricsList.Font = fontBase;
        lyricsList.DrawItem += LyricsDrawItem;
        lyricsList.Items.Add("暂无歌词");
        layout.Controls.Add(lyricsList, 0, 1);
        return page;
    }

    static void LyricsDrawItem(object sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= lyricsList.Items.Count) return;
        bool active = e.Index == lyricCurrent;
        using (SolidBrush back = new SolidBrush(active ? Color.FromArgb(44, 33, 19) : CardColor))
        {
            e.Graphics.FillRectangle(back, e.Bounds);
        }
        string text = Convert.ToString(lyricsList.Items[e.Index]);
        TextRenderer.DrawText(e.Graphics, text, active ? fontBold : fontBase,
            new Rectangle(e.Bounds.X + 16, e.Bounds.Y, e.Bounds.Width - 24, e.Bounds.Height),
            active ? AccentColor : MutedColor,
            TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }

    static Panel BuildLogsPage()
    {
        Panel page = MakePage();
        RoundPanel card = MakeCardPanel();
        page.Controls.Add(card);

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 2;
        layout.BackColor = CardColor;
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44f));
        card.Controls.Add(layout);

        logBox = new TextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.WordWrap = false;
        logBox.BackColor = Color.FromArgb(12, 12, 17);
        logBox.ForeColor = MutedColor;
        logBox.BorderStyle = BorderStyle.None;
        logBox.Font = new Font("Consolas", 9f);
        layout.Controls.Add(logBox, 0, 0);

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.FlowDirection = FlowDirection.LeftToRight;
        actions.BackColor = CardColor;
        actions.Padding = new Padding(0, 8, 0, 0);

        PillButton clear = MakeButton("清空显示", 96, 30);
        clear.Click += delegate { logBox.Clear(); lastLogs.Clear(); };
        actions.Controls.Add(clear);

        PillButton copy = MakeButton("复制全部", 96, 30);
        copy.Click += delegate
        {
            if (CopyText(logBox.Text)) AppendUiLog("日志已复制到剪贴板");
            else
            {
                MessageBox.Show(form, "复制失败，请稍后再试。", "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        actions.Controls.Add(copy);

        layout.Controls.Add(actions, 0, 1);
        return page;
    }

    static Panel BuildSettingsPage()
    {
        Panel page = MakePage();
        RoundPanel card = MakeCardPanel();
        page.Controls.Add(card);

        FlowLayoutPanel flow = new FlowLayoutPanel();
        flow.Dock = DockStyle.Fill;
        flow.FlowDirection = FlowDirection.TopDown;
        flow.WrapContents = false;
        flow.AutoScroll = true;
        flow.BackColor = CardColor;
        flow.Padding = new Padding(0);
        card.Controls.Add(flow);

        RoundPanel detection = new RoundPanel();
        detection.Height = 236;
        detection.Width = 820;
        detection.Margin = new Padding(0, 0, 0, 12);
        detection.BackColor = Card2Color;
        flow.Controls.Add(detection);

        Label detectTitle = new Label();
        detectTitle.Text = "播放器检测";
        detectTitle.Font = fontBold;
        detectTitle.ForeColor = TextColor;
        detectTitle.SetBounds(18, 14, 400, 24);
        detection.Controls.Add(detectTitle);

        Label extraLabel = new Label();
        extraLabel.Text = "额外播放器进程名（逗号分隔，窗口标题模式使用）";
        extraLabel.ForeColor = MutedColor;
        extraLabel.Font = fontSmall;
        extraLabel.SetBounds(18, 44, 620, 20);
        detection.Controls.Add(extraLabel);

        txtPlayers = new TextBox();
        txtPlayers.SetBounds(18, 68, 520, 30);
        txtPlayers.BackColor = Color.FromArgb(12, 12, 17);
        txtPlayers.ForeColor = TextColor;
        txtPlayers.BorderStyle = BorderStyle.FixedSingle;
        txtPlayers.Font = fontBase;
        detection.Controls.Add(txtPlayers);

        PillButton save = MakeButton("保存并重启服务", 140, 30);
        save.SetBounds(548, 67, 140, 30);
        save.Click += delegate { SavePlayers(); };
        detection.Controls.Add(save);

        PillButton diag = MakeButton("播放器诊断", 120, 30);
        diag.SetBounds(18, 112, 120, 30);
        diag.Click += delegate { ShowDiagnostics(); };
        detection.Controls.Add(diag);

        lblManual = new Label();
        lblManual.SetBounds(152, 118, 560, 20);
        lblManual.ForeColor = MutedColor;
        lblManual.Font = fontSmall;
        lblManual.Text = "手动检测：未启用";
        detection.Controls.Add(lblManual);

        PillButton stopManual = MakeButton("停止手动检测", 120, 30);
        stopManual.SetBounds(18, 152, 120, 30);
        stopManual.Click += delegate { StopManualDetection(true); };
        detection.Controls.Add(stopManual);

        lblDiag = new Label();
        lblDiag.SetBounds(18, 188, 760, 40);
        lblDiag.ForeColor = MutedColor;
        lblDiag.Font = fontSmall;
        lblDiag.Text = "提示：若没有播放器窗口出现在诊断列表，请在普通桌面会话中运行；管理员播放器需要本控制台同样以管理员运行。";
        detection.Controls.Add(lblDiag);

        RoundPanel address = new RoundPanel();
        address.Height = 318;
        address.Width = 820;
        address.Margin = new Padding(0, 0, 0, 12);
        address.BackColor = Card2Color;
        flow.Controls.Add(address);

        Label addrTitle = new Label();
        addrTitle.Text = "访问地址";
        addrTitle.Font = fontBold;
        addrTitle.ForeColor = TextColor;
        addrTitle.SetBounds(18, 14, 300, 24);
        address.Controls.Add(addrTitle);

        addrList = new ListBox();
        addrList.SetBounds(18, 46, 740, 170);
        addrList.BackColor = Color.FromArgb(12, 12, 17);
        addrList.ForeColor = TextColor;
        addrList.BorderStyle = BorderStyle.None;
        addrList.Font = new Font("Consolas", 9f);
        addrList.DoubleClick += delegate { CopySelectedAddress(); };
        address.Controls.Add(addrList);

        ContextMenuStrip addrMenu = new ContextMenuStrip();
        addrMenu.Items.Add("复制地址", null, delegate { CopySelectedAddress(); });
        addrMenu.Items.Add("打开地址", null, delegate { OpenSelectedAddress(); });
        addrList.ContextMenuStrip = addrMenu;

        PillButton openAddr = MakeButton("打开选中地址", 120, 30);
        openAddr.SetBounds(18, 226, 120, 30);
        openAddr.Click += delegate { OpenSelectedAddress(); };
        address.Controls.Add(openAddr);

        PillButton copyAddr = MakeButton("复制选中地址", 120, 30);
        copyAddr.SetBounds(148, 226, 120, 30);
        copyAddr.Click += delegate { CopySelectedAddress(); };
        address.Controls.Add(copyAddr);

        PillButton copyAll = MakeButton("复制全部地址", 120, 30);
        copyAll.SetBounds(278, 226, 120, 30);
        copyAll.Click += delegate { CopyAllAddresses(); };
        address.Controls.Add(copyAll);

        lblAddrHint = new Label();
        lblAddrHint.SetBounds(18, 266, 740, 20);
        lblAddrHint.ForeColor = MutedColor;
        lblAddrHint.Font = fontSmall;
        lblAddrHint.Text = "默认选中第一个地址；双击地址或右键可复制";
        address.Controls.Add(lblAddrHint);

        RoundPanel tools = new RoundPanel();
        tools.Height = 182;
        tools.Width = 820;
        tools.Margin = new Padding(0);
        tools.BackColor = Card2Color;
        flow.Controls.Add(tools);

        Label toolsTitle = new Label();
        toolsTitle.Text = "权限与工具";
        toolsTitle.Font = fontBold;
        toolsTitle.ForeColor = TextColor;
        toolsTitle.SetBounds(18, 14, 300, 24);
        tools.Controls.Add(toolsTitle);

        Label lblElevation = new Label();
        lblElevation.SetBounds(18, 48, 760, 20);
        lblElevation.ForeColor = elevated ? MutedColor : Color.FromArgb(235, 190, 110);
        lblElevation.Font = fontSmall;
        lblElevation.Text = elevated
            ? "权限：管理员（窗口标题检测可用）"
            : "权限：普通用户 — 可能读不到管理员播放器的窗口";
        tools.Controls.Add(lblElevation);

        PillButton elevate = MakeButton("以管理员身份重启", 160, 30);
        elevate.SetBounds(18, 76, 160, 30);
        elevate.Visible = !elevated;
        elevate.Click += delegate { RestartElevated(); };
        tools.Controls.Add(elevate);

        PillButton clearCache = MakeButton("清空歌词缓存", 120, 30);
        clearCache.SetBounds(18, 120, 120, 30);
        clearCache.Click += delegate { HttpGet("/api/clear-cache", 1500); AppendUiLog("已请求清空缓存"); };
        tools.Controls.Add(clearCache);

        PillButton openLyrics = MakeButton("打开歌词页", 108, 30);
        openLyrics.SetBounds(150, 120, 108, 30);
        openLyrics.Click += delegate { OpenUrl("http://localhost:" + port + "/"); };
        tools.Controls.Add(openLyrics);

        PillButton openConsole = MakeButton("网页控制台", 108, 30);
        openConsole.SetBounds(270, 120, 108, 30);
        openConsole.Click += delegate { OpenUrl("http://localhost:" + port + "/gui"); };
        tools.Controls.Add(openConsole);

        flow.Resize += delegate
        {
            int width = flow.ClientSize.Width - 24;
            if (width < 300) width = 300;
            detection.Width = width;
            address.Width = width;
            tools.Width = width;
        };

        detection.Resize += delegate
        {
            int width = detection.Width;
            if (width <= 0) return;
            txtPlayers.Width = Math.Max(220, width - 200);
            save.Left = Math.Max(238, width - 158);
            lblManual.Width = Math.Max(120, width - 170);
            lblDiag.Width = Math.Max(200, width - 36);
        };

        address.Resize += delegate
        {
            int width = address.Width;
            if (width <= 0) return;
            addrList.Width = Math.Max(200, width - 36);
            lblAddrHint.Width = Math.Max(200, width - 36);
        };

        tools.Resize += delegate
        {
            int width = tools.Width;
            if (width <= 0) return;
            lblElevation.Width = Math.Max(200, width - 36);
        };

        return page;
    }

    static Panel BuildFooter()
    {
        Panel footer = new Panel();
        footer.Dock = DockStyle.Fill;
        footer.BackColor = BgColor;

        lblFoot = new Label();
        lblFoot.Text = "就绪";
        lblFoot.Dock = DockStyle.Fill;
        lblFoot.ForeColor = Color.FromArgb(110, 108, 104);
        lblFoot.Font = fontSmall;
        lblFoot.TextAlign = ContentAlignment.MiddleLeft;
        lblFoot.Padding = new Padding(24, 0, 0, 0);
        footer.Controls.Add(lblFoot);
        return footer;
    }

    static PillButton MakeButton(string text, int width, int height)
    {
        PillButton button = new PillButton();
        button.Text = text;
        button.Width = width;
        button.Height = height;
        button.NormalColor = Card2Color;
        button.ForeColor = TextColor;
        button.Font = fontBase;
        return button;
    }

/* ---------- server lifecycle ---------- */

    static void BeginStartup()
    {
        SelectPage(currentPage);
        WindowTheme.ApplyDarkScrollbars(form);
        txtPlayers.Text = LoadPlayers();
        manualPending = LoadManualName();
        if (!elevated)
        {
            AppendUiLog("当前为普通权限；如果检测不到播放器，请在「设置」里点「以管理员身份重启」。");
        }
        if (manualPending.Length > 0) TryAttachPendingManual();

        StartPolling();

        if (Probe())
        {
            startedByUs = false;
            SetStatusText("已连接现有服务", true);
            return;
        }
        if (StartServerProcess())
        {
            btnPower.Text = "停止服务";
            btnPower.Accent = false;
            SetStatusText("正在启动服务...", false);
        }
    }

    static bool StartServerProcess()
    {
        string node = Path.Combine(baseDir, "node.exe");
        if (!File.Exists(node))
        {
            ShowError("找不到 node.exe，请把它和本程序放在同一目录。");
            return false;
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(node, "server.js");
            info.WorkingDirectory = baseDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.EnvironmentVariables["LF_NO_OPEN"] = "1";
            info.EnvironmentVariables["LF_LOG_FILE"] = logFile;
            string extras = txtPlayers != null ? txtPlayers.Text.Trim() : "";
            if (extras.Length > 0) info.EnvironmentVariables["LF_PLAYERS"] = extras;
            server = Process.Start(info);
            startedByUs = true;
            ready = false;
            return true;
        }
        catch (Exception ex)
        {
            ShowError("无法启动服务：" + ex.Message);
            return false;
        }
    }

    static void TogglePower()
    {
        bool running = ready || (server != null && !server.HasExited);
        if (running)
        {
            if (!startedByUs)
            {
                DialogResult result = MessageBox.Show(form, "当前连接的是已经运行的服务，确定要停止它吗？", "LyricFlow",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (result != DialogResult.Yes) return;
            }
            ShutdownServer();
            SetStatusText("服务已停止", false);
            btnPower.Text = "启动服务";
            btnPower.Accent = true;
        }
        else
        {
            if (StartServerProcess())
            {
                btnPower.Text = "停止服务";
                btnPower.Accent = false;
                SetStatusText("正在启动服务...", false);
            }
        }
    }

    static void RestartServer()
    {
        ShutdownServer();
        ready = false;
        SetStatusText("正在重启服务...", false);
        ThreadPool.QueueUserWorkItem(delegate
        {
            Thread.Sleep(900);
            InvokeUi(new Action(delegate
            {
                if (StartServerProcess()) SetStatusText("正在启动服务...", false);
            }));
        });
    }

    static void ShutdownServer()
    {
        try { HttpGet("/api/shutdown", 800); } catch { }
        try
        {
            if (server != null && !server.HasExited)
            {
                if (!server.WaitForExit(2000)) server.Kill();
            }
        }
        catch { }
        server = null;
        startedByUs = false;
        ready = false;
    }

    static void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (trayIcon != null)
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayIcon = null;
        }
        StopManualDetection(false);
        if (startedByUs) ShutdownServer();
    }

    /* ---------- polling ---------- */

    static void StartPolling()
    {
        pollTimer = new System.Threading.Timer(delegate { PollTick(); }, null, 250, 500);
    }

    static void PollTick()
    {
        if (polling) return;
        polling = true;
        try
        {
            if (manualPid == 0 && manualPending.Length > 0) TryAttachPendingManual();

            Dictionary<string, object> status = GetJson("/api/status", 900);
            if (status == null)
            {
                ready = false;
                InvokeUi(new Action(delegate { ApplyOffline(); }));
                return;
            }
            ready = true;
            string title = Str(status, "title");
            string artist = Str(status, "artist");
            string key = (artist + "|" + title).ToLowerInvariant();
            if (key != lastTrackKey)
            {
                lastTrackKey = key;
                lyricsDirty = true;
            }
            int statusLyricsCount = (int)Num(status, "lyricsCount");
            if (statusLyricsCount > 0 && statusLyricsCount != loadedLyricsCount) lyricsDirty = true;

            object[] lyrics = null;
            bool fetchedLyrics = false;
            if (lyricsDirty)
            {
                lyricsDirty = false;
                lyrics = GetArray("/api/lyrics", 2000, "lyrics");
                fetchedLyrics = true;
            }

            tickCount++;
            object[] logs = null;
            if (tickCount % 3 == 0)
            {
                logs = GetStringArray("/api/logs?limit=200", 1500);
            }

            InvokeUi(new Action(delegate
            {
                ApplyStatus(status);
                if (logs != null) AppendLogs(logs);
                if (fetchedLyrics)
                {
                    if (lyrics != null)
                    {
                        ApplyLyrics(lyrics, Str(status, "lyricsSource"));
                        if (lyrics.Length == 0 && statusLyricsCount > 0) lyricsDirty = true;
                    }
                    else if (statusLyricsCount == 0)
                    {
                        ApplyLyrics(null, "");
                    }
                    else
                    {
                        lyricsDirty = true;
                    }
                }
            }));
        }
        catch { }
        finally
        {
            polling = false;
        }
    }

    static void ApplyStatus(Dictionary<string, object> status)
    {
        bool connected = Bool(status, "connected");
        string title = Str(status, "title");
        string artist = Str(status, "artist");
        double position = Num(status, "position");
        double duration = Num(status, "duration");
        if (duration <= 0) duration = Num(status, "estDur");
        bool playing = Bool(status, "isPlaying");

        lblTitle.Text = string.IsNullOrEmpty(title) ? "等待播放..." : title;
        lblArtist.Text = string.IsNullOrEmpty(artist) ? "" : artist;
        btnPlay.Text = playing ? "\u275A\u275A" : "\u25B6";

        if (duration > 0)
        {
            lastPct = (int)Math.Max(0, Math.Min(100, position / duration * 100));
            lblCur.Text = Fmt(position);
            lblTotal.Text = Fmt(duration);
        }
        else
        {
            lastPct = 0;
            lblCur.Text = "0:00";
            lblTotal.Text = "0:00";
        }
        ApplyProgress(lastPct);

        SetStatusText(connected ? "已连接播放器 · 端口 " + port : "服务已就绪 · 等待播放器", true);
        btnPower.Text = "停止服务";
        btnPower.Accent = false;
        btnPower.Enabled = true;
        btnRestart.Enabled = true;
        SetPlayEnabled(true);

        Dictionary<string, object> bridge = null;
        object bridgeObject;
        if (status.TryGetValue("bridge", out bridgeObject)) bridge = bridgeObject as Dictionary<string, object>;

        SetInfo("connection", connected ? "已连接" : "等待播放器");
        SetInfo("track", string.IsNullOrEmpty(title) ? "-" : (artist.Length > 0 ? title + " — " + artist : title));
        SetInfo("lyrics", (Str(status, "lyricsSource").Length > 0 ? Str(status, "lyricsSource") : "-") + " / " + (int)Num(status, "lyricsCount") + " 行");
        SetInfo("clients", ((int)Num(status, "clients")).ToString());
        SetInfo("cache", ((int)Num(status, "cacheSize")).ToString());
        SetInfo("lrc", ((int)Num(status, "lrcIndexSize")).ToString());
        SetInfo("mem", Str(status, "memMB") + " MB");
        SetInfo("port", port.ToString());
        if (bridge != null)
        {
            SetInfo("bridgeMode", Str(bridge, "mode"));
            SetInfo("bridgeTransport", Str(bridge, "transport"));
            SetInfo("bridgeState", Bool(bridge, "alive") ? "运行中" : "未运行");
            object age = null;
            bridge.TryGetValue("lastUpdateAgo", out age);
            SetInfo("bridgeAge", age == null ? "-" : age + " 秒前");
            SetInfo("smtc", Bool(bridge, "smtc") ? "可用" : "不可用（仅窗口标题）");
        }

        suppressExternalEvent = true;
        chkExternal.Checked = Bool(status, "allowExternal");
        suppressExternalEvent = false;

        UpdateAddresses(status);
        UpdateLyricSelection(position);
        if (bridge != null && !bridge.ContainsKey("players"))
        {
            lblFoot.Text = "检测到旧版服务，点击右上角「重启服务」启用新检测";
        }
        else
        {
            lblFoot.Text = "最近更新 " + DateTime.Now.ToString("HH:mm:ss");
        }
    }

    static void ApplyOffline()
    {
        bool running = server != null && !server.HasExited;
        if (running)
        {
            SetStatusText("正在启动服务...", false);
            btnPower.Text = "停止服务";
            btnPower.Accent = false;
        }
        else
        {
            SetStatusText("服务未运行", false);
            btnPower.Text = "启动服务";
            btnPower.Accent = true;
        }
        btnPower.Enabled = true;
        btnRestart.Enabled = false;
        SetPlayEnabled(false);
        SetInfo("connection", "未连接");
        SetInfo("bridgeState", "未运行");
        lblFoot.Text = running ? "服务正在启动..." : "服务未运行 · 点击「启动服务」重试";
    }

    static void SetStatusText(string text, bool online)
    {
        lblStatus.Text = "\u25CF " + text;
        lblStatus.ForeColor = online ? Color.FromArgb(110, 231, 168) : MutedColor;
    }

    static void SetPlayEnabled(bool enabled)
    {
        btnPrev.Enabled = enabled;
        btnPlay.Enabled = enabled;
        btnNext.Enabled = enabled;
    }

    static void SetInfo(string key, string value)
    {
        Label label;
        if (infoValues.TryGetValue(key, out label)) label.Text = value;
    }

    static void ApplyProgress(int pct)
    {
        if (progressBar != null) progressBar.Value = pct;
    }

    static void UpdateLyricSelection(double position)
    {
        if (lyricTimes.Count == 0 || lyricsList == null) return;
        int index = -1;
        for (int i = lyricTimes.Count - 1; i >= 0; i--)
        {
            if (lyricTimes[i] <= position) { index = i; break; }
        }
        if (index == lyricCurrent) return;
        lyricCurrent = index;
        if (index >= 0)
        {
            if (index + 3 < lyricsList.Items.Count) lyricsList.TopIndex = Math.Max(0, index - 3);
            else lyricsList.TopIndex = Math.Max(0, lyricsList.Items.Count - 8);
        }
        lyricsList.Invalidate();
    }

    static void ApplyLyrics(object[] items, string source)
    {
        lyricTimes.Clear();
        lyricsList.Items.Clear();
        lyricCurrent = -1;

        int actualCount = 0;
        if (items != null)
        {
            for (int i = 0; i < items.Length; i++)
            {
                Dictionary<string, object> line = items[i] as Dictionary<string, object>;
                if (line == null) continue;
                lyricTimes.Add(Num(line, "time"));
                lyricsList.Items.Add(Str(line, "text"));
                actualCount++;
            }
        }
        loadedLyricsCount = actualCount;
        if (lyricsList.Items.Count == 0)
        {
            lyricsList.Items.Add("暂无歌词");
            lyricsSource.Text = "暂无歌词";
        }
        else
        {
            lyricsSource.Text = "来源：" + (string.IsNullOrEmpty(source) ? "-" : source) + " · " + lyricTimes.Count + " 行";
        }
        lyricsList.Invalidate();
    }

    static void UpdateAddresses(Dictionary<string, object> status)
    {
        object value;
        if (!status.TryGetValue("addresses", out value)) return;
        object[] items = value as object[];
        if (items == null) return;

        StringBuilder signature = new StringBuilder();
        List<string> labels = new List<string>();
        for (int i = 0; i < items.Length; i++)
        {
            Dictionary<string, object> entry = items[i] as Dictionary<string, object>;
            if (entry == null) continue;
            string tag = Str(entry, "tag");
            string url = Str(entry, "url");
            labels.Add(tag + "  " + url);
            signature.Append(url).Append('|');
        }
        if (signature.ToString() == lastAddressKey) return;
        lastAddressKey = signature.ToString();

        addrList.BeginUpdate();
        addrList.Items.Clear();
        for (int i = 0; i < labels.Count; i++) addrList.Items.Add(labels[i]);
        addrList.EndUpdate();
        if (addrList.Items.Count > 0) addrList.SelectedIndex = 0;
    }

    /* ---------- logs / lyrics fetch ---------- */

    static void AppendLogs(object[] entries)
    {
        if (entries == null || logBox == null) return;

        List<string> incoming = new List<string>();
        for (int i = 0; i < entries.Length; i++) incoming.Add(Convert.ToString(entries[i]) ?? "");

        int oldCount = lastLogs.Count;
        int overlap = 0;
        int max = Math.Min(oldCount, incoming.Count);
        for (int size = max; size >= 1; size--)
        {
            bool match = true;
            for (int j = 0; j < size; j++)
            {
                if (lastLogs[oldCount - size + j] != incoming[j]) { match = false; break; }
            }
            if (match) { overlap = size; break; }
        }

        lastLogs.Clear();
        lastLogs.AddRange(incoming);
        if (lastLogs.Count > 300) lastLogs.RemoveRange(0, lastLogs.Count - 300);

        if (overlap >= incoming.Count) return;

        StringBuilder builder = new StringBuilder();
        for (int i = overlap; i < incoming.Count; i++) builder.Append(incoming[i]).Append("\r\n");
        if (builder.Length == 0) return;

        logBox.AppendText(builder.ToString());
        if (logBox.TextLength > 200000)
        {
            logBox.Text = logBox.Text.Substring(logBox.TextLength - 100000);
        }
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    static void AppendUiLog(string text)
    {
        if (logBox == null) return;
        logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text + "\r\n");
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    /* ---------- settings / diagnostics ---------- */

    static string LoadPlayers()
    {
        try
        {
            string file = Path.Combine(baseDir, "players.ini");
            if (File.Exists(file)) return File.ReadAllText(file).Trim();
        }
        catch { }
        return "";
    }

    static void SavePlayers()
    {
        try
        {
            File.WriteAllText(Path.Combine(baseDir, "players.ini"), txtPlayers.Text.Trim());
            AppendUiLog("已保存播放器名单，正在重启服务...");
            RestartServer();
        }
        catch (Exception ex)
        {
            ShowError("保存失败：" + ex.Message);
        }
    }

    static string ManualFile()
    {
        return Path.Combine(baseDir, "manual.ini");
    }

    static string LoadManualName()
    {
        try
        {
            if (File.Exists(ManualFile())) return File.ReadAllText(ManualFile()).Trim();
        }
        catch { }
        return "";
    }

    static void SaveManualName(string name)
    {
        try { File.WriteAllText(ManualFile(), name); }
        catch { }
    }

    static void StartManualDetection(int pid, string name)
    {
        StopManualDetection(false);
        manualPid = pid;
        manualName = name;
        manualPending = "";
        manualLastTitle = "";
        SaveManualName(name);

        if (lblManual != null) lblManual.Text = "手动检测：" + name + "（PID " + pid + "）";
        AppendUiLog("手动检测已启用：" + name + "（PID " + pid + "）");
        manualTimer = new System.Threading.Timer(delegate { PollManual(); }, null, 0, 500);
    }

    static void StopManualDetection(bool clearSaved)
    {
        if (manualTimer != null)
        {
            try { manualTimer.Dispose(); } catch { }
            manualTimer = null;
        }
        string previous = manualName;
        manualPid = 0;
        manualName = "";
        manualLastTitle = "";

        if (clearSaved)
        {
            manualPending = "";
            try { if (File.Exists(ManualFile())) File.Delete(ManualFile()); } catch { }
        }
        else if (previous.Length > 0)
        {
            manualPending = previous;
        }

        InvokeUi(new Action(delegate
        {
            if (lblManual != null)
            {
                lblManual.Text = manualPending.Length > 0
                    ? "手动检测：等待 " + manualPending + " 窗口"
                    : "手动检测：未启用";
            }
        }));
    }

    static void PollManual()
    {
        int pid = manualPid;
        if (pid == 0) return;
        try
        {
            Process process = Process.GetProcessById(pid);
            string title = process.MainWindowTitle;
            if (!string.IsNullOrEmpty(title) && title != manualLastTitle)
            {
                manualLastTitle = title;
                string result = HttpGet("/api/manual-track?title=" + Uri.EscapeDataString(title), 1200);
                if (result == null) manualLastTitle = "";
            }
        }
        catch
        {
            StopManualDetection(false);
        }
    }

    static void TryAttachPendingManual()
    {
        string name = manualPending;
        if (string.IsNullOrEmpty(name)) return;
        try
        {
            foreach (Process process in Process.GetProcessesByName(name))
            {
                if (string.IsNullOrEmpty(process.MainWindowTitle)) continue;
                int pid = process.Id;
                InvokeUi(new Action(delegate { StartManualDetection(pid, name); }));
                return;
            }
        }
        catch { }
    }

    static bool IsElevated()
    {
        try
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch { return false; }
    }

    static void RestartElevated()
    {
        if (elevated) return;
        if (ready || (server != null && !server.HasExited))
        {
            ShutdownServer();
            Thread.Sleep(900);
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(Application.ExecutablePath);
            info.UseShellExecute = true;
            info.Verb = "runas";
            Process.Start(info);
            form.Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(form, "无法以管理员身份重启：" + ex.Message,
                "LyricFlow", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void ShowDiagnostics()
    {
        Form dialog = new Form();
        dialog.Text = "播放器诊断";
        dialog.Width = 780;
        dialog.Height = 620;
        dialog.StartPosition = FormStartPosition.CenterParent;
        dialog.BackColor = BgColor;
        dialog.ForeColor = TextColor;
        dialog.Font = fontBase;

        Label head = new Label();
        head.Dock = DockStyle.Top;
        head.Height = 74;
        head.ForeColor = MutedColor;
        head.Font = fontSmall;
        head.Padding = new Padding(14, 10, 14, 0);

        Dictionary<string, object> status = GetJson("/api/status", 900);
        if (status != null)
        {
            Dictionary<string, object> bridge = null;
            object b;
            if (status.TryGetValue("bridge", out b)) bridge = b as Dictionary<string, object>;
            string bridgeText = bridge == null ? "无" :
                Str(bridge, "mode") + " / " + Str(bridge, "transport") + " / " + (Bool(bridge, "alive") ? "运行中" : "未运行");
            string smtcText = bridge != null && Bool(bridge, "smtc") ? "可用" : "不可用";
            string players = "默认名单";
            if (bridge != null)
            {
                object p;
                if (bridge.TryGetValue("players", out p) && p is object[])
                {
                    players = string.Join(", ", Array.ConvertAll((object[])p, x => Convert.ToString(x)));
                }
            }
            head.Text = "权限：" + (elevated ? "管理员" : "普通用户") +
                " · 桥接：" + bridgeText + " · SMTC：" + smtcText + "\r\n已识别进程名：" + players +
                "\r\n如果播放器窗口出现在下面但未被识别，把它的进程名填入「额外播放器进程名」并重启服务，或直接选中窗口点下面的按钮。";
        }
        else
        {
            head.Text = "服务未运行，无法读取桥接状态。";
        }
        dialog.Controls.Add(head);

        ListView list = new ListView();
        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.BackColor = Color.FromArgb(12, 12, 17);
        list.ForeColor = TextColor;
        list.BorderStyle = BorderStyle.None;
        list.Columns.Add("进程", 180);
        list.Columns.Add("PID", 70);
        list.Columns.Add("窗口标题", 480);

        try
        {
            Process[] processes = Process.GetProcesses();
            Array.Sort(processes, delegate(Process a, Process b) { return string.Compare(a.ProcessName, b.ProcessName); });
            foreach (Process process in processes)
            {
                try
                {
                    string windowTitle = process.MainWindowTitle;
                    if (string.IsNullOrEmpty(windowTitle)) continue;
                    ListViewItem item = new ListViewItem(process.ProcessName);
                    item.SubItems.Add(process.Id.ToString());
                    item.SubItems.Add(windowTitle);
                    list.Items.Add(item);
                }
                catch { }
            }
        }
        catch { }
        dialog.Controls.Add(list);
        list.BringToFront();

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Bottom;
        actions.Height = 48;
        actions.FlowDirection = FlowDirection.LeftToRight;
        actions.BackColor = BgColor;
        actions.Padding = new Padding(12, 8, 12, 8);

        Button add = MakeButton("加入额外播放器名单", 160, 30);
        add.Click += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            string name = list.SelectedItems[0].Text.Trim().ToLowerInvariant();
            string current = txtPlayers.Text.Trim();
            if (current.Length == 0) txtPlayers.Text = name;
            else if (("," + current.Replace(" ", "") + ",").IndexOf("," + name + ",") < 0) txtPlayers.Text = current + "," + name;
            AppendUiLog("已加入播放器名单：" + name + "，保存后重启生效");
        };
        actions.Controls.Add(add);

        Button use = MakeButton("使用此窗口作为播放器", 190, 30);
        use.Click += delegate
        {
            if (list.SelectedItems.Count == 0) return;
            ListViewItem item = list.SelectedItems[0];
            int pid;
            if (!int.TryParse(item.SubItems[1].Text, out pid)) return;
            StartManualDetection(pid, item.Text);
            dialog.Close();
        };
        actions.Controls.Add(use);

        Button close = MakeButton("关闭", 80, 30);
        close.Click += delegate { dialog.Close(); };
        actions.Controls.Add(close);

        dialog.Controls.Add(actions);
        dialog.ShowDialog(form);
    }

    /* ---------- HTTP ---------- */

    static Dictionary<string, object> GetJson(string path, int timeout)
    {
        string text = HttpGet(path, timeout);
        if (string.IsNullOrEmpty(text)) return null;
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 16 * 1024 * 1024;
            return serializer.DeserializeObject(text) as Dictionary<string, object>;
        }
        catch { return null; }
    }

    static object[] GetArray(string path, int timeout, string key)
    {
        Dictionary<string, object> data = GetJson(path, timeout);
        if (data == null) return null;
        object value;
        if (!data.TryGetValue(key, out value)) return null;
        return value as object[];
    }

    static object[] GetStringArray(string path, int timeout)
    {
        string text = HttpGet(path, timeout);
        if (string.IsNullOrEmpty(text)) return null;
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 16 * 1024 * 1024;
            return serializer.DeserializeObject(text) as object[];
        }
        catch { return null; }
    }

    static string HttpGet(string path, int timeout)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
            request.Timeout = timeout;
            request.ReadWriteTimeout = timeout;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
        catch { return null; }
    }

    static bool Probe()
    {
        return GetJson("/api/status", 900) != null;
    }

    /* ---------- helpers ---------- */

    static void SendKey(string key)
    {
        HttpGet("/api/key?key=" + key, 1200);
    }

    static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { }
    }

    static string ExtractUrl(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        int index = text.IndexOf("http", StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? text.Substring(index).Trim() : text.Trim();
    }

    static bool CopyText(string text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Clipboard.SetDataObject(text, true, 10, 100);
                return true;
            }
            catch
            {
                Thread.Sleep(80);
            }
        }
        try
        {
            Clipboard.SetText(text);
            return true;
        }
        catch
        {
            return false;
        }
    }

    static void ShowAddrStatus(string text, bool error)
    {
        if (lblAddrHint == null) return;
        lblAddrHint.Text = text;
        lblAddrHint.ForeColor = error ? DangerColor : Color.FromArgb(110, 231, 168);
    }

    static void OpenSelectedAddress()
    {
        if (addrList == null) return;
        if (addrList.SelectedItem == null && addrList.Items.Count > 0) addrList.SelectedIndex = 0;
        if (addrList.SelectedItem == null) return;
        string url = ExtractUrl(Convert.ToString(addrList.SelectedItem));
        if (url.Length > 0) OpenUrl(url);
    }

    static void CopySelectedAddress()
    {
        if (addrList == null)
        {
            ShowAddrStatus("地址列表尚未加载", true);
            return;
        }
        if (addrList.SelectedItem == null && addrList.Items.Count > 0) addrList.SelectedIndex = 0;
        if (addrList.SelectedItem == null)
        {
            ShowAddrStatus("没有可复制的地址，请先启动服务", true);
            return;
        }

        string url = ExtractUrl(Convert.ToString(addrList.SelectedItem));
        if (CopyText(url))
        {
            ShowAddrStatus("已复制：" + url, false);
            AppendUiLog("已复制地址：" + url);
        }
        else
        {
            ShowAddrStatus("复制失败，请手动选择下面的地址复制", true);
            MessageBox.Show(form, url, "复制失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void CopyAllAddresses()
    {
        if (addrList == null || addrList.Items.Count == 0)
        {
            ShowAddrStatus("没有可复制的地址，请先启动服务", true);
            return;
        }

        List<string> urls = new List<string>();
        for (int i = 0; i < addrList.Items.Count; i++)
        {
            string url = ExtractUrl(Convert.ToString(addrList.Items[i]));
            if (url.Length > 0) urls.Add(url);
        }
        string all = string.Join("\r\n", urls.ToArray());
        if (CopyText(all))
        {
            ShowAddrStatus("已复制 " + urls.Count + " 个地址", false);
            AppendUiLog("已复制全部地址（" + urls.Count + " 个）");
        }
        else
        {
            ShowAddrStatus("复制失败，请手动复制", true);
            MessageBox.Show(form, all, "复制失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void ShowError(string message)
    {
        if (form != null && !form.IsDisposed)
        {
            MessageBox.Show(form, message, "LyricFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void InvokeUi(Action action)
    {
        try
        {
            if (form != null && !form.IsDisposed) form.BeginInvoke(action);
        }
        catch { }
    }

    static string PickWritableDir(string child)
    {
        string[] candidates = new string[]
        {
            Path.Combine(baseDir, ".lyricflow-runtime", child),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LyricFlow", child),
            Path.Combine(Path.GetTempPath(), "LyricFlow", child)
        };
        foreach (string dir in candidates)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, "probe.tmp");
                File.WriteAllText(probe, "1");
                File.Delete(probe);
                return dir;
            }
            catch { }
        }
        return candidates[2];
    }

    static string Fmt(double seconds)
    {
        if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) seconds = 0;
        int total = (int)Math.Floor(seconds);
        return (total / 60) + ":" + (total % 60).ToString("D2");
    }

    static string Str(Dictionary<string, object> data, string key)
    {
        object value;
        if (data == null || !data.TryGetValue(key, out value) || value == null) return "";
        return Convert.ToString(value);
    }

    static double Num(Dictionary<string, object> data, string key)
    {
        object value;
        if (data == null || !data.TryGetValue(key, out value) || value == null) return 0;
        try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
        catch { return 0; }
    }

    static bool Bool(Dictionary<string, object> data, string key)
    {
        object value;
        if (data == null || !data.TryGetValue(key, out value) || value == null) return false;
        try { return Convert.ToBoolean(value, CultureInfo.InvariantCulture); }
        catch { return false; }
    }
}

class RoundPanel : Panel
{
    public int Radius = 18;
    public Color BorderColor = Color.FromArgb(40, 40, 52);

    public RoundPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Color.FromArgb(19, 19, 26);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateRegion();
    }

    void UpdateRegion()
    {
        if (Width <= 0 || Height <= 0) return;
        using (GraphicsPath path = RoundPath(new Rectangle(0, 0, Width, Height), Radius))
        {
            Region old = Region;
            Region = new Region(path);
            if (old != null) old.Dispose();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (Pen pen = new Pen(BorderColor))
        using (GraphicsPath path = RoundPath(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
        {
            e.Graphics.DrawPath(pen, path);
        }
    }

    internal static GraphicsPath RoundPath(Rectangle bounds, int radius)
    {
        GraphicsPath path = new GraphicsPath();
        if (radius <= 0)
        {
            path.AddRectangle(bounds);
            return path;
        }
        int diameter = radius * 2;
        if (bounds.Width < diameter || bounds.Height < diameter)
        {
            diameter = Math.Min(bounds.Width, bounds.Height);
        }
        if (diameter <= 0)
        {
            path.AddRectangle(bounds);
            return path;
        }
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

class PillButton : Button
{
    public bool Accent;
    public Color NormalColor = Color.FromArgb(27, 27, 36);
    bool hover;

    public PillButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        FlatAppearance.MouseOverBackColor = Color.Transparent;
        FlatAppearance.MouseDownBackColor = Color.Transparent;
        BackColor = Color.FromArgb(19, 19, 26);
        ForeColor = Color.FromArgb(235, 231, 223);
        Font = new Font("Microsoft YaHei UI", 9f);
        Cursor = Cursors.Hand;
    }

    protected override void OnPaintBackground(PaintEventArgs pevent)
    {
        // Rounded drawing happens in OnPaint; the parent paints the corners.
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        hover = true;
        Invalidate();
        base.OnMouseEnter(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        hover = false;
        Invalidate();
        base.OnMouseLeave(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        Color surface = Parent != null ? Parent.BackColor : Color.FromArgb(19, 19, 26);
        if (surface.A < 255) surface = Color.FromArgb(19, 19, 26);
        using (SolidBrush surfaceBrush = new SolidBrush(surface))
        {
            e.Graphics.FillRectangle(surfaceBrush, ClientRectangle);
        }

        Color background;
        Color foreground;
        Color border;

        if (!Enabled)
        {
            background = Color.FromArgb(26, 26, 33);
            foreground = Color.FromArgb(108, 106, 102);
            border = Color.FromArgb(38, 38, 48);
        }
        else if (Accent)
        {
            background = hover ? Color.FromArgb(255, 192, 116) : Color.FromArgb(255, 176, 84);
            foreground = Color.FromArgb(30, 20, 6);
            border = background;
        }
        else if (hover)
        {
            background = Color.FromArgb(40, 40, 52);
            foreground = Color.FromArgb(245, 242, 236);
            border = Color.FromArgb(60, 60, 76);
        }
        else
        {
            background = NormalColor;
            foreground = ForeColor;
            border = Color.FromArgb(44, 44, 58);
        }

        Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = RoundPanel.RoundPath(rect, Height / 2))
        {
            using (SolidBrush brush = new SolidBrush(background))
            {
                e.Graphics.FillPath(brush, path);
            }
            using (Pen pen = new Pen(border))
            {
                e.Graphics.DrawPath(pen, path);
            }
        }

        TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(0, 0, Width, Height), foreground,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
            TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

        if (Focused && ShowFocusCues)
        {
            Rectangle focus = new Rectangle(4, 4, Width - 9, Height - 9);
            using (Pen pen = new Pen(Color.FromArgb(90, 90, 110)))
            {
                e.Graphics.DrawRectangle(pen, focus);
            }
        }
    }
}

class ProgressBarEx : Control
{
    int currentValue;

    public int Value
    {
        get { return currentValue; }
        set
        {
            int next = Math.Max(0, Math.Min(100, value));
            if (next == currentValue) return;
            currentValue = next;
            Invalidate();
        }
    }

    public ProgressBarEx()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        Height = 8;
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        Rectangle track = new Rectangle(0, 0, Width, Height);
        using (GraphicsPath path = RoundPanel.RoundPath(track, Height / 2))
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(38, 38, 50)))
        {
            e.Graphics.FillPath(brush, path);
        }

        int fillWidth = (int)(Width * (currentValue / 100.0));
        if (fillWidth <= 0) return;
        if (fillWidth < Height) fillWidth = Height;
        if (fillWidth > Width) fillWidth = Width;

        Rectangle fill = new Rectangle(0, 0, fillWidth, Height);
        using (GraphicsPath path = RoundPanel.RoundPath(fill, Math.Min(Height / 2, fillWidth / 2)))
        using (LinearGradientBrush brush = new LinearGradientBrush(
            new Rectangle(0, 0, Math.Max(fillWidth, 2), Height),
            Color.FromArgb(255, 176, 84),
            Color.FromArgb(255, 122, 89),
            LinearGradientMode.Horizontal))
        {
            e.Graphics.FillPath(brush, path);
        }
    }
}

class FramelessForm : Form
{
    const int WM_NCHITTEST = 0x0084;
    const int WM_GETMINMAXINFO = 0x0024;
    const int HTCLIENT = 1;
    const int HTLEFT = 10;
    const int HTRIGHT = 11;
    const int HTTOP = 12;
    const int HTTOPLEFT = 13;
    const int HTTOPRIGHT = 14;
    const int HTBOTTOM = 15;
    const int HTBOTTOMLEFT = 16;
    const int HTBOTTOMRIGHT = 17;
    const int ResizeBorder = 6;

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public FramelessForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        DoubleBuffered = true;
        SetStyle(ControlStyles.ResizeRedraw, true);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int preference = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(Handle, 33, ref preference, sizeof(int));
        }
        catch { }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_NCHITTEST)
        {
            base.WndProc(ref message);
            if ((int)message.Result == HTCLIENT && WindowState != FormWindowState.Maximized)
            {
                int screenX = message.LParam.ToInt32() & 0xFFFF;
                int screenY = (message.LParam.ToInt32() >> 16) & 0xFFFF;
                Point point = PointToClient(new Point(screenX, screenY));

                bool left = point.X <= ResizeBorder;
                bool right = point.X >= ClientSize.Width - ResizeBorder;
                bool top = point.Y <= ResizeBorder;
                bool bottom = point.Y >= ClientSize.Height - ResizeBorder;

                if (top && left) message.Result = (IntPtr)HTTOPLEFT;
                else if (top && right) message.Result = (IntPtr)HTTOPRIGHT;
                else if (bottom && left) message.Result = (IntPtr)HTBOTTOMLEFT;
                else if (bottom && right) message.Result = (IntPtr)HTBOTTOMRIGHT;
                else if (left) message.Result = (IntPtr)HTLEFT;
                else if (right) message.Result = (IntPtr)HTRIGHT;
                else if (top) message.Result = (IntPtr)HTTOP;
                else if (bottom) message.Result = (IntPtr)HTBOTTOM;
            }
            return;
        }

        if (message.Msg == WM_GETMINMAXINFO)
        {
            base.WndProc(ref message);
            try
            {
                IntPtr monitor = MonitorFromWindow(Handle, 2); // MONITOR_DEFAULTTONEAREST
                MONITORINFO info = new MONITORINFO();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(monitor, ref info))
                {
                    MINMAXINFO minmax = (MINMAXINFO)Marshal.PtrToStructure(message.LParam, typeof(MINMAXINFO));
                    minmax.ptMaxPosition.X = info.rcWork.Left - info.rcMonitor.Left;
                    minmax.ptMaxPosition.Y = info.rcWork.Top - info.rcMonitor.Top;
                    minmax.ptMaxSize.X = info.rcWork.Right - info.rcWork.Left;
                    minmax.ptMaxSize.Y = info.rcWork.Bottom - info.rcWork.Top;
                    Marshal.StructureToPtr(minmax, message.LParam, true);
                }
            }
            catch { }
            return;
        }

        base.WndProc(ref message);
    }
}

class CaptionButton : Control
{
    public enum ButtonKind
    {
        Minimize,
        Maximize,
        Restore,
        Close,
    }

    public ButtonKind Kind = ButtonKind.Maximize;
    bool hover;

    public CaptionButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
        TabStop = false;
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        hover = true;
        Invalidate();
        base.OnMouseEnter(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        hover = false;
        Invalidate();
        base.OnMouseLeave(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        Color surface = Parent != null ? Parent.BackColor : Color.FromArgb(9, 9, 13);
        if (surface.A < 255) surface = Color.FromArgb(9, 9, 13);
        using (SolidBrush brush = new SolidBrush(surface))
        {
            e.Graphics.FillRectangle(brush, ClientRectangle);
        }

        Color glyph = Color.FromArgb(210, 206, 198);
        if (hover)
        {
            Color fill = Kind == ButtonKind.Close
                ? Color.FromArgb(196, 58, 58)
                : Color.FromArgb(38, 38, 48);
            using (SolidBrush brush = new SolidBrush(fill))
            {
                e.Graphics.FillRectangle(brush, ClientRectangle);
            }
            if (Kind == ButtonKind.Close) glyph = Color.White;
        }

        using (Pen pen = new Pen(glyph, 1.4f))
        {
            int centerX = Width / 2;
            int centerY = Height / 2;
            switch (Kind)
            {
                case ButtonKind.Minimize:
                    e.Graphics.DrawLine(pen, centerX - 5, centerY + 4, centerX + 5, centerY + 4);
                    break;
                case ButtonKind.Maximize:
                    e.Graphics.DrawRectangle(pen, centerX - 5, centerY - 5, 10, 10);
                    break;
                case ButtonKind.Restore:
                    e.Graphics.DrawRectangle(pen, centerX - 6, centerY - 3, 8, 8);
                    e.Graphics.DrawRectangle(pen, centerX - 2, centerY - 6, 8, 8);
                    break;
                case ButtonKind.Close:
                    e.Graphics.DrawLine(pen, centerX - 5, centerY - 5, centerX + 5, centerY + 5);
                    e.Graphics.DrawLine(pen, centerX + 5, centerY - 5, centerX - 5, centerY + 5);
                    break;
            }
        }
    }
}

static class WindowTheme
{
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    static extern int SetWindowTheme(IntPtr hwnd, string appName, string idList);

    public static void ApplyDarkScrollbars(Control control)
    {
        if (control == null) return;

        bool scrollable = control is ListBox ||
            (control is TextBox && ((TextBox)control).Multiline) ||
            (control is ScrollableControl && ((ScrollableControl)control).AutoScroll);

        if (scrollable && control.IsHandleCreated)
        {
            try
            {
                SetWindowTheme(control.Handle, "DarkMode_Explorer", "DarkMode_Explorer");
            }
            catch { }
        }

        foreach (Control child in control.Controls)
        {
            ApplyDarkScrollbars(child);
        }
    }
}

static class WindowDrag
{
    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

    public static void Attach(Control control, Form form)
    {
        if (control == null || form == null) return;
        control.MouseDown += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(form.Handle, 0x00A1, (IntPtr)0x0002, IntPtr.Zero); // WM_NCLBUTTONDOWN / HTCAPTION
        };
    }
}
