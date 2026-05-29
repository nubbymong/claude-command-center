// tests/unit/permission-core.test.ts
import { describe, it, expect } from 'vitest'
import { detectHighRisk, normalizePermission, decideDisposition } from '../../src/main/permission-core'
import type { HookEvent } from '../../src/shared/hook-types'

describe('permission-core', () => {
  it('flags destructive Bash payloads', () => {
    expect(detectHighRisk('Bash', 'rm -rf node_modules')?.matched).toBe('rm -rf')
    expect(detectHighRisk('Bash', 'git push --force origin main')?.matched).toBe('git push --force')
    expect(detectHighRisk('Bash', 'sudo apt install x')?.matched).toBe('sudo')
    expect(detectHighRisk('Bash', 'ls -la')).toBeUndefined()
  })
  it('normalizePermission maps a PermissionRequest hook to a PendingPermission', () => {
    const e: HookEvent = { sessionId: 's1', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: 'rm -rf x', reason: 'cleanup', requestId: 'req1' }, ts: 1 }
    const p = normalizePermission(e, { label: 'api-server', provider: 'claude' })
    expect(p.requestId).toBe('req1')
    expect(p.tool).toBe('Bash')
    expect(p.transport).toBe('hook')
    expect(p.highRisk?.matched).toBe('rm -rf')
  })
  it('decideDisposition: high-risk always shows even with a standing approval', () => {
    const p = { tool: 'Bash', payloadPreview: 'rm -rf x', highRisk: { matched: 'rm -rf' } } as any
    expect(decideDisposition(p, () => true)).toBe('show')
  })
  it('decideDisposition: non-high-risk Bash auto-allows regardless of standing approval (v2.0.0)', () => {
    // v2.0.0: PreToolUse delivers every Bash call. Only the high-risk
    // patterns (detectHighRisk) need user input; the rest auto-allow so
    // the tray doesn't fire for ls/cat/git status.
    const p = { tool: 'Bash', payloadPreview: 'ls', highRisk: undefined } as any
    expect(decideDisposition(p, () => true)).toBe('auto-allow')
    expect(decideDisposition(p, () => false)).toBe('auto-allow')
  })
  it('decideDisposition: non-Bash tools always auto-allow (v2.0.0)', () => {
    const p = { tool: 'Edit', payloadPreview: 'foo', highRisk: undefined } as any
    expect(decideDisposition(p, () => false)).toBe('auto-allow')
  })
  it('does not flag non-Bash tools even when payload looks destructive', () => {
    expect(detectHighRisk('Edit', 'rm -rf node_modules')).toBeUndefined()
    expect(detectHighRisk('Write', 'sudo something')).toBeUndefined()
    expect(detectHighRisk('Read', 'git push --force')).toBeUndefined()
  })
  describe('--force-with-lease is the SAFE form -- never high-risk', () => {
    it('does not match the git-push label', () => {
      expect(detectHighRisk('Bash', 'git push --force-with-lease origin main')).toBeUndefined()
    })
    it('does not match the standalone --force label', () => {
      expect(detectHighRisk('Bash', 'git push origin main --force-with-lease')).toBeUndefined()
    })
    it('still flags --force on its own', () => {
      expect(detectHighRisk('Bash', 'git push --force origin main')?.matched).toBe('git push --force')
    })
    it('still flags --force in non-git contexts', () => {
      expect(detectHighRisk('Bash', 'apt-get install --force-yes pkg')?.matched).toBe('--force')
    })
  })
  describe('sudo is anchored to command position', () => {
    it('flags sudo at start of payload', () => {
      expect(detectHighRisk('Bash', 'sudo apt install x')?.matched).toBe('sudo')
    })
    it('flags sudo after a shell separator', () => {
      expect(detectHighRisk('Bash', 'cd / && sudo rm /etc/passwd')?.matched).toBe('sudo')
      expect(detectHighRisk('Bash', 'true | sudo tee /tmp/x')?.matched).toBe('sudo')
      expect(detectHighRisk('Bash', 'true; sudo whoami')?.matched).toBe('sudo')
    })
    it('does not flag sudo inside a longer word (sudoers, pseudo)', () => {
      expect(detectHighRisk('Bash', 'cat /etc/sudoers')).toBeUndefined()
      expect(detectHighRisk('Bash', 'pseudo --help')).toBeUndefined()
    })
    it('does not flag sudo inside a double-quoted string literal', () => {
      // Old `\bsudo\b` matched this; the command-position anchor does not.
      expect(detectHighRisk('Bash', 'echo "sudo is a tool"')).toBeUndefined()
    })
    it('does not flag sudo as the leaf of a path argument', () => {
      // The trailing `/` immediately after `sudo` fails the (?=\s|$) lookahead.
      expect(detectHighRisk('Bash', 'ls /var/lib/sudo/')).toBeUndefined()
    })
  })
})
