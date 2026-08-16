// readCheckedFile — the read primitive behind every canvas file read
// (BLOCKER 1 item 7, adversarial review 2026-08-15).
//
// The check it replaces was `statSync(real)` followed by a separate
// `readFileSync(real)` — one path resolved TWICE, so the checks described one
// object and the bytes could come from another — plus a link test written
// `typeof st.nlink === 'number' && st.nlink !== 1`, which silently skipped
// itself on any volume that does not report link counts.
//
// Both of those are properties of HOW the read is performed, so proving them
// needs the fs module instrumented. That has to be a module mock, and a module
// mock has to be the whole file — hence a suite of its own. The mock is a
// PASSTHROUGH: every call reaches the real filesystem, it is only observed (and,
// for the fail-closed case, one field of one result is masked).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as realFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Set by a test to mask `nlink` on the next fstat results. */
let hideNlink = false
const opened: number[] = []
const readSyncCalls: unknown[][] = []
const readFileSyncCalls: unknown[][] = []

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const wrapped = {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      opened.push(fd)
      return fd
    },
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const st = actual.fstatSync(...(args as [number]))
      if (!hideNlink) return st
      // A volume that reports no link count. The Proxy keeps every other field
      // and every method (isFile) intact, so ONLY the count is missing.
      return new Proxy(st, { get: (t, p) => (p === 'nlink' ? undefined : Reflect.get(t, p, t)) })
    }) as typeof actual.fstatSync,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      readSyncCalls.push(args as unknown[])
      return actual.readSync(...(args as Parameters<typeof actual.readSync>))
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncCalls.push(args as unknown[])
      return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>))
    },
  }
  return { ...wrapped, default: wrapped }
})

const { readCheckedFile } = await import('../../../src/main/utils/safe-file-read')

const SECRET = 'sk-ant-oat01-THE-OAUTH-TOKEN'
const tempDirs: string[] = []

function tmp(prefix: string): string {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Create a hard link and PROVE it is one — a run whose filesystem quietly
 *  copied instead would certify a guard it never exercised. */
function hardLink(target: string, link: string): void {
  realFs.linkSync(target, link)
  expect(realFs.statSync(link).nlink, 'precondition: the runner must support hard links').toBe(2)
}

beforeEach(() => {
  hideNlink = false
  opened.length = 0
  readSyncCalls.length = 0
  readFileSyncCalls.length = 0
})

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('readCheckedFile', () => {
  it('reads an ordinary single-named file', () => {
    const file = path.join(tmp('ccc-read-ok-'), 'doc.html')
    realFs.writeFileSync(file, '<p>hello</p>')
    expect(readCheckedFile(file, 1024).toString('utf8')).toBe('<p>hello</p>')
  })

  it('reads a file whose size needs more than one readSync pass', () => {
    // The loop, not just the happy one-shot: a short read must resume at the
    // right offset rather than truncate or repeat.
    const file = path.join(tmp('ccc-read-big-'), 'doc.html')
    const body = 'abcdefghij'.repeat(20000) // 200 KB
    realFs.writeFileSync(file, body)
    expect(readCheckedFile(file, 1024 * 1024).toString('utf8')).toBe(body)
  })

  it('refuses a file that has a second name', () => {
    const dir = tmp('ccc-read-link-')
    const victim = path.join(dir, 'id_rsa')
    realFs.writeFileSync(victim, 'PRIVATE-KEY-BYTES')
    const link = path.join(dir, 'mockup.html')
    hardLink(victim, link)
    expect(() => readCheckedFile(link, 1024)).toThrow(/not a regular file/i)
  })

  it('refuses hardlink-then-delete-then-restore, the COMPLETE attack', () => {
    // The sequence the pass ran against the old check: link the victim in, get
    // refused, DELETE the original so the count falls back to 1, read, then
    // re-link to put the victim back "with zero trace". The restore is not
    // optional — without it the attacker has destroyed the file they came for
    // — and the restore is exactly what the count sees.
    //
    // Stated plainly because it is the residual: the INCOMPLETE, destructive
    // form (link, delete the original, read, walk away) is not refused, and
    // cannot be. At that instant the file's only name really is inside the
    // root, which is indistinguishable from a file that was always there. What
    // bounds it is that the root is the session's own project directory and
    // never the home directory.
    const dir = tmp('ccc-read-relink-')
    const victim = path.join(dir, 'credentials.json')
    realFs.writeFileSync(victim, SECRET)
    const link = path.join(dir, 'mockup.html')

    hardLink(victim, link)
    expect(() => readCheckedFile(link, 1024)).toThrow(/not a regular file/i)

    realFs.unlinkSync(victim) // "delete the original"
    realFs.linkSync(link, victim) // "restore it" — the count is 2 again
    expect(realFs.statSync(link).nlink).toBe(2)
    expect(() => readCheckedFile(link, 1024)).toThrow(/not a regular file/i)
    expect(realFs.readFileSync(victim, 'utf8')).toBe(SECRET) // the victim survived
  })

  it('fails CLOSED when the filesystem does not report a link count', () => {
    const file = path.join(tmp('ccc-read-nonlink-'), 'doc.html')
    realFs.writeFileSync(file, '<p>hello</p>')
    hideNlink = true
    expect(() => readCheckedFile(file, 1024)).toThrow(/not a regular file/i)
    // …and the very same file reads once the count is reported again, so the
    // refusal is the missing count and not the file.
    hideNlink = false
    expect(readCheckedFile(file, 1024).toString('utf8')).toBe('<p>hello</p>')
  })

  it('enforces the byte ceiling, and only past it', () => {
    const file = path.join(tmp('ccc-read-cap-'), 'doc.html')
    realFs.writeFileSync(file, 'x'.repeat(2048))
    expect(() => readCheckedFile(file, 1024)).toThrow(/too large/i)
    expect(readCheckedFile(file, 2048).length).toBe(2048)
  })

  it('refuses a directory', () => {
    const dir = tmp('ccc-read-dir-')
    // openSync may throw EISDIR outright, or the fstat isFile() check refuses;
    // either way nothing is returned.
    expect(() => readCheckedFile(dir, 1024)).toThrow()
  })

  it('checks and reads ONE object: a single open, every read on that fd', () => {
    // The TOCTOU, fixed by construction rather than by racing it — and
    // construction is what this asserts: exactly one openSync, every readSync
    // against THAT descriptor, and no path-taking read call anywhere in the
    // operation. Reverting to `statSync(p)` + `readFileSync(p)` fails here
    // even though every behavioural test above still passes.
    const file = path.join(tmp('ccc-read-toctou-'), 'doc.html')
    realFs.writeFileSync(file, '<p>hello</p>')

    expect(readCheckedFile(file, 1024).toString('utf8')).toBe('<p>hello</p>')

    expect(opened).toHaveLength(1)
    expect(readFileSyncCalls).toHaveLength(0)
    expect(readSyncCalls.length).toBeGreaterThan(0)
    for (const call of readSyncCalls) expect(call[0]).toBe(opened[0])
  })
})

describe('readCheckedFile — the link refusal is opt-out, per call, and reported', () => {
  // Blanket-refusing every multiply-linked file broke hardlink-deduplicated
  // build output (pnpm, `cp -al`, Nx/Turbo/Bazel cache restores) served as UAT
  // assets. The exemption is a parameter the CALLER passes for one read, never
  // a mode; and taking it does not make the fact invisible.
  it('reads a multiply-linked file when the caller opts out, and reports the count', () => {
    const dir = tmp('ccc-read-optout-')
    const source = path.join(dir, 'chunk-source.js')
    realFs.writeFileSync(source, 'console.log(1)')
    const link = path.join(dir, 'chunk.js')
    hardLink(source, link)

    const seen: Array<number | null> = []
    const bytes = readCheckedFile(link, 1024, {
      requireSingleLink: false,
      onLinkAnomaly: (n) => seen.push(n),
    })
    expect(bytes.toString('utf8')).toBe('console.log(1)')
    expect(seen).toEqual([2])
  })

  it('reports null — not silence — when the volume will not say', () => {
    const file = path.join(tmp('ccc-read-optout-nonlink-'), 'chunk.js')
    realFs.writeFileSync(file, 'x')
    hideNlink = true
    const seen: Array<number | null> = []
    try {
      expect(readCheckedFile(file, 1024, { requireSingleLink: false, onLinkAnomaly: (n) => seen.push(n) }).toString('utf8')).toBe('x')
    } finally {
      hideNlink = false
    }
    expect(seen).toEqual([null])
  })

  it('does not call back for an ordinary single-named file', () => {
    const file = path.join(tmp('ccc-read-optout-plain-'), 'chunk.js')
    realFs.writeFileSync(file, 'y')
    const seen: Array<number | null> = []
    readCheckedFile(file, 1024, { requireSingleLink: false, onLinkAnomaly: (n) => seen.push(n) })
    expect(seen).toEqual([])
  })

  it('still refuses by DEFAULT, and when the caller asks for the check explicitly', () => {
    // The half that makes the opt-out safe: it has to be asked for. A default
    // that flipped to permissive would disarm every existing call site at once.
    const dir = tmp('ccc-read-optin-')
    const victim = path.join(dir, 'credentials.json')
    realFs.writeFileSync(victim, SECRET)
    const link = path.join(dir, 'mockup.html')
    hardLink(victim, link)
    expect(() => readCheckedFile(link, 1024)).toThrow(/not a regular file/i)
    expect(() => readCheckedFile(link, 1024, {})).toThrow(/not a regular file/i)
    expect(() => readCheckedFile(link, 1024, { requireSingleLink: true })).toThrow(/not a regular file/i)
  })

  it('a throwing reporter does not sink the read', () => {
    const dir = tmp('ccc-read-optout-throw-')
    const source = path.join(dir, 'a.js')
    realFs.writeFileSync(source, 'z')
    const link = path.join(dir, 'b.js')
    hardLink(source, link)
    expect(
      readCheckedFile(link, 1024, {
        requireSingleLink: false,
        onLinkAnomaly: () => {
          throw new Error('logger exploded')
        },
      }).toString('utf8'),
    ).toBe('z')
  })
})
