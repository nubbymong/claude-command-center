import { describe, it, expect, vi } from 'vitest'
import { probeCommandExe } from '../../src/main/gui-exe-probe'
import type { ExeSubsystem } from '../../src/shared/gui-exe'

// #379. The probe is the read-only half: it must be incapable of doing anything
// but reading, and every answer it cannot give must be an explicit "I don't
// know" that leaves the caller on its existing path.

const deps = (over: { subsystem?: ExeSubsystem; resolved?: string | null; platform?: NodeJS.Platform } = {}) => ({
  platform: over.platform ?? ('win32' as NodeJS.Platform),
  sniff: vi.fn(async () => over.subsystem ?? ('gui' as ExeSubsystem)),
  resolve: vi.fn(() => (over.resolved === undefined ? 'C:\\tools\\bambu-studio.exe' : over.resolved)),
  resolveWorkingDir: (cwd?: string) => cwd ?? 'C:\\work',
})

describe('probeCommandExe', () => {
  it('reports gui for a GUI-subsystem program, with the resolved path', async () => {
    const d = deps()
    await expect(probeCommandExe('bambu-studio --debug 2', 'C:\\work', d)).resolves.toEqual({
      status: 'gui',
      token: 'bambu-studio',
      exePath: 'C:\\tools\\bambu-studio.exe',
    })
  })

  it('reports console for an ordinary CLI', async () => {
    const d = deps({ subsystem: 'console' })
    const out = await probeCommandExe('git status', 'C:\\work', d)
    expect(out.status).toBe('console')
  })

  it('short-circuits off Windows without touching the filesystem', async () => {
    // AttachConsole and CONOUT$ do not exist elsewhere; a POSIX child writing to
    // an inherited tty is ordinary behaviour the pty already captures.
    const d = deps({ platform: 'darwin' })
    await expect(probeCommandExe('inkscape --version', '/work', d)).resolves.toEqual({
      status: 'not-windows',
      token: null,
      exePath: null,
    })
    expect(d.resolve).not.toHaveBeenCalled()
    expect(d.sniff).not.toHaveBeenCalled()
  })

  it('reports unresolved for a program it cannot find, and does not sniff', async () => {
    const d = deps({ resolved: null })
    const out = await probeCommandExe('$env:TOOL --version', 'C:\\work', d)
    expect(out).toEqual({ status: 'unresolved', token: '$env:TOOL', exePath: null })
    expect(d.sniff).not.toHaveBeenCalled()
  })

  it('reports unresolved for a line with no program', async () => {
    const d = deps()
    await expect(probeCommandExe('   ', 'C:\\work', d)).resolves.toEqual({
      status: 'unresolved',
      token: null,
      exePath: null,
    })
  })

  it('resolves against the session working directory it is given', async () => {
    const d = deps()
    await probeCommandExe('tool', 'D:\\project', d)
    expect(d.resolve).toHaveBeenCalledWith('tool', 'D:\\project')
  })

  it('falls back to the resolved working directory when none is given', async () => {
    const d = deps()
    await probeCommandExe('tool', undefined, d)
    expect(d.resolve).toHaveBeenCalledWith('tool', 'C:\\work')
  })
})
