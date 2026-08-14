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
    const nsh = readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf-8')
    // customInit must run the step-up, and it must recognise both legacy folder
    // names; without this an upgrade installs to <old folder>\AI Code Conductor.
    expect(nsh).toMatch(/!macro customInit/)
    expect(nsh).toMatch(/GetParent/)
    expect(nsh).toContain('"Claude Command Center"')
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
    const nsh = readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf-8')
    // Scoped to the DETECTION macro, not the whole file: every one of these
    // names also appears in the customInstall cleanup calls, so a whole-file
    // `toContain` stayed green when the detection list was gutted (caught by
    // mutation-testing this very guard).
    const detect = nsh.match(/!macro IsLegacyBrandFolder[\s\S]*?!macroend/)
    expect(detect, 'IsLegacyBrandFolder macro not found').not.toBeNull()
    for (const name of [
      '"Claude Command Center"',
      '"Claude Conductor"',
      '"Claude Command Center Beta"',
      '"Claude Conductor Beta"',
    ]) {
      expect(detect![0]).toContain(name)
    }
    // And the walk has to look at ANCESTORS, not just the last component —
    // a nested install's tail is already the current brand name.
    expect(nsh).toMatch(/GetFileName/)
    expect(nsh).toMatch(/\$\{Loop\}/)
  })

  it('a broken previous install is cleared silently instead of prompting', () => {
    // electron-builder runs the recorded old uninstaller, retries 5x, and on
    // failure shows "$(appCannotBeClosed)" — a message about the APP being
    // open, raised when the UNINSTALLER failed. With no UninstallString it
    // returns immediately, so clearing a record we know is broken is what keeps
    // the upgrade silent. Both root keys, because the record can be in either.
    const nsh = readFileSync(join(__dirname, '../../../build/installer.nsh'), 'utf-8')
    expect(nsh).toMatch(/!macro ForgetPreviousInstall/)
    expect(nsh).toMatch(/DeleteRegKey SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}"/)
    expect(nsh).toMatch(/DeleteRegKey HKCU "\$\{UNINSTALL_REGISTRY_KEY\}"/)
    // Fired both for a legacy tree and for a recorded install whose binary is
    // simply gone.
    expect(nsh).toMatch(/IfNot\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
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
