// @vitest-environment node
//
// Re-attack r11: the statusline script is rewritten while sessions run (the
// macOS realm redeploy), so the deploy writes a temp file and renames it over
// the script -- a statusline tick never reads a half-written program.
import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import realFs from 'node:fs'

const ops: string[] = []
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    writeFileSync: (p: realFs.PathOrFileDescriptor, ...rest: unknown[]) => { ops.push(`write:${String(p)}`); return (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest) },
    renameSync: (a: realFs.PathLike, b: realFs.PathLike) => { ops.push(`rename:${String(a)}->${String(b)}`); return actual.renameSync(a, b) },
  }
})

const { deployClaudeStatuslineScript } = await import('../../../../src/main/providers/claude/statusline')

const tmps: string[] = []
afterEach(() => { for (const t of tmps.splice(0)) try { realFs.rmSync(t, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('deployClaudeStatuslineScript', () => {
  it('r11: writes a temp file and renames it over the script; never writes the script in place; no temp left', async () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'sl-atomic-'))
    tmps.push(dir)
    const script = path.join(dir, 'scripts', 'claude-multi-statusline.js')
    ops.length = 0
    await deployClaudeStatuslineScript(dir)
    expect(ops).not.toContain(`write:${script}`)
    const w = ops.find((o) => o.startsWith(`write:${script}.`) && o.endsWith('.tmp'))
    expect(w).toBeTruthy()
    const tmpFile = w!.slice('write:'.length)
    expect(ops).toContain(`rename:${tmpFile}->${script}`)
    expect(realFs.existsSync(script)).toBe(true)
    expect(realFs.readdirSync(path.join(dir, 'scripts')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
