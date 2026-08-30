// @vitest-environment jsdom
/**
 * #570: the machine badge on a cluster mark says WHICH SIDE ("this PC" /
 * "remote"), never which host. Rendering the raw host (a 15-char IP like
 * 192.168.50.201) in an absolutely positioned mini-badge made it overhang the
 * neighbouring command buttons as a floating pill (rc.10). The host itself
 * stays in the cluster tooltip (clusterTitle) and the session header.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { TargetMark } from '../../../src/renderer/components/command-bar/chips'
import { sessionCapabilities } from '../../../src/renderer/lib/session-capabilities'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ssh = (over: Record<string, unknown> = {}) => ({
  provider: 'claude',
  sessionType: 'ssh',
  configId: 'cfg',
  sshConfig: { host: '192.168.50.201', port: 22, username: 'pi', remotePath: '/' },
  ...over,
}) as never

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: React.ReactElement): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

describe('TargetMark machine badge (#570)', () => {
  it('labels the agent cluster "remote" on SSH — never the raw host/IP', () => {
    const caps = sessionCapabilities(ssh())
    render(<TargetMark kind="agent" caps={caps} />)
    const badge = host!.querySelector('[data-testid="command-machine-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('remote')
    expect(badge!.textContent).not.toContain('192.168')
    // The host stays reachable: the cluster tooltip names it.
    const mark = host!.querySelector('[data-testid="command-cluster-agent"]')
    expect(mark!.getAttribute('title')).toContain('192.168.50.201')
  })

  it('labels the main-shell cluster "remote" and the partner cluster "this PC" on SSH', () => {
    const caps = sessionCapabilities(ssh())
    render(
      <>
        <TargetMark kind="main-shell" caps={caps} />
        <TargetMark kind="partner" caps={caps} />
      </>,
    )
    const badges = Array.from(host!.querySelectorAll('[data-testid="command-machine-badge"]')).map((b) => b.textContent)
    expect(badges).toEqual(['remote', 'this PC'])
  })

  it('shows no badge at all when both panes are on this PC', () => {
    const caps = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
    render(<TargetMark kind="agent" caps={caps} />)
    expect(host!.querySelector('[data-testid="command-machine-badge"]')).toBeNull()
  })
})
