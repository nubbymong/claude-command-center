// @vitest-environment jsdom
/**
 * SessionHeader — the single consolidated bar below the tabs. Covers the
 * work-name display (customName || label) and the orientation info folded in
 * from the former RepoBreadcrumb strip: working directory + GitHub repo
 * slug/connection. (Replaces the deleted repo-breadcrumb tests.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))
// Peripheral children — not under test here.
vi.mock('../../../src/renderer/components/NotesBar', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/TipPill', () => ({ default: () => null }))

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'web', workingDirectory: '/home/me/projects/web', model: 'sonnet',
    color: '#ff0000', status: 'idle', createdAt: 0, sessionType: 'local', configId: 'cfg-1', ...over,
  } as Session
}

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
const render = (s: Session) => act(() => { root.render(<SessionHeader session={s} />) })

describe('SessionHeader', () => {
  it('shows the config label when no custom name', () => {
    render(makeSession())
    expect(container.textContent).toContain('web')
  })

  it('shows customName over label when set', () => {
    render(makeSession({ customName: 'IM-8315 keychain' }))
    expect(container.textContent).toContain('IM-8315 keychain')
  })

  it('renders the working directory path (folded in from RepoBreadcrumb)', () => {
    render(makeSession())
    expect(container.textContent).toContain('/home/me/projects/web')
  })

  it('renders repo slug + connected state when GitHub integration is enabled', () => {
    render(makeSession({ githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true } as any }))
    expect(container.textContent).toContain('nubbymong/web')
    expect(container.textContent).toContain('connected')
  })

  it('renders no repo slug when there is no GitHub integration', () => {
    render(makeSession({ githubIntegration: undefined }))
    expect(container.textContent).not.toContain('nubbymong')
  })
})
