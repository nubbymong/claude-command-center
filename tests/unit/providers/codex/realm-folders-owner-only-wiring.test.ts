// The managed Codex account folders on this disk get the app's owner-only
// folder rule (owner-only-folders.ts); only a test's own folder filesystem
// brings another. The rule is replaced here, so no process starts; the
// folders are real, in a temp folder this test makes and removes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const calls: string[][] = []
vi.mock('../../../../src/main/owner-only-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/owner-only-folders')>()),
  secureOwnerOnlyFolders: vi.fn(async (dirs: readonly string[]) => {
    calls.push([...dirs])
    return dirs.map((dir) => ({ dir, ok: false, detail: 'its owner is not this user' }))
  }),
}))

import { createCodexPackage } from '../../../../src/main/providers/codex'
import type { CodexRealmFsPort } from '../../../../src/main/providers/codex'

const REALM = `realm-${'c'.repeat(16)}`

describe('the managed folders on this disk get the owner-only folder rule', () => {
  let tmp = ''
  beforeEach(() => {
    calls.length = 0
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-owner-only-wiring-')))
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const source = (resourcesDir = tmp) => ({
    lookup: async (r: { authRealmId: string }) => ({
      ok: true as const,
      realm: { id: r.authRealmId, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${r.authRealmId}`, lifecycle: 'pending' as const },
      resourcesDir,
    }),
    mkdirSecure: (dir: string) => { fs.mkdirSync(dir, { recursive: true }) },
  })

  it('Windows: the root, then the home, are given to the rule, and a refusal refuses the folder (POSIX: 0700, the rule never asked)', async () => {
    const pkg = createCodexPackage({ realms: source(), hostHome: { env: {}, homeDir: path.join(tmp, 'home') } })
    const r = await pkg.realmFolders!.prepare({ authRealmId: REALM })
    const root = path.join(tmp, 'codex-realms')
    if (process.platform === 'win32') {
      expect(r).toMatchObject({ ok: false, code: 'permissions' })
      expect(calls).toEqual([[root, path.join(root, REALM)]])
      expect(fs.existsSync(path.join(root, REALM))).toBe(false)
    } else {
      expect(r).toMatchObject({ ok: true, created: true })
      expect(calls).toEqual([])
    }
  })

  it('a test folder filesystem never reaches the app\'s rule; one it brings is asked instead', async () => {
    // A Windows-shaped folder tree in memory: nothing here is on this disk.
    const RES = 'C:\\res'
    const dirs = new Set([RES.toLowerCase()])
    const fake: CodexRealmFsPort = {
      platform: 'win32',
      realpath: (p) => { if (!dirs.has(p.toLowerCase())) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return p },
      lstat: (p) => { if (!dirs.has(p.toLowerCase())) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'dir', dev: '9', ino: String(p.length), mode: 0o700 } },
      mkdirSecure: (d) => { dirs.add(d.toLowerCase()) },
      mkdir: (d) => { if (dirs.has(d.toLowerCase())) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); dirs.add(d.toLowerCase()) },
      chmod: () => {}, readdir: () => [], unlink: () => {}, rmdir: (d) => { dirs.delete(d.toLowerCase()) },
    }
    const plain = createCodexPackage({ realms: source(RES), realmFs: fake, hostHome: { env: {}, homeDir: 'C:\\nowhere' } })
    expect(await plain.realmFolders!.prepare({ authRealmId: REALM })).toMatchObject({ ok: true })
    expect(calls).toEqual([])
    const own: string[][] = []
    const refusing = createCodexPackage({
      realms: source(RES), realmFs: fake, hostHome: { env: {}, homeDir: 'C:\\nowhere' },
      secureFolders: async (d) => { own.push([...d]); return d.map((dir) => ({ dir, ok: false })) },
    })
    const refused = await refusing.realmFolders!.prepare({ authRealmId: `realm-${'d'.repeat(16)}` })
    expect(refused).toMatchObject({ ok: false, code: 'permissions' })
    // The refusal names the folder the user can act on: the app's resources
    // folder, never "the app data folder" (read on Windows as %APPDATA%).
    expect((refused as { message: string }).message).toMatch(/AI Code Conductor's resources folder/)
    expect((refused as { message: string }).message).not.toMatch(/app data folder|app's data folder/i)
    expect(own.length).toBe(1)
    expect(calls).toEqual([])
  })

  it('the app\'s composition brings no folder filesystem of its own, so its managed folders always get the app\'s rule', () => {
    // A test's own folder filesystem (and the rule it may bring) is the only
    // route to another rule; the composition root passes neither.
    // Whole-line comments out (they may hold parentheses); each call's whole
    // argument text read, however many lines it spans.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'main', 'providers', 'compose.ts'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')
    const CALL = 'createCodexPackage('
    const argsAt = (open: number): string => {
      let depth = 0
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
      }
      throw new Error('unbalanced call')
    }
    const calls: string[] = []
    for (let at = src.indexOf(CALL); at >= 0; at = src.indexOf(CALL, at + 1)) calls.push(argsAt(at + CALL.length - 1))
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args).toMatch(/\brealms\b/)
      expect(args).not.toMatch(/\brealmFs\b|\bsecureFolders\b/)
    }
  })
})
