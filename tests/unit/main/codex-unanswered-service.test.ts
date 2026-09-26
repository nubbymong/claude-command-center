/**
 * Owner decisions 2026-09-26: until the user answers whether they use Codex,
 * Codex is "not set up", and nothing of it starts. The accounts service's own
 * rules, on the REAL Codex package against a fake CLI and in-memory
 * everything (tests/wp1/accounts-harness.ts: no file is written, no process
 * is started):
 *
 *   - the launch rule refuses Codex as not set up (it used to let "not
 *     answered yet" launch), in the existing plain style;
 *   - behind it, prepareLaunch prepares nothing and leases nothing, and no
 *     review is offered;
 *   - this computer's own sign-in is not taken in, even by an explicit
 *     adoption, and no CLI runs for it, until the user has said yes;
 *   - nor does any account operation run the Codex CLI (a sign-in, a status
 *     check, a sign-out, finishing or dropping a setup), and no new setup is
 *     reserved: the ways in record the yes first;
 *   - once the answer is yes, all of it works as before; Claude Code, whose
 *     absent value is on, is unaffected throughout.
 */
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, EXT_HOME, KEY } from '../../wp1/accounts-harness'
import type { ProviderPreference } from '../../../src/shared/providers'

describe('Codex not answered yet: not set up', () => {
  it('the launch rule refuses it as not set up, in plain words; Claude Code launches', async () => {
    const h = await harness({ preference: { codex: 'undecided' } })
    expect(h.service.launchRefusal('codex')).toEqual({
      code: 'provider-not-set-up', providerId: 'codex', message: 'Codex is not set up yet. Set it up in Settings, Accounts.',
    })
    expect(h.service.launchRefusal('claude')).toBeNull()
  })

  it('prepareLaunch prepares and leases nothing, and no review is offered; after a yes, both work', async () => {
    let pref: ProviderPreference = 'on'
    const h = await harness({ preference: { codex: () => pref } })
    const a = await addCodexAccount(h)
    expect(h.service.reviewReady('codex')).toBe(true)
    pref = 'undecided'
    const runs = h.runs.length
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's1' })).toMatchObject({
      ok: false, code: 'provider-not-set-up', message: 'Codex is not set up yet. Set it up in Settings, Accounts.',
    })
    expect(await h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r1' })).toMatchObject({ ok: false, code: 'provider-not-set-up' })
    expect(h.leases.count(a)).toBe(0)
    expect(h.runs.length).toBe(runs)
    expect(h.service.reviewReady('codex')).toBe(false)
    pref = 'on'
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's2' })).toMatchObject({ ok: true })
    expect(h.service.reviewReady('codex')).toBe(true)
  })

  it('this computer\'s sign-in is not taken in, and its CLI is not run, until the user has said yes', async () => {
    let pref: ProviderPreference = 'undecided'
    const h = await harness({ preference: { codex: () => pref } })
    // Codex is signed in there: the only thing missing is the user's yes.
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const runs = h.runs.length
    expect(await h.service.adoptExternalDefault({ providerId: 'codex' })).toMatchObject({
      ok: false, code: 'provider-not-set-up', message: "Codex is not set up yet. Say you use Codex first, then use this computer's sign-in.",
    })
    expect(h.runs.length).toBe(runs)
    expect(h.doc().accounts.some((x) => x.providerId === 'codex')).toBe(false)
    expect(h.doc().journals).toEqual([])
    // Said yes: the explicit adoption asks the status there, then registers.
    pref = 'on'
    expect(await h.service.adoptExternalDefault({ providerId: 'codex' })).toMatchObject({ ok: true })
    expect(h.doc().accounts.filter((x) => x.providerId === 'codex')).toHaveLength(1)
  })

  it('no account operation runs the Codex CLI, and no setup is reserved, until the user has said yes', async () => {
    let pref: ProviderPreference = 'on'
    const h = await harness({ preference: { codex: () => pref } })
    const a = await addCodexAccount(h)
    // A setup begun while Codex was answered on, left unfinished.
    const pending = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    pref = 'undecided'
    const runs = h.runs.length
    const journals = JSON.stringify(h.doc().journals)
    const NOT_SET_UP = { ok: false, code: 'provider-not-set-up', message: 'Codex is not set up yet. Set it up in Settings, Accounts.' }
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject(NOT_SET_UP)
    expect(await h.service.signIn({ accountId: pending.accountId, method: 'browser' }, 1)).toMatchObject(NOT_SET_UP)
    expect(await h.service.completeSetup({ accountId: pending.accountId, identity: { mode: 'new', colourKey: 'violet' } })).toMatchObject(NOT_SET_UP)
    expect(await h.service.abandonSetup({ accountId: pending.accountId })).toMatchObject(NOT_SET_UP)
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject(NOT_SET_UP)
    expect(await h.service.reconcileSignIn({ accountId: a })).toMatchObject(NOT_SET_UP)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject(NOT_SET_UP)
    expect(await h.service.logout({ accountId: a })).toMatchObject(NOT_SET_UP)
    expect(h.runs.length).toBe(runs)
    expect(JSON.stringify(h.doc().journals)).toBe(journals)
    expect(h.leases.count(a)).toBe(0)
    // Said yes: they run as before.
    pref = 'on'
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject({ ok: true, state: 'signed-in' })
    expect(await h.service.signIn({ accountId: pending.accountId, method: 'browser' }, 1)).toMatchObject({ ok: true, state: 'signed-in' })
    expect(h.runs.length).toBeGreaterThan(runs)
  })

  it('a saved on/off that cannot be read now is no answer and says so, never "not set up": nothing runs the CLI', async () => {
    let readable = true
    const h = await harness({ preference: { codex: () => { if (!readable) throw new Error('unreadable'); return 'on' } } })
    const a = await addCodexAccount(h)
    readable = false
    const runs = h.runs.length
    const UNKNOWN = { ok: false, code: 'provider-state-unknown', message: 'This app could not read whether Codex is on. Check Settings, Accounts.' }
    // An "on" read earlier is no answer now, as for a launch.
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject(UNKNOWN)
    expect(await h.service.logout({ accountId: a })).toMatchObject(UNKNOWN)
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject(UNKNOWN)
    expect(await h.service.probeExternalDefault({ providerId: 'codex' })).toMatchObject({ ok: false })
    expect(h.runs.length).toBe(runs)
    // Never read at all: the preference is undecided, and still it is unknown, not "not set up".
    const never = await harness({ preference: { codex: () => { throw new Error('unreadable') } } })
    expect(never.service.preferenceOf('codex')).toBe('undecided')
    expect(await never.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject(UNKNOWN)
    // Readable again: it runs.
    readable = true
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject({ ok: true, state: 'signed-in' })
  })

  it('a switch-on made here is not an answer: until the saved yes lands, nothing of Codex runs or is written', async () => {
    let saved: ProviderPreference = 'on'
    const h = await harness({ preference: { codex: () => saved } })
    const a = await addCodexAccount(h)
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    // The answer is gone (not answered in this model), and the renderer's
    // switch reached main, but the save that records the yes never landed.
    saved = 'undecided'
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    const runs = h.runs.length
    const writes = h.port.writes
    const discoveries = h.discoveries()
    expect(h.service.preferenceOf('codex')).toBe('undecided')
    expect(h.service.launchRefusal('codex')).toMatchObject({ code: 'provider-not-set-up' })
    const NOT_SET_UP = { ok: false, code: 'provider-not-set-up' }
    expect(await h.service.probeExternalDefault({ providerId: 'codex' })).toMatchObject(NOT_SET_UP)
    expect(await h.service.adoptExternalDefault({ providerId: 'codex' })).toMatchObject(NOT_SET_UP)
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject(NOT_SET_UP)
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject(NOT_SET_UP)
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's1' })).toMatchObject(NOT_SET_UP)
    expect(h.service.reviewReady('codex')).toBe(false)
    expect(await h.service.discover('codex')).toMatchObject(NOT_SET_UP)
    expect(h.runs.length).toBe(runs)
    expect(h.port.writes).toBe(writes)
    expect(h.discoveries()).toBe(discoveries)
    expect(h.leases.count(a)).toBe(0)
    // The saved yes lands: on, and it runs.
    saved = 'on'
    expect(h.service.preferenceOf('codex')).toBe('on')
    expect(await h.service.probeExternalDefault({ providerId: 'codex' })).toEqual({ ok: true, state: 'signed-in' })
    // A switch-off made here still applies at once, before any save.
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    expect(h.service.preferenceOf('codex')).toBe('off')
  })

  it('an unsaved switch-on is no answer even once the settings cannot be read: Claude Code stays the provider left on', async () => {
    let broken = false
    const saved: Record<'claude' | 'codex', ProviderPreference> = { claude: 'on', codex: 'undecided' }
    const read = (id: 'claude' | 'codex') => () => { if (broken) throw new Error('unreadable'); return saved[id] }
    const h = await harness({ preference: { claude: read('claude'), codex: read('codex') } })
    expect(h.service.preferenceOf('claude')).toBe('on')
    // Main's switch, with no save after it; then the settings cannot be read.
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    broken = true
    expect(h.service.preferenceOf('codex')).toBe('undecided')
    expect(await h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: false, code: 'last-provider' })
    // A switch-off still applies at once, readable or not.
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    expect(h.service.preferenceOf('codex')).toBe('off')
  })

  it('no key is taken for a Codex the user has not said they use; the dialog\'s order (yes, then the key) works, a resumed key setup too', async () => {
    let saved: ProviderPreference = 'on'
    const h = await harness({ preference: { codex: () => saved } })
    // A key setup begun while Codex was answered on, left at its key step.
    const resumed = await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' }) as { accountId: string }
    saved = 'undecided'
    expect(h.service.issueSecretHandle({ accountId: resumed.accountId }, 1)).toMatchObject({ ok: false, code: 'provider-not-set-up' })
    // The dialog records the yes first (main's switch, then the saved answer).
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    saved = 'on'
    for (const accountId of [resumed.accountId, (await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' }) as { accountId: string }).accountId]) {
      const issued = h.service.issueSecretHandle({ accountId }, 1) as { ok: true; handle: string }
      expect(issued.ok).toBe(true)
      h.service.depositSecret(issued.handle, 1, KEY)
      expect(await h.service.signIn({ accountId, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: true, state: 'signed-in' })
    }
  })

  it('a check with settings that cannot be read now is refused before anything is reserved: no registry write, no CLI run', async () => {
    let readable = true
    const h = await harness({ preference: { codex: () => { if (!readable) throw new Error('unreadable'); return 'on' } } })
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect(h.service.preferenceOf('codex')).toBe('on') // the last value read
    readable = false
    const writes = h.port.writes
    const runs = h.runs.length
    for (const call of [() => h.service.probeExternalDefault({ providerId: 'codex' }), () => h.service.adoptExternalDefault({ providerId: 'codex' })]) {
      expect(await call()).toMatchObject({ ok: false, code: 'provider-state-unknown' })
    }
    expect(h.port.writes).toBe(writes)
    expect(h.runs.length).toBe(runs)
    expect(h.doc().journals).toEqual([])
  })

  it('the snapshot says it is not set up (preference), and never offers it as looked for', async () => {
    const h = await harness({ preference: { codex: 'undecided' } })
    h.service.discoverAtStart()
    for (let i = 0; i < 40; i++) await Promise.resolve()
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')).toMatchObject({ preference: 'undecided', discoveryState: 'unchecked' })
    expect(h.discoveries()).toBe(0)
  })

  it('never counts as the provider left on: Claude Code cannot be switched off while Codex is unanswered', async () => {
    let pref: ProviderPreference = 'undecided'
    const h = await harness({ preference: { codex: () => pref } })
    // Switching Claude Code off now would leave nothing that can launch.
    expect(await h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: false, code: 'last-provider' })
    expect(h.service.launchRefusal('claude')).toBeNull()
    // Once the user says yes, Codex can launch, so Claude Code can go off.
    pref = 'on'
    expect(await h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: true })
  })
})

describe('the launch rule, asked again under the lock (A2)', () => {
  it('an answer removed, or a setting that became unreadable, while a launch waited on its CLI check refuses the lease', async () => {
    for (const [then, code] of [['undecided', 'provider-not-set-up'], ['unreadable', 'provider-state-unknown']] as const) {
      let pref: ProviderPreference | 'unreadable' = 'on'
      let hold = false
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      const h = await harness({
        preference: { codex: () => { if (pref === 'unreadable') throw new Error('unreadable'); return pref } },
        beforeDiscovery: async () => { if (hold) await gate },
      })
      const a = await addCodexAccount(h)
      hold = true
      const looking = h.service.discover('codex')
      // Past its own first check, the launch now waits on the CLI check in flight.
      const launch = h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's1' })
      pref = then
      release()
      await looking
      expect(await launch, then).toMatchObject({ ok: false, code })
      expect(h.leases.count(a), then).toBe(0)
    }
  })
})

describe('Device-code sign-in stays off in the shipped wiring (U3; WP1.41)', () => {
  it('the wired Codex package declares it experimental, so without the owner\'s flag it is not offered and nothing can start it', async () => {
    // The harness wires the registry's realms exactly as the composition root
    // does, and passes no experimental capability: what the app passes when
    // the saved settings carry none (experimentalFromSettings).
    const h = await harness()
    expect(h.codex.capabilities['auth.device']).toMatchObject({ state: 'experimental' })
    const codex = h.service.snapshot().providers.find((p) => p.providerId === 'codex')!
    expect(codex.signInMethods.device).toEqual({ enabled: false, labelExperimental: true })
    expect(codex.signInMethods.browser.enabled).toBe(true)
    const runs = h.runs.length
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'device' })).toMatchObject({ ok: false, code: 'capability-disabled' })
    expect(h.doc().journals).toEqual([])
    expect(h.runs.length).toBe(runs)
    // Only the owner's provider-scoped flag turns it on.
    const flagged = await harness({ experimental: ['codex:auth.device'] })
    expect(flagged.service.snapshot().providers.find((p) => p.providerId === 'codex')!.signInMethods.device).toEqual({ enabled: true, labelExperimental: true })
  })
})

describe('the answer key is data the package declares', () => {
  it('the real Codex package declares it, and a malformed one is refused at registration', async () => {
    const { createCodexPackage } = await import('../../../src/main/providers/codex')
    const { packageRegistrationProblem } = await import('../../../src/main/providers/core')
    // A fixed home: nothing about this computer is read.
    const codex = createCodexPackage({ hostHome: { env: {}, homeDir: 'C:/Users/u' } })
    expect(codex.enablement).toMatchObject({ settingsKey: 'codexEnabled', absent: 'undecided', answeredKey: 'codexAnswered' })
    expect(packageRegistrationProblem(codex)).toBeNull()
    for (const answeredKey of ['codexEnabled', '', 7, 'codex answered']) {
      const bad = { ...codex, enablement: { ...codex.enablement!, answeredKey } } as never
      expect(packageRegistrationProblem(bad), String(answeredKey)).toBe('enablement.answeredKey must name a boolean ...Answered setting')
    }
  })
})
