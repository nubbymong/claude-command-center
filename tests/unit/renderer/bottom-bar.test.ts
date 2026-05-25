// @vitest-environment jsdom
/**
 * P4 Task B: app-level BottomBar (A') -- single row, three zones:
 *  LEFT   = runtime (CLI dot+label, version, beta chip, update indicator)
 *  MIDDLE = active-session telemetry (respects statusLine show* flags)
 *  RIGHT  = controls (Mode / Model / Compact / Restart) -- Claude only
 *
 * Replaces the global StatusBar + per-session ContextBar. This file ports the
 * still-relevant intent of the old contextbar-*.test.ts files:
 *  - provider gating (codex hides Mode/Compact)         [from codex-firstturn]
 *  - codex-review row presence                          [from codex-review]
 *  - rate-limit bar rendering                           [from codex-compat]
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include glob -- matches the sibling contextbar tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Required for React 18 act() in jsdom -- suppresses "not configured" warning
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// __APP_VERSION__/__BUILD_TIME__ are esbuild `define` globals at build time.
// vitest does not apply those defines, so the bare identifiers would throw a
// ReferenceError. Provide them on globalThis before importing the component.
;(globalThis as any).__APP_VERSION__ = '9.9.9-test'
;(globalThis as any).__BUILD_TIME__ = '2026-05-25T00:00:00.000Z'

// --- shared status-line shape (all flags on) ---
const DEFAULT_STATUS_LINE = {
  showModel: true,
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

// --- mutable session-store state, swapped per test ---
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

// --- settings store: selector form + getState, beta channel ---
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = {
    settings: { statusLine: DEFAULT_STATUS_LINE, updateChannel: 'beta' as const, theme: 'dark' as const },
  }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { DEFAULT_STATUS_LINE, useSettingsStore }
})

// --- codex review usage: driven per test ---
const mockCodexReview = vi.fn<[string | null], any>(() => null)
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({
  useCodexReviewUsage: (id: string | null) => mockCodexReview(id),
}))

// --- restart hook: returns spies ---
const mockRestart = vi.fn()
const mockRecover = vi.fn()
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({
  useRestartSession: () => ({ restart: mockRestart, recover: mockRecover }),
}))

// --- electronAPI surface the bar touches ---
const ptyWrite = vi.fn()
const updateInstall = vi.fn()
;(globalThis as any).window.electronAPI = {
  pty: { write: ptyWrite },
  cli: { check: () => Promise.resolve(true) },
  update: {
    check: () => Promise.resolve(false),
    onAvailable: () => () => {},
    installAndRestart: updateInstall,
  },
}

// Import after mocks are registered
const { default: BottomBar } = await import('../../../src/renderer/components/BottomBar')

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
  updateInstall.mockReset()
  mockRestart.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render(view: 'sessions' | 'settings' = 'sessions'): Promise<void> {
  await act(async () => {
    root.render(React.createElement(BottomBar, { currentView: view, onViewChange: vi.fn() }))
    // Flush the cli.check()/update.check() promises that resolve after the
    // initial paint, so their setState lands inside an act() boundary.
    await Promise.resolve()
  })
}

/** Find a button by its title attribute (or label text fallback). */
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

describe('BottomBar -- left runtime zone', () => {
  it('renders version + CLI dot even when currentView is settings', async () => {
    await render('settings')
    // Version text "v9.9.9-test"
    expect(container.textContent).toContain('9.9.9-test')
    // CLI affordance present
    expect(container.textContent).toContain('CLI')
    // A status dot element exists (rounded-full pip)
    expect(container.querySelector('.rounded-full')).toBeTruthy()
  })

  it('shows the Beta chip on the beta channel', async () => {
    await render('settings')
    expect(buttonByText('Beta')).toBeTruthy()
  })
})

describe('BottomBar -- middle telemetry + right controls (Claude)', () => {
  it('renders model name and context % in the middle zone', async () => {
    await render('sessions')
    expect(container.textContent).toContain('sonnet')
    expect(container.textContent).toContain('42%')
  })

  it('renders Mode / Model / Compact / Restart controls', async () => {
    await render('sessions')
    expect(buttonByTitle('Permission mode')).toBeTruthy()
    expect(buttonByTitle('Model')).toBeTruthy()
    expect(buttonByTitle('Compact the conversation')).toBeTruthy()
    expect(buttonByTitle('Restart session')).toBeTruthy()
  })

  it('Compact button writes /compact to the active pty', async () => {
    await render('sessions')
    act(() => { buttonByTitle('Compact the conversation')!.click() })
    expect(ptyWrite).toHaveBeenCalledWith(claudeSession.id, '/compact\n')
  })

  it('selecting a model in the picker writes /model <value>', async () => {
    await render('sessions')
    // Open the model picker
    act(() => { buttonByTitle('Model')!.click() })
    // Click the first model option (Opus -> value "opus")
    const opt = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('Opus') && !(b.textContent ?? '').includes('1M'),
    )
    expect(opt).toBeTruthy()
    act(() => { opt!.click() })
    expect(ptyWrite).toHaveBeenCalledWith(claudeSession.id, '/model opus\n')
  })

  it('renders a 5h RateLimitBar when showRateLimits + rateLimitCurrent set', async () => {
    await render('sessions')
    expect(container.textContent).toContain('5h')
  })

  it('renders the codex-review count when usage record has reviews', async () => {
    mockCodexReview.mockReturnValue({
      sessionId: claudeSession.id,
      reviewCount: 4,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      lastRateLimitWindow: null,
      lastReviewAt: Date.now(),
    })
    await render('sessions')
    // Pin to the "review N" slot, not just any occurrence of the digit
    expect(container.textContent).toContain('review 4')
  })

  it('selecting a mode in the picker writes /permission-mode <value>', async () => {
    await render('sessions')
    act(() => { buttonByTitle('Permission mode')!.click() })
    // "Ask permissions" is the first PERMISSION_MODES entry (value: 'default')
    const opt = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('Ask permissions'),
    )
    expect(opt).toBeTruthy()
    act(() => { opt!.click() })
    expect(ptyWrite).toHaveBeenCalledWith(claudeSession.id, expect.stringMatching(/^\/permission-mode .+\n$/))
  })

  it('renders formatted token counts when showTokens is true and session has token data', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, inputTokens: 5000, contextWindowSize: 200000 }],
    }
    await render('sessions')
    // formatTokens(5000) -> "5k", formatTokens(200000) -> "200k"
    expect(container.textContent).toContain('5k')
    expect(container.textContent).toContain('200k')
  })

  it('renders formatted duration when showDuration is true and session has totalDurationMs', async () => {
    sessionState = {
      activeSessionId: claudeSession.id,
      sessions: [{ ...claudeSession, totalDurationMs: 90000 }],
    }
    await render('sessions')
    // formatDuration(90000) -> "1m 30s" or "90s" -- either way contains digits + time unit
    expect(container.textContent).toMatch(/\d+[ms]/)
  })
})

describe('BottomBar -- provider gating + view gating', () => {
  it('hides Mode/Compact controls for a codex session', async () => {
    sessionState = { activeSessionId: codexSession.id, sessions: [codexSession] }
    await render('sessions')
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(buttonByTitle('Compact the conversation')).toBeUndefined()
  })

  it('hides the right-zone cockpit on the settings view but keeps the runtime zone', async () => {
    await render('settings')
    // No controls
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(buttonByTitle('Compact the conversation')).toBeUndefined()
    expect(buttonByTitle('Restart session')).toBeUndefined()
    // Runtime zone still present
    expect(container.textContent).toContain('9.9.9-test')
    expect(container.textContent).toContain('CLI')
  })

  it('renders runtime zone but no cockpit when there is no active session', async () => {
    sessionState = { activeSessionId: null, sessions: [] }
    await render('sessions')
    expect(container.textContent).toContain('CLI')
    expect(buttonByTitle('Model')).toBeUndefined()
  })
})
