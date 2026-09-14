import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema } from '../../src/main/ipc/pty-handlers'

// permissionMode / extraArgs are shell-interpolated UNQUOTED into the claude
// launch command (pty-manager local + SSH). The Zod schema is the injection
// boundary, so these tests pin exactly what may reach the shell.

describe('spawnOptionsSchema — permissionMode', () => {
  it('accepts every CLI --permission-mode choice', () => {
    for (const m of ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual']) {
      expect(spawnOptionsSchema.safeParse({ permissionMode: m }).success).toBe(true)
    }
  })

  it("accepts the 'default'/'' no-override sentinels", () => {
    expect(spawnOptionsSchema.safeParse({ permissionMode: 'default' }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse({ permissionMode: '' }).success).toBe(true)
  })

  it('rejects anything outside the enum (unquoted-interpolation guard)', () => {
    expect(spawnOptionsSchema.safeParse({ permissionMode: 'yolo' }).success).toBe(false)
    expect(spawnOptionsSchema.safeParse({ permissionMode: 'bypassPermissions; rm -rf /' }).success).toBe(false)
  })
})

describe('spawnOptionsSchema — extraArgs', () => {
  it('accepts ordinary flags and paths (incl. Windows backslash paths)', () => {
    for (const v of ['', '--verbose', '--add-dir /tmp/foo', '--add-dir C:\\Users\\me\\proj', '--foo=bar,baz']) {
      expect(spawnOptionsSchema.safeParse({ extraArgs: v }).success).toBe(true)
    }
  })

  it('rejects shell metacharacters (injection guard)', () => {
    for (const v of ['; rm -rf /', 'a | b', 'a && b', '$(whoami)', '`id`', 'a > f', "a'b", 'a"b', 'a\nb', 'a & b']) {
      expect(spawnOptionsSchema.safeParse({ extraArgs: v }).success).toBe(false)
    }
  })

  it('rejects CCC-managed flags so the escape hatch cannot clobber wiring', () => {
    for (const v of ['--model sonnet', '--model=sonnet', '--effort high', '--permission-mode bypassPermissions',
      '--settings x', '--mcp-config y', '--agents z', '--resume abcd']) {
      expect(spawnOptionsSchema.safeParse({ extraArgs: v }).success).toBe(false)
    }
  })
})
