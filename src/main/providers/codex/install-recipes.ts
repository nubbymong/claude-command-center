// How the Codex CLI is installed and updated (WP2, plan A9; design 8.4).
// Code-defined, never scraped: every install command is copied verbatim from
// the openai/codex README at the pinned commit below. The update commands are
// the same package managers' own update of that documented package.
//
// Only a package-manager recipe may run, in a visible Conductor terminal and
// after an explicit confirmation. The remote pipe-to-shell scripts are shown
// and copied, never run -- they carry no argv at all: they fetch code at run
// time with no publisher digest this app could check, and the Windows one
// bypasses the PowerShell execution policy, which the design forbids the app
// itself to do.
import type { CapabilityPlatform } from '../../../shared/providers'
import type { InstallRecipe } from '../core'

export const CODEX_README_COMMIT = '39a2438d16514d0d6f88105d17b0f747994af487'
export const CODEX_INSTALL_SOURCE_URL = `https://github.com/openai/codex/blob/${CODEX_README_COMMIT}/README.md`
const PUBLISHER = 'OpenAI'
const ALL: readonly CapabilityPlatform[] = ['win32', 'darwin', 'linux']

type Draft = Omit<InstallRecipe, 'providerId' | 'platform' | 'publisher' | 'sourceUrl' | 'mayElevate'> & {
  platforms: readonly CapabilityPlatform[]
  /** Whether the provider's own tooling may ask for administrator rights there. */
  mayElevate: boolean | ((p: CapabilityPlatform) => boolean)
}

// npm's default global prefix is per-user on Windows (under %APPDATA%) but
// often a system directory elsewhere (/usr/local from the nodejs.org
// installer, a distro prefix), where `npm install -g` needs sudo. The app
// never elevates on its own; this only warns.
const npmMayElevate = (p: CapabilityPlatform) => p !== 'win32'

const DRAFTS: readonly Draft[] = [
  {
    id: 'codex-npm-install', purpose: 'install', platforms: ALL, method: 'package-manager',
    command: ['npm', 'install', '-g', '@openai/codex'], displayCommand: 'npm install -g @openai/codex',
    needsNetwork: true, mayElevate: npmMayElevate, autoRunAllowed: true,
    note: 'Needs Node.js and npm. A system-wide npm prefix may ask for administrator rights; the app never elevates on its own.',
  },
  {
    id: 'codex-brew-install', purpose: 'install', platforms: ['darwin'], method: 'package-manager',
    command: ['brew', 'install', '--cask', 'codex'], displayCommand: 'brew install --cask codex',
    needsNetwork: true, mayElevate: false, autoRunAllowed: true,
  },
  {
    id: 'codex-script-install-sh', purpose: 'install', platforms: ['darwin', 'linux'], method: 'script',
    command: null, displayCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    needsNetwork: true, mayElevate: false, autoRunAllowed: false,
    note: 'Downloads and runs a script from chatgpt.com. Shown for you to review and run yourself; the app does not run it.',
  },
  {
    id: 'codex-script-install-ps1', purpose: 'install', platforms: ['win32'], method: 'script',
    command: null, displayCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    needsNetwork: true, mayElevate: false, autoRunAllowed: false,
    note: 'Downloads and runs a script from chatgpt.com and bypasses the PowerShell execution policy. Shown for you to review and run yourself; the app does not run it.',
  },
  {
    id: 'codex-npm-update', purpose: 'update', platforms: ALL, method: 'package-manager',
    command: ['npm', 'install', '-g', '@openai/codex@latest'], displayCommand: 'npm install -g @openai/codex@latest',
    needsNetwork: true, mayElevate: npmMayElevate, autoRunAllowed: true,
    note: 'Updates an npm installation. The version is checked against the tested range afterwards.',
  },
  {
    id: 'codex-brew-update', purpose: 'update', platforms: ['darwin'], method: 'package-manager',
    command: ['brew', 'upgrade', '--cask', 'codex'], displayCommand: 'brew upgrade --cask codex',
    needsNetwork: true, mayElevate: false, autoRunAllowed: true,
  },
]

/** Every recipe for one platform, installs first, in the order shown. */
export function codexInstallRecipes(platform: CapabilityPlatform): readonly InstallRecipe[] {
  return DRAFTS.filter((d) => d.platforms.includes(platform)).map(({ platforms: _p, mayElevate, ...d }) => ({
    ...d, providerId: 'codex' as const, platform, publisher: PUBLISHER, sourceUrl: CODEX_INSTALL_SOURCE_URL,
    mayElevate: typeof mayElevate === 'function' ? mayElevate(platform) : mayElevate,
  }))
}
