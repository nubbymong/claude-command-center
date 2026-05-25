// @vitest-environment jsdom
/**
 * P5 Task B: RepoBreadcrumb passive strip
 * Renders cwd + optional GitHub repo slug + connection state.
 * No actions -- passive orientation only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Required for React 18 act() in jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Import after flag
const { default: RepoBreadcrumb } = await import('../../../src/renderer/components/RepoBreadcrumb')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const baseSession = {
  id: 'sess-1',
  label: 'web',
  workingDirectory: '/home/me/projects/web',
  model: 'sonnet',
  color: '#ff0000',
  configId: 'cfg-1',
  shellOnly: false,
  sessionType: 'local' as const,
}

describe('RepoBreadcrumb -- with GitHub integration', () => {
  it('renders the working directory path', async () => {
    const session = {
      ...baseSession,
      githubIntegration: {
        enabled: true,
        repoSlug: 'nubbymong/web',
        autoDetected: true,
      },
    }
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session }))
    })
    expect(container.textContent).toContain('/home/me/projects/web')
  })

  it('renders the repo slug', async () => {
    const session = {
      ...baseSession,
      githubIntegration: {
        enabled: true,
        repoSlug: 'nubbymong/web',
        autoDetected: true,
      },
    }
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session }))
    })
    expect(container.textContent).toContain('nubbymong/web')
  })

  it('shows a "connected" indicator when enabled=true and slug is present', async () => {
    const session = {
      ...baseSession,
      githubIntegration: {
        enabled: true,
        repoSlug: 'nubbymong/web',
        autoDetected: true,
      },
    }
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session }))
    })
    expect(container.textContent).toContain('connected')
  })
})

describe('RepoBreadcrumb -- without GitHub integration', () => {
  it('renders the working directory path even with no githubIntegration', async () => {
    const session = { ...baseSession, githubIntegration: undefined }
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session }))
    })
    expect(container.textContent).toContain('/home/me/projects/web')
  })

  it('does not render a repo slug when githubIntegration is undefined', async () => {
    const session = { ...baseSession, githubIntegration: undefined }
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session }))
    })
    expect(container.textContent).not.toContain('nubbymong')
  })

  it('does not crash when githubIntegration is undefined', async () => {
    const session = { ...baseSession, githubIntegration: undefined }
    await expect(
      act(async () => {
        root.render(React.createElement(RepoBreadcrumb, { session }))
      })
    ).resolves.toBeUndefined()
  })
})
