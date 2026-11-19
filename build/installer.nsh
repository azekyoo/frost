; Frost installer extras: folder context menu, a `frost` command, and a
; per-user PATH entry so both work from anywhere.
;
; Everything here writes to HKCU only — the installer is per-user (perMachine is
; false), so it must never touch machine-wide keys. Keys are named after
; PRODUCT_NAME, which is "Frost" in every release; a test build packaged under
; another name (tools/updatetest.js) then keeps out of the installed Frost's.

; all three carry their own include guards, so this is safe alongside
; electron-builder's own template
!include LogicLib.nsh
!include WinMessages.nsh
!include WordFunc.nsh

; --- finish an interrupted update at next sign-in -----------------------
; An update first uninstalls the old version, then copies the new files. If
; anything kills it in between (sign-out, shutdown, sleep on a dying battery)
; Frost is left half-installed and cannot start — so it can never update
; itself out of that state either. 2.9.1 -> 2.10.0 broke this way on
; 2026-11-17 when the session logged off 30 s into the install.
;
; So an update registers its own installer under RunOnce before touching
; anything, and the last step of a finished install removes that entry again.
; Killed midway, the entry survives and Windows runs the update again at the
; next sign-in. Windows deletes a RunOnce value before running it, so a retry
; that fails too does not loop.
;
; Only updates (--updated, which electron-updater always passes) do this: a
; person cancelling the setup wizard must not get a silent install later.
; The retry carries the install mode and folder, because by then the old
; version's registry record is gone and a bare /S would land in the per-user
; default even when Frost lived in Program Files.
!define RESUME_VALUE "${PRODUCT_NAME} update"

!macro customInit
  ${If} ${isUpdated}
  ${AndIfNot} ${UAC_IsInnerInstance}
    ${If} $installMode == "all"
      StrCpy $0 "/allusers"
    ${Else}
      StrCpy $0 "/currentuser"
    ${EndIf}
    ; /D= must come last and unquoted, spaces included (NSIS rule)
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "${RESUME_VALUE}" '"$EXEPATH" /S --updated $0 /D=$INSTDIR'
  ${EndIf}
!macroend

!macro customInstall
  ; --- "Open Frost here" -------------------------------------------------
  ; Two keys: Background is the right-click on empty space inside a folder,
  ; Directory is the right-click on a folder itself. %V and %1 respectively.
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_NAME}" "" "Open ${PRODUCT_NAME} here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_NAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_NAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_NAME}" "" "Open ${PRODUCT_NAME} here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_NAME}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCT_NAME}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; --- `frost` command --------------------------------------------------
  ; Frost.exe is a GUI binary; `start ""` detaches it so the calling shell gets
  ; its prompt back immediately.
  FileOpen $0 "$INSTDIR\frost.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'start "" "%~dp0${APP_EXECUTABLE_FILENAME}" %*$\r$\n'
  FileClose $0

  ; --- per-user PATH ----------------------------------------------------
  ; Written straight to the registry rather than via setx, which truncates at
  ; 1024 characters. A marker key records what we added so reinstalls don't
  ; append twice and the uninstaller can remove exactly its own entry.
  ReadRegStr $1 HKCU "Software\${PRODUCT_NAME}" "PathEntry"
  ${If} $1 != "$INSTDIR"
    ReadRegStr $0 HKCU "Environment" "Path"
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
    ${EndIf}
    WriteRegStr HKCU "Software\${PRODUCT_NAME}" "PathEntry" "$INSTDIR"
    ; tell already-running processes to re-read the environment
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}

  ; every file is in place: no retry needed (see customInit). Last on purpose.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "${RESUME_VALUE}"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${PRODUCT_NAME}"
  Delete "$INSTDIR\frost.cmd"

  ; Strip only the entry this installer added, leaving the rest of PATH alone.
  ReadRegStr $1 HKCU "Software\${PRODUCT_NAME}" "PathEntry"
  ${If} $1 != ""
    ReadRegStr $0 HKCU "Environment" "Path"
    ${un.WordReplace} "$0" ";$1" "" "+" $2
    ${un.WordReplace} "$2" "$1" "" "+" $2
    WriteRegExpandStr HKCU "Environment" "Path" "$2"
    DeleteRegKey HKCU "Software\${PRODUCT_NAME}"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
