' Starts the shuttle website with no black window (for Task Scheduler or the Startup folder).
' Use Shuttle Control.bat to see it, or to stop it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c start-shuttle.bat", 0, False
