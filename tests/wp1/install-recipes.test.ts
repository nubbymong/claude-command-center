// WP1.18, WP1.32 -- WP2 slice 3a (plan A9; design 8.4): the Codex install and
// update recipe registry, tested independently of any UI so a stale or
// unsafe command fails here. PURE.
//
// WP2 commit 6e review fix: the one shell line a terminal tab may type for a
// recipe is decided and built in main (recipeRunLine), from the argv, for the
// platform's terminal shell, and the accounts service hands it to the
// renderer (`runLine`) only for a recipe main allows to run. PURE: the
// service below has no registry, runs nothing and reads no file.
import { describe, it, expect } from 'vitest'
import { codexInstallRecipes, codexInstallKind, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from '../../src/main/providers/codex'
import { AccountsService, ConsumerLeaseRegistry, SecretHandleStore, recipeRunLine } from '../../src/main/providers/core'
import type { InstallRecipe, ProviderPackage } from '../../src/main/providers/core'
import type { CapabilityPlatform } from '../../src/shared/providers'

const platforms = ['win32', 'darwin', 'linux'] as const

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
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      'npm install -g @openai/codex',
    ])
    expect(shown(['win32'])).toEqual([
      'npm.cmd install -g @openai/codex',
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    ])
  })

  it('Windows shows the npm install and update as npm.cmd, so Copy gives a line PowerShell runs under its default script policy; macOS and Linux show npm', () => {
    expect(byId('win32', 'codex-npm-install').displayCommand).toBe('npm.cmd install -g @openai/codex')
    expect(byId('win32', 'codex-npm-update').displayCommand).toBe('npm.cmd install -g @openai/codex@latest')
    for (const p of ['darwin', 'linux'] as const) {
      expect(byId(p, 'codex-npm-install').displayCommand, p).toBe('npm install -g @openai/codex')
      expect(byId(p, 'codex-npm-update').displayCommand, p).toBe('npm install -g @openai/codex@latest')
    }
  })

  it('a pipe-to-shell script is shown and copied, never run by the app: it carries no argv at all', () => {
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p).filter((x) => x.method === 'script')) {
        expect(r.autoRunAllowed, r.id).toBe(false)
        expect(r.command, r.id).toBeNull()
        expect(r.note, r.id).toMatch(/does not run it/)
      }
    }
  })

  it('what may run is a package manager, as argv with no shell and no interpolation: the displayed text split exactly, npm named npm.cmd on Windows', () => {
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p)) {
        expect(r.autoRunAllowed, r.id).toBe(r.command !== null)
        if (!r.command) continue
        expect(['npm', 'brew'], r.id).toContain(r.command[0])
        const [program, ...args] = r.command
        const named = p === 'win32' && program === 'npm' ? 'npm.cmd' : program
        expect([named, ...args].join(' '), `${p} ${r.id}`).toBe(r.displayCommand)
        expect(r.command.every((a) => /^[A-Za-z0-9@./:_-]+$/.test(a)), r.id).toBe(true)
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
    expect(updates('darwin', '/opt/homebrew/Cellar/codex/0.155.1/bin/codex')).toEqual(['codex-npm-update', 'codex-brew-update', 'codex-script-update-sh'])
    expect(updates('linux', '/home/linuxbrew/.linuxbrew/Cellar/codex/0.155.1/bin/codex')).toEqual(['codex-npm-update', 'codex-script-update-sh'])
    expect(updates('linux', '/home/u/.config/yarn/global/node_modules/@openai/codex/bin/codex.js')).toEqual(['codex-npm-update', 'codex-script-update-sh'])
    // The cask still gets the cask upgrade alone.
    expect(updates('darwin', '/opt/homebrew/Caskroom/codex/0.155.1/codex-aarch64-apple-darwin')).toEqual(['codex-brew-update'])
  })

  it('a standalone install gets its own installer run again, never npm; npm and Homebrew get theirs', () => {
    expect(updates('win32', STANDALONE_WIN)).toEqual(['codex-script-update-ps1'])
    expect(updates('darwin', '/Users/u/.codex/packages/standalone/current/bin/codex')).toEqual(['codex-script-update-sh'])
    expect(updates('win32', 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')).toEqual(['codex-npm-update'])
    expect(updates('darwin', '/opt/homebrew/Caskroom/codex/0.155.1/codex')).toEqual(['codex-brew-update'])
    // Not known, or not resolved yet: every update, each saying which install it updates.
    expect(updates('win32', 'C:\\Tools\\codex.exe')).toEqual(['codex-npm-update', 'codex-script-update-ps1'])
    expect(updates('darwin')).toEqual(['codex-npm-update', 'codex-brew-update', 'codex-script-update-sh'])
    // The installs never change with it.
    for (const exe of [STANDALONE_WIN, undefined]) {
      expect(codexInstallRecipes('win32', exe ? { executable: exe } : {}).filter((r) => r.purpose === 'install').map((r) => r.id)).toEqual(['codex-npm-install', 'codex-script-install-ps1'])
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

  it('the standalone update is the installer, shown and copied, never run by the app', () => {
    const r = codexInstallRecipes('win32', { executable: STANDALONE_WIN }).find((x) => x.purpose === 'update')!
    expect(r).toMatchObject({ method: 'script', command: null, autoRunAllowed: false })
    expect(r.displayCommand).toBe(codexInstallRecipes('win32').find((x) => x.id === 'codex-script-install-ps1')!.displayCommand)
    expect(r.note).toMatch(/Updates a Codex this script installed/)
    expect(recipeRunLine(r, 'win32')).toBeUndefined()
    // Walk fix W8: the same for the sh installer, on both platforms it runs on.
    for (const p of ['darwin', 'linux'] as const) {
      const sh = codexInstallRecipes(p, { executable: '/Users/u/.codex/packages/standalone/current/bin/codex' }).find((x) => x.purpose === 'update')!
      expect(sh.id).toBe('codex-script-update-sh')
      expect(sh).toMatchObject({ method: 'script', command: null, autoRunAllowed: false })
      expect(sh.displayCommand).toBe(codexInstallRecipes(p).find((x) => x.id === 'codex-script-install-sh')!.displayCommand)
      expect(sh.displayCommand).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
      expect(sh.note).toMatch(/Updates a Codex this script installed/)
      expect(recipeRunLine(sh, p)).toBeUndefined()
    }
  })
})

// --- WP2 commit 6e review fix: the line the terminal tab types --------------

type Runnable = Pick<InstallRecipe, 'method' | 'autoRunAllowed' | 'command'>
const recipe = (over: Partial<Runnable> = {}): Runnable => ({ method: 'package-manager', autoRunAllowed: true, command: ['npm', 'install', '-g', '@openai/codex'], ...over })
const byId = (p: CapabilityPlatform, id: string) => codexInstallRecipes(p).find((r) => r.id === id)!

describe('recipeRunLine: what a terminal tab may type for a recipe', () => {
  it('Windows: npm is typed as npm.cmd (PowerShell would load npm.ps1, which the default execution policy refuses), every argument single-quoted', () => {
    expect(recipeRunLine(byId('win32', 'codex-npm-install'), 'win32')).toBe("npm.cmd 'install' '-g' '@openai/codex'")
    expect(recipeRunLine(byId('win32', 'codex-npm-update'), 'win32')).toBe("npm.cmd 'install' '-g' '@openai/codex@latest'")
  })

  it('macOS and Linux: npm unchanged, arguments single-quoted; brew on macOS', () => {
    for (const p of ['darwin', 'linux'] as const) {
      expect(recipeRunLine(byId(p, 'codex-npm-install'), p), p).toBe("npm 'install' '-g' '@openai/codex'")
      expect(recipeRunLine(byId(p, 'codex-npm-update'), p), p).toBe("npm 'install' '-g' '@openai/codex@latest'")
    }
    expect(recipeRunLine(byId('darwin', 'codex-brew-install'), 'darwin')).toBe("brew 'install' '--cask' 'codex'")
    expect(recipeRunLine(byId('darwin', 'codex-brew-update'), 'darwin')).toBe("brew 'upgrade' '--cask' 'codex'")
  })

  it('a script recipe gets no line on any platform', () => {
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p).filter((x) => x.method === 'script')) expect(recipeRunLine(r, p), r.id).toBeUndefined()
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
    expect(recipeRunLine(shown, 'win32')).toBe("npm.cmd 'install' '-g' '@openai/codex'")
  })

  it('the program must be a plain word typed bare; anything else gets no line', () => {
    for (const program of ['npm;calc', 'C:/Tools/npm', 'C:' + String.fromCharCode(92) + 'npm', '&npm', '-npm', 'n pm', '']) {
      expect(recipeRunLine(recipe({ command: [program, 'install'] }), 'win32'), program).toBeUndefined()
    }
  })

  it('an argument is literal in that shell: quotes escaped, nothing expanded', () => {
    expect(recipeRunLine(recipe({ command: ['npm', "it's", '$(calc)', '@x/y'] }), 'win32')).toBe("npm.cmd 'it''s' '$(calc)' '@x/y'")
    // POSIX: a single quote closes, is escaped, and reopens: 'it'\''s'.
    const BS = String.fromCharCode(92)
    expect(recipeRunLine(recipe({ command: ['npm', "it's", '$(calc)', '@x/y'] }), 'linux')).toBe(`npm 'it'${BS}''s' '$(calc)' '@x/y'`)
  })
})

describe('the accounts service hands the renderer a line only for a recipe main allows to run', () => {
  const serviceOn = (platform: CapabilityPlatform, recipes: (p: CapabilityPlatform) => readonly InstallRecipe[] = codexInstallRecipes) => {
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
    })
  }

  it('each platform: a line exactly for the runnable recipes, built for that platform; the shown command verbatim; never an argv', () => {
    for (const p of platforms) {
      const views = serviceOn(p).installRecipes('codex')
      const source = codexInstallRecipes(p)
      expect(views.map((v) => v.id), p).toEqual(source.map((r) => r.id))
      for (const v of views) {
        const r = source.find((x) => x.id === v.id)!
        expect(v.displayCommand, v.id).toBe(r.displayCommand)
        expect('command' in v, v.id).toBe(false)
        if (r.method === 'package-manager' && r.autoRunAllowed && r.command) expect(v.runLine, `${p} ${v.id}`).toBe(recipeRunLine(r, p))
        else expect('runLine' in v, `${p} ${v.id}`).toBe(false)
      }
    }
    const win = serviceOn('win32').installRecipes('codex')
    expect(win.find((v) => v.id === 'codex-npm-install')!.runLine).toBe("npm.cmd 'install' '-g' '@openai/codex'")
    expect(win.find((v) => v.id === 'codex-script-install-ps1')!.runLine).toBeUndefined()
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
    expect(svc.installRecipes('codex').filter((v) => v.purpose === 'update').map((v) => v.id)).toEqual(['codex-npm-update', 'codex-script-update-ps1'])
    expect((await svc.discover('codex')).ok).toBe(true)
    const after = svc.installRecipes('codex')
    expect(after.filter((v) => v.purpose === 'update').map((v) => v.id)).toEqual(['codex-script-update-ps1'])
    expect(JSON.stringify(after)).not.toContain('packages')
  })

  it('a recipe that says it may run but carries no argv gets no line', () => {
    const noArgv = (p: CapabilityPlatform) => codexInstallRecipes(p).map((r) => ({ ...r, command: null }))
    for (const v of serviceOn('win32', noArgv).installRecipes('codex')) expect('runLine' in v, v.id).toBe(false)
  })
})
