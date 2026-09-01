// @vitest-environment jsdom
/**
 * Remote Resumable — the resume surface (SSH Persistent, Phase 3).
 *
 * What these pin, in the order the owner-signed-off UX states it:
 *   - the section is EVIDENCE, not furniture: no entries, no section;
 *   - the TWO-pill model — Resumable / Unreachable and nothing else. A verify in
 *     flight is NOT a pill; the card keeps its last-known one and the only hint
 *     is the host-line dot;
 *   - a click resumes with the ORIGINAL id + reconnect and consumes the entry;
 *   - a CONFIRMED-dead remote opens the modal instead, and both of its exits
 *     drop the entry (Start new also launches fresh, with a NEW id);
 *   - right-click Remove kills the remote first, and a kill FAILURE still drops
 *     the card — a card the user cannot get rid of is the worse bug;
 *   - the tier-1 ping timer exists exactly while this surface does;
 *   - a deleted saved config renders and offers Remove instead of crashing.
 *
 * Everything is mocked: no IPC, no network, no real timers except where a pulse
 * is being measured.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DetachedRemote, DetachedRemoteLiveness, HostPingResult } from '../../../src/shared/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const checkDetachedLive = vi.fn<[{ configId: string; sessionIds: string[] }], Promise<DetachedRemoteLiveness>>()
const pingHost = vi.fn<[{ host: string }], Promise<HostPingResult>>()
const endRemote = vi.fn<[string | { sessionId: string; configId?: string }], Promise<void>>()
const addSession = vi.fn()
const persistSessionState = vi.fn()

Object.defineProperty(window, 'electronAPI', {
  writable: true,
  configurable: true,
  value: { ssh: { checkDetachedLive, pingHost, endRemote }, session: { save: vi.fn() } },
})

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel({ addSession, sessions: [] }), {
    getState: () => ({ addSession, sessions: [] }),
  }),
}))
vi.mock('../../../src/renderer/session-persistence', () => ({
  persistSessionState: (...a: unknown[]) => persistSessionState(...a),
}))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => 'dark',
  useThemeController: () => {},
}))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker: vi.fn() }))
vi.mock('../../../src/renderer/stores/settingsStore', async () => {
  const { create } = await import('zustand')
  const useSettingsStore = create<any>((set: any) => ({
    isLoaded: true,
    settings: { accountAliases: {}, accountColourOverrides: {}, codexEnabled: true },
    updateSettings: (patch: any) => {
      set((s: any) => ({ settings: { ...s.settings, ...patch } }))
      return Promise.resolve()
    },
  }))
  return { useSettingsStore }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', async () => {
  const { create } = await import('zustand')
  return { useAccountProfilesStore: create(() => ({ profiles: [] })) }
})

const { default: RemoteResumableSection } = await import('../../../src/renderer/components/sidebar/RemoteResumableSection')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useDetachedLivenessStore, resetDetachedLiveness } = await import('../../../src/renderer/stores/livenessStore')
const { useHostReachabilityStore, isHostPingArmed, resetHostReachability } = await import('../../../src/renderer/stores/hostReachability')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const entry = (over: Partial<DetachedRemote> = {}): DetachedRemote => ({
  sessionId: 'det-1',
  configId: 'cfg-1',
  host: 'pi.local',
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux',
  label: 'Pi-Miner',
  detachedAt: Date.now() - 12 * 60_000,
  ...over,
})

const cfg = (over: Record<string, unknown> = {}): any => ({
  id: 'cfg-1',
  label: 'Pi-Miner',
  workingDirectory: '',
  color: '#89b4fa',
  sessionType: 'ssh',
  provider: 'claude',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
  ...over,
})

const verified = (live: string[]): DetachedRemoteLiveness => ({ outcome: 'verified', liveSessionIds: live })
const unverified: DetachedRemoteLiveness = { outcome: 'unverified', liveSessionIds: [] }

/* ── harness ──────────────────────────────────────────────────────────────── */

let container: HTMLDivElement
let root: Root
const revealed: string[] = []

async function mount(props: Partial<React.ComponentProps<typeof RemoteResumableSection>> = {}) {
  await act(async () => {
    root.render(
      <RemoteResumableSection
        liveSessionIds={props.liveSessionIds ?? []}
        onRevealSession={props.onRevealSession ?? ((id: string) => { revealed.push(id) })}
      />,
    )
  })
}

async function unmount() {
  await act(async () => { root.unmount() })
}

/**
 * Mount, then set the liveness/reachability the test wants to SHOW.
 *
 * Order matters and is the point: mounting fires the section-open verify (and
 * the one tier-1 ping pass), both of which write the very maps a card renders
 * from. Seeding them BEFORE the mount would have the component's own wiring
 * overwrite the fixture — the test would be asserting against the mock's
 * default, not against what it set up.
 */
async function mountThen(state: {
  liveness?: Record<string, 'checking' | 'live' | 'dead' | 'unverified'>
  demotedHosts?: string[]
  liveSessionIds?: string[]
}) {
  await mount({ liveSessionIds: state.liveSessionIds })
  await act(async () => {
    if (state.liveness) useDetachedLivenessStore.setState({ bySession: state.liveness })
    if (state.demotedHosts) {
      useHostReachabilityStore.setState({
        byHost: Object.fromEntries(
          state.demotedHosts.map((h) => [h, { reachable: false, consecutiveFailures: 2, lastCheckedAt: 1 }]),
        ),
      })
    }
  })
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[]
const cards = () => qa('[data-testid="remote-resumable-card"]')
/** Dialogs render into the section's own tree (no portal), so document-wide
 *  queries would be identical — kept on `container` to prove that. */
const click = async (el: HTMLElement | null) => {
  expect(el, 'element to click exists').toBeTruthy()
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const rightClick = async (el: HTMLElement | null) => {
  expect(el, 'element to right-click exists').toBeTruthy()
  await act(async () => { el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 })) })
}

beforeEach(() => {
  checkDetachedLive.mockReset()
  pingHost.mockReset()
  endRemote.mockReset()
  addSession.mockReset()
  persistSessionState.mockReset()
  revealed.length = 0
  checkDetachedLive.mockResolvedValue(unverified)
  pingHost.mockResolvedValue({ host: 'pi.local', reachable: true, via: 'icmp' })
  endRemote.mockResolvedValue(undefined)
  useDetachedRemotesStore.setState({ entries: [] })
  // Clears the module-level in-flight guard too: a probe an earlier test left
  // pending would otherwise swallow this one's.
  resetDetachedLiveness()
  useConfigStore.setState({ configs: [cfg()] })
  useSettingsStore.setState((s: any) => ({ settings: { ...s.settings, remoteResumableCollapsed: false } }))
  resetHostReachability()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  try { await unmount() } catch { /* already unmounted by the test */ }
  container.remove()
  resetHostReachability()
  resetDetachedLiveness()
})

/* ── the section itself ───────────────────────────────────────────────────── */

describe('Remote Resumable — presence', () => {
  it('renders nothing when the registry is empty', async () => {
    await mount()
    expect(q('[data-testid="remote-resumable"]')).toBeNull()
  })

  it('renders the header, the count and one card per entry once entries exist', async () => {
    useDetachedRemotesStore.setState({ entries: [entry(), entry({ sessionId: 'det-2', label: 'Web Server' })] })
    await mount()
    expect(q('[data-testid="remote-resumable"]')).toBeTruthy()
    expect(q('[data-testid="remote-resumable-header"]')?.textContent).toContain('Remote Resumable')
    expect(q('[data-testid="remote-resumable-count"]')?.textContent).toBe('2')
    expect(cards()).toHaveLength(2)
  })

  it('never offers an entry whose session is already live', async () => {
    useDetachedRemotesStore.setState({ entries: [entry(), entry({ sessionId: 'det-2', label: 'Web Server' })] })
    await mount({ liveSessionIds: ['det-1'] })
    expect(cards()).toHaveLength(1)
    expect(cards()[0].dataset.sessionId).toBe('det-2')
  })

  it('the whole card is one keyboard-reachable button with an aria-label', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    const card = cards()[0]
    expect(card.tagName).toBe('BUTTON')
    expect(card.getAttribute('aria-label')).toBe('Resume Pi-Miner on mong@pi.local')
  })

  it('shows the account dot and a mono host line with the detached age', async () => {
    useDetachedRemotesStore.setState({ entries: [entry({ accountEmail: 'a@b.com' })] })
    await mount()
    expect(q('[data-testid="rr-account-dot"]')).toBeTruthy()
    expect(cards()[0].textContent).toContain('mong@pi.local · left 12m ago')
  })
})

/* ── the two-pill model ───────────────────────────────────────────────────── */

describe('Remote Resumable — card state', () => {
  it('a verified-live entry shows the Resumable pill', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'live' } })
    expect(q('[data-testid="rr-pill-resumable"]')).toBeTruthy()
    expect(q('[data-testid="rr-pill-unreachable"]')).toBeNull()
  })

  it('a tier-1 demoted host shows the Unreachable pill and the danger-tinted card', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    // 'live' underneath on purpose: tier 1 OUTRANKS a stale tier-2 verify.
    await mountThen({ liveness: { 'det-1': 'live' }, demotedHosts: ['pi.local'] })
    expect(q('[data-testid="rr-pill-unreachable"]')).toBeTruthy()
    expect(cards()[0].getAttribute('style')).toContain('var(--status-danger)')
  })

  it('a verified-dead entry shows the Unreachable pill', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'dead' } })
    expect(q('[data-testid="rr-pill-unreachable"]')).toBeTruthy()
  })

  it('an unknown (never-checked) entry reads Resumable — fail-open', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: {} })
    expect(cards()[0].dataset.liveness).toBe('unknown')
    expect(q('[data-testid="rr-pill-resumable"]')).toBeTruthy()
  })

  it('a check in flight keeps the LAST-KNOWN pill and adds the host dot — never a "Checking" pill', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'checking' } })
    expect(q('[data-testid="rr-host-checking"]')).toBeTruthy()
    // Still Resumable: 'checking' is not a state a user needs a pill for.
    expect(q('[data-testid="rr-pill-resumable"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Checking')
    expect(q('[data-testid="rr-host-checking"]')?.className).toContain('rr-host-check')
  })

  it('the host dot is absent when nothing is in flight', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'live' } })
    expect(q('[data-testid="rr-host-checking"]')).toBeNull()
  })

  it('shows the host dot while a CLICK verify is in flight, then clears it', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    // Swap in a probe that hangs AFTER the mount's own verify has settled, so
    // the pending one under test is the click's.
    let release!: (r: DetachedRemoteLiveness) => void
    checkDetachedLive.mockReturnValue(new Promise<DetachedRemoteLiveness>((res) => { release = res }))
    await act(async () => { cards()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-testid="rr-host-checking"]')).toBeTruthy()
    // Nothing is blocked or hidden while it runs: the card is still there,
    // still clickable, still wearing its last-known pill.
    expect(cards()).toHaveLength(1)
    expect(q('[data-testid="rr-pill-resumable"]')).toBeTruthy()

    await act(async () => { release(verified(['det-1'])) })
    // The card is gone (it resumed), which is also proof the dot did not block.
    expect(cards()).toHaveLength(0)
    expect(addSession.mock.calls[0][0].id).toBe('det-1')
  })
})

/* ── click to resume ──────────────────────────────────────────────────────── */

describe('Remote Resumable — click to resume', () => {
  it('a live entry resumes with the ORIGINAL id + reconnect, drops the entry and reveals the tile', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    checkDetachedLive.mockResolvedValue(verified(['det-1']))
    await mount()
    await click(cards()[0])

    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-1', sessionIds: ['det-1'] })
    expect(addSession).toHaveBeenCalledTimes(1)
    const session = addSession.mock.calls[0][0]
    expect(session.id).toBe('det-1')
    expect(session.sshReachedClaudeRunning).toBe(true)
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(persistSessionState).toHaveBeenCalled()
    expect(revealed).toEqual(['det-1'])
  })

  it('an UNVERIFIABLE entry still resumes — fail-open, the reattach self-heals', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    checkDetachedLive.mockResolvedValue(unverified)
    await mount()
    await click(cards()[0])
    expect(addSession).toHaveBeenCalledTimes(1)
    expect(addSession.mock.calls[0][0].id).toBe('det-1')
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
  })

  /**
   * The real shape of a dead click, and it is not "render a dead card and press
   * it". A verified-dead id is PRUNED from the registry by the probe itself
   * (Phase 2, deadSessionIds), so a card the user can click is one that was
   * alive or unverified when it rendered — and the CLICK is what discovers the
   * remote is gone. These mount under an unverified probe, then swap in the
   * verdict the click will get.
   */
  const clickIntoDeadModal = async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    expect(cards()).toHaveLength(1)
    checkDetachedLive.mockResolvedValue(verified([]))
    await click(cards()[0])
  }

  it('a CONFIRMED-dead entry opens the modal instead of resuming', async () => {
    await clickIntoDeadModal()
    expect(addSession).not.toHaveBeenCalled()
    const dialog = q('[data-testid="rr-dead-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('Pi-Miner — the remote session has ended.')
    expect(q('[data-testid="rr-dead-remove"]')).toBeTruthy()
    expect(q('[data-testid="rr-dead-start-new"]')).toBeTruthy()
    // The probe's own prune already took the card away — the modal explains a
    // list that has just changed under the user, which is why it exists.
    expect(cards()).toHaveLength(0)
  })

  it('the dead modal Remove drops the entry and launches nothing', async () => {
    await clickIntoDeadModal()
    // Re-add so Remove has something to drop: this asserts the button's OWN
    // effect, independent of the probe prune that normally beat it to it.
    await act(async () => { useDetachedRemotesStore.setState({ entries: [entry()] }) })
    await click(q('[data-testid="rr-dead-remove"]'))
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(addSession).not.toHaveBeenCalled()
    expect(q('[data-testid="rr-dead-dialog"]')).toBeNull()
  })

  it('the dead modal Start new drops the entry AND launches fresh with a new id', async () => {
    await clickIntoDeadModal()
    await act(async () => { useDetachedRemotesStore.setState({ entries: [entry()] }) })
    await click(q('[data-testid="rr-dead-start-new"]'))

    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(addSession).toHaveBeenCalledTimes(1)
    const session = addSession.mock.calls[0][0]
    expect(session.id).not.toBe('det-1')
    expect(session.sshReachedClaudeRunning).toBeUndefined()
    expect(revealed).toEqual([session.id])
  })

  it('the dead modal closes on Escape, launching nothing and dropping nothing itself', async () => {
    await clickIntoDeadModal()
    await act(async () => { useDetachedRemotesStore.setState({ entries: [entry()] }) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(q('[data-testid="rr-dead-dialog"]')).toBeNull()
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(1)
    expect(addSession).not.toHaveBeenCalled()
  })
})

/* ── right-click ──────────────────────────────────────────────────────────── */

describe('Remote Resumable — context menu', () => {
  it('right-click opens Resume + Remove', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    await rightClick(cards()[0])
    expect(q('[data-testid="rr-context-menu"]')).toBeTruthy()
    expect(q('[data-testid="rr-ctx-resume"]')).toBeTruthy()
    expect(q('[data-testid="rr-ctx-remove"]')).toBeTruthy()
  })

  it('Remove KILLS the remote first, then drops the entry', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'live' } })
    await rightClick(cards()[0])
    await click(q('[data-testid="rr-ctx-remove"]'))
    // Phase 3.5: BOTH ids. Main has no captured target for a DETACHED remote
    // (killPty dropped it), so without the configId to rebuild the connection
    // from the saved config the kill is a silent no-op and the remote lives on.
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'det-1', configId: 'cfg-1' })
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(persistSessionState).toHaveBeenCalled()
  })

  it('names the config the entry pairs with NOW, following a re-created config to its new id', async () => {
    useConfigStore.setState({ configs: [cfg({ id: 'cfgrecreated' })] })
    useDetachedRemotesStore.setState({ entries: [entry({ configId: 'cfgdeleted' })] })
    await mountThen({ liveness: { 'det-1': 'live' } })
    await rightClick(cards()[0])
    await click(q('[data-testid="rr-ctx-remove"]'))
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'det-1', configId: 'cfgrecreated' })
  })

  it('a kill FAILURE still drops the entry', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    endRemote.mockRejectedValue(new Error('host unreachable'))
    await mount()
    await rightClick(cards()[0])
    await click(q('[data-testid="rr-ctx-remove"]'))
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'det-1', configId: 'cfg-1' })
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
  })

  it('a CONFIRMED-dead entry is dropped without an end-remote call — nothing to kill', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mountThen({ liveness: { 'det-1': 'dead' } })
    await rightClick(cards()[0])
    await click(q('[data-testid="rr-ctx-remove"]'))
    expect(endRemote).not.toHaveBeenCalled()
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
  })

  it('Resume from the menu takes the same verify-then-reattach path as a click', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    checkDetachedLive.mockResolvedValue(verified(['det-1']))
    await mount()
    await rightClick(cards()[0])
    await click(q('[data-testid="rr-ctx-resume"]'))
    expect(checkDetachedLive).toHaveBeenCalled()
    expect(addSession.mock.calls[0][0].id).toBe('det-1')
  })
})

/* ── deleted saved config ─────────────────────────────────────────────────── */

describe('Remote Resumable — deleted saved config', () => {
  it('renders the card from the recorded label and offers Remove instead of resuming', async () => {
    useConfigStore.setState({ configs: [] })
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()

    const card = cards()[0]
    expect(card.textContent).toContain('Pi-Miner')
    expect(card.getAttribute('aria-label')).toContain('saved config deleted')

    await click(card)
    // No verify was even attempted — there is no config to build a target from.
    expect(checkDetachedLive).not.toHaveBeenCalled()
    expect(addSession).not.toHaveBeenCalled()
    const dialog = q('[data-testid="rr-missing-config-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('its saved config was deleted')

    await click(q('[data-testid="rr-missing-remove"]'))
    // Nothing pairs with it any more, so the id recorded at detach time is the
    // best (and only) thing to name. Main finds no config, so the kill no-ops —
    // and the card still goes, which is what the user asked for.
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'det-1', configId: 'cfg-1' })
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
  })

  it('its context-menu Resume is disabled, and Remove still works', async () => {
    useConfigStore.setState({ configs: [] })
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    await rightClick(cards()[0])
    expect((q('[data-testid="rr-ctx-resume"]') as HTMLButtonElement).disabled).toBe(true)
    await click(q('[data-testid="rr-ctx-remove"]'))
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
  })

  it('an entry whose config was re-created at the same host still resumes (the fallback match)', async () => {
    useConfigStore.setState({ configs: [cfg({ id: 'cfg-recreated' })] })
    useDetachedRemotesStore.setState({ entries: [entry()] })
    checkDetachedLive.mockResolvedValue(verified(['det-1']))
    await mount()
    await click(cards()[0])
    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-recreated', sessionIds: ['det-1'] })
    expect(addSession.mock.calls[0][0].id).toBe('det-1')
  })
})

/* ── wiring: verify seams + ping arm/disarm ───────────────────────────────── */

describe('Remote Resumable — wiring', () => {
  it('verifies once when the section opens, and again on the next open', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)

    // A re-render that changes nothing must not spend another connection.
    await mount()
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)

    // Collapse, then re-open: that is a new OPEN, so it verifies again.
    await act(async () => { useSettingsStore.getState().updateSettings({ remoteResumableCollapsed: true }) })
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)
    await act(async () => { useSettingsStore.getState().updateSettings({ remoteResumableCollapsed: false }) })
    expect(checkDetachedLive).toHaveBeenCalledTimes(2)
  })

  it('does not verify at all when the registry is empty', async () => {
    await mount()
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('re-verifies on window focus, and stops listening once unmounted', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    checkDetachedLive.mockClear()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)

    await unmount()
    checkDetachedLive.mockClear()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('arms the tier-1 pings while mounted with entries, and disarms on unmount', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    expect(isHostPingArmed()).toBe(false)
    await mount()
    expect(isHostPingArmed()).toBe(true)
    await unmount()
    expect(isHostPingArmed()).toBe(false)
  })

  it('arms nothing while there is nothing to ping, and arms when an entry appears', async () => {
    await mount()
    expect(isHostPingArmed()).toBe(false)
    await act(async () => { useDetachedRemotesStore.setState({ entries: [entry()] }) })
    expect(isHostPingArmed()).toBe(true)
    await act(async () => { useDetachedRemotesStore.setState({ entries: [] }) })
    expect(isHostPingArmed()).toBe(false)
  })

  it('collapsing hides the cards but keeps the header and the count', async () => {
    useDetachedRemotesStore.setState({ entries: [entry()] })
    await mount()
    expect(cards()).toHaveLength(1)
    await act(async () => { useSettingsStore.getState().updateSettings({ remoteResumableCollapsed: true }) })
    expect(cards()).toHaveLength(0)
    expect(q('[data-testid="remote-resumable-count"]')?.textContent).toBe('1')
  })
})
