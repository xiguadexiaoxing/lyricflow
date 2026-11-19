using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Installer
{
    const string AppName = "LyricFlow";
    const string AppVersion = "1.1.0";
    const string Publisher = "LyricFlow";
    const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LyricFlow";
    const string ServerExe = "LyricFlow-Server.exe";
    const string UninstallExe = "Uninstall.exe";

    static readonly string DefaultInstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "LyricFlow");

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

#if UNINSTALLER
        if (args.Length > 0 && args[0] == "--remove")
        {
            RemoveFiles(args.Length > 1 ? args[1] : "");
            return;
        }
#endif

#if SETUP
        if (args.Length > 1 && args[0] == "--extract")
        {
            try { ExtractPayload(args[1]); }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); Environment.ExitCode = 1; }
            return;
        }
#endif

        if (!IsAdmin())
        {
            MessageBox.Show("需要管理员权限运行本程序。", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

#if SETUP
        Application.Run(new SetupForm());
#else
        Application.Run(new UninstallForm());
#endif
    }

    static bool IsAdmin()
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

    static string ReadableVersion()
    {
        return AppVersion;
    }

#if SETUP
    static Stream OpenPayload()
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceStream("LyricFlow.Payload.zip");
    }

    static void ExtractPayload(string directory)
    {
        Directory.CreateDirectory(directory);
        using (Stream stream = OpenPayload())
        {
            if (stream == null) throw new InvalidOperationException("安装包缺少内置文件。");
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string target = Path.GetFullPath(Path.Combine(directory, entry.FullName));
                    if (!target.StartsWith(Path.GetFullPath(directory) + Path.DirectorySeparatorChar,
                        StringComparison.OrdinalIgnoreCase)) continue;

                    string parent = Path.GetDirectoryName(target);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    entry.ExtractToFile(target, true);
                }
            }
        }
    }
#endif

    static void RenameToRequestedCase(string target)
    {
        string full = Path.GetFullPath(target).TrimEnd('\\');
        string parent = Path.GetDirectoryName(full);
        string leaf = Path.GetFileName(full);
        if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(leaf)) return;
        if (!Directory.Exists(parent)) return;

        string actual = null;
        foreach (string directory in Directory.GetDirectories(parent))
        {
            if (string.Equals(Path.GetFileName(directory), leaf, StringComparison.OrdinalIgnoreCase))
            {
                actual = directory;
                break;
            }
        }

        if (actual == null) return;
        if (string.Equals(Path.GetFileName(actual), leaf, StringComparison.Ordinal)) return;

        bool ours = File.Exists(Path.Combine(actual, ServerExe));
        bool empty = false;
        try { empty = Directory.GetFileSystemEntries(actual).Length == 0; } catch { }

        if (!ours && !empty)
        {
            throw new InvalidOperationException(
                "Windows 文件名不区分大小写：目录实际为 \"" + Path.GetFileName(actual) +
                "\"，与指定的 \"" + leaf + "\" 是同一个文件夹，但里面已有其他文件。\r\n\r\n" +
                "请换一个不同的文件夹名，例如 LyricFlow-New。");
        }

        string temporary = actual + ".lf-case-" + Guid.NewGuid().ToString("N");
        Directory.Move(actual, temporary);
        try
        {
            Directory.Move(temporary, Path.Combine(parent, leaf));
        }
        catch
        {
            try { Directory.Move(temporary, actual); } catch { }
            throw;
        }
    }

    static void StopApp(string directory)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3721/api/shutdown");
            request.Timeout = 900;
            request.ReadWriteTimeout = 900;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { }
        }
        catch { }

        Thread.Sleep(1000);
        Process[] processes = Process.GetProcessesByName("LyricFlow-Server");
        foreach (Process process in processes)
        {
            try
            {
                process.Kill();
                process.WaitForExit(2000);
            }
            catch { }
        }

        // The native console starts node.exe as a child; make sure it is gone
        // before overwriting node.exe / server.js during an upgrade.
        foreach (Process process in Process.GetProcessesByName("node"))
        {
            try
            {
                string path = process.MainModule.FileName;
                if (path.StartsWith(directory, StringComparison.OrdinalIgnoreCase))
                {
                    process.Kill();
                    process.WaitForExit(2000);
                }
            }
            catch { }
        }
    }

    static string ReadInstallLocation()
    {
        try
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(UninstallKey))
            {
                if (key == null) return "";
                object value = key.GetValue("InstallLocation");
                return value == null ? "" : Convert.ToString(value);
            }
        }
        catch { return ""; }
    }

    static void WriteInstallRegistry(string directory)
    {
        string exe = Path.Combine(directory, ServerExe);
        string uninstaller = Path.Combine(directory, UninstallExe);
        long size = 0;
        try
        {
            foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
            {
                try { size += new FileInfo(file).Length; } catch { }
            }
        }
        catch { }

        using (RegistryKey key = Registry.LocalMachine.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", AppName, RegistryValueKind.String);
            key.SetValue("DisplayVersion", ReadableVersion(), RegistryValueKind.String);
            key.SetValue("Publisher", Publisher, RegistryValueKind.String);
            key.SetValue("InstallLocation", directory, RegistryValueKind.String);
            key.SetValue("DisplayIcon", "\"" + exe + "\",0", RegistryValueKind.String);
            key.SetValue("UninstallString", "\"" + uninstaller + "\"", RegistryValueKind.String);
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
            key.SetValue("EstimatedSize", (int)Math.Max(1, size / 1024), RegistryValueKind.DWord);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    static void RemoveRegistry()
    {
        try { Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, false); } catch { }
    }

    static void CreateShortcuts(string directory, bool desktop)
    {
        string target = Path.Combine(directory, ServerExe);
        string description = "LyricFlow 实时歌词控制台";

        string commonPrograms = Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu);
        if (!string.IsNullOrEmpty(commonPrograms))
        {
            string startMenu = Path.Combine(commonPrograms, "Programs");
            Directory.CreateDirectory(startMenu);
            CreateShortcut(Path.Combine(startMenu, "LyricFlow.lnk"), target, directory, description);
        }

        if (desktop)
        {
            string commonDesktop = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
            if (!string.IsNullOrEmpty(commonDesktop))
            {
                Directory.CreateDirectory(commonDesktop);
                CreateShortcut(Path.Combine(commonDesktop, "LyricFlow.lnk"), target, directory, description);
            }
        }
    }

    static void RemoveShortcuts()
    {
        string[] folders = new string[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        };
        foreach (string folder in folders)
        {
            if (string.IsNullOrEmpty(folder)) continue;
            string path = Path.Combine(folder, "Programs", "LyricFlow.lnk");
            TryDelete(path);
            TryDelete(Path.Combine(folder, "LyricFlow.lnk"));
        }
    }

    static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string description)
    {
        object shell = null;
        object shortcut = null;
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            shell = Activator.CreateInstance(shellType);
            shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                new object[] { shortcutPath });
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
            shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath + ",0" });
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch { }
        finally
        {
            try { if (shortcut != null) Marshal.ReleaseComObject(shortcut); } catch { }
            try { if (shell != null) Marshal.ReleaseComObject(shell); } catch { }
        }
    }

    static void RemoveFiles(string directory)
    {
        if (string.IsNullOrEmpty(directory)) return;
        try
        {
            string self = Application.ExecutablePath;
            string command = "/c ping -n 5 127.0.0.1 >nul & rmdir /s /q \"" + directory +
                             "\" & del /f /q \"" + self + "\"";
            ProcessStartInfo info = new ProcessStartInfo("cmd.exe", command);
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(info);
        }
        catch { }
    }

    static void PerformUninstall(bool removeData)
    {
        StopApp(Application.StartupPath);
        RemoveRegistry();
        RemoveShortcuts();

        if (removeData)
        {
            try
            {
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "lyricflow");
                if (Directory.Exists(data)) Directory.Delete(data, true);
            }
            catch { }
        }

        string directory = Application.StartupPath;
        string temp = Path.Combine(Path.GetTempPath(),
            "LyricFlow-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(Application.ExecutablePath, temp, true);

        ProcessStartInfo info = new ProcessStartInfo(temp, "--remove \"" + directory + "\"");
        info.UseShellExecute = false;
        Process.Start(info);
    }

    static Icon LoadIcon()
    {
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { return null; }
    }

    static Color BgColor = Color.FromArgb(10, 10, 15);
    static Color CardColor = Color.FromArgb(20, 20, 28);
    static Color TextColor = Color.FromArgb(235, 231, 223);
    static Color MutedColor = Color.FromArgb(150, 148, 142);
    static Color AccentColor = Color.FromArgb(255, 176, 84);

    static Label MakeLabel(string text, int x, int y, int width, int height, Font font, Color color)
    {
        Label label = new Label();
        label.Text = text;
        label.SetBounds(x, y, width, height);
        label.Font = font;
        label.ForeColor = color;
        label.BackColor = Color.Transparent;
        return label;
    }

    static Button MakeButton(string text, int x, int y, int width, int height, bool accent)
    {
        Button button = new Button();
        button.Text = text;
        button.SetBounds(x, y, width, height);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(50, 50, 64);
        button.BackColor = accent ? AccentColor : Color.FromArgb(28, 28, 38);
        button.ForeColor = accent ? Color.FromArgb(28, 18, 6) : TextColor;
        button.Font = new Font("Microsoft YaHei UI", 9f);
        button.Cursor = Cursors.Hand;
        return button;
    }

    static void ApplyIcon(Form form, PictureBox picture)
    {
        Icon icon = LoadIcon();
        if (icon == null) return;
        try
        {
            form.Icon = icon;
            if (picture != null) picture.Image = icon.ToBitmap();
        }
        catch { }
    }

#if SETUP
    class SetupForm : Form
    {
        readonly CheckBox desktopShortcut;
        readonly CheckBox launchAfter;
        readonly Button installButton;
        readonly Button cancelButton;
        readonly ProgressBar progress;
        readonly Label status;
        readonly TextBox pathBox;
        string installPath;

        public SetupForm()
        {
            installPath = DefaultInstallDir;
            Text = "LyricFlow 安装程序";
            Width = 620;
            Height = 470;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = BgColor;
            ForeColor = TextColor;
            Font = new Font("Microsoft YaHei UI", 9f);

            PictureBox iconBox = new PictureBox();
            iconBox.SetBounds(28, 24, 64, 64);
            iconBox.SizeMode = PictureBoxSizeMode.Zoom;
            iconBox.BackColor = Color.Transparent;
            Controls.Add(iconBox);

            Controls.Add(MakeLabel("LyricFlow", 108, 22, 360, 32,
                new Font("Microsoft YaHei UI", 18f, FontStyle.Bold), TextColor));
            Controls.Add(MakeLabel("实时同步歌词控制台 · 版本 " + AppVersion + " · 安装器 r5", 110, 56, 480, 22,
                new Font("Microsoft YaHei UI", 9f), MutedColor));
            Controls.Add(MakeLabel("安装到（自动创建子文件夹）：", 30, 108, 300, 20,
                new Font("Microsoft YaHei UI", 8.5f), MutedColor));

            pathBox = new TextBox();
            pathBox.SetBounds(30, 130, 440, 28);
            pathBox.Text = installPath;
            pathBox.BackColor = Color.FromArgb(14, 14, 20);
            pathBox.ForeColor = TextColor;
            pathBox.BorderStyle = BorderStyle.FixedSingle;
            pathBox.Font = new Font("Consolas", 9f);
            pathBox.Leave += delegate
            {
                try
                {
                    string text = pathBox.Text.Trim().Trim('"');
                    if (text.Length == 0) return;
                    string full = Path.GetFullPath(Path.IsPathRooted(text)
                        ? text
                        : Path.Combine(Application.StartupPath, text));
                    string normalized = EnsureDedicatedFolder(full);
                    installPath = normalized;
                    pathBox.Text = normalized;
                }
                catch { }
            };
            Controls.Add(pathBox);

            Button browse = MakeButton("浏览...", 480, 129, 110, 30, false);
            browse.Click += delegate { BrowsePath(); };
            Controls.Add(browse);

            Controls.Add(MakeLabel("会在所选目录下创建独立的 LyricFlow 文件夹，文件不会散落。",
                30, 160, 540, 18, new Font("Microsoft YaHei UI", 8f), MutedColor));

            desktopShortcut = new CheckBox();
            desktopShortcut.Text = "创建桌面快捷方式";
            desktopShortcut.SetBounds(30, 184, 300, 24);
            desktopShortcut.ForeColor = TextColor;
            desktopShortcut.BackColor = BgColor;
            desktopShortcut.Checked = true;
            Controls.Add(desktopShortcut);

            launchAfter = new CheckBox();
            launchAfter.Text = "安装完成后启动 LyricFlow";
            launchAfter.SetBounds(30, 212, 300, 24);
            launchAfter.ForeColor = TextColor;
            launchAfter.BackColor = BgColor;
            launchAfter.Checked = true;
            Controls.Add(launchAfter);

            status = MakeLabel("准备安装", 30, 252, 540, 22,
                new Font("Microsoft YaHei UI", 8.5f), MutedColor);
            Controls.Add(status);

            progress = new ProgressBar();
            progress.SetBounds(30, 280, 540, 10);
            progress.Style = ProgressBarStyle.Marquee;
            progress.MarqueeAnimationSpeed = 28;
            progress.Visible = false;
            Controls.Add(progress);

            installButton = MakeButton("安装", 370, 360, 96, 38, true);
            installButton.Click += delegate { BeginInstall(); };
            Controls.Add(installButton);

            cancelButton = MakeButton("取消", 476, 360, 96, 38, false);
            cancelButton.Click += delegate { Close(); };
            Controls.Add(cancelButton);

            ApplyIcon(this, iconBox);
        }

        void SetStatus(string text)
        {
            try { if (!IsDisposed) Invoke(new Action(delegate { status.Text = text; })); }
            catch { }
        }

        static bool SamePath(string left, string right)
        {
            if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right)) return false;
            try
            {
                return string.Equals(
                    Path.GetFullPath(left).TrimEnd('\\'),
                    Path.GetFullPath(right).TrimEnd('\\'),
                    StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        static string EnsureDedicatedFolder(string path)
        {
            string full = Path.GetFullPath(path);
            DirectoryInfo info = new DirectoryInfo(full);
            if (string.Equals(info.Name, "LyricFlow", StringComparison.OrdinalIgnoreCase))
            {
                return info.FullName;
            }
            return Path.Combine(info.FullName, "LyricFlow");
        }

        void BrowsePath()
        {
            FolderBrowserDialog dialog = new FolderBrowserDialog();
            dialog.Description = "选择 LyricFlow 的安装位置";
            dialog.ShowNewFolderButton = true;

            string start = installPath;
            if (!Directory.Exists(start))
            {
                string parent = Path.GetDirectoryName(start);
                if (!string.IsNullOrEmpty(parent)) start = parent;
            }
            if (Directory.Exists(start)) dialog.SelectedPath = start;

            if (dialog.ShowDialog(this) != DialogResult.OK) return;

            string selected = dialog.SelectedPath;
            try { selected = EnsureDedicatedFolder(selected); }
            catch { }

            installPath = selected;
            pathBox.Text = selected;
            pathBox.SelectionStart = pathBox.TextLength;
        }

        static void LogSetup(string message)
        {
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "lyricflow-setup.log"),
                    DateTime.Now.ToString("s") + " " + message + "\r\n");
            }
            catch { }
        }

        bool ValidatePath(out string target)
        {
            target = "";
            string text = pathBox.Text.Trim().Trim('"');
            if (text.Length == 0)
            {
                MessageBox.Show(this, "请输入安装位置。", "LyricFlow", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            try
            {
                text = Path.GetFullPath(Path.IsPathRooted(text) ? text : Path.Combine(Application.StartupPath, text));
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "安装路径无效：\r\n" + ex.Message, "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            if (File.Exists(text))
            {
                MessageBox.Show(this, "目标路径是一个文件，请选择文件夹。", "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            try
            {
                text = EnsureDedicatedFolder(text);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "安装路径无效：\r\n" + ex.Message, "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            pathBox.Text = text;

            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (!string.IsNullOrEmpty(windows) &&
                text.StartsWith(windows.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "不能安装到 Windows 系统目录。", "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            if (text.Length > 220)
            {
                MessageBox.Show(this, "安装路径过长，请选择更短的路径。", "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            if (File.Exists(text))
            {
                MessageBox.Show(this, "目标路径是一个文件，请选择文件夹。", "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            try
            {
                LogSetup("input='" + pathBox.Text + "' target='" + text +
                    "' exists=" + Directory.Exists(text) +
                    " entries=" + (Directory.Exists(text) ? Directory.GetFileSystemEntries(text).Length : 0));

                // Never create the target here: the user may still cancel at the
                // confirmation prompt. Test write access in the nearest existing
                // ancestor instead, so a cancelled install leaves no empty folder.
                string probeDir = text;
                while (!Directory.Exists(probeDir))
                {
                    DirectoryInfo parent = Directory.GetParent(probeDir);
                    if (parent == null) break;
                    probeDir = parent.FullName;
                }
                if (Directory.Exists(probeDir))
                {
                    string probe = Path.Combine(probeDir, ".lyricflow-install-probe");
                    try
                    {
                        File.WriteAllText(probe, "ok");
                    }
                    finally
                    {
                        try { File.Delete(probe); } catch { }
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "无法写入该目录：\r\n" + ex.Message, "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            target = text;
            installPath = text;
            pathBox.Text = text;
            return true;
        }

        void BeginInstall()
        {
            string target;
            if (!ValidatePath(out target)) return;

            if (MessageBox.Show(this, "确定安装 LyricFlow 到下面的位置吗？\r\n\r\n" + target, "LyricFlow",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

            bool createDesktopShortcut = desktopShortcut.Checked;
            bool launchAfterInstall = launchAfter.Checked;
            string previousPath = ReadInstallLocation();

            installButton.Enabled = false;
            cancelButton.Enabled = false;
            desktopShortcut.Enabled = false;
            launchAfter.Enabled = false;
            pathBox.Enabled = false;
            progress.Visible = true;

            Thread worker = new Thread(delegate()
            {
                try
                {
                    SetStatus("正在停止旧版本...");
                    if (!string.IsNullOrEmpty(previousPath) && !SamePath(previousPath, target))
                    {
                        StopApp(previousPath);
                    }
                    StopApp(target);
                    RenameToRequestedCase(target);
                    SetStatus("正在复制文件...");
                    ExtractPayload(target);
                    if (!string.IsNullOrEmpty(previousPath) && !SamePath(previousPath, target))
                    {
                        // Moving to a new folder: keep the existing manual player list.
                        string[] settings = new string[] { "players.ini", "manual.ini" };
                        foreach (string name in settings)
                        {
                            try
                            {
                                string source = Path.Combine(previousPath, name);
                                string destination = Path.Combine(target, name);
                                if (File.Exists(source) && !File.Exists(destination))
                                {
                                    File.Copy(source, destination, false);
                                }
                            }
                            catch { }
                        }
                    }
                    SetStatus("正在注册卸载信息...");
                    WriteInstallRegistry(target);
                    SetStatus("正在创建快捷方式...");
                    RemoveShortcuts();
                    CreateShortcuts(target, createDesktopShortcut);
                    SetStatus("安装完成");

                    Invoke(new Action(delegate
                    {
                        MessageBox.Show(this, "LyricFlow 安装完成。\r\n\r\n可以在开始菜单或桌面打开，也可以在" +
                            "「设置 → 应用 → 已安装的应用」中卸载。", "LyricFlow",
                            MessageBoxButtons.OK, MessageBoxIcon.Information);
                        if (launchAfterInstall)
                        {
                            try
                            {
                                Process.Start(new ProcessStartInfo(Path.Combine(target, ServerExe))
                                {
                                    WorkingDirectory = target,
                                    UseShellExecute = true
                                });
                            }
                            catch { }
                        }
                        Close();
                    }));
                }
                catch (Exception ex)
                {
                    Invoke(new Action(delegate
                    {
                        progress.Visible = false;
                        installButton.Enabled = true;
                        cancelButton.Enabled = true;
                        desktopShortcut.Enabled = true;
                        launchAfter.Enabled = true;
                        pathBox.Enabled = true;
                        status.Text = "安装失败";
                        MessageBox.Show(this, "安装失败：\r\n" + ex.Message, "LyricFlow",
                            MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }
#endif

#if UNINSTALLER
    class UninstallForm : Form
    {
        readonly CheckBox removeData;
        readonly Button uninstallButton;
        readonly Button cancelButton;

        public UninstallForm()
        {
            Text = "卸载 LyricFlow";
            Width = 520;
            Height = 320;
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = BgColor;
            ForeColor = TextColor;
            Font = new Font("Microsoft YaHei UI", 9f);

            PictureBox iconBox = new PictureBox();
            iconBox.SetBounds(24, 22, 52, 52);
            iconBox.SizeMode = PictureBoxSizeMode.Zoom;
            iconBox.BackColor = Color.Transparent;
            Controls.Add(iconBox);

            Controls.Add(MakeLabel("卸载 LyricFlow", 92, 22, 360, 30,
                new Font("Microsoft YaHei UI", 15f, FontStyle.Bold), TextColor));
            Controls.Add(MakeLabel("将删除程序文件、开始菜单/桌面快捷方式，以及系统中" +
                "的卸载登记信息。", 24, 92, 470, 40, new Font("Microsoft YaHei UI", 8.5f), MutedColor));
            Controls.Add(MakeLabel("安装位置：" + Application.StartupPath, 24, 138, 470, 22,
                new Font("Consolas", 8.5f), TextColor));

            removeData = new CheckBox();
            removeData.Text = "同时删除歌词缓存与本地设置 (%LOCALAPPDATA%\\lyricflow)";
            removeData.SetBounds(24, 176, 470, 24);
            removeData.ForeColor = TextColor;
            removeData.BackColor = BgColor;
            removeData.Checked = false;
            Controls.Add(removeData);

            uninstallButton = MakeButton("卸载", 290, 226, 96, 36, true);
            uninstallButton.Click += delegate { DoUninstall(); };
            Controls.Add(uninstallButton);

            cancelButton = MakeButton("取消", 396, 226, 96, 36, false);
            cancelButton.Click += delegate { Close(); };
            Controls.Add(cancelButton);

            ApplyIcon(this, iconBox);
        }

        void DoUninstall()
        {
            if (MessageBox.Show(this, "确定要卸载 LyricFlow 吗？", "LyricFlow",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;

            uninstallButton.Enabled = false;
            cancelButton.Enabled = false;
            removeData.Enabled = false;

            try
            {
                PerformUninstall(removeData.Checked);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "卸载失败：\r\n" + ex.Message, "LyricFlow",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Close();
        }
    }
#endif
}