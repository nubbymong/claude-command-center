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
import { codexInstallRecipes, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from '../../src/main/providers/codex'
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

  it('recipes are the README commands verbatim, from the pinned commit', () => {
    expect(CODEX_README_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(CODEX_INSTALL_SOURCE_URL).toBe(`https://github.com/openai/codex/blob/${CODEX_README_COMMIT}/README.md`)
    const shown = new Set(platforms.flatMap((p) => codexInstallRecipes(p).filter((r) => r.purpose === 'install').map((r) => r.displayCommand)))
    expect([...shown].sort()).toEqual([
      'brew install --cask codex',
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      'npm install -g @openai/codex',
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    ])
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

  it('what may run is a package manager, as argv with no shell and no interpolation: the displayed text split exactly', () => {
    for (const p of platforms) {
      for (const r of codexInstallRecipes(p)) {
        expect(r.autoRunAllowed, r.id).toBe(r.command !== null)
        if (!r.command) continue
        expect(['npm', 'brew'], r.id).toContain(r.command[0])
        expect(r.command.join(' '), r.id).toBe(r.displayCommand)
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

  it('a recipe that says it may run but carries no argv gets no line', () => {
    const noArgv = (p: CapabilityPlatform) => codexInstallRecipes(p).map((r) => ({ ...r, command: null }))
    for (const v of serviceOn('win32', noArgv).installRecipes('codex')) expect('runLine' in v, v.id).toBe(false)
  })
})
