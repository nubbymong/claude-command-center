// WP1.18, WP1.32 -- WP2 slice 3a (plan A9; design 8.4): the Codex install and
// update recipe registry, tested independently of any UI so a stale or
// unsafe command fails here. PURE.
import { describe, it, expect } from 'vitest'
import { codexInstallRecipes, CODEX_INSTALL_SOURCE_URL, CODEX_README_COMMIT } from '../../src/main/providers/codex'

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
