// @vitest-environment jsdom
/**
 * UAT R2: SessionStatusStrip -- the per-session telemetry + controls band that
 * sits above the command rows (the old ContextBar position). It reads the
 * session for THIS terminal's sessionId prop and writes controls to that PTY.
 *
 * Ports the still-relevant intent of the old BottomBar middle/right tests:
 *  - telemetry honours statusLine show* flags (model, context %, tokens, ...)
 *  - Model / Compact / Restart controls present + write to the right pty
 *  - provider gating (codex hides the Claude controls)
 *  - Model pill shows the real short name, never a bare "default"
 *  - rate-limit + codex-review rows render
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include glob.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULT_STATUS_LINE = {
  showModel: true,
  showEffort: true,
  showAccount: true,
  showTokens: true,
  showContextBar: true,
  showCost: true,
  showLinesChanged: true,
  showDuration: true,
  showRateLimits: true,
  showResetTime: true,
  font: 'sans',
  fontSize: 12,
}

const claudeSession = {
  id: 'sess-claude',
  provider: 'claude',
  modelName: 'sonnet',
  model: 'sonnet',
  contextPercent: 42,
  costUsd: 0.1,
  rateLimitCurrent: 30,
  rateLimitCurrentResets: '2026-05-25T13:30:00.000Z',
}
const codexSession = {
  id: 'sess-codex',
  provider: 'codex',
  modelName: 'gpt-5.5',
  model: 'gpt-5.5',
  contextPercent: 12,
  costUsd: 0.2,
  rateLimitCurrent: 41,
}

let sessionState: { activeSessionId: string | null; sessions: any[] } = {
  activeSessionId: claudeSession.id,
  sessions: [claudeSession],
}

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (selector: (s: typeof sessionState) => unknown) => selector(sessionState)
  useSessionStore.getState = () => sessionState
  return { useSessionStore }
})

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { statusLine: DEFAULT_STATUS_LINE, theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { DEFAULT_STATUS_LINE, useSettingsStore }
})

const mockCodexReview = vi.fn<[string | null], any>(() => null)
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({
  useCodexReviewUsage: (id: string | null) => mockCodexReview(id),
}))

const mockRestart = vi.fn()
const mockRecover = vi.fn()
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({
  useRestartSession: () => ({ restart: mockRestart, recover: mockRecover }),
}))

const ptyWrite = vi.fn()
;(globalThis as any).window.electronAPI = {
  pty: { write: ptyWrite },
}

const { default: SessionStatusStrip } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionState = { activeSessionId: claudeSession.id, sessions: [claudeSession] }
  mockCodexReview.mockReset()
  mockCodexReview.mockReturnValue(null)
  ptyWrite.mockReset()
  mockRestart.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render(sessionId: string): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SessionStatusStrip, { sessionId }))
    await Promise.resolve()
  })
}

function buttonByTitle(title: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('title') === title,
  )
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent ?? '').includes(text),
  )
}

describe('SessionStatusStrip -- telemetry', () => {
  it('renders model name and context % honouring statusLine flags', async () => {
    await render(claudeSession.id)
    expect(container.textContent).toContain('sonnet')
    expect(container.textContent).toContain('42%')
  })

  it('renders formatted token counts when showTokens and token data present', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, inputTokens: 5000, contextWindowSize: 200000 }],
    }
    await render(claudeSession.id)
    expect(container.textContent).toContain('5k')
    expect(container.textContent).toContain('200k')
  })

  it('renders formatted duration when showDuration and totalDurationMs present', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, totalDurationMs: 90000 }],
    }
    await render(claudeSession.id)
    expect(container.textContent).toMatch(/\d+[ms]/)
  })

  it('renders a 5h RateLimitBar when showRateLimits + rateLimitCurrent set', async () => {
    await render(claudeSession.id)
    expect(container.textContent).toContain('5h')
  })

  it('renders the codex-review count when usage record has reviews', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, enableCodexReview: true }],
    }
    mockCodexReview.mockReturnValue({
      sessionId: claudeSession.id,
      reviewCount: 4,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      lastRateLimitWindow: null,
      lastReviewAt: Date.now(),
    })
    await render(claudeSession.id)
    expect(container.textContent).toContain('review 4')
  })

  it('renders nothing for an unknown sessionId', async () => {
    await render('does-not-exist')
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(container.textContent).toBe('')
  })
})

describe('SessionStatusStrip -- controls (Claude)', () => {
  it('renders Model / Compact / Restart controls (Mode button removed)', async () => {
    await render(claudeSession.id)
    expect(buttonByTitle('Permission mode')).toBeFalsy()
    expect(buttonByTitle('Model')).toBeTruthy()
    expect(buttonByTitle('Compact the conversation')).toBeTruthy()
    expect(buttonByTitle('Restart session')).toBeTruthy()
  })

  it('Compact writes /compact to THIS session pty', async () => {
    await render(claudeSession.id)
    act(() => { buttonByTitle('Compact the conversation')!.click() })
    expect(ptyWrite).toHaveBeenCalledWith(claudeSession.id, '/compact\n')
  })

  it('selecting a model writes /model <value> to THIS session pty', async () => {
    await render(claudeSession.id)
    act(() => { buttonByTitle('Model')!.click() })
    const opt = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('Opus') && !(b.textContent ?? '').includes('1M'),
    )
    expect(opt).toBeTruthy()
    act(() => { opt!.click() })
    expect(ptyWrite).toHaveBeenCalledWith(claudeSession.id, '/model opus\n')
  })

  it('Restart invokes the restart hook', async () => {
    await render(claudeSession.id)
    act(() => { buttonByTitle('Restart session')!.click() })
    expect(mockRestart).toHaveBeenCalledTimes(1)
  })

  it('Model pill shows a muted "model" placeholder, never a bare "default"', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, modelName: undefined, model: '' }],
    }
    await render(claudeSession.id)
    const modelBtn = buttonByTitle('Model')
    expect(modelBtn).toBeTruthy()
    expect(modelBtn!.textContent).toBe('model')
    expect(modelBtn!.textContent).not.toContain('default')
  })
})

describe('SessionStatusStrip -- account chip', () => {
  it('renders the account name + dot when accountEmail is set', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, accountEmail: 'nicholas@example.com', accountColour: 'mauve' }],
    }
    await render(claudeSession.id)
    const chip = container.querySelector('[data-testid="account-chip"]') as HTMLElement | null
    expect(chip).toBeTruthy()
    // No profile/alias resolved in this test, so the visible name is the email,
    // and the full email lives in the title tooltip.
    expect(chip!.textContent).toContain('nicholas@example.com')
    expect(chip!.getAttribute('title')).toBe('nicholas@example.com')
  })

  it('renders no account chip when accountEmail is absent', async () => {
    await render(claudeSession.id)
    expect(container.querySelector('[data-testid="account-chip"]')).toBeNull()
  })
})

describe('SessionStatusStrip -- provider gating', () => {
  it('hides the Claude controls for a codex session but keeps telemetry', async () => {
    sessionState = { activeSessionId: codexSession.id, sessions: [codexSession] }
    await render(codexSession.id)
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(buttonByTitle('Compact the conversation')).toBeUndefined()
    expect(buttonByTitle('Restart session')).toBeUndefined()
    // Telemetry still renders
    expect(container.textContent).toContain('gpt-5.5')
    expect(container.textContent).toContain('12%')
  })
})
