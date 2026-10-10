// How the Codex CLI is installed and updated (WP2, plan A9; design 8.4).
// Code-defined, never scraped: every install command is copied verbatim from
// the openai/codex README at the pinned commit below, except that on Windows
// the npm commands name npm.cmd (shared/shell-program.ts): in PowerShell a
// bare `npm` runs npm.ps1, which the default execution policy refuses to
// load, so the README's line would fail as copied. The update commands are
// the same package managers' own update of that documented package, and, for
// a Codex OpenAI's own installer put there, that installer run again (as
// Claude Code's own setup says: re-run the native installer). An update is
// offered for the install discovery resolved, the one sessions run: an npm
// update beside a standalone install that stays first on PATH changes
// nothing the app runs.
//
// Only a package-manager recipe may run, in a visible Conductor terminal and
// after an explicit confirmation. The remote pipe-to-shell scripts are shown
// and copied, never run -- they carry no argv at all: they fetch code at run
// time with no publisher digest this app could check, and the Windows one
// bypasses the PowerShell execution policy, which the design forbids the app
// itself to do.
import type { CapabilityPlatform } from '../../../shared/providers'
import { shellProgram } from '../../../shared/shell-program'
import type { InstallRecipe, InstalledCli } from '../core'

export const CODEX_README_COMMIT = '39a2438d16514d0d6f88105d17b0f747994af487'
export const CODEX_INSTALL_SOURCE_URL = `https://github.com/openai/codex/blob/${CODEX_README_COMMIT}/README.md`
const PUBLISHER = 'OpenAI'
const ALL: readonly CapabilityPlatform[] = ['win32', 'darwin', 'linux']

type Draft = Omit<InstallRecipe, 'providerId' | 'platform' | 'publisher' | 'sourceUrl' | 'mayElevate' | 'displayCommand'> & {
  platforms: readonly CapabilityPlatform[]
  /** What is shown and copied there. */
  displayCommand: string | ((p: CapabilityPlatform) => string)
  /** Whether the provider's own tooling may ask for administrator rights there. */
  mayElevate: boolean | ((p: CapabilityPlatform) => boolean)
  /** An update: the kind of install it updates. */
  updates?: Exclude<CodexInstallKind, 'unknown'>
}

/** How the Codex CLI discovery resolved was installed, from its canonical
 *  path alone (nothing is read): an npm global package, a Homebrew cask, or
 *  OpenAI's standalone installer (install.ps1 / install.sh), whose binaries
 *  live under a `packages/standalone` folder, reached on Windows through
 *  `Programs\OpenAI\Codex\bin`. Anything else is unknown, and gets every
 *  update: a guess would offer a command that installs a second copy beside
 *  the one sessions run.
 *
 *  npm is told by npm's own global layout: `<prefix>/lib/node_modules`
 *  (macOS, Linux, and a Node version manager's npm), or Windows' default
 *  prefix `%APPDATA%\npm`, whose shims sit in it. Another package manager's
 *  global folder (bun, pnpm, Yarn) also holds a `node_modules/@openai/codex`,
 *  but its npm update would be a second install, so it is unknown. So is a
 *  Homebrew FORMULA (`Cellar/codex`): the README documents the cask, and this
 *  set has no formula update to offer (`brew upgrade --cask` fails on it). */
export type CodexInstallKind = 'npm' | 'brew' | 'standalone' | 'unknown'

export function codexInstallKind(executable: string | undefined): CodexInstallKind {
  if (typeof executable !== 'string' || !executable) return 'unknown'
  const p = executable.replace(/\\/g, '/').toLowerCase()
  const npmGlobal = /\/(lib|npm)\/node_modules\/@openai\/codex\//.test(p) && !p.includes('/.pnpm/')
  if (npmGlobal || /\/npm\/codex(\.cmd|\.ps1)?$/.test(p)) return 'npm'
  if (p.includes('/caskroom/codex/')) return 'brew'
  if (p.includes('/packages/standalone/') || p.includes('/programs/openai/codex/')) return 'standalone'
  return 'unknown'
}

// npm's default global prefix is per-user on Windows (under %APPDATA%) but
// often a system directory elsewhere (/usr/local from the nodejs.org
// installer, a distro prefix), where `npm install -g` needs sudo. The app
// never elevates on its own; this only warns.
const npmMayElevate = (p: CapabilityPlatform) => p !== 'win32'

const DRAFTS: readonly Draft[] = [
  {
    id: 'codex-npm-install', purpose: 'install', platforms: ALL, method: 'package-manager',
    command: ['npm', 'install', '-g', '@openai/codex'], displayCommand: (p) => `${shellProgram('npm', p)} install -g @openai/codex`,
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
    id: 'codex-npm-update', purpose: 'update', platforms: ALL, method: 'package-manager', updates: 'npm',
    command: ['npm', 'install', '-g', '@openai/codex@latest'], displayCommand: (p) => `${shellProgram('npm', p)} install -g @openai/codex@latest`,
    needsNetwork: true, mayElevate: npmMayElevate, autoRunAllowed: true,
    note: 'Updates an npm installation. The version is checked against the tested range afterwards.',
  },
  {
    id: 'codex-brew-update', purpose: 'update', platforms: ['darwin'], method: 'package-manager', updates: 'brew',
    command: ['brew', 'upgrade', '--cask', 'codex'], displayCommand: 'brew upgrade --cask codex',
    needsNetwork: true, mayElevate: false, autoRunAllowed: true,
    note: 'Updates a Homebrew cask (not a formula).',
  },
  {
    id: 'codex-script-update-sh', purpose: 'update', platforms: ['darwin', 'linux'], method: 'script', updates: 'standalone',
    command: null, displayCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    needsNetwork: true, mayElevate: false, autoRunAllowed: false,
    note: 'Updates a Codex this script installed: running it again installs the latest version. Downloads and runs a script from chatgpt.com. Shown for you to review and run yourself; the app does not run it.',
  },
  {
    id: 'codex-script-update-ps1', purpose: 'update', platforms: ['win32'], method: 'script', updates: 'standalone',
    command: null, displayCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    needsNetwork: true, mayElevate: false, autoRunAllowed: false,
    note: 'Updates a Codex this script installed: running it again installs the latest version. Downloads and runs a script from chatgpt.com and bypasses the PowerShell execution policy. Shown for you to review and run yourself; the app does not run it.',
  },
]

/** Every recipe for one platform, installs first, in the order shown. The
 *  updates are the one for the install discovery resolved (`installed`);
 *  for an install of an unknown kind, or before discovery has resolved one,
 *  every update, each saying which install it updates. */
export function codexInstallRecipes(platform: CapabilityPlatform, installed?: InstalledCli): readonly InstallRecipe[] {
  const kind = codexInstallKind(installed?.executable)
  const offered = (d: Draft) => d.purpose !== 'update' || kind === 'unknown' || d.updates === kind
  return DRAFTS.filter((d) => d.platforms.includes(platform) && offered(d)).map(({ platforms: _p, mayElevate, displayCommand, updates: _u, ...d }) => ({
    ...d, providerId: 'codex' as const, platform, publisher: PUBLISHER, sourceUrl: CODEX_INSTALL_SOURCE_URL,
    displayCommand: typeof displayCommand === 'function' ? displayCommand(platform) : displayCommand,
    mayElevate: typeof mayElevate === 'function' ? mayElevate(platform) : mayElevate,
  }))
}
