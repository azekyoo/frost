; Frost installer extras: folder context menu, a `frost` command, and a
; per-user PATH entry so both work from anywhere.
;
; Everything here writes to HKCU only — the installer is per-user (perMachine is
; false), so it must never touch machine-wide keys.

; all three carry their own include guards, so this is safe alongside
; electron-builder's own template
!include LogicLib.nsh
!include WinMessages.nsh
!include WordFunc.nsh

!macro customInstall
  ; --- "Open Frost here" -------------------------------------------------
  ; Two keys: Background is the right-click on empty space inside a folder,
  ; Directory is the right-click on a folder itself. %V and %1 respectively.
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Frost" "" "Open Frost here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Frost" "Icon" "$INSTDIR\Frost.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Frost\command" "" '"$INSTDIR\Frost.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Frost" "" "Open Frost here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Frost" "Icon" "$INSTDIR\Frost.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Frost\command" "" '"$INSTDIR\Frost.exe" "%1"'

  ; --- `frost` command --------------------------------------------------
  ; Frost.exe is a GUI binary; `start ""` detaches it so the calling shell gets
  ; its prompt back immediately.
  FileOpen $0 "$INSTDIR\frost.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'start "" "%~dp0Frost.exe" %*$\r$\n'
  FileClose $0

  ; --- per-user PATH ----------------------------------------------------
  ; Written straight to the registry rather than via setx, which truncates at
  ; 1024 characters. A marker key records what we added so reinstalls don't
  ; append twice and the uninstaller can remove exactly its own entry.
  ReadRegStr $1 HKCU "Software\Frost" "PathEntry"
  ${If} $1 != "$INSTDIR"
    ReadRegStr $0 HKCU "Environment" "Path"
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
    ${EndIf}
    WriteRegStr HKCU "Software\Frost" "PathEntry" "$INSTDIR"
    ; tell already-running processes to re-read the environment
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Frost"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Frost"
  Delete "$INSTDIR\frost.cmd"

  ; Strip only the entry this installer added, leaving the rest of PATH alone.
  ReadRegStr $1 HKCU "Software\Frost" "PathEntry"
  ${If} $1 != ""
    ReadRegStr $0 HKCU "Environment" "Path"
    ${un.WordReplace} "$0" ";$1" "" "+" $2
    ${un.WordReplace} "$2" "$1" "" "+" $2
    WriteRegExpandStr HKCU "Environment" "Path" "$2"
    DeleteRegKey HKCU "Software\Frost"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
