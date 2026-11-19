' Vserve-TimeChamp Silent Watchdog Launcher
' Executes vserve-watchdog.ps1 with completely hidden window (no console flash)

Set objArgs = WScript.Arguments
Set objFSO = CreateObject("Scripting.FileSystemObject")
strScriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

If objArgs.Count > 0 Then
    strScript = objArgs(0)
Else
    strScript = objFSO.BuildPath(strScriptDir, "vserve-watchdog.ps1")
End If

Set objShell = CreateObject("WScript.Shell")
strCommand = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File """ & strScript & """"
objShell.Run strCommand, 0, False
