; ============================================================
; MACROS FIRST — must be defined before anything else
; These are preprocessor directives and work in any context
; ============================================================
;
; electron-builder emits this file as part of the script HEADER, ahead of its own
; templates/nsis/installer.nsi (NsisTarget.computeCommonInstallerScriptHeader ->
; sharedHeader + installer.nsi). So anything at file scope here compiles FIRST,
; before multiUser.nsh / assistedInstaller.nsh — which is why a define that has
; to beat `!insertmacro addLangs` lives here, while anything needing
; ${INSTALL_REGISTRY_KEY} (defined by multiUser.nsh) has to sit inside a macro
; electron-builder inserts later (customHeader / customInit / customInstall).

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ============================================================
; SHARED PREDICATES
; ============================================================

; Is ${NAME} one of the folder names this app has shipped an INSTALL under?
; Sets ${OUT} to 1 or 0. Every rename added a name here; the " Beta" variants are
; the ones the first version of this check missed, which is how installs ended up
; NESTED (see customInit).
;
; Deliberately NOT listed: "claude-conductor", this repo's npm `name`.
; electron-builder only falls back to the sanitised package name for the install
; directory when productFilename fails /^[-_+0-9a-zA-Z .]+$/
; (out/targets/targetUtil.js getWindowsInstallationDirName), and every brand name
; this app has used passes that test — so no install has ever lived in a folder
; of that name, while a source checkout very plausibly does. Listing it could
; only ever cost someone a working copy.
!macro IsLegacyBrandFolder NAME OUT
  StrCpy ${OUT} 0
  ${If} "${NAME}" == "Claude Command Center"
  ${OrIf} "${NAME}" == "Claude Conductor"
  ${OrIf} "${NAME}" == "Claude Command Center Beta"
  ${OrIf} "${NAME}" == "Claude Conductor Beta"
    StrCpy ${OUT} 1
  ${EndIf}
!macroend

; ${OUT} = 1 when ${PATH} is ${DIR} itself, or something inside ${DIR}.
; Comparison is case-insensitive because LogicLib's == compiles to StrCmp, which
; is — matching Windows path semantics. Defines no labels of its own, so it is
; safe to insert repeatedly. Scratch: $R5 $R6 $R7.
!macro IsSameOrInside DIR PATH OUT
  StrCpy ${OUT} 0
  ${If} "${PATH}" != ""
    StrLen $R7 "${DIR}"
    StrCpy $R6 "${PATH}" $R7
    ${If} $R6 == "${DIR}"
      StrCpy $R5 "${PATH}" 1 $R7
      ${If} $R5 == ""
      ${OrIf} $R5 == "\"
        StrCpy ${OUT} 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; ${OUT} = 1 when ${A} and ${B} are the same directory, or one contains the
; other, in either direction. Scratch: $R5 $R6 $R7.
!macro PathsOverlap A B OUT
  !insertmacro IsSameOrInside "${A}" "${B}" ${OUT}
  ${If} ${OUT} != 1
    !insertmacro IsSameOrInside "${B}" "${A}" ${OUT}
  ${EndIf}
!macroend

; Walk ${PATH} from its last component upwards and return, in ${OUT}, the
; OUTERMOST legacy-brand folder in the nesting chain ("" = none).
;
; A broken upgrade can be nested several deep:
;   …\Programs\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
; That happened because each rename only compared the LAST path component
; against two exact names; a " Beta"-suffixed folder matched neither, so the
; relocation never fired and instFilesPre appended the new name INSIDE the old
; folder. Every rename made it one level deeper. Walking the whole path (not just
; its tail) is what makes this self-healing however deep it already is.
;
; The walk stops at the first component that is NEITHER a legacy name NOR the
; current app name, so it only ever spans an actual nesting CHAIN. That bound is
; load-bearing, because what this finds is what customInstall considers deleting:
; without it, an install at
;   C:\Claude Conductor\dev\AI Code Conductor
; would resolve "C:\Claude Conductor" as the legacy root. "dev" is neither, so
; the climb halts there and nothing above it is ever considered.
; Scratch: $R5 $R6 $R7 $R8 — ${OUT} must not be one of those.
!macro FindLegacyRoot PATH OUT
  StrCpy ${OUT} ""
  StrCpy $R8 "${PATH}"
  StrCpy $R6 0
  ${Do}
    ${GetFileName} "$R8" $R7
    ${If} $R7 == ""
      ${ExitDo}
    ${EndIf}
    !insertmacro IsLegacyBrandFolder "$R7" $R5
    ${If} $R5 == 1
      StrCpy ${OUT} "$R8"
    ${ElseIf} $R7 != "${APP_FILENAME}"
      ; A real parent directory — the nesting chain ends here.
      ${ExitDo}
    ${EndIf}
    ${GetParent} "$R8" $R8
    ${If} $R8 == ""
      ${ExitDo}
    ${EndIf}
    IntOp $R6 $R6 + 1
    ${If} $R6 > 8
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

; Read one of the user-chosen directories, newest brand key first.
!macro ReadUserPath NAME OUT
  ReadRegStr ${OUT} HKCU "Software\AI Code Conductor" "${NAME}"
  ${If} ${OUT} == ""
    ReadRegStr ${OUT} HKCU "Software\Claude Command Center" "${NAME}"
  ${EndIf}
  ${If} ${OUT} == ""
    ReadRegStr ${OUT} HKCU "Software\Claude Conductor" "${NAME}"
  ${EndIf}
!macroend

; ============================================================
; DESTRUCTIVE CLEANUP
; ============================================================

; Delete a directory that is PROVABLY an old install of this app, plus the
; shortcuts that pointed into it.
;
; RMDir /r is irreversible and follows directory junctions — verified with the
; real makensis: a junction made with `mklink /J` had its TARGET tree deleted,
; and ${FileExists} "<junction>\*.*" reports true *through* the junction. A
; matching folder NAME is nowhere near enough on its own. All of these must hold:
;   1. it is not the directory we are installing into;
;   2. it exists;
;   3. it is not a reparse point (junction / symlink / mount point);
;   4. it does not overlap the user's data or resources directory in either
;      direction — shipped builds defaulted DataDirectory to
;      "$LOCALAPPDATA\Claude Command Center" and ResourcesDirectory to
;      "…\Claude Command Center\resources" (git show 8c0085e:build/installer.nsh),
;      and "Claude Command Center" is a name this sweep looks for, so an install
;      into %LOCALAPPDATA% would otherwise destroy the user's sessions, logs and
;      CONFIG — twenty lines after customInstall adopted that very path;
;   5. it contains an "Uninstall *.exe" — positive proof that it is an NSIS
;      install root, and not a source checkout that happens to share the name.
; Expects $R3 = DataDirectory and $R4 = ResourcesDirectory.
; Scratch: $R5 $R6 $R7 $R8 $R9.
!macro RemoveLegacyInstall DIR NAME
  StrCpy $R8 1

  ${If} "${DIR}" == "$INSTDIR"
    StrCpy $R8 0
  ${EndIf}

  ${If} $R8 == 1
  ${AndIfNot} ${FileExists} "${DIR}\*.*"
    StrCpy $R8 0
  ${EndIf}

  ${If} $R8 == 1
    ; Fail closed: GetFileAttributes yields "1", "0", or "" on error, and only a
    ; hard "0" (no reparse attribute) is accepted.
    ${GetFileAttributes} "${DIR}" "REPARSE_POINT" $R9
    ${If} $R9 != 0
      DetailPrint "Refusing to delete a reparse point: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    !insertmacro PathsOverlap "${DIR}" "$R3" $R9
    ${If} $R9 == 1
      DetailPrint "Refusing to delete the data directory: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
    !insertmacro PathsOverlap "${DIR}" "$R4" $R9
    ${If} $R9 == 1
      DetailPrint "Refusing to delete the resources directory: ${DIR}"
      StrCpy $R8 0
    ${EndIf}
  ${EndIf}

  ${If} $R8 == 1
  ${AndIfNot} ${FileExists} "${DIR}\Uninstall *.exe"
    DetailPrint "Not an install of this app, leaving it alone: ${DIR}"
    StrCpy $R8 0
  ${EndIf}

  ${If} $R8 == 1
    DetailPrint "Removing legacy install folder: ${DIR}"
    RMDir /r "${DIR}"
    Delete "$DESKTOP\${NAME}.lnk"
    Delete "$SMPROGRAMS\${NAME}.lnk"
  ${EndIf}
!macroend

; Drop the recorded previous installation in ${ROOT_KEY}, but only when that
; record is one of:
;   a) unusable — the uninstaller it names is gone (removed by hand, or by an
;      upgrade that failed part-way). electron-builder runs it anyway, retries
;      five times and then shows "$(appCannotBeClosed)" (installUtil.nsh
;      uninstallOldVersion) — a message about the APP being open, raised when the
;      UNINSTALLER failed, with nothing for the user to close. With no
;      UninstallString it returns immediately instead;
;   b) pointing into the legacy folder beside $INSTDIR that this run relocated
;      out of and customInstall is about to delete.
;
; Judged per hive, with the caller naming the hive explicitly. appId is frozen,
; so a per-user and a per-machine installation share the same registry key PATH
; but are two SEPARATE installations. Blanket-deleting HKCU from an /allusers run
; would destroy a healthy per-user install's record, and installSection.nsh then
; calls uninstallOldVersion HKEY_CURRENT_USER, reads an empty UninstallString and
; returns — leaving that copy on disk with nothing able to remove it.
; Scratch: $R0 $R1 $R2 $R3 $R4 (+ $R5-$R9 via FindLegacyRoot).
!macro ForgetPreviousInstallIn ROOT_KEY
  ReadRegStr $R0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R0 != ""
    StrCpy $R2 0
    ; UninstallString is '"<dir>\Uninstall <app>.exe" /currentuser'. GetInQuotes
    ; is a Function in installUtil.nsh, which installer.nsi includes AFTER the
    ; point this is inserted from — but a Call is a forward reference NSIS
    ; resolves at link time, and both live in the !ifndef BUILD_UNINSTALLER pass.
    !insertmacro GetInQuotes $R1 "$R0"
    ${If} $R1 == ""
      StrCpy $R2 1
      DetailPrint "Uninstall record has no parseable path — clearing it"
    ${ElseIfNot} ${FileExists} "$R1"
      StrCpy $R2 1
      DetailPrint "Recorded uninstaller is gone ($R1) — clearing the record"
    ${Else}
      ${GetParent} "$R1" $R3
      !insertmacro FindLegacyRoot "$R3" $R9
      ${If} $R9 != ""
        ${GetParent} "$R9" $R4
        ${GetParent} "$INSTDIR" $R3
        ${If} $R4 == $R3
          StrCpy $R2 1
          DetailPrint "Uninstall record points into the legacy folder being replaced ($R9) — clearing it"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $R2 == 1
      DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
      ; Dead code for this app: electron-builder only defines
      ; UNINSTALL_REGISTRY_KEY_2 when the GUID contains a backslash
      ; (NsisTarget.js:176-178), and ours is UUID.v5(appId) =
      ; 0210f08e-15d0-5073-901d-684e27f31b7d. Kept so that setting a custom
      ; nsis.guid would still be handled.
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
    ${EndIf}
  ${EndIf}
!macroend

; SHELL_CONTEXT always; HKCU as well on an /allusers run, mirroring
; installSection.nsh, which calls uninstallOldVersion for both.
!macro ForgetBrokenPreviousInstall
  !insertmacro ForgetPreviousInstallIn SHELL_CONTEXT
  ${If} $installMode == "all"
    !insertmacro ForgetPreviousInstallIn HKCU
  ${EndIf}
  ; A ReadRegStr against a key that is not there sets the error flag; do not
  ; leave it set for whatever installSection.nsh does next.
  ClearErrors
!macroend

; ============================================================
; CANCEL SAFETY
; ============================================================
; customInit retargets the recorded InstallLocation (see below). That value is
; how BOTH installUtil.nsh's uninstallOldVersion (_?=) and the uninstaller's own
; $INSTDIR are resolved (multiUser.nsh setInstallModePerUser -> uninstaller.nsh
; "RMDir /r $INSTDIR"), so leaving it pointing at a directory that was never
; created would make a later Add/Remove-Programs uninstall delete nothing and
; then drop the entry. Put it back if the wizard never reaches the install.
;
; MUI2 defines Function .onUserAbort itself (Interface.nsh
; MUI_FUNCTION_ABORTWARNING, inserted by MUI_LANGUAGE), so this hooks its
; documented callback rather than defining a second one — two definitions would
; not compile. The define has to be in place before electron-builder's
; `!insertmacro addLangs`, which is why it sits at file scope rather than in
; customHeader.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_ABORT "CccRestoreInstallLocation"
!endif

; customHeader is inserted by installer.nsi at file scope AFTER multiUser.nsh, so
; ${INSTALL_REGISTRY_KEY} resolves here — it does not at the top of this file.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var cccSavedPerUserInstallLocation
    Var cccSavedPerMachineInstallLocation

    Function CccRestoreInstallLocation
      ${If} $cccSavedPerUserInstallLocation != ""
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$cccSavedPerUserInstallLocation"
        StrCpy $cccSavedPerUserInstallLocation ""
      ${EndIf}
      ${If} $cccSavedPerMachineInstallLocation != ""
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$cccSavedPerMachineInstallLocation"
        StrCpy $cccSavedPerMachineInstallLocation ""
      ${EndIf}
    FunctionEnd

    Function .onInstFailed
      Call CccRestoreInstallLocation
    FunctionEnd
  !endif
!macroend

; ============================================================
; APP-RUNNING CHECK — also the install's commit point
; ============================================================

; Override the default "app is running" check with debug-enabled version.
; Close a running instance before installing. An UPGRADE from a pre-rename build
; still has "Claude Command Center.exe" running, so both the current and the
; legacy executable names have to be checked — matching only
; ${APP_EXECUTABLE_FILENAME} would let the old process keep a file lock and fail
; the install.
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
    !ifndef BUILD_UNINSTALLER
      Call CccRestoreInstallLocation
    !endif
    Quit
    retry_check:
  ${else}
    DetailPrint "No running instance found. Proceeding."
  ${endIf}

  !ifndef BUILD_UNINSTALLER
    ; ---- COMMIT POINT -----------------------------------------------------
    ; installSection.nsh inserts CHECK_APP_RUNNING at the top of the install
    ; section — after every wizard page, after the user pressed Install, and
    ; immediately before uninstallOldVersion, which is the only place the
    ; recorded uninstaller is ever invoked. That makes it the earliest point at
    ; which dropping the record cannot strand anyone: registryAddInstallInfo
    ; rewrites it a few lines later, and a normal electron-builder upgrade drops
    ; it here anyway (the old uninstaller deletes the key itself).
    ;
    ; This used to run from customInit, i.e. inside .onInit, BEFORE the licence,
    ; install-mode, directory and data-directory pages — so cancelling the wizard
    ; or declining UAC left the app fully installed with no Add/Remove Programs
    ; entry at all, uninstallable by neither the user nor an MDM.
    ;
    ; Known gap: for an /allusers install that has to elevate, the whole of
    ; CHECK_APP_RUNNING is skipped in the elevated inner instance
    ; (installSection.nsh guards it with ${ifNot} ${UAC_IsInnerInstance}), so
    ; nothing is cleared there and the old uninstaller runs exactly as it did
    ; before this file cleared anything. Pre-existing behaviour, not a regression.
    !insertmacro ForgetBrokenPreviousInstall
  !endif
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
; initMultiUser has already seeded $INSTDIR from the previous installation by the
; time customInit runs (installer.nsi inserts it first), so we point $INSTDIR at
;   …\Programs\AI Code Conductor
; instead, and customInstall removes what is left behind.

; Setting $INSTDIR is NOT enough on its own. $INSTDIR is seeded from
; ${INSTALL_REGISTRY_KEY}\InstallLocation, and on any interactive (non-/S) run
; that read happens AGAIN after customInit: oneClick:false defines
; INSTALL_MODE_PER_ALL_USERS_REQUIRED (NsisTarget.js:445-446), so the
; install-mode page exists, and both its Leave callback (multiUserUi.nsh:184,187)
; and every skip path in its Pre (:35,:55,:63) re-run setInstallModePerUser /
; setInstallModePerAllUsers, which do
;   ReadRegStr … "${INSTALL_REGISTRY_KEY}" InstallLocation / StrCpy $INSTDIR …
; (multiUser.nsh:26-28, :75-77). The in-app updater launches the installer with
; NO arguments (src/main/ipc/update-handlers.ts), so auto-update IS that
; interactive path — and installSection.nsh:117 re-runs setInstallModePerAllUsers
; even under /S for a per-machine upgrade. The recorded value therefore has to
; stop naming the legacy tree, or the relocation is undone before a single file
; is written, while the uninstall record has already been dropped.
;
; It is RETARGETED rather than deleted so a custom install location keeps its
; parent: deleting makes setInstallMode* fall through to
; $LocalAppData\Programs\${APP_FILENAME} (multiUser.nsh:47), silently moving an
; install that lived on another drive. Both hives are handled because
; setInstallModePerUser reads HKCU and setInstallModePerAllUsers reads HKLM, and
; the install-mode page lets the user switch between them. /D= still wins either
; way — both macros apply GetDParameter AFTER this read (multiUser.nsh:50-54,
; :93-97).
;
; Only a record that points INTO the legacy tree being left behind is touched,
; and the previous value is remembered so CccRestoreInstallLocation can put it
; back if the wizard is cancelled.
!macro RetargetRecordedInstallLocation HIVE LEGACY_ROOT SAVE_VAR
  ReadRegStr $R3 ${HIVE} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R3 != ""
    !insertmacro IsSameOrInside "${LEGACY_ROOT}" "$R3" $R2
    ${If} $R2 == 1
      StrCpy ${SAVE_VAR} "$R3"
      WriteRegStr ${HIVE} "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
      DetailPrint "Recorded install location retargeted: $R3 -> $INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ; ---- 0. An explicit /D= is the operator's choice ------------------------
  ; initMultiUser applies /D= last, so $INSTDIR already holds the requested
  ; directory by the time this runs. Relocating it — and then letting
  ; customInstall consider its siblings for deletion — would silently override a
  ; path someone asked for by hand. The in-app updater passes no arguments, so
  ; this never suppresses the relocation on the path that actually matters.
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    DetailPrint "Explicit /D= install directory — leaving $INSTDIR alone"
  ${Else}
    ; ---- 1. Find the OUTERMOST legacy folder in $INSTDIR's path -----------
    !insertmacro FindLegacyRoot "$INSTDIR" $R9

    ${If} $R9 != ""
      ; A legacy tree. Relocate beside it, never inside it: the parent of the
      ; OUTERMOST legacy folder is the real install root (…\Programs).
      ${GetParent} "$R9" $R4
      DetailPrint "Relocating install out of legacy folder: $R9"
      ; Set the FINAL path here rather than just stepping up to the parent and
      ; letting instFilesPre append. A silent install (/S) skips MUI pages, so
      ; the page PRE callbacks never fire — leaving $INSTDIR at the parent would
      ; then install straight into …\Programs. Writing the full path is correct
      ; in both modes, and makes instFilesPre's check a no-op because the name is
      ; already present.
      StrCpy $INSTDIR "$R4\${APP_FILENAME}"

      ; ---- 2. Stop the install-mode page undoing it ----------------------
      !insertmacro RetargetRecordedInstallLocation HKCU "$R9" $cccSavedPerUserInstallLocation
      !insertmacro RetargetRecordedInstallLocation HKLM "$R9" $cccSavedPerMachineInstallLocation
    ${EndIf}
  ${EndIf}
  ; The uninstall RECORD is deliberately NOT touched here — see the commit point
  ; in customCheckAppRunning for why it can only be cleared once the install is
  ; actually going ahead.
  ;
  ; A ReadRegStr against a key that is not there sets the error flag, and .onInit
  ; hands straight over to the wizard; do not leave it set.
  ClearErrors
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

  ; --- Remove a legacy install folder sitting beside this one ---
  ; Only application binaries live there; user data lives in the data and
  ; resources directories, which RemoveLegacyInstall refuses to touch. appId is
  ; frozen, so this install has already overwritten the single uninstall entry to
  ; point at $INSTDIR — leaving the old folder would just orphan a copy that
  ; nothing can uninstall.
  ;
  ; RMDir /r on the OUTERMOST legacy folder takes any nested tree with it, which
  ; is what clears the
  ;   …\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
  ; shape that the old two-name check let accumulate. RemoveLegacyInstall refuses
  ; to touch $INSTDIR itself, so relocating first (customInit) is what makes this
  ; reachable at all — and it demands positive proof of ownership before deleting
  ; anything, because a name match alone would also match a source checkout, a
  ; junction, or the user's data directory.
  !insertmacro ReadUserPath "DataDirectory" $R3
  !insertmacro ReadUserPath "ResourcesDirectory" $R4

  ${GetParent} "$INSTDIR" $R2
  !insertmacro RemoveLegacyInstall "$R2\Claude Conductor Beta" "Claude Conductor Beta"
  !insertmacro RemoveLegacyInstall "$R2\Claude Command Center Beta" "Claude Command Center Beta"
  !insertmacro RemoveLegacyInstall "$R2\Claude Command Center" "Claude Command Center"
  !insertmacro RemoveLegacyInstall "$R2\Claude Conductor" "Claude Conductor"
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
