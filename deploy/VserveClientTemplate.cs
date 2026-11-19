using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Windows.Automation;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace VserveTimeChamp {
    internal static class Program {
        [STAThread]
        private static int Main(string[] args) {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool autostart = false;
            bool silent = false;
            foreach (string arg in args) {
                if (string.Equals(arg, "--autostart", StringComparison.OrdinalIgnoreCase)) autostart = true;
                if (string.Equals(arg, "--silent", StringComparison.OrdinalIgnoreCase) || string.Equals(arg, "/silent", StringComparison.OrdinalIgnoreCase)) silent = true;
            }

            // 1. Ensure LocalAppData directory and payload deployment
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string targetDir = Path.Combine(localAppData, "VserveTimeChamp");
            try {
                if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);
                DeploySelfAndPayloads(targetDir);
            } catch (Exception ex) {
                Debug.WriteLine("Setup error: " + ex.Message);
            }

            if (silent) return 0;

            // 2. Single-Instance Check
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "VserveTimeChamp_SingleInstance_Mutex_App", out createdNew)) {
                if (!createdNew) {
                    // Another instance is already running; activate its window
                    try {
                        Process current = Process.GetCurrentProcess();
                        foreach (Process p in Process.GetProcessesByName(current.ProcessName)) {
                            if (p.Id != current.Id && p.MainWindowHandle != IntPtr.Zero) {
                                Win32.SetForegroundWindow(p.MainWindowHandle);
                                break;
                            }
                        }
                    } catch {}
                    return 0;
                }

                // 3. Launch Tracker Main Form
                TrackerMainForm mainForm = new TrackerMainForm(targetDir, autostart);
                Application.Run(mainForm);
            }

            return 0;
        }

        private static void DeploySelfAndPayloads(string targetDir) {
            // Remove any leftover stop request file from previous uninstallation/tests
            try {
                string stopFile = Path.Combine(targetDir, ".stop_requested");
                if (File.Exists(stopFile)) File.Delete(stopFile);
            } catch {}

            // Payload extraction
            Dictionary<string, string> payloads = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
/*__PAYLOADS_INSERTION_POINT__*/

            foreach (KeyValuePair<string, string> kv in payloads) {
                string destPath = Path.Combine(targetDir, kv.Key);
                try {
                    byte[] raw = Convert.FromBase64String(kv.Value);
                    File.WriteAllBytes(destPath, raw);
                } catch {}
            }

            string currentExe = "";
            try {
                currentExe = System.Reflection.Assembly.GetExecutingAssembly().Location;
            } catch {
                currentExe = Process.GetCurrentProcess().MainModule.FileName;
            }
            string destExe = Path.Combine(targetDir, "VserveTimeChamp.exe");

            // Copy self to target directory if running from outside
            if (!string.IsNullOrEmpty(currentExe) && !string.Equals(currentExe, destExe, StringComparison.OrdinalIgnoreCase)) {
                try {
                    File.Copy(currentExe, destExe, true);
                } catch (Exception ex) {
                    Debug.WriteLine("Copy self error: " + ex.Message);
                }
            }

            // Register HKCU Run key for logon auto-start
            try {
                string watchdogLauncher = Path.Combine(targetDir, "launcher-watchdog.vbs");
                string systemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
                string wscriptExe = Path.Combine(systemDir, "wscript.exe");

                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) {
                    if (runKey != null) {
                        string exeToRun = File.Exists(destExe) ? destExe : currentExe;
                        runKey.SetValue("VserveTimeChamp", "\"" + exeToRun + "\" --autostart");
                        if (File.Exists(watchdogLauncher)) runKey.SetValue("VserveTimeChampWatchdog", "\"" + wscriptExe + "\" \"" + watchdogLauncher + "\"");
                        // Clean legacy duplicates
                        try { runKey.DeleteValue("VserveTimeChampAgent", false); } catch {}
                        try { runKey.DeleteValue("WorkTimerAgent", false); } catch {}
                    }
                }

                // Ensure watchdog is launched
                if (File.Exists(watchdogLauncher)) {
                    ProcessStartInfo psi = new ProcessStartInfo {
                        FileName = wscriptExe,
                        Arguments = "\"" + watchdogLauncher + "\"",
                        WindowStyle = ProcessWindowStyle.Hidden,
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    Process.Start(psi);
                }
            } catch {}
        }
    }

    // Win32 Helper for idle detection, window inspection and browser UI automation
    internal static class Win32 {
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder lpExeName, ref int lpdwSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HTCAPTION = 0x2;

        public static uint GetIdleSeconds() {
            LASTINPUTINFO lii = new LASTINPUTINFO();
            lii.cbSize = (uint)Marshal.SizeOf(lii);
            if (!GetLastInputInfo(ref lii)) return 0;
            uint currentTick = unchecked((uint)Environment.TickCount);
            return unchecked(currentTick - lii.dwTime) / 1000;
        }

        public static void GetActiveWindowInfo(out string processName, out string windowTitle, out IntPtr hwndOut) {
            processName = "unknown";
            windowTitle = "";
            hwndOut = IntPtr.Zero;

            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return;
            hwndOut = hwnd;

            StringBuilder sbTitle = new StringBuilder(512);
            if (GetWindowText(hwnd, sbTitle, 512) > 0) {
                windowTitle = sbTitle.ToString();
            }

            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid > 0) {
                IntPtr hProc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
                if (hProc != IntPtr.Zero) {
                    StringBuilder sbPath = new StringBuilder(1024);
                    int size = 1024;
                    if (QueryFullProcessImageName(hProc, 0, sbPath, ref size)) {
                        processName = Path.GetFileName(sbPath.ToString()).ToLower();
                    }
                    CloseHandle(hProc);
                }

                if ((string.IsNullOrEmpty(processName) || processName == "unknown")) {
                    try {
                        using (Process p = Process.GetProcessById((int)pid)) {
                            processName = p.ProcessName.ToLower() + ".exe";
                        }
                    } catch {}
                }
            }
        }

        public static string GetActiveBrowserUrl(IntPtr hwnd, string processName) {
            string p = (processName ?? "").ToLower();
            if (!p.Contains("chrome") && !p.Contains("msedge") && !p.Contains("brave") && !p.Contains("opera")) {
                return "";
            }
            if (hwnd == IntPtr.Zero) return "";
            try {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return "";

                PropertyCondition cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
                AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, cond);
                foreach (AutomationElement edit in edits) {
                    try {
                        string name = edit.Current.Name ?? "";
                        if (name.IndexOf("address", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            name.IndexOf("search", StringComparison.OrdinalIgnoreCase) >= 0) {
                            object pattern;
                            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
                                string val = ((ValuePattern)pattern).Current.Value;
                                if (!string.IsNullOrEmpty(val)) {
                                    val = val.Trim();
                                    if (!val.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                                        !val.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) {
                                        val = "https://" + val;
                                    }
                                    return val;
                                }
                            }
                        }
                    } catch {}
                }
            } catch {}
            return "";
        }

        public static string ExtractDomain(string url) {
            if (string.IsNullOrEmpty(url)) return "";
            try {
                string u = url.Trim();
                if (!u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                    !u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) {
                    u = "https://" + u;
                }
                Uri uri = new Uri(u);
                return uri.Host.ToLower();
            } catch {
                return "";
            }
        }
    }

    // Main Floating Tracking & Login Window
    public class TrackerMainForm : Form {
        private string targetDir;
        private bool isAutostart;
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;
        private System.Windows.Forms.Timer trackingTimer;
        private JavaScriptSerializer serializer;

        // Session & State
        private string currentUser = "";
        private string currentDisplayName = "";
        private string currentDepartment = "Engineering";
        private string serverUrl = "http://localhost:3000";
        private long activeSeconds = 0;
        private long idleSeconds = 0;
        private long productiveSeconds = 0;
        private long unproductiveSeconds = 0;
        private bool isTracking = true;
        private bool isIdle = false;
        private int idleThresholdSeconds = 600;
        private string currentApp = "desktop";
        private string currentTitle = "System Active";
        private string currentUrl = "";
        private string currentDomain = "";
        private string currentClassification = "Productive";
        private DateTime shiftStartTime = DateTime.UtcNow;
        private int pauseCount = 0;
        private int heartbeatTicks = 0;

        // UI Panels
        private Panel headerPanel;
        private Panel contentPanel;
        private Panel loginPanel;
        private Panel trackingPanel;

        // Login Controls
        private ComboBox cbUsers;
        private TextBox txtServerUrl;
        private TextBox txtPassword;
        private Label lblLoginStatus;
        private Button btnSignIn;

        // Tracking Controls
        private Label lblUserAvatar;
        private Label lblUserName;
        private Label lblUserMeta;
        private Label lblStatusBadge;
        private Label lblTimer;
        private Label lblActivityApp;
        private Label lblActivityTitle;
        private Label lblClassificationTag;
        private Label lblSummaryActive;
        private Label lblSummaryIdle;
        private Label lblSummaryProd;
        private Button btnTogglePause;

        public TrackerMainForm(string targetDir, bool autostart) {
            this.targetDir = targetDir;
            this.isAutostart = autostart;
            this.serializer = new JavaScriptSerializer();

            InitializeForm();
            InitializeTray();
            InitializeTimer();

            // Load saved session or existing state
            LoadSavedSession();

            if (isAutostart && !string.IsNullOrEmpty(currentUser)) {
                // If auto-started and already logged in, start minimized to tray
                this.WindowState = FormWindowState.Minimized;
                this.ShowInTaskbar = false;
                this.Hide();
                trayIcon.ShowBalloonTip(3000, "Vserve TimeChamp", "Tracking active in background for " + currentDisplayName, ToolTipIcon.Info);
            }
        }

        private void InitializeForm() {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Size = new Size(410, 540);
            this.BackColor = Color.FromArgb(11, 15, 25); // Deep Dark Slate
            this.ForeColor = Color.FromArgb(248, 250, 252);
            this.DoubleBuffered = true;
            this.ShowInTaskbar = true;
            this.TopMost = false;

            // Custom Header Bar
            headerPanel = new Panel();
            headerPanel.Size = new Size(410, 48);
            headerPanel.Dock = DockStyle.Top;
            headerPanel.BackColor = Color.FromArgb(15, 23, 42);
            headerPanel.MouseDown += HeaderPanel_MouseDown;

            // Logo & Title
            Label lblBrand = new Label();
            lblBrand.Text = "VSERVE TIMECHAMP";
            lblBrand.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            lblBrand.ForeColor = Color.White;
            lblBrand.Location = new Point(16, 8);
            lblBrand.AutoSize = true;
            lblBrand.MouseDown += HeaderPanel_MouseDown;

            Label lblSub = new Label();
            lblSub.Text = "Workforce Active Tracker";
            lblSub.Font = new Font("Segoe UI", 7.5f, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(148, 163, 184);
            lblSub.Location = new Point(17, 28);
            lblSub.AutoSize = true;
            lblSub.MouseDown += HeaderPanel_MouseDown;

            // Minimize Button (_)
            Button btnMin = new Button();
            btnMin.Text = "\u2014"; // Unicode em-dash
            btnMin.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            btnMin.Size = new Size(32, 28);
            btnMin.Location = new Point(334, 10);
            btnMin.FlatStyle = FlatStyle.Flat;
            btnMin.FlatAppearance.BorderSize = 0;
            btnMin.BackColor = Color.Transparent;
            btnMin.ForeColor = Color.FromArgb(148, 163, 184);
            btnMin.Cursor = Cursors.Hand;
            btnMin.Click += (s, e) => {
                this.Hide();
                this.ShowInTaskbar = false;
                trayIcon.ShowBalloonTip(2000, "Vserve TimeChamp", "Minimized to System Tray. Double-click tray icon to open.", ToolTipIcon.Info);
            };

            // Close Button (✕)
            Button btnClose = new Button();
            btnClose.Text = "\u2715"; // Unicode multiplication X
            btnClose.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btnClose.Size = new Size(32, 28);
            btnClose.Location = new Point(368, 10);
            btnClose.FlatStyle = FlatStyle.Flat;
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.BackColor = Color.Transparent;
            btnClose.ForeColor = Color.FromArgb(148, 163, 184);
            btnClose.Cursor = Cursors.Hand;
            btnClose.Click += (s, e) => {
                this.Hide();
                this.ShowInTaskbar = false;
                trayIcon.ShowBalloonTip(2000, "Vserve TimeChamp", "Tracker running in background. To exit, right-click tray icon.", ToolTipIcon.Info);
            };

            headerPanel.Controls.Add(lblBrand);
            headerPanel.Controls.Add(lblSub);
            headerPanel.Controls.Add(btnMin);
            headerPanel.Controls.Add(btnClose);
            this.Controls.Add(headerPanel);

            // Content Panel (Holds Login or Tracker Panel)
            contentPanel = new Panel();
            contentPanel.Dock = DockStyle.Fill;
            contentPanel.BackColor = Color.FromArgb(11, 15, 25);
            this.Controls.Add(contentPanel);

            // Construct both views
            BuildLoginPanel();
            BuildTrackingPanel();
        }

        private void HeaderPanel_MouseDown(object sender, MouseEventArgs e) {
            if (e.Button == MouseButtons.Left) {
                Win32.ReleaseCapture();
                Win32.SendMessage(this.Handle, Win32.WM_NCLBUTTONDOWN, Win32.HTCAPTION, 0);
            }
        }

        // =====================================================================
        // VIEW 1: LOGIN PANEL ("login menu when admin user created login")
        // =====================================================================
        private void BuildLoginPanel() {
            loginPanel = new Panel();
            loginPanel.Dock = DockStyle.Fill;
            loginPanel.BackColor = Color.FromArgb(11, 15, 25);
            loginPanel.Padding = new Padding(24, 16, 24, 20);

            // Title
            Label lblHero = new Label();
            lblHero.Text = "Employee Login";
            lblHero.Font = new Font("Segoe UI", 14f, FontStyle.Bold);
            lblHero.ForeColor = Color.White;
            lblHero.Location = new Point(24, 20);
            lblHero.AutoSize = true;

            Label lblHeroSub = new Label();
            lblHeroSub.Text = "Sign in to activate workforce tracking for your assigned shift.";
            lblHeroSub.Font = new Font("Segoe UI", 8.5f);
            lblHeroSub.ForeColor = Color.FromArgb(148, 163, 184);
            lblHeroSub.Location = new Point(25, 48);
            lblHeroSub.Size = new Size(350, 32);

            // Server URL Label & Box
            Label lblSrv = new Label();
            lblSrv.Text = "TRACKING SERVER URL";
            lblSrv.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblSrv.ForeColor = Color.FromArgb(100, 116, 139);
            lblSrv.Location = new Point(25, 90);
            lblSrv.AutoSize = true;

            txtServerUrl = new TextBox();
            txtServerUrl.Text = serverUrl;
            txtServerUrl.Location = new Point(25, 108);
            txtServerUrl.Size = new Size(270, 26);
            txtServerUrl.BackColor = Color.FromArgb(30, 41, 59);
            txtServerUrl.ForeColor = Color.White;
            txtServerUrl.BorderStyle = BorderStyle.FixedSingle;
            txtServerUrl.Font = new Font("Segoe UI", 9f);

            Button btnRefreshUsers = new Button();
            btnRefreshUsers.Text = "Refresh";
            btnRefreshUsers.Location = new Point(302, 108);
            btnRefreshUsers.Size = new Size(76, 26);
            btnRefreshUsers.FlatStyle = FlatStyle.Flat;
            btnRefreshUsers.BackColor = Color.FromArgb(37, 99, 235);
            btnRefreshUsers.ForeColor = Color.White;
            btnRefreshUsers.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            btnRefreshUsers.Cursor = Cursors.Hand;
            btnRefreshUsers.Click += (s, e) => FetchUsersFromServer();

            // Username Label & ComboBox
            Label lblUser = new Label();
            lblUser.Text = "SELECT USERNAME / ACCOUNT";
            lblUser.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblUser.ForeColor = Color.FromArgb(100, 116, 139);
            lblUser.Location = new Point(25, 150);
            lblUser.AutoSize = true;

            cbUsers = new ComboBox();
            cbUsers.Location = new Point(25, 168);
            cbUsers.Size = new Size(353, 26);
            cbUsers.BackColor = Color.FromArgb(30, 41, 59);
            cbUsers.ForeColor = Color.White;
            cbUsers.Font = new Font("Segoe UI", 9.5f);
            cbUsers.DropDownStyle = ComboBoxStyle.DropDown;

            // Password / PIN Label & Box
            Label lblPass = new Label();
            lblPass.Text = "PASSWORD / ACCESS PIN (OPTIONAL)";
            lblPass.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblPass.ForeColor = Color.FromArgb(100, 116, 139);
            lblPass.Location = new Point(25, 210);
            lblPass.AutoSize = true;

            txtPassword = new TextBox();
            txtPassword.PasswordChar = '\u25CF'; // Standard bullet
            txtPassword.Location = new Point(25, 228);
            txtPassword.Size = new Size(353, 26);
            txtPassword.BackColor = Color.FromArgb(30, 41, 59);
            txtPassword.ForeColor = Color.White;
            txtPassword.BorderStyle = BorderStyle.FixedSingle;
            txtPassword.Font = new Font("Segoe UI", 9f);

            // Remember Checkbox
            CheckBox chkRemember = new CheckBox();
            chkRemember.Text = "Auto-start and remember credentials on Windows logon";
            chkRemember.Checked = true;
            chkRemember.ForeColor = Color.FromArgb(148, 163, 184);
            chkRemember.Font = new Font("Segoe UI", 8f);
            chkRemember.Location = new Point(25, 268);
            chkRemember.Size = new Size(353, 24);

            // Status message
            lblLoginStatus = new Label();
            lblLoginStatus.Text = "Ready to connect. Loading accounts...";
            lblLoginStatus.Font = new Font("Segoe UI", 8f);
            lblLoginStatus.ForeColor = Color.FromArgb(56, 189, 248);
            lblLoginStatus.Location = new Point(25, 300);
            lblLoginStatus.Size = new Size(353, 36);

            // Sign In Button
            btnSignIn = new Button();
            btnSignIn.Text = "SIGN IN & START TRACKING";
            btnSignIn.Location = new Point(25, 345);
            btnSignIn.Size = new Size(353, 44);
            btnSignIn.FlatStyle = FlatStyle.Flat;
            btnSignIn.BackColor = Color.FromArgb(37, 99, 235);
            btnSignIn.FlatAppearance.BorderSize = 0;
            btnSignIn.ForeColor = Color.White;
            btnSignIn.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            btnSignIn.Cursor = Cursors.Hand;
            btnSignIn.Click += BtnSignIn_Click;

            // Info note
            Label lblNote = new Label();
            lblNote.Text = "Employee Workforce Client \u2014 Restricted to registered team members.\nAdmin portal is restricted to authorized administrators only.";
            lblNote.Font = new Font("Segoe UI", 7.5f);
            lblNote.ForeColor = Color.FromArgb(100, 116, 139);
            lblNote.Location = new Point(25, 405);
            lblNote.Size = new Size(353, 35);
            lblNote.TextAlign = ContentAlignment.MiddleCenter;

            loginPanel.Controls.Add(lblHero);
            loginPanel.Controls.Add(lblHeroSub);
            loginPanel.Controls.Add(lblSrv);
            loginPanel.Controls.Add(txtServerUrl);
            loginPanel.Controls.Add(btnRefreshUsers);
            loginPanel.Controls.Add(lblUser);
            loginPanel.Controls.Add(cbUsers);
            loginPanel.Controls.Add(lblPass);
            loginPanel.Controls.Add(txtPassword);
            loginPanel.Controls.Add(chkRemember);
            loginPanel.Controls.Add(lblLoginStatus);
            loginPanel.Controls.Add(btnSignIn);
            loginPanel.Controls.Add(lblNote);

            contentPanel.Controls.Add(loginPanel);
        }

        // =====================================================================
        // VIEW 2: TRACKING PANEL ("then show tracking time minimal infomations")
        // =====================================================================
        private void BuildTrackingPanel() {
            trackingPanel = new Panel();
            trackingPanel.Dock = DockStyle.Fill;
            trackingPanel.BackColor = Color.FromArgb(11, 15, 25);
            trackingPanel.Padding = new Padding(20, 14, 20, 16);

            // Profile Card (Header)
            Panel profileCard = new Panel();
            profileCard.Location = new Point(20, 12);
            profileCard.Size = new Size(370, 64);
            profileCard.BackColor = Color.FromArgb(19, 28, 46);

            lblUserAvatar = new Label();
            lblUserAvatar.Text = "SP";
            lblUserAvatar.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            lblUserAvatar.ForeColor = Color.White;
            lblUserAvatar.BackColor = Color.FromArgb(37, 99, 235);
            lblUserAvatar.Location = new Point(12, 12);
            lblUserAvatar.Size = new Size(40, 40);
            lblUserAvatar.TextAlign = ContentAlignment.MiddleCenter;

            lblUserName = new Label();
            lblUserName.Text = "Samuel P";
            lblUserName.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            lblUserName.ForeColor = Color.White;
            lblUserName.Location = new Point(60, 12);
            lblUserName.AutoSize = true;

            lblUserMeta = new Label();
            lblUserMeta.Text = "Engineering \u2022 Workstation";
            lblUserMeta.Font = new Font("Segoe UI", 8f);
            lblUserMeta.ForeColor = Color.FromArgb(148, 163, 184);
            lblUserMeta.Location = new Point(61, 35);
            lblUserMeta.AutoSize = true;

            lblStatusBadge = new Label();
            lblStatusBadge.Text = "\u25CF ACTIVE";
            lblStatusBadge.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblStatusBadge.ForeColor = Color.FromArgb(16, 185, 129);
            lblStatusBadge.BackColor = Color.FromArgb(20, 16, 185, 129);
            lblStatusBadge.Location = new Point(275, 18);
            lblStatusBadge.Size = new Size(82, 26);
            lblStatusBadge.TextAlign = ContentAlignment.MiddleCenter;

            profileCard.Controls.Add(lblUserAvatar);
            profileCard.Controls.Add(lblUserName);
            profileCard.Controls.Add(lblUserMeta);
            profileCard.Controls.Add(lblStatusBadge);
            trackingPanel.Controls.Add(profileCard);

            // Digital Clock Hero Card
            Panel timerCard = new Panel();
            timerCard.Location = new Point(20, 86);
            timerCard.Size = new Size(370, 94);
            timerCard.BackColor = Color.FromArgb(15, 23, 42);

            lblTimer = new Label();
            lblTimer.Text = "00:00:00";
            lblTimer.Font = new Font("Consolas", 32f, FontStyle.Bold);
            lblTimer.ForeColor = Color.FromArgb(56, 189, 248);
            lblTimer.Location = new Point(0, 10);
            lblTimer.Size = new Size(370, 52);
            lblTimer.TextAlign = ContentAlignment.MiddleCenter;

            Label lblTimerSub = new Label();
            lblTimerSub.Text = "TODAY'S ACTIVE WORK TIME";
            lblTimerSub.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblTimerSub.ForeColor = Color.FromArgb(100, 116, 139);
            lblTimerSub.Location = new Point(0, 66);
            lblTimerSub.Size = new Size(370, 16);
            lblTimerSub.TextAlign = ContentAlignment.MiddleCenter;

            timerCard.Controls.Add(lblTimer);
            timerCard.Controls.Add(lblTimerSub);
            trackingPanel.Controls.Add(timerCard);

            // Current Activity Card
            Panel actCard = new Panel();
            actCard.Location = new Point(20, 190);
            actCard.Size = new Size(370, 78);
            actCard.BackColor = Color.FromArgb(19, 28, 46);

            Label lblActHeader = new Label();
            lblActHeader.Text = "FOCUSED APPLICATION & WINDOW";
            lblActHeader.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblActHeader.ForeColor = Color.FromArgb(100, 116, 139);
            lblActHeader.Location = new Point(14, 10);
            lblActHeader.AutoSize = true;

            lblClassificationTag = new Label();
            lblClassificationTag.Text = "Productive";
            lblClassificationTag.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            lblClassificationTag.ForeColor = Color.FromArgb(16, 185, 129);
            lblClassificationTag.Location = new Point(270, 8);
            lblClassificationTag.Size = new Size(90, 20);
            lblClassificationTag.TextAlign = ContentAlignment.MiddleRight;

            lblActivityApp = new Label();
            lblActivityApp.Text = "antigravity.exe";
            lblActivityApp.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            lblActivityApp.ForeColor = Color.White;
            lblActivityApp.Location = new Point(14, 30);
            lblActivityApp.Size = new Size(342, 20);

            lblActivityTitle = new Label();
            lblActivityTitle.Text = "Visual Studio Code - server.js";
            lblActivityTitle.Font = new Font("Segoe UI", 8f);
            lblActivityTitle.ForeColor = Color.FromArgb(148, 163, 184);
            lblActivityTitle.Location = new Point(14, 52);
            lblActivityTitle.Size = new Size(342, 18);

            actCard.Controls.Add(lblActHeader);
            actCard.Controls.Add(lblClassificationTag);
            actCard.Controls.Add(lblActivityApp);
            actCard.Controls.Add(lblActivityTitle);
            trackingPanel.Controls.Add(actCard);

            // Shift Summary Metrics Row
            Panel summaryBar = new Panel();
            summaryBar.Location = new Point(20, 278);
            summaryBar.Size = new Size(370, 48);
            summaryBar.BackColor = Color.FromArgb(15, 23, 42);

            lblSummaryActive = new Label();
            lblSummaryActive.Text = "Active: 00:00:00";
            lblSummaryActive.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblSummaryActive.ForeColor = Color.FromArgb(56, 189, 248);
            lblSummaryActive.Location = new Point(10, 14);
            lblSummaryActive.Size = new Size(115, 20);

            lblSummaryIdle = new Label();
            lblSummaryIdle.Text = "Idle: 00:00:00";
            lblSummaryIdle.Font = new Font("Segoe UI", 8f);
            lblSummaryIdle.ForeColor = Color.FromArgb(245, 158, 11);
            lblSummaryIdle.Location = new Point(130, 14);
            lblSummaryIdle.Size = new Size(115, 20);

            lblSummaryProd = new Label();
            lblSummaryProd.Text = "Prod: 100%";
            lblSummaryProd.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblSummaryProd.ForeColor = Color.FromArgb(16, 185, 129);
            lblSummaryProd.Location = new Point(255, 14);
            lblSummaryProd.Size = new Size(105, 20);
            lblSummaryProd.TextAlign = ContentAlignment.TopRight;

            summaryBar.Controls.Add(lblSummaryActive);
            summaryBar.Controls.Add(lblSummaryIdle);
            summaryBar.Controls.Add(lblSummaryProd);
            trackingPanel.Controls.Add(summaryBar);

            // Action Buttons
            btnTogglePause = new Button();
            btnTogglePause.Text = "\u23F8 PAUSE TRACKING";
            btnTogglePause.Location = new Point(20, 338);
            btnTogglePause.Size = new Size(180, 42);
            btnTogglePause.FlatStyle = FlatStyle.Flat;
            btnTogglePause.BackColor = Color.FromArgb(245, 158, 11);
            btnTogglePause.FlatAppearance.BorderSize = 0;
            btnTogglePause.ForeColor = Color.Black;
            btnTogglePause.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            btnTogglePause.Cursor = Cursors.Hand;
            btnTogglePause.Click += (s, e) => TogglePauseTracking();

            Button btnHideToTray = new Button();
            btnHideToTray.Text = "\u25BC  MINIMIZE TO TRAY";
            btnHideToTray.Location = new Point(210, 338);
            btnHideToTray.Size = new Size(180, 42);
            btnHideToTray.FlatStyle = FlatStyle.Flat;
            btnHideToTray.BackColor = Color.FromArgb(30, 41, 59);
            btnHideToTray.FlatAppearance.BorderSize = 0;
            btnHideToTray.ForeColor = Color.FromArgb(203, 213, 225);
            btnHideToTray.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            btnHideToTray.Cursor = Cursors.Hand;
            btnHideToTray.Click += (s, e) => {
                this.Hide();
                this.ShowInTaskbar = false;
                trayIcon.ShowBalloonTip(2000, "Vserve TimeChamp", "Tracking active in background. Double-click tray icon to open.", ToolTipIcon.Info);
            };

            Button btnSignOut = new Button();
            btnSignOut.Text = "Switch User / Sign Out";
            btnSignOut.Location = new Point(110, 396);
            btnSignOut.Size = new Size(190, 26);
            btnSignOut.FlatStyle = FlatStyle.Flat;
            btnSignOut.FlatAppearance.BorderSize = 0;
            btnSignOut.BackColor = Color.Transparent;
            btnSignOut.ForeColor = Color.FromArgb(148, 163, 184);
            btnSignOut.Font = new Font("Segoe UI", 8f, FontStyle.Underline);
            btnSignOut.Cursor = Cursors.Hand;
            btnSignOut.Click += (s, e) => SignOut();

            trackingPanel.Controls.Add(btnTogglePause);
            trackingPanel.Controls.Add(btnHideToTray);
            trackingPanel.Controls.Add(btnSignOut);

            contentPanel.Controls.Add(trackingPanel);
            trackingPanel.Visible = false; // Initially hidden until login
        }

        // =====================================================================
        // SYSTEM TRAY INTEGRATION
        // =====================================================================
        private void InitializeTray() {
            trayMenu = new ContextMenuStrip();
            ToolStripMenuItem itemHeader = new ToolStripMenuItem("Vserve TimeChamp");
            itemHeader.Enabled = false;

            ToolStripMenuItem itemShow = new ToolStripMenuItem("Show Tracker Window");
            itemShow.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            itemShow.Click += (s, e) => RestoreWindow();

            ToolStripMenuItem itemPause = new ToolStripMenuItem("Pause / Resume Tracking");
            itemPause.Click += (s, e) => TogglePauseTracking();

            ToolStripMenuItem itemLogout = new ToolStripMenuItem("Sign Out");
            itemLogout.Click += (s, e) => SignOut();

            ToolStripMenuItem itemExit = new ToolStripMenuItem("Exit Tracker");
            itemExit.Click += (s, e) => {
                trackingTimer.Stop();
                FlushStateToDisk();
                trayIcon.Visible = false;
                Application.Exit();
            };

            trayMenu.Items.Add(itemHeader);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(itemShow);
            trayMenu.Items.Add(itemPause);
            trayMenu.Items.Add(itemLogout);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(itemExit);

            trayIcon = new NotifyIcon();
            trayIcon.Text = "Vserve TimeChamp Tracker";
            trayIcon.Icon = CreateAppIcon();
            this.Icon = trayIcon.Icon;
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => RestoreWindow();
        }

        private Icon CreateAppIcon() {
            using (Bitmap bmp = new Bitmap(32, 32)) {
                using (Graphics g = Graphics.FromImage(bmp)) {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (LinearGradientBrush br = new LinearGradientBrush(new Rectangle(0, 0, 32, 32), Color.FromArgb(37, 99, 235), Color.FromArgb(16, 185, 129), 45f)) {
                        g.FillEllipse(br, 2, 2, 28, 28);
                    }
                    using (Pen p = new Pen(Color.White, 2.5f)) {
                        g.DrawEllipse(p, 6, 6, 20, 20);
                        g.DrawLine(p, 16, 16, 16, 10);
                        g.DrawLine(p, 16, 16, 21, 16);
                    }
                }
                IntPtr hIcon = bmp.GetHicon();
                return Icon.FromHandle(hIcon);
            }
        }

        private void RestoreWindow() {
            this.Show();
            this.WindowState = FormWindowState.Normal;
            this.ShowInTaskbar = true;
            this.BringToFront();
            Win32.SetForegroundWindow(this.Handle);
        }

        // =====================================================================
        // TRACKING TIMER & ACTIVE-TIME ENGINE
        // =====================================================================
        private void InitializeTimer() {
            trackingTimer = new System.Windows.Forms.Timer();
            trackingTimer.Interval = 1000; // 1-second pulse
            trackingTimer.Tick += TrackingTimer_Tick;
        }

        private void TrackingTimer_Tick(object sender, EventArgs e) {
            if (string.IsNullOrEmpty(currentUser)) return;

            // 1. Check Idle Status via Win32 GetLastInputInfo
            uint idleSec = Win32.GetIdleSeconds();
            if (idleSec >= (uint)idleThresholdSeconds) {
                if (!isIdle) {
                    isIdle = true;
                    pauseCount++;
                }
            } else {
                isIdle = false;
            }

            // 2. Accumulate time
            if (isTracking && !isIdle) {
                activeSeconds++;
                if (currentClassification == "Productive") productiveSeconds++;
                else if (currentClassification == "Unproductive") unproductiveSeconds++;
            } else if (isIdle) {
                idleSeconds++;
            }

            // 3. Update active window inspection every 3 seconds
            heartbeatTicks++;
            if (heartbeatTicks % 3 == 0) {
                string pName, wTitle;
                IntPtr hwnd;
                Win32.GetActiveWindowInfo(out pName, out wTitle, out hwnd);
                if (!string.IsNullOrEmpty(pName) && pName != "unknown") currentApp = pName;
                if (!string.IsNullOrEmpty(wTitle)) currentTitle = wTitle;

                // Inspect browser URL if browser window
                string bUrl = Win32.GetActiveBrowserUrl(hwnd, currentApp);
                if (!string.IsNullOrEmpty(bUrl)) {
                    currentUrl = bUrl;
                    currentDomain = Win32.ExtractDomain(bUrl);
                } else if (!currentApp.Contains("chrome") && !currentApp.Contains("msedge") && !currentApp.Contains("brave")) {
                    currentUrl = "";
                    currentDomain = "";
                }

                currentClassification = ClassifyActivity(currentApp, currentUrl);
            }

            // Periodic screenshot capture every 300 ticks (5 minutes) while active
            if (heartbeatTicks % 300 == 0 && isTracking && !isIdle) {
                ThreadPool.QueueUserWorkItem(s => CaptureScreenshot());
            }

            // 4. Update UI labels
            lblTimer.Text = FormatHMS(activeSeconds);
            lblSummaryActive.Text = "Active: " + FormatHMS(activeSeconds);
            lblSummaryIdle.Text = "Idle: " + FormatHMS(idleSeconds);
            long prodScore = activeSeconds > 0 ? (productiveSeconds * 100 / activeSeconds) : 100;
            lblSummaryProd.Text = "Prod: " + prodScore + "%";

            lblActivityApp.Text = currentApp + (!string.IsNullOrEmpty(currentDomain) ? (" (" + currentDomain + ")") : "");
            lblActivityTitle.Text = currentTitle;
            lblClassificationTag.Text = currentClassification;
            if (currentClassification == "Productive") lblClassificationTag.ForeColor = Color.FromArgb(16, 185, 129);
            else if (currentClassification == "Unproductive") lblClassificationTag.ForeColor = Color.FromArgb(239, 68, 68);
            else lblClassificationTag.ForeColor = Color.FromArgb(56, 189, 248);

            if (!isTracking) {
                lblStatusBadge.Text = "\u23F8 PAUSED";
                lblStatusBadge.ForeColor = Color.FromArgb(245, 158, 11);
            } else if (isIdle) {
                lblStatusBadge.Text = "[IDLE] IDLE";
                lblStatusBadge.ForeColor = Color.FromArgb(249, 115, 22);
            } else {
                lblStatusBadge.Text = "\u25CF ACTIVE";
                lblStatusBadge.ForeColor = Color.FromArgb(16, 185, 129);
            }

            // Update tray tooltip
            trayIcon.Text = ("TC: " + currentUser + " [" + FormatHMS(activeSeconds) + "]").Substring(0, Math.Min(63, ("TC: " + currentUser + " [" + FormatHMS(activeSeconds) + "]").Length));

            // 5. Send Live Telemetry to Admin Server every 10 seconds & Flush State
            if (heartbeatTicks % 10 == 0) {
                ThreadPool.QueueUserWorkItem(state => {
                    SendHeartbeat();
                    FlushStateToDisk();
                });
            }
        }

        private string ClassifyActivity(string app, string url) {
            string a = (app ?? "").ToLower();
            string u = (url ?? "").ToLower();

            // Unproductive sites/apps
            if (u.Contains("facebook.com") || u.Contains("instagram.com") || u.Contains("twitter.com") ||
                u.Contains("x.com") || u.Contains("tiktok.com") || u.Contains("netflix.com") ||
                u.Contains("reddit.com") || a.Contains("spotify") || a.Contains("steam") ||
                a.Contains("discord") || a.Contains("game")) {
                return "Unproductive";
            }

            // Productive sites/apps
            if (u.Contains("github.com") || u.Contains("gitlab.com") || u.Contains("bitbucket.org") ||
                u.Contains("stackoverflow.com") || u.Contains("vservesolution.com") || u.Contains("jira") ||
                u.Contains("confluence") || u.Contains("docs.google.com") ||
                a.Contains("code") || a.Contains("devenv") || a.Contains("idea") || a.Contains("excel") ||
                a.Contains("word") || a.Contains("powerpnt") || a.Contains("teams") ||
                a.Contains("slack") || a.Contains("outlook") || a.Contains("antigravity")) {
                return "Productive";
            }

            return "Productive";
        }

        private void CaptureScreenshot() {
            try {
                string today = DateTime.UtcNow.ToString("yyyy-MM-dd");
                string ssDir = Path.Combine(targetDir, "screenshots", today);
                if (!Directory.Exists(ssDir)) Directory.CreateDirectory(ssDir);

                string timeCode = DateTime.UtcNow.ToString("HHmmss");
                string ssPath = Path.Combine(ssDir, "ss_" + timeCode + ".jpg");

                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                int w = Math.Max(100, bounds.Width);
                int h = Math.Max(100, bounds.Height);
                using (Bitmap bmp = new Bitmap(w, h)) {
                    using (Graphics g = Graphics.FromImage(bmp)) {
                        try {
                            g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
                        } catch {
                            // Workstation screen is locked or DC unavailable
                            g.Clear(Color.FromArgb(15, 23, 42));
                            using (Brush brush = new SolidBrush(Color.FromArgb(148, 163, 184))) {
                                using (Font font = new Font("Segoe UI", 12f, FontStyle.Bold)) {
                                    g.DrawString("Workstation Locked / Display Inactive\n" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), font, brush, 40, 40);
                                }
                            }
                        }
                    }
                    bmp.Save(ssPath, System.Drawing.Imaging.ImageFormat.Jpeg);
                }
            } catch {}
        }

        private void TogglePauseTracking() {
            isTracking = !isTracking;
            if (!isTracking) {
                btnTogglePause.Text = "\u25B6 RESUME TRACKING";
                btnTogglePause.BackColor = Color.FromArgb(16, 185, 129);
                btnTogglePause.ForeColor = Color.White;
            } else {
                btnTogglePause.Text = "\u23F8 PAUSE TRACKING";
                btnTogglePause.BackColor = Color.FromArgb(245, 158, 11);
                btnTogglePause.ForeColor = Color.Black;
            }
        }

        private string FormatHMS(long sec) {
            if (sec < 0) sec = 0;
            long h = sec / 3600;
            long m = (sec % 3600) / 60;
            long s = sec % 60;
            return string.Format("{0:D2}:{1:D2}:{2:D2}", h, m, s);
        }

        // =====================================================================
        // AUTHENTICATION & SESSION PERSISTENCE
        // =====================================================================
        private void LoadSavedSession() {
            string sessionFile = Path.Combine(targetDir, "session.json");
            if (File.Exists(sessionFile)) {
                try {
                    string raw = File.ReadAllText(sessionFile, Encoding.UTF8);
                    Dictionary<string, object> sess = serializer.Deserialize<Dictionary<string, object>>(raw);
                    if (sess != null && sess.ContainsKey("username")) {
                        currentUser = sess["username"].ToString();
                        currentDisplayName = sess.ContainsKey("displayName") ? sess["displayName"].ToString() : currentUser;
                        currentDepartment = sess.ContainsKey("department") ? sess["department"].ToString() : "Engineering";
                        if (sess.ContainsKey("serverUrl")) serverUrl = sess["serverUrl"].ToString();

                        ResumeTodayState();
                        ShowTrackingView();
                        return;
                    }
                } catch {}
            }

            FetchUsersFromServer();
        }

        private void ResumeTodayState() {
            string todayStr = DateTime.UtcNow.ToString("yyyy-MM-dd");
            string stateFile = Path.Combine(targetDir, "state_" + todayStr + ".json");
            if (File.Exists(stateFile)) {
                try {
                    string raw = File.ReadAllText(stateFile, Encoding.UTF8);
                    Dictionary<string, object> st = serializer.Deserialize<Dictionary<string, object>>(raw);
                    if (st != null) {
                        if (st.ContainsKey("active_seconds")) activeSeconds = Convert.ToInt64(st["active_seconds"]);
                        if (st.ContainsKey("idle_seconds")) idleSeconds = Convert.ToInt64(st["idle_seconds"]);
                        if (st.ContainsKey("productive_seconds")) productiveSeconds = Convert.ToInt64(st["productive_seconds"]);
                        if (st.ContainsKey("unproductive_seconds")) unproductiveSeconds = Convert.ToInt64(st["unproductive_seconds"]);
                        if (st.ContainsKey("pause_count")) pauseCount = Convert.ToInt32(st["pause_count"]);
                    }
                } catch {}
            }
        }

        private void FetchUsersFromServer() {
            serverUrl = txtServerUrl.Text.Trim();
            if (string.IsNullOrEmpty(serverUrl)) serverUrl = "http://localhost:3000";

            lblLoginStatus.Text = "Connecting to " + serverUrl + "...";
            lblLoginStatus.ForeColor = Color.FromArgb(56, 189, 248);

            ThreadPool.QueueUserWorkItem(state => {
                try {
                    using (WebClient wc = new WebClient()) {
                        wc.Encoding = Encoding.UTF8;
                        string json = wc.DownloadString(serverUrl + "/api/client/roster");
                        object[] userList = serializer.Deserialize<object[]>(json);

                        this.Invoke(new Action(() => {
                            cbUsers.Items.Clear();
                            if (userList != null && userList.Length > 0) {
                                foreach (object u in userList) {
                                    Dictionary<string, object> ud = u as Dictionary<string, object>;
                                    if (ud != null && ud.ContainsKey("username")) {
                                        cbUsers.Items.Add(ud["username"].ToString());
                                    }
                                }
                                if (cbUsers.Items.Count > 0) cbUsers.SelectedIndex = 0;
                                lblLoginStatus.Text = "[OK] Connected: " + cbUsers.Items.Count + " user account(s) available.";
                                lblLoginStatus.ForeColor = Color.FromArgb(16, 185, 129);
                            } else {
                                lblLoginStatus.Text = "Connected, but no employee accounts found.";
                                lblLoginStatus.ForeColor = Color.FromArgb(245, 158, 11);
                            }
                        }));
                    }
                } catch (Exception ex) {
                    this.Invoke(new Action(() => {
                        lblLoginStatus.Text = "[!] Unable to connect to server: " + ex.Message;
                        lblLoginStatus.ForeColor = Color.FromArgb(239, 68, 68);
                    }));
                }
            });
        }

        private void BtnSignIn_Click(object sender, EventArgs e) {
            string user = cbUsers.Text.Trim();
            string pass = txtPassword.Text.Trim();
            serverUrl = txtServerUrl.Text.Trim();

            if (string.IsNullOrEmpty(user)) {
                lblLoginStatus.Text = "Please enter or select your employee username.";
                lblLoginStatus.ForeColor = Color.FromArgb(239, 68, 68);
                return;
            }

            lblLoginStatus.Text = "Authenticating with server...";
            lblLoginStatus.ForeColor = Color.FromArgb(56, 189, 248);
            btnSignIn.Enabled = false;

            ThreadPool.QueueUserWorkItem(state => {
                try {
                    using (WebClient wc = new WebClient()) {
                        wc.Encoding = Encoding.UTF8;
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";

                        Dictionary<string, object> req = new Dictionary<string, object>();
                        req["username"] = user;
                        req["password"] = pass;
                        string reqJson = serializer.Serialize(req);

                        string resp = wc.UploadString(serverUrl + "/api/client/login", "POST", reqJson);
                        Dictionary<string, object> res = serializer.Deserialize<Dictionary<string, object>>(resp);

                        if (res != null && res.ContainsKey("success") && Convert.ToBoolean(res["success"])) {
                            Dictionary<string, object> userObj = res["user"] as Dictionary<string, object>;
                            this.Invoke(new Action(() => {
                                currentUser = user;
                                currentDisplayName = userObj != null && userObj.ContainsKey("displayName") ? userObj["displayName"].ToString() : user;
                                currentDepartment = userObj != null && userObj.ContainsKey("department") ? userObj["department"].ToString() : "General";

                                SaveSession(currentUser, currentDisplayName, currentDepartment);
                                ResumeTodayState();
                                ShowTrackingView();
                            }));
                        } else {
                            string err = res != null && res.ContainsKey("error") ? res["error"].ToString() : "Authentication failed.";
                            this.Invoke(new Action(() => {
                                lblLoginStatus.Text = "[X] " + err;
                                lblLoginStatus.ForeColor = Color.FromArgb(239, 68, 68);
                                btnSignIn.Enabled = true;
                            }));
                        }
                    }
                } catch (Exception ex) {
                    this.Invoke(new Action(() => {
                        lblLoginStatus.Text = "[X] Login Error: " + ex.Message;
                        lblLoginStatus.ForeColor = Color.FromArgb(239, 68, 68);
                        btnSignIn.Enabled = true;
                    }));
                }
            });
        }

        private void SaveSession(string username, string displayName, string department) {
            try {
                Dictionary<string, object> sess = new Dictionary<string, object>();
                sess["username"] = username;
                sess["displayName"] = displayName;
                sess["department"] = department;
                sess["serverUrl"] = serverUrl;
                sess["lastLogin"] = DateTime.UtcNow.ToString("o");

                string raw = serializer.Serialize(sess);
                File.WriteAllText(Path.Combine(targetDir, "session.json"), raw, Encoding.UTF8);

                // Also sync config.json for background agent
                string cfgPath = Path.Combine(targetDir, "config.json");
                if (File.Exists(cfgPath)) {
                    string cfgRaw = File.ReadAllText(cfgPath, Encoding.UTF8);
                    Dictionary<string, object> cfg = serializer.Deserialize<Dictionary<string, object>>(cfgRaw);
                    if (cfg != null && cfg.ContainsKey("agent")) {
                        Dictionary<string, object> agentCfg = cfg["agent"] as Dictionary<string, object>;
                        if (agentCfg != null) {
                            agentCfg["user"] = username;
                            File.WriteAllText(cfgPath, serializer.Serialize(cfg), Encoding.UTF8);
                        }
                    }
                }
            } catch {}
        }

        private void SignOut() {
            trackingTimer.Stop();
            FlushStateToDisk();

            try {
                string sessFile = Path.Combine(targetDir, "session.json");
                if (File.Exists(sessFile)) File.Delete(sessFile);
            } catch {}

            currentUser = "";
            trackingPanel.Visible = false;
            loginPanel.Visible = true;
            btnSignIn.Enabled = true;
            RestoreWindow();
            FetchUsersFromServer();
        }

        private void ShowTrackingView() {
            loginPanel.Visible = false;
            trackingPanel.Visible = true;

            lblUserName.Text = currentDisplayName;
            lblUserMeta.Text = currentDepartment + " \u2022 " + Environment.MachineName;

            string initials = "SP";
            string[] parts = currentDisplayName.Split(' ');
            if (parts.Length > 1 && parts[0].Length > 0 && parts[1].Length > 0) initials = ("" + parts[0][0] + parts[1][0]).ToUpper();
            else if (currentDisplayName.Length >= 2) initials = currentDisplayName.Substring(0, 2).ToUpper();
            lblUserAvatar.Text = initials;

            trackingTimer.Start();
        }

        // =====================================================================
        // LIVE HEARTBEAT & LOCAL STATE SYNCHRONIZATION
        // =====================================================================
        private void SendHeartbeat() {
            if (string.IsNullOrEmpty(currentUser)) return;
            try {
                using (WebClient wc = new WebClient()) {
                    wc.Encoding = Encoding.UTF8;
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";

                    long score = activeSeconds > 0 ? (productiveSeconds * 100 / activeSeconds) : 100;
                    Dictionary<string, object> hb = new Dictionary<string, object>();
                    hb["user"] = currentUser;
                    hb["machine"] = Environment.MachineName;
                    hb["status"] = !isTracking ? "paused" : (isIdle ? "idle" : "active");
                    hb["activeSeconds"] = activeSeconds;
                    hb["idleSeconds"] = idleSeconds;
                    hb["productiveSeconds"] = productiveSeconds;
                    hb["unproductiveSeconds"] = unproductiveSeconds;
                    hb["prodPct"] = score;
                    hb["currentApp"] = currentApp;
                    hb["windowTitle"] = currentTitle;
                    hb["url"] = currentUrl;
                    hb["pauses"] = pauseCount;
                    hb["timestamp"] = DateTime.UtcNow.ToString("o");

                    string req = serializer.Serialize(hb);
                    wc.UploadString(serverUrl + "/api/heartbeat", "POST", req);
                }
            } catch {}
        }

        private void FlushStateToDisk() {
            if (string.IsNullOrEmpty(currentUser)) return;
            try {
                string todayStr = DateTime.UtcNow.ToString("yyyy-MM-dd");
                string stateFile = Path.Combine(targetDir, "state_" + todayStr + ".json");
                string tmpFile = stateFile + ".tmp";

                Dictionary<string, object> st = new Dictionary<string, object>();
                st["date"] = todayStr;
                st["user"] = currentUser;
                st["machine"] = Environment.MachineName;
                st["status"] = !isTracking ? "paused" : (isIdle ? "idle" : "active");
                st["active_seconds"] = activeSeconds;
                st["idle_seconds"] = idleSeconds;
                st["productive_seconds"] = productiveSeconds;
                st["unproductive_seconds"] = unproductiveSeconds;
                st["pause_count"] = pauseCount;
                st["last_input_utc"] = DateTime.UtcNow.ToString("o");
                st["last_flush_utc"] = DateTime.UtcNow.ToString("o");

                string raw = serializer.Serialize(st);
                File.WriteAllText(tmpFile, raw, Encoding.UTF8);
                if (File.Exists(stateFile)) File.Delete(stateFile);
                File.Move(tmpFile, stateFile);

                // Update daily CSV
                string csvFile = Path.Combine(targetDir, "daily_" + todayStr + ".csv");
                long score = activeSeconds > 0 ? (productiveSeconds * 100 / activeSeconds) : 100;
                string header = "date,user,machine,active_seconds,active_hms,idle_seconds,idle_hms,first_input_utc,last_input_utc,pause_count,productive_seconds,unproductive_seconds,productivity_pct\r\n";
                string row = string.Format("{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12}\r\n",
                    todayStr, currentUser, Environment.MachineName, activeSeconds, FormatHMS(activeSeconds), idleSeconds, FormatHMS(idleSeconds),
                    shiftStartTime.ToString("o"), DateTime.UtcNow.ToString("o"), pauseCount, productiveSeconds, unproductiveSeconds, score);
                File.WriteAllText(csvFile, header + row, Encoding.UTF8);
            } catch {}
        }
    }
}
