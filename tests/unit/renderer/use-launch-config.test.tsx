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

// SSH tmux enhancement (items 1/3, adversarial review 2026-08-18): the SAME
// field-by-field-rebuild drop that made loggingEnabled inert (#188 above) also
// dropped the SSH persistence controls -- `detachable` (the owner's "never
// silently install tmux" opt-out) and `remoteOs` (the Windows path selector) --
// so unticking Detachable did nothing and remoteOs could never reach main. These
// pin that every SshConfig control survives config -> launched session.
describe('useLaunchConfig SSH persistence fields (items 1/3)', () => {
  beforeEach(() => { addSession.mockClear() })

  const sshBase = {
    id: 'cfg-ssh',
    label: 'remote',
    workingDirectory: '',
    color: '#fff',
    sessionType: 'ssh' as const,
    provider: 'claude' as const,
    sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', hasPassword: false },
  }

  it('carries detachable:false (the opt-out) onto the launched session', () => {
    const session = launchWith({ ...sshBase, sshConfig: { ...sshBase.sshConfig, detachable: false } })
    expect(session.sshConfig.detachable).toBe(false)
  })

  it('carries remoteOs:windows onto the launched session', () => {
    const session = launchWith({ ...sshBase, sshConfig: { ...sshBase.sshConfig, remoteOs: 'windows' } })
    expect(session.sshConfig.remoteOs).toBe('windows')
  })

  it('leaves detachable/remoteOs undefined (defaults) when unset -- persistence ON, POSIX', () => {
    const session = launchWith({ ...sshBase })
    expect(session.sshConfig.detachable).toBeUndefined()
    expect(session.sshConfig.remoteOs).toBeUndefined()
  })
})
