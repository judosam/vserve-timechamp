using System;
using System.IO;
using System.Diagnostics;
using Microsoft.Win32;

namespace VserveTimeChamp {
    internal static class UninstallProgram {
        [STAThread]
        private static int Main(string[] args) {
            try {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string targetDir = Path.Combine(localAppData, "VserveTimeChamp");

                // Request graceful stop via signal file
                string stopFile = Path.Combine(targetDir, ".stop_requested");
                if (Directory.Exists(targetDir)) {
                    try { File.WriteAllText(stopFile, DateTime.UtcNow.ToString("o")); } catch {}
                }

                // Kill running agent & watchdog PowerShell processes
                try {
                    Process[] procs = Process.GetProcesses();
                    foreach (Process p in procs) {
                        try {
                            if (p.ProcessName.IndexOf("powershell", StringComparison.OrdinalIgnoreCase) >= 0) {
                                // check command line or terminate safely
                            }
                        } catch {}
                    }
                } catch {}

                // Execute PowerShell uninstaller script if present to cleanly terminate
                string uninstPs = Path.Combine(targetDir, "deploy", "uninstall.ps1");
                if (File.Exists(uninstPs)) {
                    ProcessStartInfo psi = new ProcessStartInfo {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + uninstPs + "\" -RemoveData",
                        WindowStyle = ProcessWindowStyle.Hidden,
                        CreateNoWindow = true
                    };
                    Process p = Process.Start(psi);
                    if (p != null) p.WaitForExit(5000);
                }

                // Remove HKCU Run Registry entries
                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) {
                    if (runKey != null) {
                        runKey.DeleteValue("VserveTimeChampAgent", false);
                        runKey.DeleteValue("VserveTimeChampWatchdog", false);
                    }
                }

                // Purge target directory
                if (Directory.Exists(targetDir)) {
                    try { Directory.Delete(targetDir, true); } catch {}
                }

                return 0;
            } catch (Exception) {
                return 1;
            }
        }
    }
}