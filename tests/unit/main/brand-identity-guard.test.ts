import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Rename-safety tripwires for the "AI Code Conductor" display rename.
 *
 * The display name lives ONLY in build.productName. Everything filename- and
 * identity-shaped is deliberately frozen to the legacy values so existing
 * installs keep updating and upgrading in place:
 *   - win/mac executableName pin the exe / .app bundle filename (the NSIS
 *     assisted installer appends APP_FILENAME to any install dir that does not
 *     contain it, and the mac drag-install replaces only on filename collision)
 *   - artifactName now carries the CURRENT brand, which is only safe because
 *     the updater accepts both prefixes (since 2.1.0-beta.6); that tolerance is
 *     pinned by its own test below and must outlive the rename
 *   - a top-level productName must never exist (Electron app.name would follow
 *     it and relocate userData away from %APPDATA%/claude-conductor)
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'))

const readNsh = () => readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf-8')

/**
 * The body of one NSIS macro, so an assertion cannot be satisfied by a match
 * somewhere else in the file. That is not hypothetical: an earlier round of this
 * guard used whole-file `toContain` for the legacy folder names, and stayed
 * GREEN while the detection list was gutted — because the same names also appear
 * in the customInstall cleanup calls and in the comments.
 */
function nshMacro(name: string): string {
  const m = readNsh().match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
  if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
  return m[0]
}

describe('brand identity guard', () => {
  it('display name is AI Code Conductor, set only under build', () => {
    expect(pkg.build.productName).toBe('AI Code Conductor')
    expect(Object.prototype.hasOwnProperty.call(pkg, 'productName')).toBe(false)
  })

  it('exe and .app bundle carry the current brand, so a fresh install has no legacy name', () => {
    // These WERE pinned to "Claude Command Center" to stop upgrades relocating,
    // because electron-builder's instFilesPre appends ${APP_FILENAME} to any
    // $INSTDIR lacking it. A fresh install therefore landed in
    // …\Programs\Claude Command Center\Claude Command Center.exe — the legacy
    // name in the install path and in Task Manager. The pin is now replaced by
    // an explicit relocation in build/installer.nsh (customInit steps $INSTDIR
    // up to the parent when it ends in a legacy folder name, so the append
    // re-lands it under the new name, and customInstall removes the old folder).
    // If these two ever revert, that relocation silently becomes dead code.
    expect(pkg.build.win.executableName).toBe('AI Code Conductor')
    expect(pkg.build.mac.executableName).toBe('AI Code Conductor')
    // Still never top-level — Linux has no relocation story and derives its
    // binary name from productName.
    expect(pkg.build.executableName).toBeUndefined()
  })

  it('the installer still relocates a legacy install folder instead of nesting inside it', () => {
    const nsh = readNsh()
    // customInit must run the step-up, and it must recognise the legacy folder
    // names; without this an upgrade installs to <old folder>\AI Code Conductor.
    expect(nsh).toMatch(/!macro customInit/)
    expect(nsh).toMatch(/GetParent/)
    expect(nshMacro('customInit')).toMatch(/StrCpy \$INSTDIR "\$R4\\\$\{APP_FILENAME\}"/)
    // And the old folder has to be cleaned up, or the machine keeps a dead copy
    // that nothing can uninstall (the single uninstall entry now points at the
    // new folder).
    expect(nsh).toMatch(/!macro RemoveLegacyInstall/)
    expect(nsh).toMatch(/RMDir \/r "\$\{DIR\}"/)
  })

  it('the relocation recognises the " Beta"-suffixed folder names too', () => {
    // The original check compared only against "Claude Command Center" and
    // "Claude Conductor". Real installs were in "Claude Conductor Beta" and
    // "Claude Command Center Beta", which matched NEITHER — so the relocation
    // never fired and each rename installed INSIDE the previous folder:
    //   …\Claude Conductor Beta\Claude Command Center Beta\AI Code Conductor
    // Missing any of these names re-opens that nesting.
    const detect = nshMacro('IsLegacyBrandFolder')
    for (const name of [
      '"Claude Command Center"',
      '"Claude Conductor"',
      '"Claude Command Center Beta"',
      '"Claude Conductor Beta"',
    ]) {
      expect(detect).toContain(name)
    }
    // ...and "claude-conductor" must NOT be one of them. It is this repo's npm
    // `name`, never an install directory: electron-builder only falls back to
    // the sanitised package name when productFilename fails
    // /^[-_+0-9a-zA-Z .]+$/ (targetUtil.js getWindowsInstallationDirName), and
    // every brand name here passes. It IS, however, the obvious directory name
    // for a source checkout — so listing it aims the sweep at working copies for
    // no upside at all.
    expect(detect).not.toContain('claude-conductor')

    const nsh = readNsh()
    // The walk has to look at ANCESTORS, not just the last component — a nested
    // install's tail is already the current brand name.
    expect(nsh).toMatch(/GetFileName/)
    expect(nsh).toMatch(/\$\{Loop\}/)
    // ...but it must STOP at the first component that is neither a legacy name
    // nor the app name. customInstall RMDir /r's siblings of whatever this
    // resolves to, so an unbounded climb would let an install at
    //   C:\Claude Conductor\dev\AI Code Conductor
    // treat C:\Claude Conductor as the legacy root.
    expect(nsh).toMatch(/\$\{ElseIf\}\s+\$R7\s+!=\s+"\$\{APP_FILENAME\}"/)
  })

  it('the sweep demands proof of ownership before RMDir /r', () => {
    // RMDir /r is irreversible and FOLLOWS DIRECTORY JUNCTIONS — verified with
    // the real makensis: with the reparse check removed, RMDir /r on a
    // `mklink /J` junction emptied the tree it pointed at. A folder-name match
    // is therefore not remotely enough. Scoped to the macro body, because every
    // one of these tokens also appears in prose elsewhere in the file.
    const body = nshMacro('RemoveLegacyInstall')
    // 1. never the directory we are installing into
    expect(body).toMatch(/\$\{If\}\s+"\$\{DIR\}"\s+==\s+"\$INSTDIR"/)
    // 2. never a junction / symlink / mount point
    expect(body).toMatch(/GetFileAttributes\}\s+"\$\{DIR\}"\s+"REPARSE_POINT"/)
    // 3. never anything overlapping the user's data or resources directory.
    //    Shipped builds defaulted DataDirectory to
    //    "$LOCALAPPDATA\Claude Command Center" — a name this sweep looks for —
    //    so an install into %LOCALAPPDATA% would delete the user's sessions,
    //    logs and CONFIG, twenty lines after customInstall adopted that path.
    expect(body).toMatch(/PathsOverlap "\$\{DIR\}" "\$R3"/)
    expect(body).toMatch(/PathsOverlap "\$\{DIR\}" "\$R4"/)
    // 4. positive proof it is an install root and not a source checkout
    expect(body).toMatch(/FileExists\}\s+"\$\{DIR\}\\Uninstall \*\.exe"/)
    // ...and the deletion itself still has to be there.
    expect(body).toMatch(/RMDir \/r "\$\{DIR\}"/)
    // The data/resources paths must actually be loaded before the sweep runs,
    // from every brand key.
    const install = nshMacro('customInstall')
    expect(install).toMatch(/ReadUserPath "DataDirectory" \$R3/)
    expect(install).toMatch(/ReadUserPath "ResourcesDirectory" \$R4/)
    expect(nshMacro('ReadUserPath')).toContain('Software\\Claude Conductor')
    // The cleanup list must not name the npm package directory either.
    expect(install).not.toContain('claude-conductor')
  })

  it('the uninstall record is only dropped once the install is committing', () => {
    // customInit runs inside .onInit — BEFORE the licence, install-mode,
    // directory and data-directory pages. Clearing the Add/Remove Programs
    // record there meant cancelling the wizard (or declining UAC) left the app
    // fully installed with no ARP entry, uninstallable by neither user nor MDM.
    // installSection.nsh inserts CHECK_APP_RUNNING immediately before
    // uninstallOldVersion, which is both after the user committed and before the
    // only place the old uninstaller is ever run.
    expect(nshMacro('customInit')).not.toMatch(/DeleteRegKey/)
    expect(nshMacro('customCheckAppRunning')).toMatch(/ForgetBrokenPreviousInstall/)

    // And the delete has to follow the hive it was asked about. appId is frozen,
    // so a per-user and a per-machine install share the key PATH but are two
    // separate installations: an unconditional `DeleteRegKey HKCU` from an
    // /allusers run destroyed a healthy per-user record, after which
    // uninstallOldVersion HKEY_CURRENT_USER read an empty UninstallString and
    // returned — orphaning that copy on disk.
    const forget = nshMacro('ForgetPreviousInstallIn')
    expect(forget).toMatch(/DeleteRegKey \$\{ROOT_KEY\} "\$\{UNINSTALL_REGISTRY_KEY\}"/)
    expect(forget).not.toMatch(/DeleteRegKey HKCU/)
    expect(forget).not.toMatch(/DeleteRegKey SHELL_CONTEXT/)

    // The "is the previous install still there?" test reads the RECORDED
    // uninstaller, not $INSTDIR\<app>.exe. The old exe-existence gate wrongly
    // condemned any beta.5-or-older install sitting in a non-legacy-named
    // folder, where the executable was still called Claude Command Center.exe.
    expect(forget).toMatch(/ReadRegStr \$R0 \$\{ROOT_KEY\} "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/)
    expect(forget).toMatch(/\$\{ElseIfNot\} \$\{FileExists\} "\$R1"/)
    expect(readNsh()).not.toMatch(/FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  })

  it('the relocation also neutralises the registry seed that would undo it', () => {
    // $INSTDIR is seeded from ${INSTALL_REGISTRY_KEY}\InstallLocation, and on
    // any interactive run that read happens AGAIN after customInit: the
    // install-mode page's Leave (multiUserUi.nsh:184,187) and every skip path in
    // its Pre re-run setInstallModePerUser / setInstallModePerAllUsers. The
    // in-app updater launches the installer with no arguments, so auto-update IS
    // that path — leaving just `StrCpy $INSTDIR` here would re-nest the install
    // AND leave the old tree orphaned.
    const init = nshMacro('customInit')
    expect(init).toMatch(/RetargetRecordedInstallLocation HKCU/)
    expect(init).toMatch(/RetargetRecordedInstallLocation HKLM/)
    const retarget = nshMacro('RetargetRecordedInstallLocation')
    expect(retarget).toMatch(/ReadRegStr \$R3 \$\{HIVE\} "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/)
    expect(retarget).toMatch(/WriteRegStr \$\{HIVE\} "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation" "\$INSTDIR"/)
    // Only a record that names the tree being left behind is touched.
    expect(retarget).toMatch(/IsSameOrInside "\$\{LEGACY_ROOT\}"/)

    // ...and it is undone if the wizard never installs anything: that value is
    // where the UNINSTALLER gets its $INSTDIR from, so a dangling one would make
    // a later uninstall delete nothing and then drop the ARP entry. MUI2 owns
    // Function .onUserAbort, so this has to ride its callback.
    const nsh = readNsh()
    expect(nsh).toMatch(/!define MUI_CUSTOMFUNCTION_ABORT "CccRestoreInstallLocation"/)
    expect(nsh).toMatch(/Function CccRestoreInstallLocation/)
    expect(nsh).toMatch(/Function \.onInstFailed/)

    // An explicit /D= is the operator's directory and is never relocated.
    expect(init).toMatch(/GetDParameter/)
  })

  it('release artifacts carry the current brand name, on every platform', () => {
    // These WERE frozen to ClaudeCommandCenter- because the updater in shipped
    // clients matched release assets by that literal prefix, so renaming them
    // would have made every install see "no matching asset" — indistinguishable
    // from "up to date", and unfixable, since the fix only ships in the build
    // they can no longer see. Releases worked around it by publishing each
    // installer TWICE, under both names.
    //
    // 2.1.0-beta.6 taught the updater BOTH prefixes (see the next test), so any
    // client that can reach a new release already resolves the brand name and
    // the duplicate is dead weight — its .blockmap and latest*.yml never even
    // referenced it. Only installs on beta.5 or older are left behind, and they
    // can download from the release page by hand.
    expect(pkg.build.nsis.artifactName).toBe('AI-Code-Conductor-${version}.${ext}')
    expect(pkg.build.mac.artifactName).toBe('AI-Code-Conductor-${version}-mac.${ext}')
    expect(pkg.build.linux.artifactName).toBe('AI-Code-Conductor-${version}-linux-${arch}.${ext}')
  })

  it('the updater still accepts the LEGACY prefix, which is what makes the rename safe', () => {
    // This is the load-bearing half of the rename and the reason the assertion
    // above could change at all. Dropping 'ClaudeCommandCenter-' from this list
    // is harmless for assets published from now on, but it would strand any
    // client still running a build whose release assets carried the old name if
    // one is ever re-published. Keep both until beta-era installs are gone.
    const updater = readFileSync(join(__dirname, '../../../src/main/github-update.ts'), 'utf-8')
    const line = updater.match(/const INSTALLER_PREFIXES = \[([^\]]+)\]/)
    expect(line).not.toBeNull()
    expect(line![1]).toContain("'ClaudeCommandCenter-'")
    expect(line![1]).toContain("'AI-Code-Conductor-'")
  })

  it('releases publish ONE set of installers — no legacy duplicate', () => {
    // The duplicate-copy step is what put two names on every release. If it
    // comes back, so does the "which one do I download?" confusion, and the
    // copies carry no matching .blockmap.
    const workflow = readFileSync(join(__dirname, '../../../.github/workflows/release.yml'), 'utf-8')
    expect(workflow).not.toMatch(/cp -- "\$f" "\$clean"/)
    expect(workflow).toContain('INSTALLER="AI-Code-Conductor-${VERSION}.exe"')
  })

  it('npm name and appId stay frozen (userData path + NSIS upgrade GUID)', () => {
    expect(pkg.name).toBe('claude-conductor')
    expect(pkg.build.appId).toBe('com.claudeconductor.app')
  })

  it('window title and the screenshot self-exclusion filter move in lockstep', () => {
    // The vision window-picker excludes the app by substring-matching the OS
    // window title against a literal in the MAIN process, while the title
    // itself comes from the renderer <title> (prod) / dev override. All three
    // live in different files; this pins them to each other.
    const html = readFileSync(join(__dirname, '../../../src/renderer/index.html'), 'utf-8')
    const mainIndex = readFileSync(join(__dirname, '../../../src/main/index.ts'), 'utf-8')
    const capture = readFileSync(join(__dirname, '../../../src/main/screenshot-capture.ts'), 'utf-8')

    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    expect(titleMatch).not.toBeNull()
    const prodTitle = titleMatch![1]

    const filterMatch = capture.match(/!s\.name\.includes\('([^']+)'\)/)
    expect(filterMatch).not.toBeNull()
    const filter = filterMatch![1]

    const devTitleMatch = mainIndex.match(/const devTitle = '([^']+)'/)
    expect(devTitleMatch).not.toBeNull()
    const devTitle = devTitleMatch![1]

    expect(prodTitle).toContain(filter)
    expect(devTitle).toContain(filter)
  })
})
