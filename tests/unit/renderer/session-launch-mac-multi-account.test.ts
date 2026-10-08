// @vitest-environment jsdom
// canSwitchAccountForSession on macOS: off under D2, on only with the
// experimental macOS multi-account setting (src/shared/mac-multi-account.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { canSwitchAccountForSession } from '../../../src/renderer/utils/sessionLaunch'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

const setPlatform = (p: string) => { ;(window as unknown as { electronPlatform: string }).electronPlatform = p }
const setFlag = (on: boolean | undefined) => useSettingsStore.setState({
  settings: { ...DEFAULT_SETTINGS, ...(on === undefined ? {} : { experimentalMacMultiAccount: on }) },
  isLoaded: true,
})

afterEach(() => { setPlatform('win32'); setFlag(undefined) })

describe('canSwitchAccountForSession and the macOS setting', () => {
  const ok = { provider: 'claude' as const, profileCount: 2 }

  it('macOS, setting absent or off: never', () => {
    setPlatform('darwin')
    setFlag(undefined)
    expect(canSwitchAccountForSession(ok)).toBe(false)
    setFlag(false)
    expect(canSwitchAccountForSession(ok)).toBe(false)
  })

  it('macOS, setting on: the usual rule (local Claude, 2+ profiles, not SSH, not shell-only)', () => {
    setPlatform('darwin')
    setFlag(true)
    expect(canSwitchAccountForSession(ok)).toBe(true)
    expect(canSwitchAccountForSession({ ...ok, isSsh: true })).toBe(false)
    expect(canSwitchAccountForSession({ ...ok, shellOnly: true })).toBe(false)
    expect(canSwitchAccountForSession({ ...ok, profileCount: 1 })).toBe(false)
    expect(canSwitchAccountForSession({ ...ok, provider: 'codex' })).toBe(false)
  })

  it('Windows and Linux: the setting changes nothing', () => {
    for (const p of ['win32', 'linux']) {
      setPlatform(p)
      for (const f of [undefined, false, true]) {
        setFlag(f)
        expect(canSwitchAccountForSession(ok), `${p} ${String(f)}`).toBe(true)
      }
    }
  })
})
