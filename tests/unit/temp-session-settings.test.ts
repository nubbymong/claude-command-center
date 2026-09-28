// The temp stand-in for the per-session settings writer (tests/helpers/
// temp-session-settings.ts) keeps a test's session files out of the real
// Claude config folder. pty-buffered-write-ordering spawns local sessions
// through pty-manager, whose real writer puts settings-<sid>.json and
// mcp-<sid>.json into os.homedir()/.claude; it rewrote files there on a
// developer machine. This checks the stand-in itself, and that the test uses
// it, without running that test here (it runs in CI).
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { tempSessionSettings } from '../helpers/temp-session-settings'

const ROOT = path.resolve(__dirname, '..', '..')
const inside = (p: string, dir: string) => {
  const rel = path.relative(dir, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

describe('the temp session settings stand-in', () => {
  it('writes every session file into its own temp folder, never the real home, and removes it', () => {
    const s = tempSessionSettings()
    const home = path.join(os.homedir(), '.claude')
    expect(inside(s.dir, os.tmpdir())).toBe(true)
    expect(inside(s.dir, home)).toBe(false)
    const written = [
      s.writeLocalSessionSettings('ask-window-1'),
      s.writeLocalSessionMcpConfig('ask-window-1'),
      s.writeLocalSessionStatusUrl('ask-window-1'),
    ]
    for (const p of written) {
      expect(inside(p, s.dir), p).toBe(true)
      expect(inside(p, home), p).toBe(false)
      expect(fs.existsSync(p), p).toBe(true)
    }
    // The same names the real writer uses, so a launch line keeps its shape.
    expect(written.map((p) => path.basename(p))).toEqual(['settings-ask-window-1.json', 'mcp-ask-window-1.json', 'ccc-status-ask-window-1.url'])
    s.removeLocalSessionSettings('ask-window-1')
    s.removeLocalSessionMcpConfig('ask-window-1')
    s.removeLocalSessionStatusUrl('ask-window-1')
    for (const p of written) expect(fs.existsSync(p), p).toBe(false)
    s.dispose()
    expect(fs.existsSync(s.dir)).toBe(false)
  })

  it('stands in for every function the real writer exports', () => {
    const real = fs.readFileSync(path.join(ROOT, 'src/main/hooks/per-session-settings.ts'), 'utf8')
    const exported = [...real.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(0)
    const s = tempSessionSettings()
    try {
      for (const name of exported) expect(typeof (s as Record<string, unknown>)[name], name).toBe('function')
    } finally {
      s.dispose()
    }
  })

  it('pty-buffered-write-ordering puts its session files through it', () => {
    const text = fs.readFileSync(path.join(ROOT, 'tests/unit/pty-buffered-write-ordering.test.ts'), 'utf8')
    expect(text).toMatch(/vi\.mock\('\.\.\/\.\.\/src\/main\/hooks\/per-session-settings', async \(\) => \(await import\('\.\.\/helpers\/temp-session-settings'\)\)\.tempSessionSettings\(\)\)/)
    expect(text).toMatch(/\.dispose\(\)/)
  })
})
