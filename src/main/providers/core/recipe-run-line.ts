// WP2 commit 6e: the one shell line the app may type to run an install or
// update recipe, decided and built here in main. PURE.
//
// A Conductor terminal tab is a shell: PowerShell on Windows, the user's
// POSIX shell elsewhere. The renderer types a line into it; it never builds
// one. So main decides which recipe may run at all, and hands the renderer
// the exact line:
//
//   - A package-manager recipe with `autoRunAllowed` and an argv: the line is
//     built from the argv (never from the text the user is shown, which is
//     the provider's documented command and may not run as is in that shell).
//   - A vendor's own installer script with `autoRunAllowed` (ADR-024): the
//     line is the documented command itself, character for character, and
//     only when that command names exactly one web address, its `scriptUrl`,
//     an HTTPS address with no user, port, query or fragment, fixed in code
//     beside it. The confirmation the renderer shows names that address's
//     host (installRecipeView's `downloadsFrom`), so the user is told where
//     the script comes from before anything runs. A command with a second
//     address, another address, or a control character gets no line.
//   - Anything else (an installer, a recipe not allowed to run) gets none, so
//     there is nothing the renderer could type for it.
//   - Every line ends its own shell when its command ends (`; exit`, and in
//     PowerShell `; exit $LASTEXITCODE`). The tab's session then reads as
//     exited, which is how the surface that opened it knows to check again;
//     the exit code is shown, but whether the tool is there is always decided
//     by that check, never by the code.
//   - On Windows, PowerShell resolves `npm` to npm.ps1, which the default
//     execution policy (Restricted) refuses to load: the install would fail
//     for most Windows users. The line names npm.cmd, the batch shim installed
//     beside it, which the execution policy does not govern (shellProgram,
//     the one rule the commands the app shows follow too). The app never
//     changes or bypasses the execution policy itself; a vendor's documented
//     command that does so for its own script is typed as documented.
//   - The program is typed bare (PowerShell reads a quoted first word as a
//     string, not a command) and must be a plain word; every argument is
//     single-quoted for that shell (quoteArgForShell), so a scoped package
//     name (`@scope/name`) reaches npm literally and not as PowerShell
//     splatting.
import type { CapabilityPlatform, InstallRecipeView } from '../../../shared/providers'
import { quoteArgForShell } from '../../../shared/shell-quote'
import { shellProgram } from '../../../shared/shell-program'
import type { InstallRecipe } from './package'

/** A program name that can be typed bare at the start of the line. */
const PLAIN_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** What ends a line in PowerShell: the shell exits with the command's code. */
export const WINDOWS_RUN_LINE_END = '; exit $LASTEXITCODE'
/** What ends a line in a POSIX shell: the shell exits with the command's status. */
export const POSIX_RUN_LINE_END = '; exit'

function runLineEnd(platform: CapabilityPlatform): string {
  return platform === 'win32' ? WINDOWS_RUN_LINE_END : POSIX_RUN_LINE_END
}

/** Every web address a command names (any scheme), as written. */
const ADDRESS = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`|;&<>()]+/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** `u` as a fixed HTTPS address: https, no user or password, no port, query
 *  or fragment, and written exactly as a URL parser reads it back. */
function fixedHttpsAddress(u: unknown): URL | null {
  if (typeof u !== 'string' || u === '') return null
  let url: URL
  try { url = new URL(u) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
  return url.href === u ? url : null
}

/** For a vendor's installer script the app may run: the host its documented
 *  command downloads the script from (its fixed `scriptUrl`, the one address
 *  the command names). Undefined for anything else, which then gets no line. */
export function vendorScriptHost(
  recipe: Pick<InstallRecipe, 'method' | 'autoRunAllowed'> & Partial<Pick<InstallRecipe, 'displayCommand' | 'scriptUrl'>>,
): string | undefined {
  if (recipe.method !== 'script' || recipe.autoRunAllowed !== true) return undefined
  const url = fixedHttpsAddress(recipe.scriptUrl)
  const line = recipe.displayCommand
  if (!url || typeof line !== 'string' || line.trim() === '' || CONTROL.test(line)) return undefined
  const named = line.match(ADDRESS) ?? []
  return named.length === 1 && named[0] === recipe.scriptUrl ? url.hostname : undefined
}

/** The line a terminal tab types to run `recipe` on `platform`, or undefined
 *  when the app must not run it (show and copy only). */
export function recipeRunLine(
  recipe: Pick<InstallRecipe, 'method' | 'autoRunAllowed' | 'command'> & Partial<Pick<InstallRecipe, 'displayCommand' | 'scriptUrl'>>,
  platform: CapabilityPlatform,
): string | undefined {
  if (recipe.autoRunAllowed !== true) return undefined
  if (recipe.method === 'script') {
    return vendorScriptHost(recipe) === undefined ? undefined : `${recipe.displayCommand}${runLineEnd(platform)}`
  }
  if (recipe.method !== 'package-manager') return undefined
  const argv = recipe.command
  if (!argv || argv.length === 0) return undefined
  const [program, ...args] = argv
  if (typeof program !== 'string' || !PLAIN_PROGRAM.test(program)) return undefined
  if (!args.every((a) => typeof a === 'string')) return undefined
  const isWin32 = platform === 'win32'
  return [shellProgram(program, platform), ...args.map((a) => quoteArgForShell(a, isWin32))].join(' ') + runLineEnd(platform)
}

/** A recipe whose line runs npm, which needs Node.js on this computer. */
export function recipeRunsNpm(recipe: Pick<InstallRecipe, 'method' | 'command'>): boolean {
  return recipe.method === 'package-manager' && recipe.command?.[0] === 'npm'
}

/** The recipe as the renderer sees it: what to show and copy, and, only for
 *  a recipe main allows to run, the line to type (`runLine`) and, for a
 *  vendor's installer, the host its script comes from (`downloadsFrom`).
 *  Never the argv or the script address itself. `nodeFound: false` (Node.js
 *  was looked for and not found) marks every npm recipe `needsNode`; it keeps
 *  its line, and the renderer offers only Copy for it. */
export function installRecipeView(r: InstallRecipe, platform: CapabilityPlatform, opts: { nodeFound?: boolean } = {}): InstallRecipeView {
  const runLine = recipeRunLine(r, platform)
  const downloadsFrom = runLine !== undefined && r.method === 'script' ? vendorScriptHost(r) : undefined
  return {
    id: r.id, providerId: r.providerId, purpose: r.purpose, publisher: r.publisher, sourceUrl: r.sourceUrl, displayCommand: r.displayCommand,
    method: r.method, needsNetwork: r.needsNetwork, mayElevate: r.mayElevate, autoRunAllowed: r.autoRunAllowed, ...(r.note !== undefined ? { note: r.note } : {}),
    ...(runLine !== undefined ? { runLine } : {}),
    ...(downloadsFrom !== undefined ? { downloadsFrom } : {}),
    ...(opts.nodeFound === false && recipeRunsNpm(r) ? { needsNode: true as const } : {}),
  }
}
