// HOST QUARANTINE: plants directory junctions, symbolic links and a hard link. [CI] [VM] only -- never run on the owner's machine.
// P3.10 (rows 43, 46, 47, 63), the link cases of hooks.test.ts, moved here
// whole so the host-safe file plants no link: the plain-path copy folder or
// its base standing as a link or junction is refused and never handed to the
// owner-only rule; a base replaced by a link to where it went is refused; a
// copy with a second name (a hard link) does not verify; a prepared root
// replaced by a link is not used and never handed to the rule; a folder
// replaced by a link while the rule runs is refused and nothing is made or
// written through it; a data folder reached through a link is the user's
// choice. The host-safe rest stays in hooks.test.ts.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  realFolderChainBelow,
  prepareCodexHookFolders,
  preparedCodexHookRoot,
  __resetCodexHookFoldersForTests,
  verifyPlainCodexHookWrapper,
  CODEX_HOOK_ROOT_NAME,
  CODEX_HOOK_PLAIN_BASE,
} from '../../../../src/main/providers/codex/hooks'

const TEST_PREFIX = 'p310-hooks-links-'
const made: string[] = []
const links: string[] = []
function tmp(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
/** A folder link: a junction on Windows (no special right needed), a symlink elsewhere. */
function folderLink(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(at)
}
afterEach(() => {
  __resetCodexHookFoldersForTests()
  // Links first, removed as links (never followed).
  for (const l of links.splice(0)) {
    try { if (fs.lstatSync(l).isSymbolicLink()) { try { fs.unlinkSync(l) } catch { fs.rmdirSync(l) } } } catch { /* gone */ }
  }
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(TEST_PREFIX) || path.dirname(d) !== fs.realpathSync.native(os.tmpdir())) continue
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** A folder's identity (its volume and inode number). */
const folderId = (d: string): string => { const st = fs.lstatSync(d, { bigint: true }); return `${st.dev}:${st.ino}` }

/** The empty folder at `dir` removed and made again: another folder on every
 *  file system. The new one is made beside it while it still exists (`fill`
 *  writes into it), then renamed into its place. Removing a folder and making
 *  it again at once is not enough: ext4 hands the freed inode number straight
 *  to the next folder, so on Linux it would carry the first one's identity. */
function makeFolderAgain(dir: string, fill?: (d: string) => void): void {
  const before = folderId(dir)
  const next = `${dir}.next`
  fs.mkdirSync(next)
  fill?.(next)
  fs.rmdirSync(dir)
  fs.renameSync(next, dir)
  expect(folderId(dir)).not.toBe(before)
}

/** The owner-only rule as the real one behaves for the folder order
 *  (src/main/owner-only-folders.ts): each folder in turn; a link is refused,
 *  and so is a folder below a refused one, or below an earlier folder of the
 *  call that is a link by now (a parent outside the call is the caller's
 *  choice, never inspected); a missing folder is made inside its parent;
 *  `ok` decides each verdict. `onEach` runs once a folder is there, before
 *  its verdict. Records every call. */
type Verdict = { dir: string; ok: boolean; detail: string }
function rule(ok: (dir: string) => boolean = () => true, onEach?: (dir: string) => void) {
  const calls: string[][] = []
  const secure = async (dirs: readonly string[]): Promise<Verdict[]> => {
    calls.push([...dirs])
    const refused = new Set<string>()
    const done = new Set<string>()
    const out: Verdict[] = []
    for (const dir of dirs) {
      const refuse = (detail: string): void => { refused.add(dir); out.push({ dir, ok: false, detail }) }
      const parent = path.dirname(dir)
      if (refused.has(parent)) { refuse('its parent was refused'); continue }
      if (done.has(parent) && fs.lstatSync(parent).isSymbolicLink()) { refuse('its parent is a link'); continue }
      let st: fs.Stats | null = null
      try { st = fs.lstatSync(dir) } catch { st = null }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) { refuse('a link'); continue }
      if (!st) fs.mkdirSync(dir)
      onEach?.(dir)
      if (ok(dir)) { done.add(dir); out.push({ dir, ok: true, detail: 'owner-only' }) }
      else refuse('not this user\'s alone')
    }
    return out
  }
  return { calls, secure }
}

describe('round 1 (V3): the plain-path copy for the npm shim route, with links', () => {
  function scripts(): string {
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.js'), '// forwarder')
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem wrapper')
    return path.join(res, 'scripts')
  }

  it('stages both files into real folders made the user\'s first, and they verify; a changed, replaced or extra-named copy does not', async () => {
    const src = scripts()
    const lad = tmp()
    const data = tmp()
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    const r = rule()
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(true)
    expect(fs.readFileSync(path.join(plain, 'ccc-codex-hook.cmd'), 'utf8')).toBe('rem wrapper')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    // Changed since it was staged.
    fs.writeFileSync(path.join(plain, 'ccc-codex-hook.js'), '// someone else')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    // Prepared again (the next launch): whole again.
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(true)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    expect(r.calls).toHaveLength(2)
    // A copy with a second name.
    fs.linkSync(path.join(plain, 'ccc-codex-hook.cmd'), path.join(lad, 'second-name.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
  })

  it('refuses a copy folder, or its base, that is a link or junction (never handed to the rule), and a rule that does not take', async () => {
    const src = scripts()
    const lad = tmp()
    const elsewhere = tmp()
    fs.mkdirSync(path.join(lad, CODEX_HOOK_PLAIN_BASE))
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    folderLink(elsewhere, plain)
    const r = rule()
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(false)
    expect(r.calls.flat()).not.toContain(plain)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.js'), path.join(elsewhere, 'ccc-codex-hook.js'))
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.cmd'), path.join(elsewhere, 'ccc-codex-hook.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    const lad2 = tmp()
    const base2 = tmp()
    folderLink(base2, path.join(lad2, CODEX_HOOK_PLAIN_BASE))
    const r2 = rule()
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: path.join(lad2, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345') }, r2.secure)).plain).toBe(false)
    expect(r2.calls.flat()).not.toContain(path.join(lad2, CODEX_HOOK_PLAIN_BASE))
    expect(fs.readdirSync(base2)).toEqual([])
    const lad3 = tmp()
    const plain3 = path.join(lad3, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain3 }, rule((d) => d !== plain3).secure)).plain).toBe(false)
    expect(verifyPlainCodexHookWrapper(src, plain3)).toBe(false)
  })

  it('round 4: the check covers both levels: a base folder replaced by a link to where it went is refused, though the copy folder below it is real', async () => {
    const src = scripts()
    const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain }, rule().secure)).plain).toBe(true)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    const base = path.dirname(plain)
    fs.renameSync(base, `${base}-moved`)
    folderLink(`${base}-moved`, base)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
  })
})

describe('round 4: preparing the hook folders, with links', () => {
  const scriptsDir = (): string => {
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.js'), '// forwarder')
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem wrapper')
    return path.join(res, 'scripts')
  }

  it('one preparation at a time; once ready a further one asks the rule nothing; a root made again in the run is prepared again', async () => {
    const data = tmp()
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    const src = scriptsDir()
    const plan = { dataDir: data, scriptsDir: src, plainDir: null }
    // Launches at the same moment share one attempt, refused or not.
    const no = rule(() => false)
    const refused = await Promise.all([prepareCodexHookFolders(plan, no.secure), prepareCodexHookFolders(plan, no.secure)])
    expect(refused.map((o) => o.root)).toEqual([false, false])
    expect(no.calls).toHaveLength(1)
    // Round 5 (G3): that failure would be remembered for a while; start afresh.
    __resetCodexHookFoldersForTests()
    const r = rule()
    const [a, b] = await Promise.all([prepareCodexHookFolders(plan, r.secure), prepareCodexHookFolders(plan, r.secure)])
    expect(a.root && b.root).toBe(true)
    expect(r.calls).toHaveLength(1)
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(true)
    expect(r.calls).toHaveLength(1)
    // Removed and made again: another folder, not ready until prepared again.
    makeFolderAgain(root)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(true)
    expect(r.calls).toHaveLength(2)
    expect(preparedCodexHookRoot(data)).toBe(root)
    // Replaced by a link: not used, and never handed to the rule.
    fs.rmdirSync(root)
    folderLink(tmp(), root)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(false)
    expect(r.calls).toHaveLength(2)
  })

  it('a folder replaced by a link while the rule runs is refused, and nothing is made or written through it', async () => {
    const src = scriptsDir()
    for (const level of ['root', 'base', 'copy'] as const) {
      __resetCodexHookFoldersForTests()
      const data = tmp()
      const elsewhere = tmp()
      const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
      const target = level === 'root' ? path.join(data, CODEX_HOOK_ROOT_NAME) : level === 'base' ? path.dirname(plain) : plain
      const r = rule(() => true, (dir) => {
        if (dir !== target) return
        fs.renameSync(target, `${target}-moved`)
        folderLink(elsewhere, target)
      })
      const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)
      if (level === 'root') expect(out.root, level).toBe(false)
      else expect(out.plain, level).toBe(false)
      expect(fs.readdirSync(elsewhere), level).toEqual([])
    }
  })

  it('a data folder reached through a link is the user\'s choice: its own real codex-hooks is used', async () => {
    const real = tmp()
    const viaLink = path.join(tmp(), 'data-link')
    folderLink(real, viaLink)
    expect((await prepareCodexHookFolders({ dataDir: viaLink, scriptsDir: scriptsDir(), plainDir: null }, rule().secure)).root).toBe(true)
    expect(preparedCodexHookRoot(viaLink)).toBe(path.join(viaLink, CODEX_HOOK_ROOT_NAME))
    expect(realFolderChainBelow(viaLink, path.join(viaLink, CODEX_HOOK_ROOT_NAME))).toBe(true)
  })
})
