// WP2 commit 6e: the one shell line the app may type to run an install or
// update recipe, decided and built here in main. PURE.
//
// A Conductor terminal tab is a shell: PowerShell on Windows, the user's
// POSIX shell elsewhere. The renderer types a line into it; it never builds
// one. So main decides which recipe may run at all, and hands the renderer
// the exact line, built from the recipe's argv (never from the text the user
// is shown, which is the provider's documented command and may not run as
// is in that shell):
//
//   - Only a package-manager recipe with `autoRunAllowed` and an argv gets a
//     line. A script, an installer or anything without an argv gets none, so
//     there is nothing the renderer could type for it.
//   - On Windows, PowerShell resolves `npm` to npm.ps1, which the default
//     execution policy (Restricted) refuses to load: the install would fail
//     for most Windows users. The line names npm.cmd, the batch shim installed
//     beside it, which the execution policy does not govern. The app never
//     changes or bypasses the execution policy itself.
//   - The program is typed bare (PowerShell reads a quoted first word as a
//     string, not a command) and must be a plain word; every argument is
//     single-quoted for that shell (quoteArgForShell), so a scoped package
//     name (`@scope/name`) reaches npm literally and not as PowerShell
//     splatting.
import type { CapabilityPlatform } from '../../../shared/providers'
import { quoteArgForShell } from '../../spawn-claude-command'
import type { InstallRecipe } from './package'

/** A program name that can be typed bare at the start of the line. */
const PLAIN_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** On Windows: the batch shim for a program whose PowerShell resolution is a
 *  script the default execution policy refuses to load. */
const WINDOWS_BATCH_SHIM: ReadonlyMap<string, string> = new Map([['npm', 'npm.cmd']])

/** The line a terminal tab types to run `recipe` on `platform`, or undefined
 *  when the app must not run it (show and copy only). */
export function recipeRunLine(
  recipe: Pick<InstallRecipe, 'method' | 'autoRunAllowed' | 'command'>,
  platform: CapabilityPlatform,
): string | undefined {
  if (recipe.method !== 'package-manager' || recipe.autoRunAllowed !== true) return undefined
  const argv = recipe.command
  if (!argv || argv.length === 0) return undefined
  const [program, ...args] = argv
  if (typeof program !== 'string' || !PLAIN_PROGRAM.test(program)) return undefined
  if (!args.every((a) => typeof a === 'string')) return undefined
  const isWin32 = platform === 'win32'
  const typed = isWin32 ? (WINDOWS_BATCH_SHIM.get(program) ?? program) : program
  return [typed, ...args.map((a) => quoteArgForShell(a, isWin32))].join(' ')
}
