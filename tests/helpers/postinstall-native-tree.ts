// A fake package tree and a recording process runner for scripts/postinstall-native.mjs
// main() (its `root` and `run`). The tree is files under the worker's temp root holding
// only the names asked for; the runner records each start and answers with a status.
// Nothing is built, spawned or installed. Shared by tests/unit/scripts/postinstall-native.test.ts
// and tests/unit/main/bundled-conpty.test.ts.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** A temp folder holding exactly `present` (paths relative to it, forward slashes). */
export function fakeNativeTree(present: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-tree-'))
  for (const f of present) {
    const p = path.join(root, ...f.split('/'))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'fake')
  }
  return root
}

export type RunCall = { cmd: string; args: string[]; cwd: string | undefined }

/**
 * A stand-in for spawnSync that records each call. A call whose first argument
 * is node-pty's post-install.js answers `post`; any other answers `rebuild`
 * (null is a process that did not exit normally).
 */
export function recordingRunner(statuses: { rebuild?: number | null; post?: number | null } = {}) {
  const calls: RunCall[] = []
  const status = (k: 'rebuild' | 'post'): number | null => (k in statuses ? (statuses[k] as number | null) : 0)
  const run = (cmd: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    return { status: /post-install\.js$/.test(String(args[0])) ? status('post') : status('rebuild') }
  }
  return { run, calls }
}

/** Where main() finds node-pty's post-install step and @electron/rebuild's CLI under `root`. */
export const postInstallPath = (root: string) => path.join(root, 'node_modules', 'node-pty', 'scripts', 'post-install.js')
export const rebuildCliPath = (root: string) => path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js')
