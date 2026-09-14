// @vitest-environment jsdom
/**
 * SshFlowOverlay — the persistence-unavailable warning gate (owner UX,
 * 2026-08-31). The tmux ladder giving up (probe=none / tmux-*-fail:*) is only
 * worth warning about when persistence was actually WANTED. Main forces it OFF
 * for a standard session (detachable === false) or a container runtime
 * (runtime.type === 'container'), so probe=none is the expected outcome there —
 * warning about it alarmed the owner launching a standard SSH session that works
 * fine. These cover the gate; the shared reason-recognition helpers are tested
 * in tests/unit/shared/ssh-tmux-persistence.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: SshFlowOverlay, failureText, CONTAINER_ENTRY_FAILED, CONTAINER_LEFT, ENTRY_UNVERIFIED } = await import('../../../src/renderer/components/SshFlowOverlay')
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { SSH_ENTRY } from '../../../src/shared/ssh-entry'
import type { Session } from '../../../src/renderer/stores/sessionStore'

const WARNING = 'persistent session unavailable'

let flowCb: ((msg: { state: string; info?: string }) => void) | null = null

function setSession(sshConfig: unknown) {
  useSessionStore.setState({
    sessions: [
      {
        id: 's1', label: 'remote', workingDirectory: '/home/u/app', model: 'sonnet',
        color: '#ffffff', status: 'idle', createdAt: 0, sessionType: 'ssh', configId: 'cfg-1',
        sshConfig,
      } as unknown as Session,
    ],
  })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  flowCb = null
  ;(globalThis as any).window.electronAPI = {
    ssh: {
      onFlowState: vi.fn((_id: string, cb: (msg: { state: string; info?: string }) => void) => {
        flowCb = cb
        return () => {}
      }),
      // Never resolves: the flow-state push (below) is the sole driver, so the
      // catch-up poll never fires a setState or reschedules a timer.
      getState: vi.fn(() => new Promise(() => {})),
      runPostCommand: vi.fn(),
      launchClaude: vi.fn(),
      skip: vi.fn(),
    },
  }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useSessionStore.setState({ sessions: [] })
})

const mount = () =>
  act(() => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand={false} shellOnly={false} enabled />) })
const push = (msg: { state: string; info?: string }) => act(() => { flowCb?.(msg) })

// rc.14 review F1 round 2 (aicc_planning#45): a failed container entry offers
// Run again (the post-command re-run main accepts from this exact state), not
// Retry Launch (which main answers by re-emitting the failure).
describe('SshFlowOverlay failed container entry', () => {
  const containerCfg = { host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } }

  it('shows Run again wired to runPostCommand, plus Skip; no Retry Launch', async () => {
    setSession(containerCfg)
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'failed', info: 'container entry failed' }) })
    const again = container.querySelector('[data-testid="ssh-run-post-command-again"]') as HTMLButtonElement | null
    expect(again).not.toBeNull()
    expect(again!.textContent).toBe('Run again')
    expect(container.textContent).not.toContain('Retry Launch')
    expect(container.textContent).toContain('Skip')
    expect(container.textContent).toContain('run the post-connect command again')
    await act(async () => { again!.click() })
    expect((globalThis as any).window.electronAPI.ssh.runPostCommand).toHaveBeenCalledWith('s1')
    expect((globalThis as any).window.electronAPI.ssh.launchClaude).not.toHaveBeenCalled()
  })

  it('failureText: the container reason gets the sentence, any other reason is shown as sent, none falls back to the log pointer', () => {
    expect(failureText(CONTAINER_ENTRY_FAILED)).toContain('run the post-connect command again')
    expect(failureText('host setup timeout')).toBe('host setup timeout')
    expect(failureText(undefined)).toBe('See app.log for details.')
  })

  it('any other setup failure keeps Retry Launch', async () => {
    setSession(containerCfg)
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'failed', info: 'container setup timeout' }) })
    expect(container.querySelector('[data-testid="ssh-run-post-command-again"]')).toBeNull()
    expect(container.textContent).toContain('Retry Launch')
    expect(container.textContent).toContain('container setup timeout')
  })
})

describe('SshFlowOverlay persistence-unavailable warning gate', () => {
  it('does NOT warn on a standard session (detachable:false) with probe=none', () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', detachable: false })
    mount()
    push({ state: 'running-claude', info: 'probe=none' })
    expect(container.textContent).not.toContain(WARNING)
  })

  it('does NOT warn on a container runtime session with probe=none', () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', container: 'ccc-test' } })
    mount()
    push({ state: 'running-claude', info: 'probe=none' })
    expect(container.textContent).not.toContain(WARNING)
  })

  it('does NOT warn on a LEGACY docker session (free-text postCommand, no structured runtime) with probe=none', () => {
    // Double Review must-fix: main treats a docker-shaped postCommand with no
    // structured runtime as a container (persistence forced off), so probe=none
    // is normal there too — the overlay must mirror that exact gate.
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', postCommand: 'sudo docker exec -it ccc bash' })
    mount()
    push({ state: 'running-claude', info: 'probe=none' })
    expect(container.textContent).not.toContain(WARNING)
  })

  it('DOES warn on a persistence-wanted session (detachable undefined) with a real ladder failure', () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~' })
    mount()
    push({ state: 'running-claude', info: 'tmux-push-fail:timeout' })
    expect(container.textContent).toContain(WARNING)
  })

  it('DOES warn on a persistence-wanted session (detachable:true) with probe=none', () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', detachable: true })
    mount()
    push({ state: 'running-claude', info: 'probe=none' })
    expect(container.textContent).toContain(WARNING)
  })
})

// rc.15 review R1 (aicc_planning#45): two new main-side outcomes. 'unverified'
// = the post-connect command finished but nothing proved where it landed
// (a start -ai attach, a free-text command): the overlay must WARN that the
// launch may run on the SSH host or a non-shell process and make it an
// explicit "Launch anyway", never the ordinary inner-shell copy. 'left the
// container' = a proven entry was lost again: Run again, like a failed entry.
describe('SshFlowOverlay rc.15 review R1: unverified entry needs explicit consent; a lost container shell offers Run again', () => {
  const containerCfg = { host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start' } }

  it('awaiting-claude/unverified: warns, offers Launch anyway (wired to launchClaude) and Skip; never the inner-shell copy', async () => {
    setSession(containerCfg)
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: ENTRY_UNVERIFIED }) })
    expect(container.textContent).toContain('Couldn’t verify where that landed')
    expect(container.textContent).toContain('possibly the SSH host itself')
    expect(container.textContent).not.toContain('Inner shell ready')
    expect(container.textContent).not.toContain('inside the post-connect shell')
    const anyway = container.querySelector('[data-testid="ssh-launch-anyway"]') as HTMLButtonElement | null
    expect(anyway).not.toBeNull()
    expect(anyway!.textContent).toBe('Launch anyway')
    expect(container.textContent).toContain('Skip')
    await act(async () => { anyway!.click() })
    expect((globalThis as any).window.electronAPI.ssh.launchClaude).toHaveBeenCalledWith('s1')
  })

  it('awaiting-claude/inner is unchanged: the ordinary Launch Claude, no warning', async () => {
    setSession(containerCfg)
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: 'inner' }) })
    expect(container.textContent).toContain('Inner shell ready')
    expect(container.querySelector('[data-testid="ssh-launch-anyway"]')).toBeNull()
    expect(container.textContent).not.toContain('possibly the SSH host itself')
  })

  it("failed/'left the container': the sentence says nothing was launched, and Run again is wired to runPostCommand", async () => {
    setSession(containerCfg)
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'failed', info: CONTAINER_LEFT }) })
    expect(container.textContent).toContain('Nothing was launched')
    const again = container.querySelector('[data-testid="ssh-run-post-command-again"]') as HTMLButtonElement | null
    expect(again).not.toBeNull()
    expect(container.textContent).not.toContain('Retry Launch')
    await act(async () => { again!.click() })
    expect((globalThis as any).window.electronAPI.ssh.runPostCommand).toHaveBeenCalledWith('s1')
    expect(failureText(CONTAINER_LEFT)).toMatch(/run the post-connect command again/i)
    expect(failureText(CONTAINER_ENTRY_FAILED)).toContain('no entry confirmation')
  })
})

// Quality review on the R1 commit: a HOST session with a free-text command is
// on the host it asked for unless the command hopped somewhere -- the consent
// copy must not describe running on the host as the hazard.
describe('SshFlowOverlay rc.15 review R1: the unverified copy is tailored to the session kind', () => {
  it('a host session (no runtime) gets the "cannot tell whether it changed where you are" copy, still with Launch anyway', async () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', postCommand: 'source ~/.venv/bin/activate' })
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: ENTRY_UNVERIFIED }) })
    expect(container.textContent).toContain('cannot tell whether it changed where you are')
    expect(container.textContent).not.toContain('possibly the SSH host itself')
    expect(container.querySelector('[data-testid="ssh-launch-anyway"]')).not.toBeNull()
  })

  it('a container session (start mode) keeps the host/non-shell warning', async () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test', mode: 'start' } })
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: ENTRY_UNVERIFIED }) })
    expect(container.textContent).toContain('possibly the SSH host itself')
  })

  it('the overlay constants ARE the shared constants main emits', async () => {
    const { SSH_ENTRY } = await import('../../../src/shared/ssh-entry')
    expect(CONTAINER_ENTRY_FAILED).toBe(SSH_ENTRY.FAILED)
    expect(CONTAINER_LEFT).toBe(SSH_ENTRY.LEFT)
    expect(ENTRY_UNVERIFIED).toBe(SSH_ENTRY.UNVERIFIED)
  })
})

// rc.15 review R1 round 2: the launch guard is a probe, not an injection --
// the overlay must not say "Injecting statusline" while nothing has been typed.
describe('SshFlowOverlay launch guard headline', () => {
  it('running-setup with the verifying info reads as a check of the container shell', async () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } })
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'running-setup', info: SSH_ENTRY.VERIFYING }) })
    expect(container.textContent).toContain('Checking the container shell')
    expect(container.textContent).not.toContain('Injecting statusline')
    await act(async () => { flowCb?.({ state: 'running-setup', info: 'container' }) })
    expect(container.textContent).toContain('Injecting statusline (container)')
  })

  it('the inner headline keys off the shared constant', async () => {
    setSession({ host: 'h', port: 22, username: 'u', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } })
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly={false} enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: SSH_ENTRY.INNER }) })
    expect(container.textContent).toContain('Inner shell ready')
  })
})
