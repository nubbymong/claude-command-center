// How Claude Code is installed (ADR-024; owner decisions D1 to D3,
// 2026-10-10). Code-defined, never scraped: each command is copied verbatim
// from Anthropic's own setup page (CLAUDE_INSTALL_SOURCE_URL), except that on
// Windows the npm command names npm.cmd (shared/shell-program.ts): in
// PowerShell a bare `npm` runs npm.ps1, which the default execution policy
// refuses to load, so the page's line would fail as copied.
//
// Anthropic's native installer comes first, the page's recommended install;
// npm, which needs Node.js, is the alternative. Both may run, only in a
// visible Conductor terminal, only after an explicit confirmation, never on
// their own and never elevated by the app. npm runs from its argv. The native
// installer runs as the page's line, character for character, which names
// `scriptUrl`, the one HTTPS address fixed here beside it: main types that
// line only when it names exactly that address, and the confirmation names
// its host, claude.ai, and says it downloads and runs a script. Its
// PowerShell line runs in the terminal's own PowerShell and changes nothing
// about its execution policy.
//
// Installs only: a native install updates itself in the background, and an
// out-of-date Claude Code is not a state setup stops on.
import type { CapabilityPlatform } from '../../../shared/providers'
import { shellProgram } from '../../../shared/shell-program'
import type { InstallRecipe } from '../core'

/** Anthropic's setup page for Claude Code, which the commands are copied from. */
export const CLAUDE_INSTALL_SOURCE_URL = 'https://code.claude.com/docs/en/setup'
const PUBLISHER = 'Anthropic'

const NATIVE_NOTE = "Anthropic's native installer: it downloads a script from claude.ai and runs it. It does not need Node.js."

/** The native installer's line on each platform, and the address it names. */
const NATIVE: Readonly<Record<CapabilityPlatform, { id: string; line: string; url: string }>> = {
  win32: { id: 'claude-script-install-ps1', line: 'irm https://claude.ai/install.ps1 | iex', url: 'https://claude.ai/install.ps1' },
  darwin: { id: 'claude-script-install-sh', line: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://claude.ai/install.sh' },
  linux: { id: 'claude-script-install-sh', line: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://claude.ai/install.sh' },
}

/** Claude Code's install recipes for one platform, in the order shown: the
 *  native installer, then npm. */
export function claudeInstallRecipes(platform: CapabilityPlatform): readonly InstallRecipe[] {
  const native = NATIVE[platform]
  if (!native) return []
  const common = { providerId: 'claude' as const, purpose: 'install' as const, platform, publisher: PUBLISHER, sourceUrl: CLAUDE_INSTALL_SOURCE_URL, needsNetwork: true }
  return [
    {
      ...common, id: native.id, method: 'script', command: null, displayCommand: native.line, scriptUrl: native.url,
      mayElevate: false, autoRunAllowed: true, note: NATIVE_NOTE,
    },
    {
      ...common, id: 'claude-npm-install', method: 'package-manager',
      command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], displayCommand: `${shellProgram('npm', platform)} install -g @anthropic-ai/claude-code`,
      // npm's default global prefix is per-user on Windows but often a system
      // folder elsewhere, where `npm install -g` needs sudo. This only warns.
      mayElevate: platform !== 'win32', autoRunAllowed: true,
      note: platform === 'win32'
        ? 'Needs Node.js 22 or later.'
        : 'Needs Node.js 22 or later. If npm says permission denied (EACCES), use the installer above instead: the app never asks for administrator rights.',
    },
  ]
}
