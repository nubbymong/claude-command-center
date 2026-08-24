// @vitest-environment jsdom
/**
 * #442 — clicking "New pipeline" in the Agent Hub crashed the whole app.
 *
 * The crash: TeamBuilder selected `s.getAllTemplates()` from the agent library
 * store — a method that builds a FRESH array every call. Zustand's Object.is
 * equality never holds, useSyncExternalStore re-renders for ever, React throws
 * "Maximum update depth exceeded" the moment the dialog mounts, and the
 * app-wide ErrorBoundary takes the window down.
 *
 * The save-failure suite never saw it because it stubs the store with a plain
 * selector call — no subscription, no re-render loop. So THIS file mounts
 * TeamBuilder against the REAL agentLibraryStore: with the bad selector the
 * mount itself throws and the test fails; with the fix it renders. Only
 * config-saver is stubbed (disk writes are not the point).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(),
  registerConfigSaver: vi.fn(),
}))

const { default: TeamBuilder } = await import('../../../src/renderer/components/TeamBuilder')
const { useAgentLibraryStore, BUILTIN_TEMPLATES } = await import('../../../src/renderer/stores/agentLibraryStore')
const { useTeamStore } = await import('../../../src/renderer/stores/teamStore')

describe('TeamBuilder mounts against the real agent library store (#442)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useTeamStore.setState({ editingTeam: null } as any)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('New Pipeline renders instead of tripping the update-depth guard', () => {
    act(() => {
      root.render(<TeamBuilder onClose={() => {}} />)
    })
    expect(container.textContent).toContain('New Pipeline')
    // The step picker is fed by the store: built-ins must be offered even with
    // no user templates, or "Add step" silently no-ops.
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThan(0)
  })

  it('a user template arriving re-renders the open dialog without looping', () => {
    act(() => {
      root.render(<TeamBuilder onClose={() => {}} />)
    })
    act(() => {
      useAgentLibraryStore.setState({
        templates: [{ id: 'u1', name: 'My Agent', description: '', systemPrompt: '', createdAt: 1, updatedAt: 1 } as any],
      })
    })
    expect(container.textContent).toContain('New Pipeline')
    act(() => { useAgentLibraryStore.setState({ templates: [] }) })
  })
})
