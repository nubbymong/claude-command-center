import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// validateMemoryPath resolves against os.homedir()/.claude/projects. Mock
// os.homedir to an isolated mkdtemp dir so a junction can be planted that
// escapes it. Junctions (not file symlinks) need no admin/dev mode on Windows.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, homedir: () => hoisted.home }
})

const realOs = await vi.importActual<typeof import('os')>('os')
const { validateMemoryPath } = await import('../../src/main/utils/path-validator')

let tmpHome: string
const projects = () => path.join(tmpHome, '.claude', 'projects')

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ccc-mem-sec-'))
  fs.mkdirSync(projects(), { recursive: true })
  hoisted.home = tmpHome
})

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('validateMemoryPath symlink hardening (P2.5)', () => {
  it('allows a real file inside the memory dir', () => {
    const f = path.join(projects(), 'mem.md')
    fs.writeFileSync(f, '# hi')
    expect(() => validateMemoryPath(f)).not.toThrow()
  })

  it('rejects a literal ../ traversal (string containment preserved)', () => {
    fs.writeFileSync(path.join(tmpHome, 'secret.txt'), 'secret')
    expect(() => validateMemoryPath(path.join(projects(), '..', '..', 'secret.txt'))).toThrow()
  })

  it('rejects a path that escapes the memory dir through a junction', () => {
    const outsideDir = path.join(tmpHome, 'outside')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret')
    const link = path.join(projects(), 'link')
    fs.symlinkSync(outsideDir, link, 'junction')

    // String containment passes (literal path is "inside"), realpath catches it.
    expect(() => validateMemoryPath(path.join(link, 'secret.md'))).toThrow()
  })

  it('refuses a destructive op on a symlinked entry even if it resolves inside', () => {
    const realDir = path.join(projects(), 'real')
    fs.mkdirSync(realDir)
    fs.writeFileSync(path.join(realDir, 'x.md'), 'x')
    const innerLink = path.join(projects(), 'inner')
    fs.symlinkSync(realDir, innerLink, 'junction')

    // Resolves back inside the root -> read is fine.
    expect(() => validateMemoryPath(innerLink)).not.toThrow()
    // ...but a destructive op must not act through the link.
    expect(() => validateMemoryPath(innerLink, { destructive: true })).toThrow()
  })
})
