#!/usr/bin/env node
/**
 * Dev preflight: make sure Electron's own binary is actually there (#226).
 *
 * A worktree can look completely installed while the one file that matters is
 * missing. `node_modules/electron/` exists, `package.json` is satisfied and
 * `npm ls` is clean, but `node_modules/electron/path.txt` and the binary it
 * names are absent -- because the repo's `postinstall` is
 * `electron-rebuild --only=node-pty,better-sqlite3`, which rebuilds the two
 * native addons and does nothing about Electron itself. That download is the
 * `electron` package's OWN install script, and when it does not run (or does
 * not finish) nothing notices.
 *
 * What the operator sees instead is `Error: Electron uninstall` thrown from
 * inside electron-vite, in a launcher window that closes the instant the
 * command dies, with the real message only in `dev-logs/ccc-dev-*.log`. That
 * has cost three separate debugging sessions across two worktrees, none of them
 * about the code under test.
 *
 * Runs as `predev`, so `npm run dev` and the `ccc` launcher (which shells out to
 * `npm run dev`) both get it without either having to remember. It is two stat
 * calls when the tree is healthy.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Is Electron's binary present and resolvable?
 *
 * Mirrors how electron-vite resolves it: read `path.txt`, which holds a path
 * RELATIVE to the electron package, and check the file it names. Both halves
 * matter -- `path.txt` present with the binary missing is the exact state that
 * fails, and it is the state a half-finished install leaves behind.
 *
 * Pure and injectable so the failure modes can be tested without breaking a
 * real node_modules tree.
 */
export function checkElectron(root = REPO_ROOT, fs = { existsSync, readFileSync }) {
  const pkgDir = path.join(root, 'node_modules', 'electron')
  if (!fs.existsSync(pkgDir)) {
    return { ok: false, reason: 'missing-package', detail: pkgDir }
  }
  const pathTxt = path.join(pkgDir, 'path.txt')
  if (!fs.existsSync(pathTxt)) {
    return { ok: false, reason: 'missing-path-txt', detail: pathTxt }
  }
  let rel
  try {
    rel = String(fs.readFileSync(pathTxt, 'utf8')).trim()
  } catch {
    return { ok: false, reason: 'unreadable-path-txt', detail: pathTxt }
  }
  if (!rel) return { ok: false, reason: 'empty-path-txt', detail: pathTxt }

  const binary = path.join(pkgDir, 'dist', rel)
  if (!fs.existsSync(binary)) {
    return { ok: false, reason: 'missing-binary', detail: binary }
  }
  return { ok: true, binary }
}

/** The heal step is the same one that fixed it by hand, both times. */
function heal() {
  const installer = path.join(REPO_ROOT, 'node_modules', 'electron', 'install.js')
  if (!existsSync(installer)) return false
  process.stdout.write('[preflight] Electron binary missing — running its install script...\n')
  try {
    execFileSync(process.execPath, [installer], { cwd: REPO_ROOT, stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

function main() {
  const first = checkElectron()
  if (first.ok) return

  // A missing PACKAGE is not ours to fix: running install.js cannot conjure one,
  // and silently reaching for `npm install` here is the very thing that breaks
  // these trees (see AGENTS.md).
  if (first.reason === 'missing-package') {
    process.stderr.write(
      `[preflight] node_modules/electron is missing (${first.detail}).\n` +
      '[preflight] This worktree was never installed. Run `npm ci` here — NOT `npm install`.\n',
    )
    process.exit(1)
  }

  if (heal()) {
    const after = checkElectron()
    if (after.ok) {
      process.stdout.write(`[preflight] Electron restored: ${after.binary}\n`)
      return
    }
  }

  process.stderr.write(
    `[preflight] Electron's binary is still missing after re-running its installer (${first.reason}: ${first.detail}).\n` +
    '[preflight] Without it electron-vite fails with an opaque "Error: Electron uninstall" and no window opens.\n' +
    '[preflight] Fix: `npm ci` in THIS worktree, then `node node_modules/electron/install.js`.\n',
  )
  process.exit(1)
}

// Only act when run directly; importing this for a test must have no effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
