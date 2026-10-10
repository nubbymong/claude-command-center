// A stand-in Claude Code that the Windows launch's PATH walk really finds.
//
// On Windows a Claude launch names Claude Code by the full path it finds in a
// fully qualified folder PATH names (claude.exe in any of them, then
// claude.cmd, then claude.bat), and starts nothing when there is none:
// resolveClaudeBinary (src/main/providers/claude/spawn.ts) throws
// CLAUDE_NOT_ON_PATH. A suite that drives a Claude spawn with node-pty faked
// still needs that lookup to answer, on a machine with no Claude Code too (the
// Windows CI runner).
//
// This puts an EMPTY claude.exe in a new folder under the test temp root and
// names that folder FIRST on PATH, so the walk finds it before any Claude Code
// the machine has installed: a suite never picks up a real CLI. An empty file
// cannot start, so whatever asks the found program for its version starts no
// process. On Linux and macOS the launch names `claude` for the login shell to
// find and asks no PATH walk: nothing is done there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'ccc-vitest-fake-cli-'

export interface FakeClaudeOnPath {
  /** The stand-in's full path (Windows), or null where no walk is asked. */
  claude: string | null
  /** PATH as it was, and the folder removed. */
  restore(): void
}

export function putFakeClaudeOnPath(): FakeClaudeOnPath {
  if (process.platform !== 'win32') return { claude: null, restore() {} }
  // The folder name carries no "claude": a write that names the folder is
  // never mistaken for the launch line by a suite that looks for that word.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const claude = path.join(dir, 'claude.exe')
  fs.writeFileSync(claude, '')
  const saved = process.env.PATH
  process.env.PATH = saved ? `${dir};${saved}` : dir
  return {
    claude,
    restore() {
      if (saved === undefined) delete process.env.PATH
      else process.env.PATH = saved
      // TEST CLEANUP GUARD: this helper's own temp folder only.
      if (path.basename(dir).startsWith(PREFIX)) fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
