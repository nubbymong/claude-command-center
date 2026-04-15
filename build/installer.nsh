; ============================================================
; MACROS FIRST — must be defined before anything else
; These are preprocessor directives and work in any context
; ============================================================

; Override the default "app is running" check with debug-enabled version
!macro customCheckAppRunning
  DetailPrint "=== customCheckAppRunning: checking for ${APP_EXECUTABLE_FILENAME} ==="

  ; Use tasklist to check for the process
  nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0

  DetailPrint "Process check result: $R0 (0=found, error=not found)"

  ${if} $R0 == 0
    ; Process was found — try to close it gracefully
    DetailPrint "Found running ${APP_EXECUTABLE_FILENAME}, attempting to close..."
    nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}"`
    Sleep 2000

    ; Check again
    nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0

    ${if} $R0 == 0
      ; Still running — show debug info and let user decide
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Claude Command Center is still running.$\n$\nProcess: ${APP_EXECUTABLE_FILENAME}$\nCheck result: $R0$\n$\nPlease close it manually and click Retry." IDRETRY retry_check
      Quit
      retry_check:
    ${endIf}
  ${else}
    DetailPrint "No running instance of ${APP_EXECUTABLE_FILENAME} found. Proceeding."
  ${endIf}
!macroend

; Write registry entries after install + migrate from old key
!macro customInstall
  ; --- Registry migration from "Claude Conductor" → "Claude Command Center" ---
  ; Read all values from old key and copy to new key (if old key exists)
  ReadRegStr $R0 HKCU "Software\Claude Conductor" "DataDirectory"
  ${If} $R0 != ""
    DetailPrint "Migrating registry from Claude Conductor to Claude Command Center..."
    ; Copy DataDirectory (don't overwrite if new key already has it)
    ReadRegStr $R1 HKCU "Software\Claude Command Center" "DataDirectory"
    ${If} $R1 == ""
      WriteRegStr HKCU "Software\Claude Command Center" "DataDirectory" $R0
      DetailPrint "  Migrated DataDirectory: $R0"
    ${EndIf}

    ; Copy ResourcesDirectory
    ReadRegStr $R0 HKCU "Software\Claude Conductor" "ResourcesDirectory"
    ${If} $R0 != ""
      ReadRegStr $R1 HKCU "Software\Claude Command Center" "ResourcesDirectory"
      ${If} $R1 == ""
        WriteRegStr HKCU "Software\Claude Command Center" "ResourcesDirectory" $R0
        DetailPrint "  Migrated ResourcesDirectory: $R0"
      ${EndIf}
    ${EndIf}

    ; Copy SourcePath
    ReadRegStr $R0 HKCU "Software\Claude Conductor" "SourcePath"
    ${If} $R0 != ""
      ReadRegStr $R1 HKCU "Software\Claude Command Center" "SourcePath"
      ${If} $R1 == ""
        WriteRegStr HKCU "Software\Claude Command Center" "SourcePath" $R0
        DetailPrint "  Migrated SourcePath: $R0"
      ${EndIf}
    ${EndIf}

    ; Copy UpdateServer
    ReadRegStr $R0 HKCU "Software\Claude Conductor" "UpdateServer"
    ${If} $R0 != ""
      ReadRegStr $R1 HKCU "Software\Claude Command Center" "UpdateServer"
      ${If} $R1 == ""
        WriteRegStr HKCU "Software\Claude Command Center" "UpdateServer" $R0
        DetailPrint "  Migrated UpdateServer: $R0"
      ${EndIf}
    ${EndIf}

    ; Do NOT delete old key — app startup will clean it up after confirming migration
    DetailPrint "Registry migration complete (old key preserved for rollback safety)"
  ${EndIf}

  ; Always write InstallPath to new key
  WriteRegStr HKCU "Software\Claude Command Center" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\Claude Command Center" "SourcePath" ""
!macroend

; ============================================================
; CUSTOM PAGES — directory selection for Data and Resources
; ============================================================
!include "MUI2.nsh"
!include "FileFunc.nsh"

Var DataDir
Var ResourcesDir

; Custom pages for directory selection
Page custom DataDirPage DataDirPageLeave
Page custom ResourcesDirPage ResourcesDirPageLeave

; --- Data Directory Page ---
Function DataDirPage
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 24u "Choose where to store sessions, logs, and configuration data:"
  Pop $0

  ; Read existing value from new registry key, fall back to old key, default for fresh install
  ReadRegStr $1 HKCU "Software\Claude Command Center" "DataDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "DataDirectory"
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "$LOCALAPPDATA\Claude Command Center"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 30u 75% 12u "$1"
  Pop $DataDir

  ${NSD_CreateBrowseButton} 77% 29u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseDataDir

  nsDialogs::Show
FunctionEnd

Function OnBrowseDataDir
  nsDialogs::SelectFolderDialog "Select Data Directory" "$LOCALAPPDATA\Claude Command Center"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DataDir $0
  ${EndIf}
FunctionEnd

Function DataDirPageLeave
  ${NSD_GetText} $DataDir $0
  WriteRegStr HKCU "Software\Claude Command Center" "DataDirectory" $0
  CreateDirectory "$0"
  CreateDirectory "$0\sessions"
  CreateDirectory "$0\logs"
FunctionEnd

; --- Resources Directory Page ---
Function ResourcesDirPage
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 36u "Choose where to store shared resources (insights, screenshots, skills, scripts).$\nUse a network-mountable path to share across SSH sessions."
  Pop $0

  ; Read existing value from new registry key, fall back to old key, default for fresh install
  ReadRegStr $1 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "ResourcesDirectory"
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "$LOCALAPPDATA\Claude Command Center\resources"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 42u 75% 12u "$1"
  Pop $ResourcesDir

  ${NSD_CreateBrowseButton} 77% 41u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseResourcesDir

  nsDialogs::Show
FunctionEnd

Function OnBrowseResourcesDir
  nsDialogs::SelectFolderDialog "Select Resources Directory" "$LOCALAPPDATA\Claude Command Center\resources"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $ResourcesDir $0
  ${EndIf}
FunctionEnd

Function ResourcesDirPageLeave
  ${NSD_GetText} $ResourcesDir $0
  WriteRegStr HKCU "Software\Claude Command Center" "ResourcesDirectory" $0
  CreateDirectory "$0"
  CreateDirectory "$0\CONFIG"
  CreateDirectory "$0\insights"
  CreateDirectory "$0\screenshots"
  CreateDirectory "$0\skills"
  CreateDirectory "$0\scripts"
FunctionEnd

; ============================================================
; UNINSTALLER — protect CONFIG/ by default
; ============================================================
!macro customUnInstall
  ; Read ResourcesDirectory from new key, fall back to old key
  ReadRegStr $0 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Claude Conductor" "ResourcesDirectory"
  ${EndIf}
  ${If} $0 != ""
    ${If} ${FileExists} "$0\CONFIG\*.*"
      ; Only ask during manual uninstall (not during silent upgrade)
      IfSilent skip_config_dialog
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove user configuration data from:$\n$0\CONFIG$\n$\n(Settings, terminal configs, command buttons, etc.)" IDYES remove_config
        Goto skip_config_removal
        remove_config:
          RMDir /r "$0\CONFIG"
          DetailPrint "Removed CONFIG directory: $0\CONFIG"
        skip_config_removal:
      skip_config_dialog:
    ${EndIf}
  ${EndIf}

  ; Clean up old registry key if it still exists
  DeleteRegKey /ifempty HKCU "Software\Claude Conductor"
!macroend
