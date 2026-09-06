// @vitest-environment jsdom
//
// The #54 config-edit guard: editing a saved SSH config while a session it
// launched is live -- or was left running -- is warned about (advise, don't
// block), because changes apply on the next launch and a destination change can
// break resume. These pin the pure decision AND the dialog's behaviour.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DetachedRemote } from '../../../src/shared/types'
import { configEditGuardState } from '../../../src/renderer/components/sidebar/configEditGuard'
import ConfigEditGuardDialog from '../../../src/renderer/components/sidebar/ConfigEditGuardDialog'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sshConfig = (over: Record<string, unknown> = {}): any => ({
  id: 'cfg-1', label: 'Pi · miner', sessionType: 'ssh',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
  ...over,
})
const detached = (over: Partial<DetachedRemote> = {}): DetachedRemote => ({
  sessionId: 'det-1', configId: 'cfg-1', host: 'pi.local', username: 'mong', remotePath: '~/work',
  port: 22, runtime: { type: 'host' }, mux: 'tmux', label: 'Pi', detachedAt: 1, ...over,
})

describe('configEditGuardState (#54 decision)', () => {
  it('needs the guard for an SSH config with a live session', () => {
    const s = configEditGuardState(sshConfig(), 1, [])
    expect(s).toEqual({ liveCount: 1, leftRunningCount: 0, needsGuard: true })
  })

  it('needs the guard for an SSH config with only a left-running (detached) session', () => {
    const s = configEditGuardState(sshConfig(), 0, [detached()])
    expect(s).toEqual({ liveCount: 0, leftRunningCount: 1, needsGuard: true })
  })

  it('does NOT guard an SSH config with no live or left-running session', () => {
    expect(configEditGuardState(sshConfig(), 0, []).needsGuard).toBe(false)
    // A detached entry for a DIFFERENT config does not count.
    expect(configEditGuardState(sshConfig(), 0, [detached({ configId: 'other', host: 'elsewhere' })]).needsGuard).toBe(false)
  })

  it('never guards a non-SSH (local) config, even with live sessions, and reports no left-running for it', () => {
    const s = configEditGuardState(sshConfig({ sessionType: 'local', sshConfig: undefined }), 3, [detached()])
    expect(s.needsGuard).toBe(false)
    expect(s.leftRunningCount).toBe(0)
  })

  it('does not count a detached entry whose destination the config was edited away from (orphan, #54)', () => {
    // The config now points at a different host, so its old detached session is an
    // orphan of that edit -- matchDetachedRemotes excludes it, so it is not a
    // "left running" session of THIS config any more.
    const moved = sshConfig({ sshConfig: { host: 'other.box', port: 22, username: 'mong', remotePath: '~/work' } })
    expect(configEditGuardState(moved, 0, [detached()]).leftRunningCount).toBe(0)
  })
})

/* ── the dialog ─────────────────────────────────────────────────────────────── */

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const click = (el: HTMLElement | null) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(props: Partial<React.ComponentProps<typeof ConfigEditGuardDialog>> = {}) {
  act(() => root.render(
    <ConfigEditGuardDialog
      label={props.label ?? 'Pi · miner'}
      liveCount={props.liveCount ?? 1}
      leftRunningCount={props.leftRunningCount ?? 0}
      onProceed={props.onProceed ?? (() => {})}
      onCancel={props.onCancel ?? (() => {})}
    />,
  ))
}

describe('ConfigEditGuardDialog', () => {
  it('names the config and warns about apply-on-launch and resume-break, offering Cancel / Edit anyway', () => {
    render({ label: 'Deploy box' })
    expect(q('[data-testid="config-edit-guard"]')).toBeTruthy()
    const text = container.textContent ?? ''
    expect(text).toContain('Deploy box')
    expect(text).toMatch(/apply on the next launch/i)
    expect(text).toMatch(/resuming the running session may break/i)
    expect(q('[data-testid="cfg-guard-cancel"]')?.textContent).toMatch(/Cancel/)
    expect(q('[data-testid="cfg-guard-proceed"]')?.textContent).toMatch(/Edit anyway/)
  })

  it('phrases the affected sessions from the counts (singular / plural, live + left-running)', () => {
    render({ liveCount: 1, leftRunningCount: 2 })
    const affected = q('[data-testid="cfg-guard-affected"]')?.textContent ?? ''
    expect(affected).toMatch(/a live session/)
    expect(affected).toMatch(/2 sessions left running/)
  })

  it('Edit anyway fires onProceed; Cancel fires onCancel', async () => {
    const onProceed = vi.fn(); const onCancel = vi.fn()
    render({ onProceed, onCancel })
    await click(q('[data-testid="cfg-guard-proceed"]'))
    expect(onProceed).toHaveBeenCalledTimes(1)
    render({ onProceed, onCancel })
    await click(q('[data-testid="cfg-guard-cancel"]'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
