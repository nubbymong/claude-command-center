; ============================================================
; MACROS FIRST — must be defined before anything else
; These are preprocessor directives and work in any context
; ============================================================

; Override the default "app is running" check with debug-enabled version
; Close a running instance before installing. An UPGRADE from a pre-rename build
; still has "Claude Command Center.exe" running, so both the current and the
; legacy executable names have to be checked — matching only ${APP_EXECUTABLE_FILENAME}
; would let the old process keep a file lock and fail the install.
!macro KillIfRunning EXE
  nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${EXE}" /FO csv | "$SYSDIR\find.exe" "${EXE}"`
  Pop $R0
  ${if} $R0 == 0
    DetailPrint "Found running ${EXE}, attempting to close..."
    nsExec::Exec `taskkill /im "${EXE}"`
    Sleep 2000
  ${endIf}
!macroend

!macro customCheckAppRunning
  DetailPrint "=== customCheckAppRunning: current + legacy executables ==="

  !insertmacro KillIfRunning "${APP_EXECUTABLE_FILENAME}"
  !insertmacro KillIfRunning "Claude Command Center.exe"
  !insertmacro KillIfRunning "Claude Conductor.exe"

  ; Re-check the current executable; if it survived a taskkill, let the user act.
  nsExec::Exec /TIMEOUT=5000 `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${if} $R0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AI Code Conductor is still running.$\n$\nProcess: ${APP_EXECUTABLE_FILENAME}$\n$\nPlease close it manually and click Retry." IDRETRY retry_check
    Quit
    retry_check:
  ${else}
    DetailPrint "No running instance found. Proceeding."
  ${endIf}
!macroend

; Copy one setting forward into the current brand key if it does not have one
; yet, looking through the legacy keys newest-first.
!macro AdoptLegacyValue NAME
  ReadRegStr $R1 HKCU "Software\AI Code Conductor" "${NAME}"
  ${If} $R1 == ""
    ReadRegStr $R0 HKCU "Software\Claude Command Center" "${NAME}"
    ${If} $R0 == ""
      ReadRegStr $R0 HKCU "Software\Claude Conductor" "${NAME}"
    ${EndIf}
    ${If} $R0 != ""
      WriteRegStr HKCU "Software\AI Code Conductor" "${NAME}" $R0
      DetailPrint "  Adopted ${NAME}: $R0"
    ${EndIf}
  ${EndIf}
!macroend

; ============================================================
; UPGRADE RELOCATION — move a legacy-named install folder to the new brand
; ============================================================
; The executable is now "AI Code Conductor.exe", which changes ${APP_FILENAME}.
; electron-builder's assisted installer runs instFilesPre AFTER this macro and
; unconditionally appends ${APP_FILENAME} to any $INSTDIR that does not already
; contain it — so an upgrade seeded with the old
;   …\Programs\Claude Command Center
; would otherwise be installed NESTED at
;   …\Programs\Claude Command Center\AI Code Conductor.
; initMultiUser has already seeded $INSTDIR from the previous installation by
; the time customInit runs (installer.nsi inserts it first), so we step $INSTDIR
; up to the parent and let instFilesPre re-append the NEW name — landing at
;   …\Programs\AI Code Conductor
; and record the old folder so customInstall can remove it.
;
; Guarded on the final path component being a known legacy folder name, so a
; custom install location is never touched and the parent is never something
; broad like C:\Program Files.
!include "FileFunc.nsh"
Var LegacyInstallDir

!macro customInit
  StrCpy $LegacyInstallDir ""
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 == "Claude Command Center"
  ${OrIf} $0 == "Claude Conductor"
    DetailPrint "Relocating install from legacy folder: $INSTDIR"
    StrCpy $LegacyInstallDir "$INSTDIR"
    ${GetParent} "$INSTDIR" $1
    ; Set the FINAL path here rather than just stepping up to the parent and
    ; letting instFilesPre append. A silent install (/S) skips MUI pages, so the
    ; page PRE callbacks never fire — leaving $INSTDIR at the parent would then
    ; install straight into …\Programs. Writing the full path is correct in both
    ; modes, and makes instFilesPre's check a no-op because the name is present.
    StrCpy $INSTDIR "$1\${APP_FILENAME}"
  ${EndIf}
!macroend

; Write registry entries after install + migrate from old key
!macro customInstall
  ; --- Adopt settings from either legacy key into the current brand key ---
  ; Newest legacy key first so a newer value never loses to an older one. Values
  ; are only copied where the brand key does not already have one, and the legacy
  ; keys are left in place (the app deletes only the original one — see
  ; registry.ts) so a rollback can still resolve the data directory.
  !insertmacro AdoptLegacyValue "DataDirectory"
  !insertmacro AdoptLegacyValue "ResourcesDirectory"
  !insertmacro AdoptLegacyValue "SourcePath"
  !insertmacro AdoptLegacyValue "UpdateServer"

  ; Always record the install path under the current brand key.
  WriteRegStr HKCU "Software\AI Code Conductor" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "Software\AI Code Conductor" "SourcePath" ""

  ; --- Remove the legacy install folder we relocated away from ---
  ; Only the application binaries live here; user data lives in the data and
  ; resources directories, which are untouched. appId is frozen, so this install
  ; has already overwritten the single uninstall entry to point at $INSTDIR.
  ${If} $LegacyInstallDir != ""
  ${AndIf} $LegacyInstallDir != $INSTDIR
    ${If} ${FileExists} "$LegacyInstallDir\*.*"
      DetailPrint "Removing legacy install folder: $LegacyInstallDir"
      RMDir /r "$LegacyInstallDir"
    ${EndIf}
    ; Shortcuts created under the old display name now point at a deleted exe.
    Delete "$DESKTOP\Claude Command Center.lnk"
    Delete "$SMPROGRAMS\Claude Command Center.lnk"
    Delete "$DESKTOP\Claude Conductor.lnk"
    Delete "$SMPROGRAMS\Claude Conductor.lnk"
  ${EndIf}
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

  ; Current brand key first, then each legacy key, then the fresh-install default.
  ReadRegStr $1 HKCU "Software\AI Code Conductor" "DataDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Command Center" "DataDirectory"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "DataDirectory"
  ${EndIf}
  ${If} $1 == ""
    ; FRESH INSTALL ONLY — reached only when neither registry key exists, so an
    ; upgrade always keeps the path it already had. New installs get a
    ; new-brand folder with no legacy name in it.
    StrCpy $1 "$LOCALAPPDATA\AI Code Conductor"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 30u 75% 12u "$1"
  Pop $DataDir

  ${NSD_CreateBrowseButton} 77% 29u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseDataDir

  nsDialogs::Show
FunctionEnd

Function OnBrowseDataDir
  nsDialogs::SelectFolderDialog "Select Data Directory" "$LOCALAPPDATA\AI Code Conductor"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DataDir $0
  ${EndIf}
FunctionEnd

Function DataDirPageLeave
  ${NSD_GetText} $DataDir $0
  WriteRegStr HKCU "Software\AI Code Conductor" "DataDirectory" $0
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

  ; Current brand key first, then each legacy key, then the fresh-install default.
  ReadRegStr $1 HKCU "Software\AI Code Conductor" "ResourcesDirectory"
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKCU "Software\Claude Conductor" "ResourcesDirectory"
  ${EndIf}
  ${If} $1 == ""
    ; FRESH INSTALL ONLY (see DataDirPage) — upgrades keep their existing path.
    StrCpy $1 "$LOCALAPPDATA\AI Code Conductor\resources"
  ${EndIf}

  ${NSD_CreateDirRequest} 0 42u 75% 12u "$1"
  Pop $ResourcesDir

  ${NSD_CreateBrowseButton} 77% 41u 23% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 OnBrowseResourcesDir

  nsDialogs::Show
FunctionEnd

Function OnBrowseResourcesDir
  nsDialogs::SelectFolderDialog "Select Resources Directory" "$LOCALAPPDATA\AI Code Conductor\resources"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $ResourcesDir $0
  ${EndIf}
FunctionEnd

Function ResourcesDirPageLeave
  ${NSD_GetText} $ResourcesDir $0
  WriteRegStr HKCU "Software\AI Code Conductor" "ResourcesDirectory" $0
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
  ReadRegStr $0 HKCU "Software\AI Code Conductor" "ResourcesDirectory"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Claude Command Center" "ResourcesDirectory"
  ${EndIf}
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

  ; U2: remove the legacy planted statusline script from ~/.claude. Pre-U2 installs
  ; left ~/.claude/claude-multi-statusline.js behind (new installs never plant it).
  ; The settings.json statusLine stanza is stripped by CCC's boot-heal on the first
  ; run after upgrade; a belt-and-braces uninstall-time stanza strip is deferred
  ; until it can be build-validated (Unit 13).
  Delete "$PROFILE\.claude\claude-multi-statusline.js"

  ; Clean up old registry key if it still exists
  DeleteRegKey /ifempty HKCU "Software\Claude Conductor"
!macroend
