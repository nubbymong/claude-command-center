// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import AccountPanel from '../../../src/renderer/components/github/config/AccountPanel'
import AccountsSection from '../../../src/renderer/components/github/config/AccountsSection'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import type {
  AuthProfile,
  Capability,
  GitHubAuthFeatureKey,
  GitHubConfig,
  ReauthResult,
} from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// electronAPI surface used by the panel: Test button (testProfile), the
// kind-aware re-auth (reauthProfile), the device-flow poll (oauthPoll), the
// cancel path (oauthCancel), and the external-link opener (shell.openExternal).
const testProfileMock = vi.fn().mockResolvedValue({ ok: true, username: 'work-user' })
const reauthProfileMock = vi.fn<(id: string) => Promise<ReauthResult>>()
// Never-resolving by default so the device-flow modal stays mounted on "Waiting".
const oauthPollMock = vi.fn(() => new Promise<{ ok: boolean }>(() => {}))
const oauthCancelMock = vi.fn().mockResolvedValue({ ok: true })
const openExternalMock = vi.fn().mockResolvedValue(undefined)
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  github: {
    ...((globalThis as any).window?.electronAPI?.github ?? {}),
    testProfile: testProfileMock,
    reauthProfile: reauthProfileMock,
    oauthPoll: oauthPollMock,
    oauthCancel: oauthCancelMock,
  },
  shell: {
    ...((globalThis as any).window?.electronAPI?.shell ?? {}),
    openExternal: openExternalMock,
  },
}

function flush() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

const allOn: Record<GitHubAuthFeatureKey, boolean> = {
  activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, aiCredits: true,
}

// Capabilities that cover all six auth features (pulls, actions, issues,
// notifications, plan). Profile 'a' is fully covered; profile 'b' is missing
// `plan` so aiCredits-on -> pending re-auth.
const FULL_CAPS: Capability[] = ['pulls', 'actions', 'issues', 'notifications', 'plan']
const CAPS_NO_PLAN: Capability[] = ['pulls', 'actions', 'issues', 'notifications']

function makeProfile(
  id: string,
  caps: Capability[],
  toggles?: Record<GitHubAuthFeatureKey, boolean>,
  kind: AuthProfile['kind'] = 'oauth',
): AuthProfile {
  return {
    id,
    kind,
    label: id === 'a' ? 'Work' : 'Personal',
    username: id === 'a' ? 'work-user' : 'personal-user',
    scopes: ['repo', 'workflow'],
    capabilities: caps,
    createdAt: 0,
    lastVerifiedAt: 0,
    expiryObservable: false,
    featureToggles: toggles,
  }
}

function makeConfig(profiles: AuthProfile[]): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, localGit: true, sessionContext: true,
    },
    featureDefaults: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: false,
    },
    appWideToggles: { localGit: true, sessionContext: true },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

function makeSession(id: string, label: string, authProfileId?: string): Session {
  return {
    id,
    label,
    workingDirectory: '/repo',
    model: 'opus',
    color: '#fff',
    status: 'idle',
    createdAt: 0,
    sessionType: 'local',
    githubIntegration: authProfileId
      ? { enabled: true, authProfileId, autoDetected: false }
      : undefined,
  }
}

function seedGitHub(
  config: GitHubConfig,
  actions?: {
    setProfileFeature?: ReturnType<typeof vi.fn>
    applyProfileToAll?: ReturnType<typeof vi.fn>
    removeProfile?: ReturnType<typeof vi.fn>
    renameProfile?: ReturnType<typeof vi.fn>
    loadConfig?: ReturnType<typeof vi.fn>
    loadAiUsage?: ReturnType<typeof vi.fn>
  },
) {
  useGitHubStore.setState({
    config,
    profiles: Object.values(config.authProfiles),
    setProfileFeature: actions?.setProfileFeature ?? vi.fn(),
    applyProfileToAll: actions?.applyProfileToAll ?? vi.fn(),
    removeProfile: actions?.removeProfile ?? vi.fn(),
    renameProfile: actions?.renameProfile ?? vi.fn(),
    loadConfig: actions?.loadConfig ?? vi.fn().mockResolvedValue(undefined),
    loadAiUsage: actions?.loadAiUsage ?? vi.fn().mockResolvedValue(undefined),
  } as never)
}

function seedSessions(sessions: Session[]) {
  useSessionStore.setState({ sessions } as never)
}

function switchFor(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLElement
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  useGitHubStore.setState({ config: null, profiles: [] } as never)
  useSessionStore.setState({ sessions: [] } as never)
  vi.restoreAllMocks()
  testProfileMock.mockClear().mockResolvedValue({ ok: true, username: 'work-user' })
  reauthProfileMock.mockReset()
  oauthPollMock.mockClear().mockImplementation(() => new Promise<{ ok: boolean }>(() => {}))
  oauthCancelMock.mockClear().mockResolvedValue({ ok: true })
  openExternalMock.mockClear().mockResolvedValue(undefined)
})

describe('AccountPanel', () => {
  it('single body, no Status/Features tabs: every feature row renders directly', () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    const r = render(<AccountPanel profile={b} index={0} />)
    // No tab strip buttons.
    expect(buttonByText(r.container, 'Status & permissions')).toBeUndefined()
    expect(buttonByText(r.container, 'Features')).toBeUndefined()
    // All six feature labels render in one body with no tab click.
    for (const label of [
      'Active PR card', 'CI / Actions', 'Reviews & comments',
      'Linked issues', 'Notifications inbox', 'AI credits usage',
    ]) {
      expect(r.container.textContent).toContain(label)
    }
    r.unmount()
  })

  it('header shows the pending chip for an uncovered profile and not for a covered one', () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    const rb = render(<AccountPanel profile={b} index={0} />)
    expect(rb.container.textContent).toContain('re-auth needed')
    expect(rb.container.textContent).toContain('AI credits usage')
    rb.unmount()

    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    const ra = render(<AccountPanel profile={a} index={0} />)
    expect(ra.container.textContent).not.toContain('re-auth needed')
    ra.unmount()
  })

  it('coverage hint per row: uncovered aiCredits shows "needs user", covered rows show "covered"', () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    const r = render(<AccountPanel profile={b} index={0} />)
    const text = r.container.textContent ?? ''
    // aiCredits is uncovered (missingScopeForFeature -> 'user').
    expect(text).toContain('needs')
    expect(text).toContain('user')
    // The five covered features show the "covered" marker.
    expect(text).toContain('covered')
    r.unmount()
  })

  it('"Powers 5 of 6" and the bound live session show in the single body', () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    seedSessions([
      makeSession('s1', 'fix the parser', 'b'),
      makeSession('s2', 'unrelated', undefined),
    ])
    const r = render(<AccountPanel profile={b} index={0} />)
    expect(r.container.textContent).toContain('Powers 5 of 6')
    expect(r.container.textContent).toContain('fix the parser')
    r.unmount()
  })

  it('"no live sessions right now" when none are bound', () => {
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    seedSessions([makeSession('s1', 'something', undefined)])
    const r = render(<AccountPanel profile={a} index={0} />)
    expect(r.container.textContent).toContain('no live sessions right now')
    r.unmount()
  })

  it('toggling a feature calls setProfileFeature with the inverse', () => {
    const setProfileFeature = vi.fn()
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]), { setProfileFeature })
    const r = render(<AccountPanel profile={b} index={0} />)
    const sw = switchFor(r.container, 'AI credits usage')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setProfileFeature).toHaveBeenCalledWith('b', 'aiCredits', false)
    r.unmount()
  })

  it('pending footer + oauth re-auth: ONE button calls reauthProfile and renders the device flow', async () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([b]))
    reauthProfileMock.mockResolvedValue({
      ok: true,
      plan: { kind: 'oauth', mode: 'private', scopes: ['user'] },
      flow: {
        flowId: 'f1',
        userCode: 'AB-CD',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      },
    })
    const r = render(<AccountPanel profile={b} index={0} />)
    // Footer announces the re-auth count and offers exactly one re-auth button.
    const footerText = r.container.textContent ?? ''
    expect(footerText).toContain('need')
    expect(/re-authoriz/i.test(footerText)).toBe(true)
    const reauthBtn = buttonByText(r.container, 'Re-authorize this account')
    expect(reauthBtn).toBeTruthy()
    act(() => {
      reauthBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(reauthProfileMock).toHaveBeenCalledWith('b')
    // Device-flow modal mounted.
    const after = r.container.textContent ?? ''
    expect(after.includes('AB-CD') || after.includes('Sign in with GitHub')).toBe(true)
    r.unmount()
  })

  it('pat-classic re-auth shows inline instructions and NO device flow', async () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn, 'pat-classic')
    seedGitHub(makeConfig([b]))
    reauthProfileMock.mockResolvedValue({
      ok: true,
      plan: {
        kind: 'pat-classic',
        instruction: 'Edit this classic token and add the `user` scope, then re-save it here.',
        scopes: ['user'],
      },
    })
    const r = render(<AccountPanel profile={b} index={0} />)
    act(() => {
      buttonByText(r.container, 'Re-authorize this account')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await flush()
    const text = r.container.textContent ?? ''
    // Driven by plan.instruction (contains 'user' + 'scope').
    expect(text).toContain('user')
    expect(text).toContain('scope')
    // No device flow.
    expect(text).not.toContain('Sign in with GitHub')
    r.unmount()
  })

  it('gh-cli re-auth renders the computed refresh command and NO device flow', async () => {
    const b = makeProfile('b', CAPS_NO_PLAN, allOn, 'gh-cli')
    seedGitHub(makeConfig([b]))
    reauthProfileMock.mockResolvedValue({
      ok: true,
      plan: {
        kind: 'gh-cli',
        command: 'gh auth refresh -h github.com -s user',
        scopes: ['user'],
      },
    })
    const r = render(<AccountPanel profile={b} index={0} />)
    act(() => {
      buttonByText(r.container, 'Re-authorize this account')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await flush()
    const text = r.container.textContent ?? ''
    // Driven by plan.command (the exact gh auth refresh line), no device flow.
    expect(text).toContain('gh auth refresh -h github.com -s user')
    expect(text).not.toContain('Sign in with GitHub')
    r.unmount()
  })

  it('"Apply to all accounts" calls applyProfileToAll and is absent with a single profile', () => {
    const applyProfileToAll = vi.fn()
    const a = makeProfile('a', FULL_CAPS, allOn)
    const b = makeProfile('b', CAPS_NO_PLAN, allOn)
    seedGitHub(makeConfig([a, b]), { applyProfileToAll })
    const r = render(<AccountPanel profile={a} index={0} />)
    const applyBtn = buttonByText(r.container, 'Apply to all accounts')
    expect(applyBtn).toBeTruthy()
    act(() => {
      applyBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(applyProfileToAll).toHaveBeenCalledWith('a')
    r.unmount()

    // single profile -> no Apply button
    seedGitHub(makeConfig([a]), { applyProfileToAll })
    const r2 = render(<AccountPanel profile={a} index={0} />)
    expect(buttonByText(r2.container, 'Apply to all accounts')).toBeUndefined()
    r2.unmount()
  })

  it('marks a feature that differs across accounts and leaves agreeing ones unmarked', () => {
    // a: aiCredits ON; b: aiCredits OFF -> masterState('aiCredits') === 'mixed'.
    const a = makeProfile('a', FULL_CAPS, allOn)
    const b = makeProfile('b', FULL_CAPS, { ...allOn, aiCredits: false })
    seedGitHub(makeConfig([a, b]))
    const r = render(<AccountPanel profile={a} index={0} />)
    const differs = Array.from(r.container.querySelectorAll('*')).filter(
      (el) => el.childElementCount === 0 && el.textContent === 'differs across accounts',
    )
    expect(differs).toHaveLength(1)
    r.unmount()

    seedGitHub(makeConfig([makeProfile('a', FULL_CAPS, allOn), makeProfile('b', FULL_CAPS, allOn)]))
    const r2 = render(<AccountPanel profile={makeProfile('a', FULL_CAPS, allOn)} index={0} />)
    expect(r2.container.textContent).not.toContain('differs across accounts')
    r2.unmount()
  })

  it('Test button calls testProfile and renders the result', async () => {
    testProfileMock.mockClear().mockResolvedValue({ ok: true, username: 'work-user' })
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]))
    const r = render(<AccountPanel profile={a} index={0} />)
    act(() => {
      buttonByText(r.container, 'Test')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(testProfileMock).toHaveBeenCalledWith('a')
    expect(r.container.textContent).toContain('work-user')
    r.unmount()
  })

  it('rename double-fire guard: Enter then blur fires renameProfile once', async () => {
    // commitRename runs on BOTH Enter (onKeyDown) and the blur it triggers; the
    // renamingRef guard must collapse the pair into a single IPC call.
    let resolveRename: () => void = () => {}
    const renameProfile = vi.fn().mockImplementation(
      () => new Promise<void>((res) => { resolveRename = res }),
    )
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]), { renameProfile })
    const r = render(<AccountPanel profile={a} index={0} />)
    act(() => {
      buttonByText(r.container, 'Rename')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = r.container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      // React delegates onBlur to the bubbling 'focusout' event, not 'blur'.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(renameProfile).toHaveBeenCalledTimes(1)
    act(() => { resolveRename() })
    await flush()
    r.unmount()
  })

  it('Remove keeps the confirm() guard: confirm=false does not call removeProfile', () => {
    const removeProfile = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const a = makeProfile('a', FULL_CAPS, allOn)
    seedGitHub(makeConfig([a]), { removeProfile })
    const r = render(<AccountPanel profile={a} index={0} />)
    const removeBtn = buttonByText(r.container, 'Remove')
    act(() => {
      removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(removeProfile).not.toHaveBeenCalled()
    r.unmount()
  })
})

describe('AccountsSection', () => {
  it('renders the empty card when there are no profiles', () => {
    seedGitHub(makeConfig([]))
    seedSessions([])
    const r = render(<AccountsSection />)
    expect(r.container.textContent).toContain('No auth profiles yet')
    // and the primary add button
    expect(r.container.textContent).toContain('Sign in with GitHub')
    r.unmount()
  })

  it('renders one AccountPanel per profile', () => {
    seedGitHub(makeConfig([makeProfile('a', FULL_CAPS, allOn), makeProfile('b', CAPS_NO_PLAN, allOn)]))
    seedSessions([])
    const r = render(<AccountsSection />)
    expect(r.container.textContent).toContain('Work')
    expect(r.container.textContent).toContain('Personal')
    r.unmount()
  })
})
