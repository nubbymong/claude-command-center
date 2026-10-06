// A provider account's own memories on the Memory page (WP2 PR 4, P4.4, row
// 55): the listing, and the read and delete behind the existing memory
// channels. Beside memory-scanner.ts, which keeps Claude's one shared store.
//
// Codex keeps an account's memories in its folder's `memories/` (off by
// default; turned on in Codex with /memories). Codex itself makes that folder
// a git repository (PB6), so `.git` is never listed, read or deleted. The walk
// never follows a link or junction (each entry is looked at with lstat, and a
// link is skipped; each folder is at its own real path before it is listed,
// and each file before it is opened), lists only plain `.md` files with one
// name, and is bounded in depth, entries and files; a file whose path is longer
// than the memory channels take (memoryPathWithinBound) is left out. Each listed file's
// description is read from its first bytes, from a handle checked to be the
// file the walk saw. Without openat, what is left is a folder swapped for a
// link and back between those checks by someone who can write in the
// memories folder; the read and delete check every path again.
//
// Read and delete take the path the listing gave the renderer, and check it
// again against the memories folders main names now
// (validateAccountMemoryPath); the read then opens it without following a
// link and compares what it opened with what the check saw. Frontmatter edit
// does not carry over (Codex's files carry a heading, not frontmatter): the
// channel keeps refusing any path outside Claude's store.
import * as crypto from 'crypto'
import * as path from 'path'
import type { BigIntStats } from 'fs'
import { memoryPathWithinBound } from '../shared/account-memories'
import type { AccountMemories, AccountMemoryFile } from '../shared/account-memories'
import { readCheckedFile } from './account-folders'
import type { AccountFileFs, AccountFolderSet } from './account-folders'
import { AccountPathRefused, isGitSegment, pathInside, samePathForm, validateAccountMemoryPath, localPathFormProblem } from './utils/path-validator'
import { extractDescription, inferTypeFromFilename, parseFrontmatter } from './memory-scanner'

/** The walk's bounds. A folder past them is listed in part (`truncated`). */
export const ACCOUNT_MEMORY_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEntries: 5000,
  maxFiles: 500,
  /** Read for the description only. */
  descriptionBytes: 16 * 1024,
  /** A memory file opened in the reading drawer. */
  maxReadBytes: 1024 * 1024,
})

export interface AccountMemoryDeps {
  fs: AccountFileFs
  platform: NodeJS.Platform
}

const pathFor = (platform: NodeJS.Platform): typeof path => (platform === 'win32' ? path.win32 : path.posix)

function fileId(set: AccountFolderSet, rel: string): string {
  return crypto.createHash('sha256').update(`${set.providerId}:${set.accountId}/${rel}`).digest('hex').substring(0, 16)
}

/** One account's memories folder, walked. */
async function scanOne(set: AccountFolderSet, deps: AccountMemoryDeps): Promise<AccountMemories> {
  const base: AccountMemories = { providerId: set.providerId, accountId: set.accountId, external: set.external === true, state: 'unreadable', files: [], truncated: false }
  const p = pathFor(deps.platform)
  const root = set.memoriesDir
  if (localPathFormProblem(root, deps.platform)) return base
  let rootStat: BigIntStats
  try {
    rootStat = await deps.fs.lstat(root, { bigint: true })
  } catch (e) {
    return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? { ...base, state: 'none' } : base
  }
  // lstat looks at the last name itself: a link or junction there is not a
  // folder. Then the folder's real path must be its own (no link above it).
  if (!rootStat.isDirectory()) return base
  try {
    if (!samePathForm(await deps.fs.realpath(root), root, deps.platform)) return base
  } catch {
    return base
  }

  const L = ACCOUNT_MEMORY_LIMITS
  const found: Array<{ abs: string; rel: string; st: BigIntStats }> = []
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }]
  let entries = 0
  let truncated = false
  let stop = false
  /** The folder is still at its own real path: no folder on the way swapped
   *  for a link since the walk looked at it. */
  const stillOwn = async (abs: string): Promise<boolean> => {
    try { return samePathForm(await deps.fs.realpath(abs), abs, deps.platform) } catch { return false }
  }
  while (queue.length > 0 && !stop) {
    const dir = queue.shift()!
    let names: string[]
    try {
      if (dir.depth > 0 && !(await stillOwn(dir.abs))) continue
      names = await deps.fs.readdir(dir.abs)
    } catch {
      continue
    }
    names.sort()
    for (const name of names) {
      if (++entries > L.maxEntries) { stop = true; break }
      if (isGitSegment(name)) continue
      const abs = p.join(dir.abs, name)
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`
      let st: BigIntStats
      try {
        st = await deps.fs.lstat(abs, { bigint: true })
      } catch {
        continue
      }
      // A link or junction is neither a folder nor a plain file to lstat:
      // never followed, never listed.
      if (st.isDirectory()) {
        if (dir.depth + 1 < L.maxDepth) queue.push({ abs, rel, depth: dir.depth + 1 })
        else truncated = true
        continue
      }
      if (!st.isFile() || st.nlink !== 1n || !/\.md$/i.test(name)) continue
      // A path the memory channels would refuse is never listed: the folder
      // then reads as listed in part.
      if (!memoryPathWithinBound(abs)) { truncated = true; continue }
      if (found.length >= L.maxFiles) { stop = true; break }
      found.push({ abs, rel, st })
    }
  }
  if (stop || queue.length > 0) truncated = true

  const files: AccountMemoryFile[] = []
  for (const f of found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    let head = ''
    try {
      // At its own real path (no folder on the way swapped for a link since
      // the walk), and the file the walk saw.
      if (!samePathForm(await deps.fs.realpath(f.abs), f.abs, deps.platform)) continue
      head = await readCheckedFile(f.abs, L.descriptionBytes, deps.fs, { expect: { dev: f.st.dev, ino: f.st.ino } })
    } catch {
      continue
    }
    const filename = p.basename(f.abs)
    const { fields, body, hasFrontmatter } = parseFrontmatter(head)
    files.push({
      id: fileId(set, f.rel),
      name: filename.replace(/\.md$/i, ''),
      filename: f.rel,
      project: '',
      projectDir: `account:${set.accountId}`,
      type: inferTypeFromFilename(filename),
      description: (typeof fields.description === 'string' && fields.description) || extractDescription(body),
      size: Number(f.st.size),
      modified: Number(f.st.mtimeMs),
      hasFrontmatter,
      path: f.abs,
      providerId: set.providerId,
      accountId: set.accountId,
      relPath: f.rel,
    })
  }
  return { ...base, state: 'present', files, truncated }
}

/** memory:scan's account part: each account's memories, in the order the
 *  accounts came. An account that cannot be walked reads `unreadable`; one
 *  failing never hides the others. */
export async function scanAccountMemories(sets: readonly AccountFolderSet[] | null, deps: AccountMemoryDeps): Promise<AccountMemories[]> {
  const out: AccountMemories[] = []
  for (const set of sets ?? []) {
    if (!set || typeof set.accountId !== 'string' || out.some((o) => o.accountId === set.accountId)) continue
    try {
      out.push(await scanOne(set, deps))
    } catch {
      out.push({ providerId: set.providerId, accountId: set.accountId, external: set.external === true, state: 'unreadable', files: [], truncated: false })
    }
  }
  return out
}

const rootsOf = (sets: readonly AccountFolderSet[] | null): string[] => (sets ?? []).map((s) => s.memoriesDir).filter((r) => typeof r === 'string' && r !== '')

/** True when `filePath` is, by its spelling, inside one of the accounts'
 *  memories folders (pathInside, the guard's own rule): which channel branch
 *  checks it. The check itself is validateAccountMemoryPath. */
export function isUnderAccountMemories(filePath: string, sets: readonly AccountFolderSet[] | null, platform: NodeJS.Platform): boolean {
  if (typeof filePath !== 'string' || localPathFormProblem(filePath, platform)) return false
  return rootsOf(sets).some((r) => pathInside(r, filePath, platform) !== null)
}

/** memory:read for an account's memory file. */
export async function readAccountMemory(filePath: unknown, sets: readonly AccountFolderSet[] | null, deps: AccountMemoryDeps): Promise<string> {
  const t = await validateAccountMemoryPath(filePath, rootsOf(sets), { platform: deps.platform, fs: deps.fs })
  return readCheckedFile(t.path, ACCOUNT_MEMORY_LIMITS.maxReadBytes, deps.fs, { expect: { dev: t.dev, ino: t.ino }, whole: true })
}

/** memory:delete for an account's memory file: checked as a read is, then
 *  looked at once more right before the unlink; never inside `.git`. */
export async function deleteAccountMemory(filePath: unknown, sets: readonly AccountFolderSet[] | null, deps: AccountMemoryDeps): Promise<void> {
  const t = await validateAccountMemoryPath(filePath, rootsOf(sets), { destructive: true, platform: deps.platform, fs: deps.fs })
  const again = await deps.fs.lstat(t.path, { bigint: true })
  if (again.dev !== t.dev || again.ino !== t.ino) {
    throw new AccountPathRefused('refused', 'the file changed')
  }
  await deps.fs.unlink(t.path)
}
