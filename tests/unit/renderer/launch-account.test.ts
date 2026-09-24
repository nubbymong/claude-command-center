/**
 * WP2 commit 6: the pure half of a session's account binding.
 *
 *  - the New session picker's list (default first and "(Default)", the others
 *    by name, this computer's ~/.codex labelled "confirm at launch", blocked
 *    ones disabled with "Needs attention", inactive and archived not listed);
 *  - which account a launch names, when it needs its own acknowledgement,
 *    and the step a launch takes (spawn, or ask first);
 *  - a refused launch in plain words, pinned to main's own sentences: the
 *    ones in src/shared are produced by the real code, the ones that live
 *    only in main are quoted;
 *  - the binding riding config -> session -> saved session, and the dialog's
 *    one-shot grant, which never covers a second launch and is never saved.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  sessionAccountOptions, defaultAccountId, accountFieldState, resolveLaunchAccount, launchStep, describeLaunchFailure,
  providerTooOldText, restartPicksConversation, noticeText,
  NEEDS_ATTENTION, NEEDS_ATTENTION_TEXT, SIGNED_IN_ELSEWHERE, SIGNED_IN_ELSEWHERE_TEXT, NOT_CHECKED,
} from '../../../src/renderer/utils/launchAccount'
import { grantLaunchAcknowledgement, consumeLaunchAcknowledgement, useLaunchAckStore } from '../../../src/renderer/stores/launchAckStore'
import { buildLaunchSession } from '../../../src/renderer/hooks/useLaunchConfig'
import { buildSessionState } from '../../../src/renderer/session-persistence'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import type { TerminalConfig } from '../../../src/renderer/stores/configStore'
import { resolveLaunchBinding, chooseSessionAccount, emptyRegistry, makeOpaqueId, type ProviderRegistryDoc } from '../../../src/shared/providers'
import { snapshot, provider, work, local } from './accounts-snapshot-harness'

// Electron wraps a handler's throw like this on the way to the renderer; main
// throws `Codex session refused: <reason>` (src/main/ipc/pty-handlers.ts).
const refused = (why: string) => new Error(`Error invoking remote method 'pty:spawn': Error: Codex session refused: ${why}`)

/** main's own binding refusal for an account in this state, from the real
 *  shared code (resolveLaunchBinding), so the wording is never a copy. */
function bindingRefusal(state: 'inactive' | 'archived' | 'blocked' | 'gone'): string {
  const id = makeOpaqueId('account', 'a'.repeat(16))
  const doc: ProviderRegistryDoc = state === 'gone'
    ? emptyRegistry()
    : { ...emptyRegistry(), accounts: [{ id, providerId: 'codex', lifecycle: state === 'blocked' ? 'active' : state, operationalState: state === 'blocked' ? 'blocked' : 'ready' } as never] }
  const r = resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: id })
  if (r.ok) throw new Error('expected a refusal')
  return r.message
}

describe('the Codex account picker list', () => {
  it('puts the default first and marks it, then the others by name, then the blocked ones', () => {
    const opts = sessionAccountOptions(snapshot(), 'codex')
    expect(opts.map((o) => o.id)).toEqual(['acc-work', 'acc-personal', 'acc-local', 'acc-old'])
    expect(opts[0].label).toBe('Work (Default)')
    expect(opts[0].isDefault).toBe(true)
    expect(defaultAccountId(snapshot(), 'codex')).toBe('acc-work')
  })

  it("labels this computer's own sign-in as confirmed at launch", () => {
    const ext = sessionAccountOptions(snapshot(), 'codex').find((o) => o.id === 'acc-local')!
    expect(ext.label).toBe("This computer's Codex (~/.codex) - confirm at launch")
    expect(ext.disabled).toBe(false)
  })

  it('shows a blocked account disabled with "Needs attention"', () => {
    const blocked = sessionAccountOptions(snapshot(), 'codex').find((o) => o.id === 'acc-old')!
    expect(blocked.disabled).toBe(true)
    expect(blocked.label).toBe('Old (Needs attention)')
  })

  it("does not list inactive or archived accounts, nor another provider's", () => {
    const ids = sessionAccountOptions(snapshot(), 'codex').map((o) => o.id)
    expect(ids).not.toContain('acc-parked')
    expect(ids).not.toContain('acc-gone')
    expect(ids).not.toContain('acc-claude-main')
  })

  it('lists nothing before the snapshot has arrived', () => {
    expect(sessionAccountOptions(null, 'codex')).toEqual([])
    expect(defaultAccountId(null, 'codex')).toBeUndefined()
  })
})

describe('the account field for one selection', () => {
  it('needs the per-launch confirmation for the external account only', () => {
    expect(accountFieldState(snapshot(), 'codex', 'acc-local').needsAck).toBe(true)
    expect(accountFieldState(snapshot(), 'codex', 'acc-work').needsAck).toBe(false)
  })

  it('says a blocked account signed in as someone else', () => {
    expect(accountFieldState(snapshot(), 'codex', 'acc-old').notice).toBe(SIGNED_IN_ELSEWHERE)
  })

  it('keeps a saved binding to an inactive or removed account visible, and says it needs attention', () => {
    const inactive = accountFieldState(snapshot(), 'codex', 'acc-parked')
    expect(inactive.unlisted).toEqual({ id: 'acc-parked', label: 'Parked (Needs attention)' })
    expect(inactive.notice).toBe(NEEDS_ATTENTION)
    const removed = accountFieldState(snapshot(), 'codex', 'acc-nope')
    expect(removed.unlisted?.label).toContain('removed')
    expect(removed.notice).toBe(NEEDS_ATTENTION)
  })

  it('judges nothing before the snapshot has arrived', () => {
    const s = accountFieldState(null, 'codex', 'acc-parked')
    expect(s.unlisted).toBeUndefined()
    expect(s.notice).toBeUndefined()
  })

  it('a notice reads "Open Accounts" once, as its own words', () => {
    expect(NEEDS_ATTENTION_TEXT).toBe('This account needs attention. Open Accounts.')
    expect(SIGNED_IN_ELSEWHERE_TEXT).toBe('This account signed in as someone else. Open Accounts and confirm it is still yours.')
    for (const n of [NEEDS_ATTENTION, SIGNED_IN_ELSEWHERE, NOT_CHECKED]) expect(noticeText(n).match(/Open Accounts/g)).toHaveLength(1)
  })

  it('says Codex is too old only when discovery judged it too old, and not to update in Accounts', () => {
    const at = (compatibility: 'too-old' | 'unknown' | 'unsupported') =>
      snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', version: '0.150.2', compatibility })] })
    expect(providerTooOldText(at('too-old'), 'codex')).toBe('Codex 0.150.2 is too old for this app. Update Codex, then Check again in Settings, Accounts.')
    expect(providerTooOldText(at('unknown'), 'codex')).toBeNull()
    expect(providerTooOldText(at('unsupported'), 'codex')).toBeNull()
    expect(providerTooOldText(snapshot(), 'codex')).toBeNull()
  })
})

describe('the account a launch names, and its next step', () => {
  it('a bound session names its account, and an external one needs the acknowledgement', () => {
    expect(resolveLaunchAccount(snapshot(), 'codex', 'acc-work')).toMatchObject({ accountId: 'acc-work', needsAck: false })
    expect(resolveLaunchAccount(snapshot(), 'codex', 'acc-local')).toMatchObject({ accountId: 'acc-local', needsAck: true })
  })

  it('an unbound session keeps the provider default and names nothing', () => {
    expect(resolveLaunchAccount(snapshot(), 'codex', undefined)).toEqual({ needsAck: false })
  })

  it('an unbound session whose default is the external sign-in names that default for the acknowledgement', () => {
    const s = snapshot({ accounts: [{ ...work, isProviderDefault: false }, { ...local, isProviderDefault: true }] })
    expect(resolveLaunchAccount(s, 'codex', undefined)).toMatchObject({ accountId: 'acc-local', needsAck: true })
  })

  it('with no account list at all, a bound session asks rather than assume nothing is needed', () => {
    expect(resolveLaunchAccount(null, 'codex', 'acc-work')).toEqual({ accountId: 'acc-work', needsAck: true, unknown: true })
    const step = launchStep(null, resolveLaunchAccount(null, 'codex', 'acc-work'), false)
    expect(step).toEqual({
      kind: 'ask',
      fields: { providerAccountId: 'acc-work', acknowledgeRealmOnly: true },
      question: { accountName: 'this Codex account', email: undefined, external: false, unknown: true },
    })
  })

  it('spawns at once for an account that needs nothing, or one the dialog\'s tick covered', () => {
    const s = snapshot()
    expect(launchStep(s, resolveLaunchAccount(s, 'codex', 'acc-work'), false)).toEqual({ kind: 'spawn', fields: { providerAccountId: 'acc-work' } })
    expect(launchStep(s, resolveLaunchAccount(s, 'codex', undefined), false)).toEqual({ kind: 'spawn', fields: {} })
    expect(launchStep(s, resolveLaunchAccount(s, 'codex', 'acc-local'), true))
      .toEqual({ kind: 'spawn', fields: { providerAccountId: 'acc-local', acknowledgeRealmOnly: true } })
  })

  it('asks about the external account by name and email otherwise', () => {
    const s = snapshot()
    const step = launchStep(s, resolveLaunchAccount(s, 'codex', 'acc-local'), false)
    expect(step).toMatchObject({
      kind: 'ask',
      fields: { providerAccountId: 'acc-local', acknowledgeRealmOnly: true },
      question: { accountName: "This computer's Codex (~/.codex)", email: 'alex@example.com', external: true, unknown: false },
    })
  })

  it('a plain Restart picks a conversation for Claude, not for Codex', () => {
    expect(restartPicksConversation('claude')).toBe(true)
    expect(restartPicksConversation(undefined)).toBe(true)
    expect(restartPicksConversation('codex')).toBe(false)
  })
})

describe("a refused launch in plain words (main's sentences)", () => {
  // Quoted from main (src/main/providers/core/accounts-service.ts): these
  // sentences exist only in the main process, whose modules a renderer test
  // does not load.
  const ACK = 'This sign-in is unverified: confirm that this launch may use it.'

  it("acknowledgement-required names what was not confirmed, and only says 'on this computer' for this computer's own sign-in", () => {
    expect(describeLaunchFailure(refused(ACK), { external: true }))
      .toBe('Codex did not start. This launch was not confirmed for the Codex sign-in already on this computer. Restart the session to confirm it.')
    expect(describeLaunchFailure(refused(ACK), { external: false }))
      .toBe("Codex did not start. This launch was not confirmed for this account's unverified sign-in. Restart the session to confirm it.")
    expect(describeLaunchFailure(refused(ACK)))
      .toBe('Codex did not start. This launch needs your confirmation. Restart the session to confirm it.')
  })

  it('lifecycle: inactive, archived and blocked all say the account needs attention (real shared wording)', () => {
    for (const state of ['inactive', 'archived', 'blocked'] as const) {
      expect(describeLaunchFailure(refused(bindingRefusal(state)))).toBe(`Codex did not start. ${NEEDS_ATTENTION_TEXT}`)
    }
  })

  it('an account that no longer exists (real shared wording)', () => {
    expect(describeLaunchFailure(refused(bindingRefusal('gone'))))
      .toBe('Codex did not start. The account this session uses no longer exists. Edit the config to choose another account.')
  })

  it('an unbound session with no account at all says to sign in to Codex first (real shared wording)', () => {
    const none = chooseSessionAccount(emptyRegistry(), 'codex')
    if (none.ok) throw new Error('expected no account')
    expect(describeLaunchFailure(refused(none.message))).toBe('Codex did not start. Sign in to Codex first. Open Accounts.')
  })

  it('busy: signing in again, and anything else holding the account', () => {
    expect(describeLaunchFailure(refused('This account is signing in again; try again when that finishes.')))
      .toBe('Codex did not start. This account is signing in again. Try again when that finishes.')
    expect(describeLaunchFailure(refused('Something else is using this account right now; try again when it finishes.')))
      .toBe('Codex did not start. This account is busy right now. Try again when it finishes.')
  })

  it('sign-in-changed', () => {
    expect(describeLaunchFailure(refused('This account now holds a different sign-in than before. Review it in Accounts and confirm it before continuing.')))
      .toBe(`Codex did not start. ${SIGNED_IN_ELSEWHERE_TEXT}`)
    expect(describeLaunchFailure(refused('This account signed in again, but the app could not record it. Check it in Accounts before using it.')))
      .toBe(`Codex did not start. ${SIGNED_IN_ELSEWHERE_TEXT}`)
  })

  it('a CLI main may not run: "too old" only when discovery said so; unknown says it could not check', () => {
    const why = 'This Codex CLI version cannot be used for sign-in. Update it, then check it again in setup.'
    expect(describeLaunchFailure(refused(why), { version: '0.150.2', compatibility: 'too-old' }))
      .toBe('Codex did not start. Codex 0.150.2 is too old for this app. Update Codex, then Check again in Settings, Accounts.')
    expect(describeLaunchFailure(refused(why), { compatibility: 'unknown' }))
      .toBe('Codex did not start. This app could not check Codex. Open Accounts.')
    expect(describeLaunchFailure(refused(why)))
      .toBe('Codex did not start. This app could not check Codex. Open Accounts.')
  })

  it("keeps main's own text for anything else, and a non-Codex failure as before", () => {
    expect(describeLaunchFailure(refused('Codex runs on this computer only in this release; it is not available in SSH sessions.')))
      .toBe('Codex did not start. Codex runs on this computer only in this release; it is not available in SSH sessions.')
    expect(describeLaunchFailure(new Error("Error invoking remote method 'pty:spawn': Error: spawn claude ENOENT")))
      .toBe('Failed to launch session: spawn claude ENOENT')
  })
})

describe('the binding rides config -> session -> saved session; the acknowledgement never does', () => {
  const codexConfig = (over: Partial<TerminalConfig> = {}): TerminalConfig => ({
    id: 'cfg-1', label: 'api-server', workingDirectory: 'C:/proj', color: '', sessionType: 'local', provider: 'codex',
    codexOptions: { permissionsPreset: 'standard' }, providerAccountId: 'acc-local', ...over,
  })

  beforeEach(() => { useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false }) })

  it('a Codex config launches a session bound to its account; a Claude config never carries one', () => {
    expect(buildLaunchSession(codexConfig())!.providerAccountId).toBe('acc-local')
    expect(buildLaunchSession(codexConfig({ provider: 'claude' }))!.providerAccountId).toBeUndefined()
  })

  it('a saved Codex session keeps its account id and nothing that could acknowledge a launch', () => {
    const s = buildLaunchSession(codexConfig())! as Session
    useSessionStore.setState({ sessions: [s], activeSessionId: s.id, isRestoring: false })
    const saved = buildSessionState().sessions[0] as unknown as Record<string, unknown>
    expect(saved.providerAccountId).toBe('acc-local')
    expect(JSON.stringify(saved)).not.toMatch(/acknowledge/i)
  })

  it("the dialog's grant covers one launch on the account it names, then is gone", () => {
    grantLaunchAcknowledgement('s-1', 'acc-local')
    expect(consumeLaunchAcknowledgement('s-1', 'acc-local')).toBe(true)
    expect(consumeLaunchAcknowledgement('s-1', 'acc-local')).toBe(false)
    grantLaunchAcknowledgement('s-2', 'acc-local')
    expect(consumeLaunchAcknowledgement('s-2', 'acc-work')).toBe(false)
    // Used up by the mismatch too: it never waits around for another launch.
    expect(consumeLaunchAcknowledgement('s-2', 'acc-local')).toBe(false)
  })

  it('a withdrawn confirm answers "no" and leaves the queue', async () => {
    const answer = useLaunchAckStore.getState().request({ sessionId: 's-9', sessionLabel: 'x', accountName: 'y', external: true, unknown: false })
    expect(useLaunchAckStore.getState().isPending('s-9')).toBe(true)
    useLaunchAckStore.getState().withdraw('s-9')
    await expect(answer).resolves.toBe(false)
    expect(useLaunchAckStore.getState().isPending('s-9')).toBe(false)
  })

  it('an answer resolves only the question it names', async () => {
    const store = useLaunchAckStore.getState()
    const first = store.request({ sessionId: 'a', sessionLabel: 'a', accountName: 'y', external: true, unknown: false })
    const second = store.request({ sessionId: 'b', sessionLabel: 'b', accountName: 'y', external: true, unknown: false })
    const [qa, qb] = useLaunchAckStore.getState().queue
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    useLaunchAckStore.getState().withdraw('a')
    // A click meant for "a" arriving after it was withdrawn answers nothing.
    useLaunchAckStore.getState().answer(qa.requestId, true)
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    expect(useLaunchAckStore.getState().queue.map((q) => q.requestId)).toEqual([qb.requestId])
    await expect(first).resolves.toBe(false)
    useLaunchAckStore.getState().answer(qb.requestId, false)
    await expect(second).resolves.toBe(false)
  })
})
