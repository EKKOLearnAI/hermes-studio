!macro customInit
  IfFileExists "$INSTDIR\Hermes Studio.exe" 0 hermesStudioStopDone
    DetailPrint "Stopping Hermes Studio..."
    nsExec::ExecToLog '"$INSTDIR\Hermes Studio.exe" --quit'
    Sleep 5000
    nsExec::ExecToLog 'taskkill.exe /IM "Hermes Studio.exe" /T /F'
  hermesStudioStopDone:
!macroend
