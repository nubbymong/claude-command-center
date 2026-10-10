// Claude Code's install recipes (ADR-024): copied from Anthropic's own setup
// page, the native installer first and npm second, through the same recipe
// mechanism, run line and confirmation as every provider's. PURE: nothing is
// run and no file is read.
import { describe, it, expect } from 'vitest'
import { claudeInstallRecipes, CLAUDE_INSTALL_SOURCE_URL, createClaudePackage, claudeWiredCapabilities } from '../../../../src/main/providers/claude'
import { recipeRunLine, installRecipeView, vendorScriptHost, packageRegistrationProblem } from '../../../../src/main/providers/core'

const platforms = ['win32', 'darwin', 'linux'] as const
const PS1 = 'irm https://claude.ai/install.ps1 | iex'
const SH = 'curl -fsSL https://claude.ai/install.sh | bash'

describe("Claude Code's install recipes", () => {
  it("cite Anthropic's setup page, which they are copied from, and are installs only", () => {
    expect(CLAUDE_INSTALL_SOURCE_URL).toBe('https://code.claude.com/docs/en/setup')
    for (const p of platforms) {
      for (const r of claudeInstallRecipes(p)) {
        expect(r).toMatchObject({ providerId: 'claude', platform: p, publisher: 'Anthropic', sourceUrl: CLAUDE_INSTALL_SOURCE_URL, purpose: 'install', needsNetwork: true })
      }
    }
  })

  it("Anthropic's native installer comes first and npm second, on every platform", () => {
    expect(claudeInstallRecipes('win32').map((r) => r.id)).toEqual(['claude-script-install-ps1', 'claude-npm-install'])
    for (const p of ['darwin', 'linux'] as const) expect(claudeInstallRecipes(p).map((r) => r.id), p).toEqual(['claude-script-install-sh', 'claude-npm-install'])
  })

  it("the native installer is the setup page's line, verbatim, naming its one fixed https address on claude.ai", () => {
    const win = claudeInstallRecipes('win32')[0]
    expect(win).toMatchObject({ method: 'script', command: null, autoRunAllowed: true, mayElevate: false, displayCommand: PS1, scriptUrl: 'https://claude.ai/install.ps1' })
    for (const p of ['darwin', 'linux'] as const) {
      expect(claudeInstallRecipes(p)[0], p).toMatchObject({ method: 'script', command: null, autoRunAllowed: true, mayElevate: false, displayCommand: SH, scriptUrl: 'https://claude.ai/install.sh' })
    }
    for (const p of platforms) {
      const r = claudeInstallRecipes(p)[0]
      expect(vendorScriptHost(r), p).toBe('claude.ai')
      expect(r.note, p).toBe("Anthropic's native installer: it downloads a script from claude.ai and runs it. It does not need Node.js.")
    }
  })

  it("npm is the setup page's command; on Windows it names npm.cmd; it says it needs Node.js", () => {
    for (const p of platforms) {
      const npm = claudeInstallRecipes(p)[1]
      expect(npm, p).toMatchObject({
        method: 'package-manager', autoRunAllowed: true, command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
        displayCommand: `${p === 'win32' ? 'npm.cmd' : 'npm'} install -g @anthropic-ai/claude-code`, mayElevate: p !== 'win32',
      })
      expect(npm.scriptUrl, p).toBeUndefined()
      expect(npm.note, p).toBe('Needs Node.js 22 or later and npm. A system-wide npm prefix may ask for administrator rights; the app never elevates on its own.')
    }
  })

  it('the lines a terminal tab types, each ending its shell when its command ends', () => {
    const lines = (p: (typeof platforms)[number]) => claudeInstallRecipes(p).map((r) => recipeRunLine(r, p))
    expect(lines('win32')).toEqual([`${PS1}; exit $LASTEXITCODE`, "npm.cmd 'install' '-g' '@anthropic-ai/claude-code'; exit $LASTEXITCODE"])
    for (const p of ['darwin', 'linux'] as const) expect(lines(p), p).toEqual([`${SH}; exit`, "npm 'install' '-g' '@anthropic-ai/claude-code'; exit"])
  })

  it('the view names claude.ai as where the installer downloads its script from; npm names none', () => {
    for (const p of platforms) {
      const [native, npm] = claudeInstallRecipes(p).map((r) => installRecipeView(r, p))
      expect(native.downloadsFrom, p).toBe('claude.ai')
      expect('downloadsFrom' in npm, p).toBe(false)
      expect(installRecipeView(claudeInstallRecipes(p)[1], p, { nodeFound: false }).needsNode, p).toBe(true)
      expect('needsNode' in installRecipeView(claudeInstallRecipes(p)[0], p, { nodeFound: false }), p).toBe(false)
    }
  })

  it('with its CLI ports wired, the package offers them and declares install.recipes supported; registration accepts it', () => {
    const wired = createClaudePackage({ review: {} as never })
    expect(typeof wired.setup?.installRecipes).toBe('function')
    expect(wired.setup!.installRecipes('win32')).toEqual(claudeInstallRecipes('win32'))
    expect(wired.capabilities['install.recipes'].state).toBe('supported')
    expect(claudeWiredCapabilities['install.recipes'].state).toBe('supported')
    expect(packageRegistrationProblem(wired)).toBeNull()
    // With no CLI ports there is no setup to back it: unknown, as before.
    const bare = createClaudePackage()
    expect(bare.setup).toBeUndefined()
    expect(bare.capabilities['install.recipes'].state).toBe('unknown')
    expect(packageRegistrationProblem(bare)).toBeNull()
  })
})
