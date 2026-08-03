/**
 * #174 -- the private staging directory an installer is downloaded into.
 *
 * Deliberately NOT mocking `fs`. The properties that matter here are properties
 * of the real filesystem: that mkdtemp gives an unpredictable name, that 0700
 * actually lands on POSIX, and that pruning removes what it should and nothing
 * else. A mocked `fs` would only prove the code calls the functions the test
 * expects it to call, which is the same test written twice.
 *
 * The sibling suite in tests/unit/github-update.test.ts drives these through
 * `downloadInstallerFile` with the network mocked; this one checks the
 * primitives against a real directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// installerRoot() derives the staging root from the app's own data directory,
// which is what keeps it off %APPDATA% (roaming) and out of a shared /tmp, and
// what makes a dev instance stage inside its own data root. Point it at a
// scratch dir so the real thing can be exercised end to end.
const dataDir = vi.hoisted(() => ({ path: '' }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => dataDir.path,
}))

import { createInstallerDir, pruneStaleInstallerDirs, assertPrivateDir, installerRoot } from '../../../src/main/github-update'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-staging-test-'))
  dataDir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-datadir-test-'))
})

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  try { fs.rmSync(dataDir.path, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** A symlink where allowed, otherwise a Windows junction (no admin needed). */
function linkDir(from: string, to: string): boolean {
  for (const type of ['junction', 'dir'] as const) {
    try { fs.symlinkSync(to, from, type); return true } catch { /* try the next */ }
  }
  return false
}

describe('installerRoot — the parent of the staging directory', () => {
  it('creates <dataDir>/updates and returns it', () => {
    const r = installerRoot()
    expect(path.resolve(r)).toBe(path.resolve(path.join(dataDir.path, 'updates')))
    expect(fs.statSync(r).isDirectory()).toBe(true)
  })

  it('is derived from the app data dir, so it never lands in a roaming profile or a shared /tmp', () => {
    // Pinning the BASE, not just the suffix. Electron's userData is %APPDATA%
    // on Windows, which roams — staging 200 MB there syncs it to a file share
    // at sign-out. getDataDirectory() uses %LOCALAPPDATA% and honours
    // CCC_DEV_DATA_DIR, which is why it is the base.
    const r = installerRoot().replace(/\\/g, '/')
    expect(r.startsWith(dataDir.path.replace(/\\/g, '/'))).toBe(true)
    expect(r).not.toContain(os.tmpdir().replace(/\\/g, '/') + '/updates')
  })

  it('REFUSES a pre-planted link at <dataDir>/updates', () => {
    // The attack this guard exists for. mkdirSync(..., {recursive: true})
    // swallows EEXIST, so without the check a link planted once redirects every
    // future staged installer into a directory the planter controls — and the
    // parent is what they need to rename the 0700 leaf away and substitute
    // their own payload. No admin required for a junction on Windows.
    const attacker = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-attacker-'))
    if (!linkDir(path.join(dataDir.path, 'updates'), attacker)) return
    try {
      expect(() => installerRoot()).toThrow(/not a directory|redirected/i)
    } finally {
      fs.rmSync(attacker, { recursive: true, force: true })
    }
  })

  it('REFUSES a file where the staging root should be, instead of falling back', () => {
    // There is deliberately no fallback chain: every candidate a fallback could
    // reach is shared (/tmp) or roaming (%APPDATA%), so "try the next one" means
    // silently downgrading to the state this change exists to leave.
    fs.writeFileSync(path.join(dataDir.path, 'updates'), 'not a directory')
    expect(() => installerRoot()).toThrow()
  })
})

describe('assertPrivateDir', () => {
  it('accepts a normal owner-only directory', () => {
    expect(() => assertPrivateDir(createInstallerDir(root))).not.toThrow()
  })

  it('rejects a symlink or junction', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-target-'))
    const link = path.join(root, 'linked')
    if (!linkDir(link, target)) return
    try {
      expect(() => assertPrivateDir(link)).toThrow(/not a directory|redirected/i)
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it('rejects a group- or world-writable directory on POSIX', () => {
    if (process.platform === 'win32') return
    const loose = path.join(root, 'loose')
    fs.mkdirSync(loose, { recursive: true })
    fs.chmodSync(loose, 0o777)
    expect(() => assertPrivateDir(loose)).toThrow(/writable/i)
  })

  it('tolerates a legitimate symlink higher up the path', () => {
    // macOS resolves /var -> /private/var, and os.tmpdir() often sits under it.
    // Only the FINAL component is checked, so a real deployment does not fail.
    const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realparent-'))
    const linkedParent = path.join(root, 'linked-parent')
    if (!linkDir(linkedParent, realParent)) return
    const inner = path.join(linkedParent, 'updates')
    fs.mkdirSync(inner, { recursive: true })
    try {
      expect(() => assertPrivateDir(inner)).not.toThrow()
    } finally {
      fs.rmSync(realParent, { recursive: true, force: true })
    }
  })
})

describe('createInstallerDir', () => {
  it('creates a real directory under the given root', () => {
    const dir = createInstallerDir(root)
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(path.dirname(dir)).toBe(root)
  })

  it('uses the ccc-upd- prefix so pruning can recognise it', () => {
    // pruneStaleInstallerDirs matches on this prefix. If the two ever disagree,
    // staging dirs accumulate forever and nothing fails.
    expect(path.basename(createInstallerDir(root)).startsWith('ccc-upd-')).toBe(true)
  })

  it('gives an UNPREDICTABLE name each time', () => {
    // The security property. The asset name is public in the release feed, so a
    // fixed directory would put the installer back at a guessable path and hand
    // the verify->spawn race straight back to a local attacker.
    const names = new Set(Array.from({ length: 20 }, () => path.basename(createInstallerDir(root))))
    expect(names.size).toBe(20)
    // And the suffix is not a counter or a timestamp anyone can compute.
    for (const n of names) expect(n).toMatch(/^ccc-upd-[A-Za-z0-9]{6,}$/)
  })

  it('is owner-only on POSIX', () => {
    // Windows has no mode bits to assert; the userData tree is already
    // per-user there and chmod is a documented no-op.
    if (process.platform === 'win32') return
    const dir = createInstallerDir(root)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('throws rather than falling back to a shared directory when the root is unusable', () => {
    // Fail closed. Silently degrading to a world-writable location is the exact
    // state this change exists to leave.
    expect(() => createInstallerDir(path.join(root, 'does', 'not', 'exist'))).toThrow()
  })
})

describe('pruneStaleInstallerDirs — hostile entries', () => {
  it('unlinks a ccc-upd- link instead of deleting through it', () => {
    // This function is a recursive delete driven by readdir of a directory the
    // attacker can write to. A `ccc-upd-evil` link pointing at $HOME must cost
    // the link, not the home directory. Node's rimraf happens to lstat first,
    // but that is an implementation detail — the guard is explicit in the code
    // and this is what pins it.
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-victim-'))
    fs.writeFileSync(path.join(victim, 'precious.txt'), 'do not delete me')
    const link = path.join(root, 'ccc-upd-evil')
    if (!linkDir(link, victim)) return // platform denies both primitives
    try {
      expect(pruneStaleInstallerDirs(root)).toBe(1)
      expect(fs.existsSync(link)).toBe(false)
      expect(fs.existsSync(path.join(victim, 'precious.txt'))).toBe(true)
    } finally {
      fs.rmSync(victim, { recursive: true, force: true })
    }
  })

  it('does not throw when an entry cannot be removed', () => {
    // The call site is NOT wrapped in a try/catch, so a throw here would abort
    // the whole update over a tidy-up -- turning "a leftover directory" into
    // "the update fails". Production hits this whenever a previous installer is
    // still running and Windows holds the lock.
    const doomed = createInstallerDir(root)
    fs.writeFileSync(path.join(doomed, 'locked.bin'), 'x')
    const cwd = process.cwd()
    if (process.platform === 'win32') {
      // Windows refuses to remove a directory that is a process's CWD (EBUSY) —
      // deterministic, and no ACL surgery needed.
      process.chdir(doomed)
    } else {
      fs.chmodSync(root, 0o500) // no write on the parent -> unlink denied
    }
    try {
      expect(() => pruneStaleInstallerDirs(root)).not.toThrow()
      // ...and it did not silently succeed either, which would make the test
      // pass for the wrong reason.
      expect(fs.existsSync(doomed)).toBe(true)
    } finally {
      if (process.platform === 'win32') process.chdir(cwd)
      else fs.chmodSync(root, 0o700)
    }
  })
})

describe('pruneStaleInstallerDirs', () => {
  it('removes staging directories from earlier updates', () => {
    const a = createInstallerDir(root)
    const b = createInstallerDir(root)
    expect(pruneStaleInstallerDirs(root)).toBe(2)
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
  })

  it('keeps the directory the current download is using', () => {
    // The success path cannot clean up after itself -- CCC spawns the installer
    // and exits -- so deleting the live one here would delete the installer out
    // from under the update.
    const old = createInstallerDir(root)
    const live = createInstallerDir(root)
    fs.writeFileSync(path.join(live, 'installer.exe'), 'bytes')
    expect(pruneStaleInstallerDirs(root, live)).toBe(1)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(path.join(live, 'installer.exe'))).toBe(true)
  })

  it('touches nothing that is not a staging directory', () => {
    const keepFile = path.join(root, 'unrelated.txt')
    const keepDir = path.join(root, 'some-other-dir')
    fs.writeFileSync(keepFile, 'x')
    fs.mkdirSync(keepDir)
    createInstallerDir(root)
    expect(pruneStaleInstallerDirs(root)).toBe(1)
    expect(fs.existsSync(keepFile)).toBe(true)
    expect(fs.existsSync(keepDir)).toBe(true)
  })

  it('does not match a directory that merely contains the prefix', () => {
    const decoy = path.join(root, 'not-ccc-upd-anything')
    fs.mkdirSync(decoy)
    expect(pruneStaleInstallerDirs(root)).toBe(0)
    expect(fs.existsSync(decoy)).toBe(true)
  })

  it('returns 0 for a root that does not exist instead of throwing', () => {
    // Runs on the download path, where an unreadable root must not abort the
    // update -- a leftover directory is untidy, never unsafe.
    expect(pruneStaleInstallerDirs(path.join(root, 'nope'))).toBe(0)
  })

  it('recurses into a populated staging directory', () => {
    const dir = createInstallerDir(root)
    fs.mkdirSync(path.join(dir, 'nested'))
    fs.writeFileSync(path.join(dir, 'nested', 'big.exe'), 'bytes')
    expect(pruneStaleInstallerDirs(root)).toBe(1)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
