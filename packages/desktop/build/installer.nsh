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
    FileWrite $0 "$$installDir = [System.IO.Path]::GetFullPath($$env:HERMES_STUDIO_INSTALL_DIR)$\r$\n"
    FileWrite $0 "$$webUiHome = Join-Path $$env:USERPROFILE '.hermes-web-ui'$\r$\n"
    FileWrite $0 "function Normalize-Path([string]$$path) {$\r$\n"
    FileWrite $0 "  try { if ($$path) { return [System.IO.Path]::GetFullPath($$path) } } catch {}$\r$\n"
    FileWrite $0 "  return ''$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Test-UnderPath([string]$$path, [string]$$root) {$\r$\n"
    FileWrite $0 "  $$normalizedPath = Normalize-Path $$path$\r$\n"
    FileWrite $0 "  $$normalizedRoot = Normalize-Path $$root$\r$\n"
    FileWrite $0 "  if (-not $$normalizedPath -or -not $$normalizedRoot) { return $$false }$\r$\n"
    FileWrite $0 "  $$rootWithSlash = $$normalizedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar$\r$\n"
    FileWrite $0 "  return $$normalizedPath.StartsWith($$rootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Get-DesktopRuntimeRoots {$\r$\n"
    FileWrite $0 "  $$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
    FileWrite $0 "  $$active = Join-Path $$webUiHome 'desktop-runtime\active-version.json'$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    if (Test-Path -LiteralPath $$active) {$\r$\n"
    FileWrite $0 "      $$json = Get-Content -LiteralPath $$active -Raw -Encoding UTF8 | ConvertFrom-Json$\r$\n"
    FileWrite $0 "      foreach ($$value in @($$json.runtimeDirectory, $$json.runtimeRootDirectory)) {$\r$\n"
    FileWrite $0 "        $$normalized = Normalize-Path ([string]$$value)$\r$\n"
    FileWrite $0 "        if ($$normalized) { $$roots.Add($$normalized) }$\r$\n"
    FileWrite $0 "      }$\r$\n"
    FileWrite $0 "    }$\r$\n"
    FileWrite $0 "  } catch {}$\r$\n"
    FileWrite $0 "  $$defaultRoot = Join-Path $$webUiHome 'desktop-runtime\hermes'$\r$\n"
    FileWrite $0 "  $$normalizedDefault = Normalize-Path $$defaultRoot$\r$\n"
    FileWrite $0 "  if ($$normalizedDefault) { $$roots.Add($$normalizedDefault) }$\r$\n"
    FileWrite $0 "  return $$roots | Select-Object -Unique$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Get-HermesStudioProcess {$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process -Filter $\"Name = 'Hermes Studio.exe'$\" | Where-Object {$\r$\n"
    FileWrite $0 "    try { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } catch { $$false }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$runtimeRoots = @(Get-DesktopRuntimeRoots)$\r$\n"
    FileWrite $0 "function Get-HermesStudioRelatedProcess {$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
    FileWrite $0 "    if ($$_.ProcessId -eq $$PID) { return $$false }$\r$\n"
    FileWrite $0 "    $$exe = Normalize-Path $$_.ExecutablePath$\r$\n"
    FileWrite $0 "    $$cmd = [string]$$_.CommandLine$\r$\n"
    FileWrite $0 "    if ($$exe -and $$exe -ieq $$target) { return $$true }$\r$\n"
    FileWrite $0 "    if ($$cmd -and $$cmd.IndexOf($$installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $$true }$\r$\n"
    FileWrite $0 "    foreach ($$root in $$runtimeRoots) {$\r$\n"
    FileWrite $0 "      if ((Test-UnderPath $$exe $$root) -and ($$cmd -match 'hermes-studio-mcp|hermes_bridge\.py|hermes_cli\.main gateway run')) { return $$true }$\r$\n"
    FileWrite $0 "    }$\r$\n"
    FileWrite $0 "    return $$false$\r$\n"
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
    FileWrite $0 "  $$processes = @(Get-HermesStudioRelatedProcess)$\r$\n"
    FileWrite $0 "  if ($$processes.Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  $$processes | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch {} }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 500$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "if (@(Get-HermesStudioRelatedProcess).Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "exit 1$\r$\n"
    FileClose $0

    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "$INSTDIR\Hermes Studio.exe") i .r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_INSTALL_DIR", t "$INSTDIR") i .r0'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-hermes-studio.ps1"'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "") i .r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_INSTALL_DIR", t "") i .r0'
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
