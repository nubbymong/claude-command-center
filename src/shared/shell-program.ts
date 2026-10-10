// The name a Conductor terminal's shell is given for a program at the start
// of a line: one the app types (the install and update line it runs after you
// confirm it) or one it shows for you to copy and run in a terminal. PURE, no
// imports, so main (provider core's run line, a provider's shown commands)
// and the renderer (the commands it shows) follow one rule.
//
// On Windows a terminal is PowerShell, which resolves a bare `npm` to npm.ps1
// before npm.cmd. The default execution policy on a Windows client
// (Restricted) refuses to load that script, so `npm install ...` fails there
// with "running scripts is disabled on this system". npm.cmd, the batch shim
// npm installs beside it, is not governed by the execution policy and runs
// the same npm in cmd.exe, Windows PowerShell and PowerShell 7. The app never
// changes or bypasses the execution policy itself. macOS and Linux keep the
// name as it is.

/** On Windows: the batch shim for a program whose PowerShell resolution is a
 *  script the default execution policy refuses to load. */
const WINDOWS_BATCH_SHIM: ReadonlyMap<string, string> = new Map([['npm', 'npm.cmd']])

/** `program` as a terminal's shell on `platform` (a Node platform name) is
 *  to be given it. */
export function shellProgram(program: string, platform: string | undefined): string {
  return platform === 'win32' ? (WINDOWS_BATCH_SHIM.get(program) ?? program) : program
}
