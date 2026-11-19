# Build-StandaloneInstaller.ps1
# Compiles a 100% self-contained, zero-dependency, silent Windows .exe installer
# using Windows built-in csc.exe (C# Compiler). No admin rights required.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $cscPath)) {
    $cscPath = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $cscPath)) {
    throw "Microsoft .NET C# compiler (csc.exe) not found."
}

Write-Host "Building Vserve-TimeChamp Standalone Installer..." -ForegroundColor Cyan

# 1. Read source files to embed
$filesToEmbed = @{
    "agent.ps1"                  = (Join-Path $rootDir "agent\agent.ps1")
    "Vserve-ActivityTracker.ps1" = (Join-Path $rootDir "agent\Vserve-ActivityTracker.ps1")
    "vserve-watchdog.ps1"        = (Join-Path $rootDir "agent\vserve-watchdog.ps1")
    "launcher.vbs"               = (Join-Path $rootDir "agent\launcher.vbs")
    "launcher-watchdog.vbs"      = (Join-Path $rootDir "agent\launcher-watchdog.vbs")
    "config.json"                = (Join-Path $rootDir "config.default.json")
    "Sync-Transport.ps1"         = (Join-Path $rootDir "sync\Sync-Transport.ps1")
}

# Verify all source files exist
foreach ($k in $filesToEmbed.Keys) {
    if (-not (Test-Path $filesToEmbed[$k])) {
        throw "Required payload file missing: $($filesToEmbed[$k])"
    }
}

# 2. Generate C# Payload Dictionary entries
$sbPayloads = New-Object System.Text.StringBuilder
foreach ($name in $filesToEmbed.Keys) {
    $bytes = [System.IO.File]::ReadAllBytes($filesToEmbed[$name])
    $b64 = [Convert]::ToBase64String($bytes)
    [void]$sbPayloads.AppendLine("            payloads.Add(`"$name`", `"$b64`");")
}

# 3. Create C# Source for vserve-timechamp-setup.exe
$templateFile = Join-Path $scriptDir "VserveClientTemplate.cs"
if (-not (Test-Path $templateFile)) {
    throw "Template file missing: $templateFile"
}
$templateContent = [System.IO.File]::ReadAllText($templateFile, [System.Text.Encoding]::UTF8)
$setupCs = $templateContent.Replace("/*__PAYLOADS_INSERTION_POINT__*/", $sbPayloads.ToString())

$setupCsFile = Join-Path $scriptDir "VserveSetup.cs"
[System.IO.File]::WriteAllText($setupCsFile, $setupCs, [System.Text.Encoding]::UTF8)

# 4. Compile vserve-timechamp-setup.exe
$setupExeOut = Join-Path $rootDir "vserve-timechamp-setup.exe"
$setupArgs = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    "/r:System.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    "/r:System.Core.dll",
    "/r:`"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll`"",
    "/out:`"$setupExeOut`"",
    "`"$setupCsFile`""
)

Write-Host "Compiling setup executable: $setupExeOut" -ForegroundColor Yellow
$proc = Start-Process -FilePath $cscPath -ArgumentList ($setupArgs -join " ") -Wait -NoNewWindow -PassThru
if ($proc.ExitCode -ne 0) {
    throw "Setup executable compilation failed with exit code $($proc.ExitCode)"
}

# 5. Create C# Source for vserve-timechamp-uninstall.exe
$uninstallCs = @"
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
"@

$uninstallCsFile = Join-Path $scriptDir "VserveUninstall.cs"
[System.IO.File]::WriteAllText($uninstallCsFile, $uninstallCs, [System.Text.Encoding]::UTF8)

# 6. Compile vserve-timechamp-uninstall.exe
$uninstallExeOut = Join-Path $rootDir "vserve-timechamp-uninstall.exe"
$uninstArgs = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    "/out:`"$uninstallExeOut`"",
    "`"$uninstallCsFile`""
)

Write-Host "Compiling uninstaller executable: $uninstallExeOut" -ForegroundColor Yellow
$procUninst = Start-Process -FilePath $cscPath -ArgumentList ($uninstArgs -join " ") -Wait -NoNewWindow -PassThru
if ($procUninst.ExitCode -ne 0) {
    throw "Uninstall executable compilation failed with exit code $($procUninst.ExitCode)"
}

Write-Host "`nCompilation Successful!" -ForegroundColor Green
Write-Host "1. Silent Standalone Setup:   $setupExeOut" -ForegroundColor Green
Write-Host "2. Silent Standalone Cleanup: $uninstallExeOut" -ForegroundColor Green
