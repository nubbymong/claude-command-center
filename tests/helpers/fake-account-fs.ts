// An in-memory file system for the account-folder checks (WP2 PR 4, P4.4):
// folders, files and links with a device, a file id and a link count, in
// Windows or POSIX path form, whatever the host. It answers only the calls
// AccountFileFs makes (lstat and fstat as bigint stats, realpath, readdir,
// open, unlink), counting each, so a test can prove a path was refused before
// any file call. No real file is touched.
import path from 'node:path'
import type { BigIntStats } from 'node:fs'

type Node =
  | { kind: 'dir'; ino: bigint; nlink: bigint }
  | { kind: 'file'; ino: bigint; nlink: bigint; data: Buffer; mtimeMs: number }
  | { kind: 'link'; ino: bigint; nlink: bigint; target: string }

export interface FakeFsCalls { lstat: string[]; realpath: string[]; readdir: string[]; open: string[]; unlink: string[] }

const enoent = (p: string): NodeJS.ErrnoException => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
const eloop = (p: string): NodeJS.ErrnoException => Object.assign(new Error(`ELOOP: ${p}`), { code: 'ELOOP' })

export const O_NOFOLLOW_FAKE = 0x20000

export function createFakeAccountFs(platform: 'win32' | 'linux' = 'linux') {
  const p = platform === 'win32' ? path.win32 : path.posix
  const key = (x: string): string => {
    const n = p.resolve(x)
    return platform === 'win32' ? n.toLowerCase() : n
  }
  const nodes = new Map<string, Node>()
  const display = new Map<string, string>()
  let nextIno = 100n
  const calls: FakeFsCalls = { lstat: [], realpath: [], readdir: [], open: [], unlink: [] }

  const put = (x: string, node: Node): void => {
    const full = p.resolve(x)
    // Parents are folders.
    const parent = p.dirname(full)
    if (parent !== full && !nodes.has(key(parent))) mkdir(parent)
    nodes.set(key(full), node)
    display.set(key(full), full)
  }
  function mkdir(x: string): void { put(x, { kind: 'dir', ino: nextIno++, nlink: 1n }) }
  function writeFile(x: string, content: string | Buffer, opts: { mtimeMs?: number; nlink?: number } = {}): void {
    put(x, { kind: 'file', ino: nextIno++, nlink: BigInt(opts.nlink ?? 1), data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), mtimeMs: opts.mtimeMs ?? 1_700_000_000_000 })
  }
  function symlink(target: string, x: string): void { put(x, { kind: 'link', ino: nextIno++, nlink: 1n, target: p.resolve(target) }) }
  function remove(x: string): void { nodes.delete(key(x)) }

  /** Every segment resolved through links; ENOENT when something is missing. */
  function resolveReal(x: string, depth = 0): string {
    if (depth > 20) throw eloop(x)
    const full = p.resolve(x)
    const root = p.parse(full).root
    const segs = full.slice(root.length).split(p.sep).filter(Boolean)
    let cur = root
    for (const s of segs) {
      const next = p.join(cur, s)
      const n = nodes.get(key(next))
      if (!n) throw enoent(next)
      if (n.kind === 'link') cur = resolveReal(n.target, depth + 1)
      else cur = display.get(key(next)) ?? next
    }
    return cur
  }

  function stats(n: Node): BigIntStats {
    const size = n.kind === 'file' ? BigInt(n.data.length) : 0n
    const mtimeMs = n.kind === 'file' ? BigInt(Math.trunc(n.mtimeMs)) : 0n
    return {
      isFile: () => n.kind === 'file',
      isDirectory: () => n.kind === 'dir',
      isSymbolicLink: () => n.kind === 'link',
      dev: 7n, ino: n.ino, nlink: n.nlink, size, mtimeMs,
    } as unknown as BigIntStats
  }

  const api = {
    calls,
    platform,
    mkdir, writeFile, symlink, remove,
    async lstat(x: string, _opts: { bigint: true }): Promise<BigIntStats> {
      calls.lstat.push(x)
      const full = p.resolve(x)
      // The parent chain is followed, the last segment is not.
      const parent = p.dirname(full)
      const realParent = parent === full ? parent : resolveReal(parent)
      const n = nodes.get(key(p.join(realParent, p.basename(full))))
      if (!n) throw enoent(x)
      return stats(n)
    },
    async realpath(x: string): Promise<string> {
      calls.realpath.push(x)
      return resolveReal(x)
    },
    async readdir(x: string): Promise<string[]> {
      calls.readdir.push(x)
      const real = resolveReal(x)
      const n = nodes.get(key(real))
      if (!n) throw enoent(x)
      if (n.kind !== 'dir') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
      const prefix = key(real) + (key(real).endsWith(p.sep) ? '' : p.sep)
      const out: string[] = []
      for (const [k, v] of display) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes(p.sep) && k !== key(real)) out.push(p.basename(v))
      }
      return out.sort()
    },
    async open(x: string, flags: number) {
      calls.open.push(x)
      const full = p.resolve(x)
      const realParent = resolveReal(p.dirname(full))
      let n = nodes.get(key(p.join(realParent, p.basename(full))))
      if (!n) throw enoent(x)
      if (n.kind === 'link') {
        if (flags & O_NOFOLLOW_FAKE) throw eloop(x)
        n = nodes.get(key(resolveReal(full)))
        if (!n) throw enoent(x)
      }
      const node = n
      return {
        stat: async (_o: { bigint: true }) => stats(node),
        read: async (buf: Buffer, off: number, len: number, pos: number) => {
          if (node.kind !== 'file') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
          const n2 = node.data.copy(buf, off, pos, Math.min(node.data.length, pos + len))
          return { bytesRead: n2, buffer: buf }
        },
        close: async () => {},
      }
    },
    async unlink(x: string): Promise<void> {
      calls.unlink.push(x)
      const full = p.resolve(x)
      const realParent = resolveReal(p.dirname(full))
      const k = key(p.join(realParent, p.basename(full)))
      const n = nodes.get(k)
      if (!n) throw enoent(x)
      if (n.kind === 'dir') throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      nodes.delete(k)
      display.delete(k)
    },
    constants: { O_RDONLY: 0, O_NOFOLLOW: O_NOFOLLOW_FAKE, O_NONBLOCK: 0 },
    exists(x: string): boolean { return nodes.has(key(x)) },
    fileCalls(): number { return calls.lstat.length + calls.realpath.length + calls.readdir.length + calls.open.length + calls.unlink.length },
  }
  return api
}

export type FakeAccountFs = ReturnType<typeof createFakeAccountFs>
