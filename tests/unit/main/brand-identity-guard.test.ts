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
 *   - artifactName keeps the ClaudeCommandCenter- prefix (the updater in every
 *     installed client matches release assets by that literal prefix; a
 *     non-match is indistinguishable from "up to date")
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

  it('release artifact names keep the frozen ClaudeCommandCenter- prefix', () => {
    expect(pkg.build.nsis.artifactName).toBe('ClaudeCommandCenter-${version}.${ext}')
    expect(pkg.build.mac.artifactName).toBe('ClaudeCommandCenter-${version}-mac.${ext}')
    expect(pkg.build.linux.artifactName).toBe('ClaudeCommandCenter-${version}-linux-${arch}.${ext}')
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
