// @vitest-environment jsdom
/**
 * ResumeSessionsPrompt unit tests — the startup gate that stops saved sessions
 * from force-resuming every boot ("Don't open" option).
 *
 * Props-driven (App owns the pending saved state): renders the saved-session
 * count, "Resume" fires onResume, "Don't open" fires onDontOpen. Mouse-only —
 * no autofocus, tabIndex=-1 — so it never steals focus from a terminal.
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ResumeSessionsPrompt } = await import('../../../src/renderer/components/ResumeSessionsPrompt')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

function renderComponent(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

const buttonByText = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

const mkSessions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Config ${i}` }))

describe('ResumeSessionsPrompt: whose conversations stay resumable, by provider', () => {
  const note = (sessions: Array<{ id: string; label: string; provider?: string; shellOnly?: boolean }>) => {
    const { container, unmount } = renderComponent(<ResumeSessionsPrompt sessions={sessions} onResume={() => {}} onDontOpen={() => {}} />)
    const text = container.querySelector('[data-testid="resume-sessions-note"]')!.textContent
    unmount()
    return text
  }

  it('Codex sessions only: Codex conversations, resumable from inside Codex; Claude is not named', () => {
    const t = note([{ id: 'a', label: 'Codex Lab', provider: 'codex' }])
    expect(t).toBe('Saved from your last run. "Don\'t open" discards these cards; your Codex conversations stay resumable from inside Codex.')
    expect(t).not.toContain('Claude')
  })

  it('Claude sessions (a saved session with no provider is Claude): as before', () => {
    expect(note([{ id: 'a', label: 'Web App' }, { id: 'b', label: 'API', provider: 'claude' }]))
      .toBe('Saved from your last run. "Don\'t open" discards these cards; your Claude conversations stay resumable from inside Claude.')
  })

  it('both: each named; a terminal-only session has no conversation to keep', () => {
    expect(note([{ id: 'a', label: 'Web App', provider: 'claude' }, { id: 'b', label: 'Codex Lab', provider: 'codex' }]))
      .toBe('Saved from your last run. "Don\'t open" discards these cards; your Claude and Codex conversations stay resumable from inside Claude and Codex.')
    expect(note([{ id: 'a', label: 'Shell', provider: 'claude', shellOnly: true }])).toBe('Saved from your last run. "Don\'t open" discards these cards.')
  })
})

describe('ResumeSessionsPrompt: every saved session is listed; one whose provider cannot launch is tagged (it reopens as Not started)', () => {
  const setProviders = (over: { claudeEnabled?: boolean; codexEnabled?: boolean }) =>
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } })
  const three = [
    { id: 'c', label: 'Claude job', provider: 'claude' },
    { id: 'x', label: 'Codex job', provider: 'codex' },
    { id: 'sh', label: 'Shell', provider: 'claude', shellOnly: true },
  ]
  const tags = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid="resume-session-launch-blocked"]')).map((t) => ({
      tag: t.textContent, title: t.getAttribute('title'), row: t.closest('li')!.textContent,
    }))

  it('Codex off: the Codex session wears the launch surfaces\' tag, titled with what its tab will read; the rest are untagged and nothing is dropped', () => {
    setProviders({ claudeEnabled: true, codexEnabled: false })
    const { container, unmount } = renderComponent(<ResumeSessionsPrompt sessions={three} onResume={() => {}} onDontOpen={() => {}} />)
    expect(container.querySelectorAll('li')).toHaveLength(3)
    expect(tags(container)).toEqual([{ tag: 'Codex off', title: 'Not started. Codex is off. Turn it on in Settings, Accounts, then Restart this tab.', row: 'Codex jobCodex off' }])
    unmount()
  })

  it('Codex not set up, and Claude Code off (a terminal-only session runs no Claude, so it is never tagged)', () => {
    setProviders({ claudeEnabled: true })
    let r = renderComponent(<ResumeSessionsPrompt sessions={three} onResume={() => {}} onDontOpen={() => {}} />)
    expect(tags(r.container).map((t) => [t.tag, t.title])).toEqual([['Codex not set up', 'Not started. Codex is not set up yet. Set it up in Settings, Accounts, then Restart this tab.']])
    r.unmount()
    setProviders({ claudeEnabled: false, codexEnabled: true })
    r = renderComponent(<ResumeSessionsPrompt sessions={three} onResume={() => {}} onDontOpen={() => {}} />)
    expect(tags(r.container).map((t) => [t.tag, t.row])).toEqual([['Claude Code off', 'Claude jobClaude Code off']])
    r.unmount()
  })

  it('the tag follows the switch live: turning Codex on while the prompt is up clears it', () => {
    setProviders({ claudeEnabled: true, codexEnabled: false })
    const { container, unmount } = renderComponent(<ResumeSessionsPrompt sessions={three} onResume={() => {}} onDontOpen={() => {}} />)
    expect(tags(container)).toHaveLength(1)
    act(() => { setProviders({ claudeEnabled: true, codexEnabled: true }) })
    expect(tags(container)).toHaveLength(0)
    expect(container.querySelectorAll('li')).toHaveLength(3)
    unmount()
    setProviders({})
  })
})

describe('ResumeSessionsPrompt', () => {
  it('renders the saved-session count', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt sessions={mkSessions(3)} onResume={() => {}} onDontOpen={() => {}} />,
    )
    expect(container.textContent).toContain('3')
    expect(buttonByText(container, 'Resume')).toBeTruthy()
    expect(buttonByText(container, "Don't open")).toBeTruthy()
    unmount()
  })

  it('lists each session by its work name (customName primary, label as sub-line)', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt
        sessions={[
          { id: 'a', label: 'sonnet · ~/proj', customName: 'IM-8315 keychain fix' },
          { id: 'b', label: 'opus · ~/other' },
        ]}
        onResume={() => {}}
        onDontOpen={() => {}}
      />,
    )
    const items = Array.from(container.querySelectorAll('li'))
    // Named session: customName is the primary line, label shown as a sub-line.
    const named = items.find((li) => li.textContent?.includes('IM-8315 keychain fix'))!
    expect(named).toBeTruthy()
    expect(named.querySelector('div')?.textContent).toBe('IM-8315 keychain fix')
    expect(named.textContent).toContain('sonnet · ~/proj')
    // Unnamed session: label is the primary (and only) line.
    const unnamed = items.find((li) => li.textContent === 'opus · ~/other')!
    expect(unnamed).toBeTruthy()
    unmount()
  })

  it('shows a refresh control only when onRefresh is given, and it fires onRefresh', async () => {
    const onRefresh = vi.fn()
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt
        sessions={mkSessions(1)}
        onResume={() => {}}
        onDontOpen={() => {}}
        onRefresh={onRefresh}
      />,
    )
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh sessions"]')
    expect(refresh).toBeTruthy()
    await act(async () => { refresh!.click() })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('omits the refresh control when onRefresh is not provided', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt sessions={mkSessions(1)} onResume={() => {}} onDontOpen={() => {}} />,
    )
    expect(container.querySelector('button[aria-label="Refresh sessions"]')).toBeNull()
    unmount()
  })

  it('Resume fires onResume (and not onDontOpen)', () => {
    const onResume = vi.fn()
    const onDontOpen = vi.fn()
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt sessions={mkSessions(1)} onResume={onResume} onDontOpen={onDontOpen} />,
    )
    act(() => { buttonByText(container, 'Resume')!.click() })
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onDontOpen).not.toHaveBeenCalled()
    unmount()
  })

  it("Don't open fires onDontOpen (and not onResume)", () => {
    const onResume = vi.fn()
    const onDontOpen = vi.fn()
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt sessions={mkSessions(2)} onResume={onResume} onDontOpen={onDontOpen} />,
    )
    act(() => { buttonByText(container, "Don't open")!.click() })
    expect(onDontOpen).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
    unmount()
  })

  it('never steals focus (no autofocus; dialog tabIndex=-1)', () => {
    const { container, unmount } = renderComponent(
      <ResumeSessionsPrompt sessions={mkSessions(1)} onResume={() => {}} onDontOpen={() => {}} />,
    )
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)
    unmount()
  })
})
