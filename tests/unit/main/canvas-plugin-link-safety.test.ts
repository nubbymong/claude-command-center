// Cross-platform proof that the owned-FILE check refuses a LINK.
//
// `OWNED_FILES` was verified with `statSync().isFile()`, which follows links, so
// a symlinked SKILL.md whose target held the right bytes passed forever — and
// the target lives outside the tree, where the attacker can keep editing it at
// will and no wipe ever reaches it. The fix is `lstatSync().isFile()` plus a
// read from a single `O_NOFOLLOW` descriptor.
//
// The real-symlink version of this test can only run on POSIX: creating a file
// symlink on Windows needs privilege, and a junction covers directories only
// (the root-link case in canvas-plugin.test.ts uses one). A guard proven on one
// leg of the matrix is a guard that is usually off, so here the disagreement is
// INJECTED — lstat reports a symbolic link, stat reports a regular file, which
// is precisely the disagreement `statSync` used to resolve the wrong way — and
// the rebuild is observed directly through `rmSync`.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as realFs from 'fs'
import * as path from 'path'

const res = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-plugin-link-')) }
})

vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => res.dir
}))

/** `link.path`: the one path lstat should call a symbolic link. `wipes`: every
 *  `rmSync` target, which is how "the tree was rebuilt" is observed without
 *  changing the content the check is supposed to be happy with. */
const spy = vi.hoisted(() => ({ linkPath: '', wipes: [] as string[] }))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      const st = (real.lstatSync as (...a: unknown[]) => realFs.Stats)(p, ...rest)
      if (spy.linkPath && String(p) === spy.linkPath) {
        // Everything else about the inode stays true; only the verdict changes.
        return Object.create(st, {
          isFile: { value: () => false },
          isDirectory: { value: () => false },
          isSymbolicLink: { value: () => true }
        }) as realFs.Stats
      }
      return st
    },
    rmSync: (p: unknown, opts?: unknown) => {
      spy.wipes.push(String(p))
      return (real.rmSync as (...a: unknown[]) => void)(p, opts)
    }
  }
  return { ...patched, default: patched }
})

const { ensureCanvasPlugin, _resetCanvasPluginForTest } = await import('../../../src/main/canvas/canvas-plugin')

const skillPath = (root: string) => path.join(root, 'skills', 'agent-canvas', 'SKILL.md')

beforeEach(() => {
  _resetCanvasPluginForTest()
  spy.linkPath = ''
  spy.wipes = []
  realFs.rmSync(path.join(res.dir, 'canvas-plugin'), { recursive: true, force: true })
})

afterAll(() => {
  try { realFs.rmSync(res.dir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('the owned-file check is link-safe on every platform', () => {
  it('leaves a genuinely pristine tree alone — the control for the test below', () => {
    // Without this, "it wiped" proves nothing: a check that rebuilds on EVERY
    // call would pass the link test for the wrong reason.
    const dir = ensureCanvasPlugin()!
    spy.wipes = []

    expect(ensureCanvasPlugin()).toBe(dir)
    expect(spy.wipes).toEqual([]) // nothing rebuilt: the tree really did verify
  })

  it('rebuilds when an owned file is a LINK, even though its content is correct', () => {
    const dir = ensureCanvasPlugin()!
    const good = realFs.readFileSync(skillPath(dir))
    spy.wipes = []

    // Content untouched and byte-perfect. The ONLY thing wrong is that the
    // entry is a link — which is exactly what statSync could not see.
    spy.linkPath = skillPath(dir)

    expect(ensureCanvasPlugin()).toBe(dir)
    expect(spy.wipes).toContain(dir)
    expect(realFs.readFileSync(skillPath(dir))).toEqual(good)
  })
})
