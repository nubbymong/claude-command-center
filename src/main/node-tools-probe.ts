// Whether Node.js and npm are where an install tab's npm line would find them
// (owner decision D3, 2026-10-10). An npm install needs Node.js; when it is
// not found, the setup pages and Settings say so beside the npm command and
// offer only Copy for it, until a check finds it.
//
// Nothing is started for this check beyond what the CLI checks already start:
//   - Windows: the two programs the tab's line runs, npm.cmd (PowerShell would
//     load npm.ps1 for a bare npm) and node.exe (which npm.cmd starts), each in
//     a folder PATH names in full, as the install tab looks them up. No
//     process. Before a check the user asked for, the PATH has been brought up
//     to date from the registry (windows-path-refresh.ts), so a Node.js
//     installed while the app was open is found.
//   - macOS and Linux: npm and node in the PATH the user's login shell builds,
//     which the tab's login shell builds too (login-shell.ts, its existing
//     process), else in the absolute folders of this process's PATH.
import { findOnWindowsPathAsync } from './windows-programs'
import { absolutePosixPathEntries, defaultLoginShell, findOnPosixPathAsync, loginShellPathAsync } from './login-shell'

export interface NodeToolsDeps {
  platform: string
  env: NodeJS.ProcessEnv
  /** Windows: whether this is a file (the PATH walk's check). */
  isFile?: (path: string) => Promise<boolean>
  /** macOS and Linux: the PATH the login shell builds, or null. */
  loginShellPath?: (env: NodeJS.ProcessEnv, platform: string) => Promise<string | null>
  /** macOS and Linux: whether this is a file that can run. */
  runnable?: (path: string) => Promise<boolean>
}

const WINDOWS_TOOLS = ['npm.cmd', 'node.exe'] as const
const POSIX_TOOLS = ['npm', 'node'] as const

const loginShellPathOf = (env: NodeJS.ProcessEnv, platform: string) =>
  loginShellPathAsync(defaultLoginShell(env, platform as NodeJS.Platform), env)

/** Both programs found, as the install tab would find them. */
export async function nodeToolsFoundWith(deps: NodeToolsDeps): Promise<boolean> {
  if (deps.platform === 'win32') {
    for (const name of WINDOWS_TOOLS) {
      if ((await findOnWindowsPathAsync([name], deps.env, deps.isFile)) === null) return false
    }
    return true
  }
  const shellPath = await (deps.loginShellPath ?? loginShellPathOf)(deps.env, deps.platform)
  const pathValue = shellPath ?? absolutePosixPathEntries(deps.env.PATH ?? '') ?? ''
  for (const name of POSIX_TOOLS) {
    if ((await findOnPosixPathAsync(name, pathValue, deps.runnable)) === null) return false
  }
  return true
}

/** One check at a time: callers that ask while one runs share its answer,
 *  and the next call after it settles checks again (nothing is kept). */
export function createNodeToolsCheck(depsOf: () => NodeToolsDeps): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null
  return () => {
    if (inFlight) return inFlight
    const run = nodeToolsFoundWith(depsOf()).finally(() => { inFlight = null })
    inFlight = run
    return run
  }
}

/** This computer's answer, for the accounts service (provider-accounts.ts). */
export const nodeToolsFound = createNodeToolsCheck(() => ({ platform: process.platform, env: process.env }))
