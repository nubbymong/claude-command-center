// @vitest-environment jsdom
/**
 * #371 BLOCKER-1 (renderer surface) — a refused `team:delete` now leaves the
 * pipeline row on screen, which on its own is indistinguishable from a click
 * that missed. TeamsPanel must say what happened.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useTeamStore } from '../../../src/renderer/stores/teamStore'
import type { TeamTemplate } from '../../../src/renderer/types/electron'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/agentLibraryStore', () => ({
  BUILTIN_TEMPLATES: [],
  useAgentLibraryStore: (selector: (s: any) => unknown) =>
    selector({ templates: [] }),
}))

const { default: TeamsPanel } = await import('../../../src/renderer/components/TeamsPanel')

const TEAM: TeamTemplate = {
  id: 'team-t1',
  name: 'Full Review Pipeline',
  description: 'desc',
  steps: [{ id: 'ts-1', templateId: 'builtin-code-reviewer', label: 'Code Review', mode: 'sequential' }],
  projectPath: '/dev/project',
  createdAt: 1,
  updatedAt: 1,
}

const api = () => (window as any).electronAPI.team

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    b => (b.textContent ?? '').trim() === text,
  )
  if (!match) throw new Error(`no button labelled "${text}"`)
  return match as HTMLButtonElement
}

describe('TeamsPanel delete failure (#371 BLOCKER-1)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useTeamStore.setState({
      teams: [TEAM],
      runs: [],
      selectedTeamId: 'team-t1',
      selectedRunId: null,
      showBuilder: false,
      editingTeam: null,
      error: null,
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  async function clickDelete() {
    await act(async () => {
      root.render(React.createElement(TeamsPanel))
    })
    await act(async () => {
      buttonByText(container, 'Delete').click()
    })
  }

  it('shows the failure message and keeps the row when the delete is refused', async () => {
    api().delete.mockResolvedValueOnce({
      ok: false,
      error: 'Your team library could not be written to disk.',
    })

    await clickDelete()

    expect(container.textContent).toContain('Your team library could not be written to disk.')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(useTeamStore.getState().teams.map(t => t.id)).toEqual(['team-t1'])
  })

  it('shows nothing and drops the row when the delete succeeds', async () => {
    api().delete.mockResolvedValueOnce({ ok: true, deleted: true })

    await clickDelete()

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(useTeamStore.getState().teams).toHaveLength(0)
  })
})
