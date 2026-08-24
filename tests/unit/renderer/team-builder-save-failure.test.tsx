// @vitest-environment jsdom
/**
 * #371 BLOCKER-1 (renderer surface) — TeamBuilder used to `await saveTeam(team)`
 * and then close unconditionally. When main refused or failed the disk write the
 * dialog closed anyway, the only copy of the pipeline the user had just built
 * went with it, and nothing said so. It must stay open and show why.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useTeamStore } from '../../../src/renderer/stores/teamStore'
import type { TeamTemplate } from '../../../src/renderer/types/electron'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The agent library is irrelevant to the save path; stub it so the dialog can
// render its one step row without pulling in the real store's config hydration.
// The stub serves the STABLE `templates` array (what the component now
// selects), never a method building a fresh array — that shape is the crash
// team-builder-mount.test.tsx pins against the real store.
const STUB_TEMPLATES = [{ id: 'builtin-code-reviewer', name: 'Code Reviewer' }]
vi.mock('../../../src/renderer/stores/agentLibraryStore', () => ({
  BUILTIN_TEMPLATES: [],
  useAgentLibraryStore: (selector: (s: any) => unknown) =>
    selector({ templates: STUB_TEMPLATES }),
}))

const { default: TeamBuilder } = await import('../../../src/renderer/components/TeamBuilder')

const EDITING: TeamTemplate = {
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

describe('TeamBuilder save failure (#371 BLOCKER-1)', () => {
  let container: HTMLDivElement
  let root: Root
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onClose = vi.fn()
    useTeamStore.setState({
      teams: [],
      runs: [],
      selectedTeamId: null,
      selectedRunId: null,
      showBuilder: true,
      editingTeam: EDITING,
      error: null,
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  async function clickSave() {
    await act(async () => {
      root.render(React.createElement(TeamBuilder, { onClose }))
    })
    await act(async () => {
      buttonByText(container, 'Save Changes').click()
    })
  }

  it('does NOT close the dialog when the write is refused', async () => {
    api().save.mockResolvedValueOnce({ ok: false, error: 'Your team library could not be written to disk.' })

    await clickSave()

    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the failure message from main inside the dialog', async () => {
    api().save.mockResolvedValueOnce({ ok: false, error: 'Your team library could not be written to disk.' })

    await clickSave()

    expect(container.textContent).toContain('Your team library could not be written to disk.')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('leaves the pipeline out of the store, and the editor still usable', async () => {
    api().save.mockResolvedValueOnce({ ok: false, error: 'nope' })

    await clickSave()

    expect(useTeamStore.getState().teams).toHaveLength(0)
    // Not stuck on "Saving..." — the user can correct and try again.
    expect(buttonByText(container, 'Save Changes').disabled).toBe(false)
  })

  it('closes and shows no error when the write succeeds', async () => {
    api().save.mockResolvedValueOnce({ ok: true, team: EDITING })

    await clickSave()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(useTeamStore.getState().teams.map(t => t.id)).toEqual(['team-t1'])
  })

  it('retires the previous failure message once a retry succeeds', async () => {
    api().save.mockResolvedValueOnce({ ok: false, error: 'transient disk error' })
    await clickSave()
    expect(container.textContent).toContain('transient disk error')

    api().save.mockResolvedValueOnce({ ok: true, team: EDITING })
    await act(async () => {
      buttonByText(container, 'Save Changes').click()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('transient disk error')
  })
})
