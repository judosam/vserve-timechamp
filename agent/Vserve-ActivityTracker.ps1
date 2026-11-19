<#
.SYNOPSIS
    Vserve-TimeChamp - Activity, Window, and Browser Tracking Engine
.DESCRIPTION
    Replicates TimeChamp's core tracking capabilities:
    - Active foreground window & process inspection
    - Windows UI Automation browser URL tracking (Chrome, Edge, Brave)
    - Productive / Unproductive activity classification
    - Periodic desktop screenshot capture with optional privacy blur
#>

# -------------------------------------------------------------------------
# Win32 Native Methods for Active Window Inspection
# -------------------------------------------------------------------------
if (-not ([System.Management.Automation.PSTypeName]'VserveTimeChamp.Win32.WindowHelper').Type) {
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace VserveTimeChamp.Win32 {
    public static class WindowHelper {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder lpExeName, ref int lpdwSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        public class WindowInfo {
            public IntPtr Handle;
            public uint ProcessId;
            public string ProcessName;
            public string ProcessPath;
            public string WindowTitle;
        }

        public static WindowInfo GetActiveWindow() {
            WindowInfo info = new WindowInfo();
            info.Handle = GetForegroundWindow();
            info.ProcessName = "";
            info.ProcessPath = "";
            info.WindowTitle = "";

            if (info.Handle == IntPtr.Zero) {
                return info;
            }

            // Window Title
            StringBuilder sbTitle = new StringBuilder(512);
            if (GetWindowText(info.Handle, sbTitle, 512) > 0) {
                info.WindowTitle = sbTitle.ToString();
            }

            // PID
            uint pid;
            GetWindowThreadProcessId(info.Handle, out pid);
            info.ProcessId = pid;

            // Process executable path
            IntPtr hProc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (hProc != IntPtr.Zero) {
                StringBuilder sbPath = new StringBuilder(1024);
                int size = 1024;
                if (QueryFullProcessImageName(hProc, 0, sbPath, ref size)) {
                    info.ProcessPath = sbPath.ToString();
                    info.ProcessName = System.IO.Path.GetFileName(info.ProcessPath);
                }
                CloseHandle(hProc);
            }

            // Fallback process name via System.Diagnostics.Process if OpenProcess failed
            if (string.IsNullOrEmpty(info.ProcessName) && pid > 0) {
                try {
                    using (System.Diagnostics.Process proc = System.Diagnostics.Process.GetProcessById((int)pid)) {
                        info.ProcessName = proc.ProcessName + ".exe";
                    }
                } catch {}
            }

            return info;
        }
    }
}
'@
}

# -------------------------------------------------------------------------
# UI Automation Helper for Browser Address Bar Extraction
# -------------------------------------------------------------------------
if (-not ([System.Management.Automation.PSTypeName]'VserveTimeChamp.Win32.BrowserHelper').Type) {
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
        Add-Type @'
using System;
using System.Windows.Automation;

namespace VserveTimeChamp.Win32 {
    public static class BrowserHelper {
        public static string GetBrowserAddressBarUrl(IntPtr hwnd) {
            if (hwnd == IntPtr.Zero) return "";
            try {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return "";

                // Search for Edit controls
                PropertyCondition condEdit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
                AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, condEdit);

                foreach (AutomationElement edit in edits) {
                    try {
                        string name = edit.Current.Name ?? "";
                        if (name.IndexOf("address", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            name.IndexOf("search", StringComparison.OrdinalIgnoreCase) >= 0) {
                            object pattern;
                            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
                                string val = ((ValuePattern)pattern).Current.Value;
                                if (!string.IsNullOrEmpty(val)) {
                                    return val;
                                }
                            }
                        }
                    } catch {}
                }
            } catch {}
            return "";
        }
    }
}
'@ -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
    } catch {}
}

# -------------------------------------------------------------------------
# Activity Tracker Functions
# -------------------------------------------------------------------------

function Get-ActiveWindowSnapshot {
    [CmdletBinding()]
    param()

    try {
        $win = [VserveTimeChamp.Win32.WindowHelper]::GetActiveWindow()
        return [PSCustomObject]@{
            Handle      = $win.Handle
            ProcessId   = $win.ProcessId
            ProcessName = if ($win.ProcessName) { $win.ProcessName.ToLower() } else { "unknown" }
            ProcessPath = $win.ProcessPath
            WindowTitle = if ($win.WindowTitle) { $win.WindowTitle } else { "" }
        }
    }
    catch {
        return [PSCustomObject]@{
            Handle      = [IntPtr]::Zero
            ProcessId   = 0
            ProcessName = "unknown"
            ProcessPath = ""
            WindowTitle = ""
        }
    }
}

function Get-ActiveBrowserUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProcessName,
        [Parameter(Mandatory = $true)][IntPtr]$Hwnd
    )

    $supportedBrowsers = @("chrome.exe", "msedge.exe", "brave.exe", "opera.exe")
    if ($supportedBrowsers -notcontains $ProcessName.ToLower()) {
        return ""
    }

    if (-not ([System.Management.Automation.PSTypeName]'VserveTimeChamp.Win32.BrowserHelper').Type) {
        return ""
    }

    try {
        $rawUrl = [VserveTimeChamp.Win32.BrowserHelper]::GetBrowserAddressBarUrl($Hwnd)
        if (-not [string]::IsNullOrWhiteSpace($rawUrl)) {
            $cleaned = $rawUrl.Trim()
            if (-not ($cleaned.StartsWith("http://") -or $cleaned.StartsWith("https://") -or $cleaned.StartsWith("ftp://"))) {
                $cleaned = "https://$cleaned"
            }
            return $cleaned
        }
    }
    catch {}

    return ""
}

function Get-DomainFromUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
    try {
        $uri = New-Object System.Uri($Url)
        return $uri.Host.ToLower()
    }
    catch {
        # Fallback regex extraction
        if ($Url -match '(?:https?:\/\/)?(?:www\.)?([^\/\?#]+)') {
            return $Matches[1].ToLower()
        }
        return $Url
    }
}

function Get-ProductivityScore {
    param(
        [string]$ProcessName,
        [string]$Url,
        [object]$Rules
    )

    if (-not $Rules) { return "Neutral" }

    $pName = if ($ProcessName) { $ProcessName.ToLower() } else { "" }
    $domain = Get-DomainFromUrl -Url $Url

    # 1. Check Productive URLs
    if ($Rules.productiveUrls -and -not [string]::IsNullOrEmpty($domain)) {
        foreach ($pattern in $Rules.productiveUrls) {
            if ($domain -like "*$($pattern.ToLower())*") { return "Productive" }
        }
    }

    # 2. Check Unproductive URLs
    if ($Rules.unproductiveUrls -and -not [string]::IsNullOrEmpty($domain)) {
        foreach ($pattern in $Rules.unproductiveUrls) {
            if ($domain -like "*$($pattern.ToLower())*") { return "Unproductive" }
        }
    }

    # 3. Check Productive Apps
    if ($Rules.productiveApps -and -not [string]::IsNullOrEmpty($pName)) {
        foreach ($pattern in $Rules.productiveApps) {
            if ($pName -like "*$($pattern.ToLower())*") { return "Productive" }
        }
    }

    # 4. Check Unproductive Apps
    if ($Rules.unproductiveApps -and -not [string]::IsNullOrEmpty($pName)) {
        foreach ($pattern in $Rules.unproductiveApps) {
            if ($pName -like "*$($pattern.ToLower())*") { return "Unproductive" }
        }
    }

    return "Neutral"
}

# -------------------------------------------------------------------------
# Screenshot Capture with Multi-Monitor & Privacy Blur Support
# -------------------------------------------------------------------------
function Take-DesktopScreenshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [switch]$ApplyBlur
    )

    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction SilentlyContinue

        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
            return $false
        }

        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)

        if ($ApplyBlur) {
            # Pixelate blur for employee privacy
            $factor = 16
            $smallW = [math]::Max(1, [int]($bounds.Width / $factor))
            $smallH = [math]::Max(1, [int]($bounds.Height / $factor))
            $smallBmp = New-Object System.Drawing.Bitmap $bmp, $smallW, $smallH
            $blurredBmp = New-Object System.Drawing.Bitmap $smallBmp, $bounds.Width, $bounds.Height

            $destDir = Split-Path -Parent $DestinationPath
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            $blurredBmp.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)

            $smallBmp.Dispose()
            $blurredBmp.Dispose()
        }
        else {
            $destDir = Split-Path -Parent $DestinationPath
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            $bmp.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        }

        $gfx.Dispose()
        $bmp.Dispose()
        return $true
    }
    catch {
        return $false
    }
}
