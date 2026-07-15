!macro stopHermesStudioProcesses
  IfFileExists "$INSTDIR\Hermes Studio.exe" 0 hermesStudioStopDone
    DetailPrint "Stopping Hermes Studio..."
    nsExec::ExecToLog '"$INSTDIR\Hermes Studio.exe" --quit'
    Pop $0
    Sleep 1500

    InitPluginsDir
    FileOpen $0 "$PLUGINSDIR\stop-hermes-studio.ps1" w
    FileWrite $0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
    FileWrite $0 "$$target = [System.IO.Path]::GetFullPath($$env:HERMES_STUDIO_EXE)$\r$\n"
    FileWrite $0 "function Get-HermesStudioProcess {$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process -Filter $\"Name = 'Hermes Studio.exe'$\" | Where-Object {$\r$\n"
    FileWrite $0 "    try { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } catch { $$false }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "Get-HermesStudioProcess | ForEach-Object {$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    $$process = Get-Process -Id $$_.ProcessId$\r$\n"
    FileWrite $0 "    if ($$process) { $$process.CloseMainWindow() | Out-Null }$\r$\n"
    FileWrite $0 "  } catch {}$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "Start-Sleep -Milliseconds 750$\r$\n"
    FileWrite $0 "$$deadline = (Get-Date).AddSeconds(30)$\r$\n"
    FileWrite $0 "while ((Get-Date) -lt $$deadline) {$\r$\n"
    FileWrite $0 "  $$processes = @(Get-HermesStudioProcess)$\r$\n"
    FileWrite $0 "  if ($$processes.Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  $$processes | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch {} }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 500$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "if (@(Get-HermesStudioProcess).Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "exit 1$\r$\n"
    FileClose $0

    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "$INSTDIR\Hermes Studio.exe") i .r0'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-hermes-studio.ps1"'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "") i .r0'
    nsExec::ExecToLog 'taskkill.exe /IM "Hermes Studio.exe" /T /F'
    Pop $0
  hermesStudioStopDone:
!macroend

!macro customInit
  !insertmacro stopHermesStudioProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro stopHermesStudioProcesses
!macroend
