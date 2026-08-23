/**
 * One function says what a session can do. The bar, the dialog, the Logs button
 * and the Settings page read it and nothing else -- so a Codex session is never
 * called "Claude" again, and an SSH session's partner shell is never described
 * as if it ran on the host.
 */
import { describe, it, expect } from 'vitest'
import { sessionCapabilities, describeTarget } from '../../../src/renderer/lib/session-capabilities'

const local = (over: Record<string, unknown> = {}) => ({ provider: 'claude', sessionType: 'local', configId: 'cfg', ...over }) as never
const ssh = (over: Record<string, unknown> = {}) => ({ provider: 'claude', sessionType: 'ssh', configId: 'cfg', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' }, ...over }) as never

describe('sessionCapabilities', () => {
  it('local Claude: an agent named Claude, everything local, logs indexable, snap allowed', () => {
    const c = sessionCapabilities(local())
    expect(c.agent).toBe('claude')
    expect(c.agentName).toBe('Claude')
    expect(c.mainAccepts).toBe('prompt')
    expect(c.mainRunsOn).toBe('local')
    expect(c.panesOnDifferentMachines).toBe(false)
    expect(c.canIndexLogs).toBe(true)
    expect(c.logsEmptyReason).toBeNull()
    expect(c.canSendImageToAgent).toBe(true)
    expect(c.hasConfig).toBe(true)
    expect(c.mainPaneIsShell).toBe(false)
  })

  it('local Codex: the agent is Codex -- never the word Claude -- and logs are not indexable', () => {
    const c = sessionCapabilities(local({ provider: 'codex' }))
    expect(c.agent).toBe('codex')
    expect(c.agentName).toBe('Codex')
    expect(c.logsEmptyReason).toBe('codex')
    expect(c.canIndexLogs).toBe(false)
    expect(describeTarget(c, 'claude')).toBe('the Codex terminal')
  })

  it('terminal-only: no agent, the main pane accepts a shell line, no snap, no transcript', () => {
    const c = sessionCapabilities(local({ shellOnly: true }))
    expect(c.agent).toBeNull()
    expect(c.agentName).toBe('')
    expect(c.mainAccepts).toBe('shell')
    expect(c.mainPaneIsShell).toBe(true)
    expect(c.canSendImageToAgent).toBe(false)
    expect(c.logsEmptyReason).toBe('shell-only')
    expect(describeTarget(c, 'claude')).toBe('this shell')
  })

  it('SSH Claude: the main pane is remote, the partner is this PC, the two panes differ, logs live on the host', () => {
    const c = sessionCapabilities(ssh())
    expect(c.mainRunsOn).toBe('remote')
    expect(c.partnerRunsOn).toBe('local')
    expect(c.remoteHost).toBe('build-box')
    expect(c.panesOnDifferentMachines).toBe(true)
    expect(c.logsEmptyReason).toBe('ssh')
    expect(c.runsOn('claude')).toBe('remote')
    expect(c.runsOn('partner')).toBe('local')
    expect(describeTarget(c, 'claude')).toBe('Claude on build-box')
    expect(describeTarget(c, 'partner')).toBe('the partner shell (this PC)')
  })

  it('shell-only takes precedence over ssh and codex for the logs reason, as LogsPane does', () => {
    expect(sessionCapabilities(ssh({ shellOnly: true })).logsEmptyReason).toBe('shell-only')
    expect(sessionCapabilities(local({ provider: 'codex', shellOnly: true })).logsEmptyReason).toBe('shell-only')
  })

  describe('canDeliverSecret -- a secret reaches only a LOCAL shell spawn', () => {
    it('local Claude: the partner shell yes, the agent pane no (a reference typed into a TUI is text)', () => {
      const c = sessionCapabilities(local())
      expect(c.canDeliverSecret('partner')).toBe(true)
      expect(c.canDeliverSecret('claude')).toBe(false)
    })
    it('local terminal-only: both shells are local spawns', () => {
      const c = sessionCapabilities(local({ shellOnly: true }))
      expect(c.canDeliverSecret('claude')).toBe(true)
      expect(c.canDeliverSecret('partner')).toBe(true)
    })
    it('SSH: the remote main pane never, the local partner yes', () => {
      expect(sessionCapabilities(ssh()).canDeliverSecret('claude')).toBe(false)
      expect(sessionCapabilities(ssh()).canDeliverSecret('partner')).toBe(true)
      expect(sessionCapabilities(ssh({ shellOnly: true })).canDeliverSecret('claude')).toBe(false)
      expect(sessionCapabilities(ssh({ shellOnly: true })).canDeliverSecret('partner')).toBe(true)
    })
  })

  it('a session with no config (Ask Conductor, a resumed folder) says so', () => {
    const c = sessionCapabilities(local({ configId: undefined, kind: 'ask' }))
    expect(c.hasConfig).toBe(false)
    expect(c.isAsk).toBe(true)
  })

  it('tolerates a missing session (defaults to local Claude with no config)', () => {
    const c = sessionCapabilities(undefined)
    expect(c.agent).toBe('claude')
    expect(c.hasConfig).toBe(false)
    expect(c.mainRunsOn).toBe('local')
  })
})
