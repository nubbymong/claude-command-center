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

const { default: SshFlowOverlay } = await import('../../../src/renderer/components/SshFlowOverlay')
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
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
