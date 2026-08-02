// @vitest-environment jsdom
/**
 * 2.1.0-beta.5 (adversarial review, #188): the sidebar/empty-state launch path
 * (`useLaunchConfig`) must copy `loggingEnabled` from the config's claudeOptions
 * onto the new session — otherwise the "Index conversation logs" opt-out never
 * reaches the spawn for a launched-from-config session (it was dropped before
 * this fix). This test fails if `loggingEnabled: config.claudeOptions?.loggingEnabled`
 * is reverted. It also pins that the retired `enableCodexReview` is NOT copied.
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const addSession = vi.fn()

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ addSession }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: any) => sel({ settings: { codexEnabled: true } }), {
    getState: () => ({ settings: { codexEnabled: true } }),
  }),
}))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: vi.fn(),
}))

import { useLaunchConfig } from '../../../src/renderer/hooks/useLaunchConfig'

function launchWith(config: any): any {
  let captured: any = null
  function Harness() {
    const launch = useLaunchConfig()
    React.useEffect(() => { launch(config) }, [])
    return null
  }
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => { root.render(React.createElement(Harness)) })
  captured = addSession.mock.calls[0]?.[0]
  act(() => { root.unmount() })
  return captured
}

describe('useLaunchConfig loggingEnabled mapping (#188)', () => {
  beforeEach(() => { addSession.mockClear() })

  const base = {
    id: 'cfg1',
    label: 'x',
    workingDirectory: 'C:\\proj',
    color: '#fff',
    sessionType: 'local' as const,
    provider: 'claude' as const,
  }

  it('copies loggingEnabled: false onto the session (the opt-out reaches the spawn)', () => {
    const session = launchWith({ ...base, claudeOptions: { loggingEnabled: false } })
    expect(session).toBeTruthy()
    expect(session.loggingEnabled).toBe(false)
  })

  it('copies loggingEnabled: true onto the session', () => {
    const session = launchWith({ ...base, claudeOptions: { loggingEnabled: true } })
    expect(session.loggingEnabled).toBe(true)
  })

  it('leaves loggingEnabled undefined (default-on) when unset', () => {
    const session = launchWith({ ...base, claudeOptions: {} })
    expect(session.loggingEnabled).toBeUndefined()
  })

  it('does NOT copy the retired enableCodexReview flag onto the session', () => {
    const session = launchWith({ ...base, claudeOptions: { enableCodexReview: true } })
    expect(session.enableCodexReview).toBeUndefined()
  })
})
