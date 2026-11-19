' Work Timer - Zero-Window Silent Launcher
' Executes agent.ps1 in PowerShell with zero console window flash (SW_HIDE = 0)
Option Explicit

Dim objFSO, objShell, strScriptDir, strAgentPath, strCommand

Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")

strScriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
    strAgentPath = WScript.Arguments(0)
Else
    strAgentPath = objFSO.BuildPath(strScriptDir, "agent.ps1")
End If

If Not objFSO.FileExists(strAgentPath) Then
    ' Fallback to LocalAppData if installed
    Dim strLocalAppData
    strLocalAppData = objShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
    strAgentPath = objFSO.BuildPath(objFSO.BuildPath(strLocalAppData, "WT"), "agent.ps1")
End If

If objFSO.FileExists(strAgentPath) Then
    strCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & strAgentPath & """"
    ' 0 = SW_HIDE, False = Do not wait for return
    objShell.Run strCommand, 0, False
End If

Set objShell = Nothing
Set objFSO = Nothing
