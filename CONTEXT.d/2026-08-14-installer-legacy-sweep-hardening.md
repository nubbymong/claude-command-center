## 2026-08-14 -- installer legacy-folder sweep: ownership proof, elevated-upgrade ordering, and behavioural tests

An independent adversarial re-attack on the legacy-install relocation in
`build/installer.nsh` (unreleased -- the sweep has never been in a tagged build)
found three ship blockers and three cheap fail-open bugs. All six are fixed here,
and the tests that were supposed to hold this code are replaced with ones that
actually can.

### 1. The ownership proof missed the tree it exists to clean

`RemoveLegacyInstall` demanded `Uninstall *.exe` at the candidate folder itself.
In the triple-nested shape

    ...\Programs\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor

the uninstaller exists ONLY at the leaf: electron-builder's uninstaller does
`RMDir /r $INSTDIR` before `SetOutPath` recreates the chain one level deeper, so
every outer level holds nothing but the next folder. `IfFileExists` with a
wildcard is not recursive, so the proof could never be satisfied on the outer
root -- while the ARP record WAS cleared for that shape, orphaning several
hundred MB with nothing able to uninstall it. That is the exact outcome the
change was meant to prevent.

Ownership is now proved two ways, either sufficient:

- `CccProveInstallRoot` walks DOWN from the candidate (depth-first, bounded to 24
  nodes), stepping only into folders whose name can be a link in a nesting chain
  and never into a reparse point, and accepts an `Uninstall *.exe` only when the
  match is a FILE. It was measured that a DIRECTORY named `Uninstall x.exe`
  satisfied the old check, after which the sibling source checkout was deleted --
  `IfFileExists` with a wildcard is `FindFirstFile`, which matches directories.
- the uninstaller path the replaced install recorded, captured by `customInit`
  before anything rewrites it (the commit point clears the record and
  `registryAddInstallInfo` writes a new one pointing at `$INSTDIR`, so `.onInit`
  is the only place the answer still exists).

### 2. The retarget aimed the OLD uninstaller at the NEW directory when elevating

`customInit` is inserted unguarded (`installer.nsi:79-81`), so the elevated inner
instance rewrites `${INSTALL_REGISTRY_KEY}\InstallLocation` to the new
`$INSTDIR`. But `installSection.nsh:35-37` guards `CHECK_APP_RUNNING` with
`${ifNot} ${UAC_IsInnerInstance}`, so the commit-point clear never runs there.
`uninstallOldVersion` then reads the retargeted value, runs the old uninstaller
with `_?=<new dir>`, and `uninstaller.nsh:187` does `RMDir /r $INSTDIR` -- on the
directory this run is about to install into.

Deferring the retarget is not possible: the install-mode page (and, under `/S`,
`installer.nsi:117`) re-seeds `$INSTDIR` from that value before the section runs,
and any value left there is what the old uninstaller resolves its `$INSTDIR`
from. So the record is neutralised instead. In the inner instance only,
`customInit` now removes just the `UninstallString` value --
`uninstallOldVersion` returns immediately on an empty one -- and remembers it, so
`CccRestoreInstallLocation` (MUI's abort callback, plus `.onInstFailed`) puts it
back if the wizard the inner instance still shows is cancelled. One value rather
than `DeleteRegKey`, precisely so it is restorable from a single saved string.

### 3. The guards were only ever asserted to be PRESENT

10/10 deletion mutants went red; 6/6 polarity mutants stayed green, including
`${If} $R8 == 1` rewritten to `${If} "1" == "1"` immediately before `RMDir /r` --
which compiled, ran, destroyed a junction target, a source checkout and a
CONFIG/settings.json, and left the suite green.

`tests/unit/main/installer-nsis-behaviour.test.ts` now compiles the real macros
out of `build/installer.nsh` with the real makensis, runs them over a real
fixture tree and asserts what is left on disk. It skips (does not fail) when
makensis is absent, with a tripwire that fails if it skips on a machine whose
electron-builder NSIS cache is plainly there. 17 polarity mutants were applied
one at a time; all 17 turn it red.

### Also fixed (same code, all measured fail-open)

- **Data/resources overlap was void for empty and forward-slash values.**
  `PathsOverlap(dir, "")` is 0, so an unreadable `DataDirectory` contributed
  nothing at all; a value recorded with forward slashes likewise. `ReadUserPath`
  is HKCU-only (the only hive the app writes), so on an all-users install
  elevated by a different admin both come back empty -- the guard was off exactly
  where privilege is highest. Both sides are now canonicalised
  (separators, trailing separator, and `GetFullPathName /SHORT` for 8.3 and
  `..`), compared in both spellings, and an unreadable or empty value now
  REFUSES the deletion instead of reading as "no overlap".
- **The "never `$INSTDIR`" check was a raw `StrCmp`**, so `/S /D=C:\PROGRA~1\CLAUDE~1`
  gave `$INSTDIR` an 8.3 spelling that matched nothing and the just-installed
  directory was swept. It is now a canonical overlap test in both directions, and
  an explicit `/D=` skips the sweep entirely -- the same reasoning that already
  suppresses the relocation for a hand-picked directory.

### Verification

- `npm run typecheck` clean; full `npx vitest run` green (4176 passed).
- A real `electron-builder --win nsis` run (stub `--prepackaged` tree) compiles
  both the installer and the uninstaller pass. electron-builder invokes
  `makensis -WX`, so that also proves the file produces no NSIS warnings.
- End to end over a real fixture tree, silently and interactively: a triple-
  nested install relocates to `...\Programs\AI Code Conductor`, the nested tree is
  removed, the old uninstaller is never run, and the ARP record points at the new
  install.

### Known and deliberately out of scope

A junction sitting INSIDE a proven install root is still followed by `RMDir /r`;
per-machine nesting when both hives hold records; the `Quit` paths that leave
`.onInit` without going through MUI's abort callback. Noted in comments where the
code is adjacent; tracked separately.
