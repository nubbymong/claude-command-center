// [host] WP1.1 / WP1.2 / WP1.3 / WP1.60 -- the mode matrix, contract half
// (P4.9, row 67). Each cell of the matrix -- a fresh install with Claude Code
// only, Codex only or both; an upgrade; a restart; an enable and disable
// round trip; the minimum launch -- is checked here against the accounts
// service's own rules, and each names the e2e spec that drives it in the real
// app (VM) and the evidence record that lists it. The real-CLI half of WP1.2
// and the minimum real launch are tests/e2e/codex-real-launch.spec.ts on the
// VM and docs/wp1/evidence/real-cli-matrix.md; the CI half is the
// codex-conformance job (P4.8).
//
// PURE: the real Codex and Claude packages on the shared harness (a fake CLI,
// an in-memory registry and folder tree). No file is written and no process
// is started; the only reads are this repo's spec files and the evidence
// document.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { harness, addCodexAccount, managedHome, EXE } from './accounts-harness'
import type { Harness } from './accounts-harness'
import { createCodexPackage } from '../../src/main/providers/codex'
import { createClaudePackage } from '../../src/main/providers/claude'
import type { ProviderPreference } from '../../src/shared/providers'

const ROOT = resolve(__dirname, '..', '..')

/** What the renderer saved, read three-way as the composition root reads it
 *  (provider-accounts.ts providerPreferenceFromSettings). */
type Saved = { claudeEnabled?: boolean; codexEnabled?: boolean; codexAnswered?: boolean }

/** A harness whose saved on/off is `saved`, read afresh on every question,
 *  as main reads the settings file. */
async function withSettings(saved: Saved, opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; saved: Saved }> {
  const { providerPreferenceFromSettings } = await import('../../src/main/provider-accounts')
  // Each package's own enablement data (which key, what absent means, the answer key).
  const specs = { claude: createClaudePackage({}).enablement, codex: createCodexPackage({}).enablement }
  const pref = (id: 'claude' | 'codex') => (): ProviderPreference => providerPreferenceFromSettings(specs[id], saved as Record<string, unknown>)
  const h = await harness({ ...opts, preference: { claude: pref('claude'), codex: pref('codex') } })
  return { h, saved }
}

const session = (ownerId: string, providerAccountId?: string) => ({ kind: 'session' as const, providerId: 'codex' as const, ownerId, sessionId: ownerId, ...(providerAccountId ? { providerAccountId } : {}) })
const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId

describe('a fresh install, per assistants choice (WP1.1, WP1.2, WP1.3)', () => {
  it('Claude Code only, with no Codex installed: Claude launches, nothing of Codex starts, and Codex reads off (WP1.1)', async () => {
    const { h } = await withSettings({ claudeEnabled: true, codexEnabled: false, codexAnswered: true }, { cli: false })
    expect(h.service.launchRefusal('claude')).toBeNull()
    expect(h.service.launchRefusal('codex')).toMatchObject({ code: 'provider-off', providerId: 'codex' })
    const runs = h.runs.length
    expect(await h.service.prepareLaunch(session('s1'))).toMatchObject({ ok: false, code: 'provider-disabled' })
    // No Codex CLI was looked for or run, and no lease taken.
    expect(h.runs.length).toBe(runs)
    expect(h.discoveries()).toBe(0)
    expect(h.leases.countForProvider('codex')).toBe(0)
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')).toMatchObject({ enabled: false, preference: 'off' })
  })

  it("Codex only: a session runs on the selected account's exact realm, with the proven CLI, and nothing of Claude starts (WP1.2, contract half)", async () => {
    const { h } = await withSettings({ claudeEnabled: false, codexEnabled: true, codexAnswered: true })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect(h.service.launchRefusal('claude')).toMatchObject({ code: 'provider-off', providerId: 'claude' })
    const r = await h.service.prepareLaunch(session('s1', b))
    if (!r.ok) throw new Error(`${r.code}: ${r.message ?? ''}`)
    expect(r.binding.providerAccountId).toBe(b)
    expect(r.home).toBe(managedHome(realmOf(h, b)))
    expect(r.home).not.toBe(managedHome(realmOf(h, a)))
    expect(r.executable).toBe(EXE)
    // The realm's own folder is the session's CODEX_HOME, set last; no ambient key.
    expect(r.env.CODEX_HOME).toBe(r.home)
    expect(Object.keys(r.env).at(-1)).toBe('CODEX_HOME')
    expect(r.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(h.leases.runningSessions(b)).toBe(1)
    expect(h.leases.runningSessions(a)).toBe(0)
  })

  it('both: each provider is verified on its own; Codex missing leaves Claude usable, and Claude off leaves Codex usable (WP1.3)', async () => {
    const both = await withSettings({ claudeEnabled: true, codexEnabled: true, codexAnswered: true }, { cli: false })
    expect((await both.h.service.discover('codex')) as unknown).toMatchObject({ ok: true })
    expect(both.h.service.snapshot().providers.find((p) => p.providerId === 'codex')).toMatchObject({ enabled: true, discoveryState: 'missing' })
    expect(both.h.service.launchRefusal('claude')).toBeNull()
    expect(both.h.service.launchRefusal('codex')).toBeNull()
    // Found, once installed: Codex launches beside Claude.
    both.h.state.cli = true
    expect(await both.h.service.discover('codex')).toMatchObject({ ok: true })
    const a = await addCodexAccount(both.h)
    expect(await both.h.service.prepareLaunch(session('s1', a))).toMatchObject({ ok: true })
    expect(both.h.service.launchRefusal('claude')).toBeNull()
    // Claude off does not stop Codex.
    both.saved.claudeEnabled = false
    expect(both.h.service.launchRefusal('claude')).toMatchObject({ code: 'provider-off' })
    expect(await both.h.service.prepareLaunch(session('s2', a))).toMatchObject({ ok: true })
  })
})

describe('an upgrade (WP1.60)', () => {
  it("an earlier build's Codex on/off without the answer is no answer: nothing of Codex starts until the user says, and Claude is unaffected", async () => {
    const { h, saved } = await withSettings({ codexEnabled: true })
    expect(h.service.launchRefusal('codex')).toMatchObject({ code: 'provider-not-set-up' })
    expect(await h.service.prepareLaunch(session('s1'))).toMatchObject({ ok: false, code: 'provider-not-set-up' })
    expect(h.service.launchRefusal('claude')).toBeNull()
    // The answer (Yes) makes it on.
    saved.codexAnswered = true
    expect(h.service.launchRefusal('codex')).toBeNull()
  })
})

describe('a restart (WP1.60)', () => {
  it('a restarted session runs on the same account and realm, as a new lease; with Codex turned off it starts nothing', async () => {
    const { h, saved } = await withSettings({ codexEnabled: true, codexAnswered: true })
    const a = await addCodexAccount(h)
    const first = await h.service.prepareLaunch(session('tab-1', a))
    if (!first.ok) throw new Error(first.code)
    expect(h.service.releaseLaunch('session', 'tab-1')).toBe(true)
    const again = await h.service.prepareLaunch(session('tab-1', a))
    if (!again.ok) throw new Error(again.code)
    expect(again.home).toBe(first.home)
    expect(again.binding.providerAccountId).toBe(a)
    expect(h.leases.runningSessions(a)).toBe(1)
    h.service.releaseLaunch('session', 'tab-1')
    // Off: the tab's restart is refused before any lease (it reads Not started).
    saved.codexEnabled = false
    expect(await h.service.prepareLaunch(session('tab-1', a))).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(h.leases.count(a)).toBe(0)
  })

  it('after an app relaunch the restored session finds its account and realm on the same disk', async () => {
    const { h } = await withSettings({ codexEnabled: true, codexAnswered: true })
    const a = await addCodexAccount(h)
    const before = await h.service.prepareLaunch(session('tab-1', a))
    if (!before.ok) throw new Error(before.code)
    // A new start of the app: the same registry file and folders.
    const { h: next } = await withSettings({ codexEnabled: true, codexAnswered: true }, { port: h.port, folders: h.folders })
    const after = await next.service.prepareLaunch(session('tab-1', a))
    if (!after.ok) throw new Error(after.code)
    expect(after.home).toBe(before.home)
    expect(after.binding.providerAccountId).toBe(a)
  })
})

describe('an enable and disable round trip (WP1.60)', () => {
  it('in use refuses the switch-off; once stopped it turns off and launches are refused; turned on, the same account launches again', async () => {
    const { h, saved } = await withSettings({ claudeEnabled: true, codexEnabled: true, codexAnswered: true })
    const a = await addCodexAccount(h)
    const r = await h.service.prepareLaunch(session('tab-1', a))
    if (!r.ok) throw new Error(r.code)
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    expect(h.service.isEnabled('codex')).toBe(true)
    h.service.releaseLaunch('session', 'tab-1')
    expect(await h.service.setProviderEnabled('codex', false)).toEqual({ ok: true })
    // The renderer saves the switch-off (providerAccountsStore saveProviderSwitch).
    saved.codexEnabled = false
    expect(await h.service.prepareLaunch(session('tab-1', a))).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')).toMatchObject({ enabled: false })
    // On again: the same account, the same realm.
    expect(await h.service.setProviderEnabled('codex', true)).toEqual({ ok: true })
    saved.codexEnabled = true
    const again = await h.service.prepareLaunch(session('tab-1', a))
    if (!again.ok) throw new Error(again.code)
    expect(again.home).toBe(r.home)
  })

  it('the last provider on stays on, whichever it is', async () => {
    const codexOnly = await withSettings({ claudeEnabled: false, codexEnabled: true, codexAnswered: true })
    expect(await codexOnly.h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'last-provider' })
    const claudeOnly = await withSettings({ claudeEnabled: true, codexEnabled: false, codexAnswered: true })
    expect(await claudeOnly.h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: false, code: 'last-provider' })
  })
})

// Every cell of the matrix is driven in the real app by its e2e spec (VM),
// and the evidence record names that spec: a cell with no spec, or a spec
// the record does not list, fails here.
const CELLS: Array<{ cell: string; items: string[]; specs: string[] }> = [
  { cell: 'fresh install, Claude Code only, no Codex installed', items: ['WP1.1'], specs: ['tests/e2e/onboarding-provider-select.spec.ts'] },
  { cell: 'fresh install, Codex only', items: ['WP1.2'], specs: ['tests/e2e/onboarding-provider-select.spec.ts', 'tests/e2e/codex-session-creation.spec.ts'] },
  { cell: 'fresh install, both', items: ['WP1.3'], specs: ['tests/e2e/onboarding-provider-select.spec.ts'] },
  { cell: 'upgrade', items: ['WP1.60'], specs: ['tests/e2e/codex-reconfirm-upgrade.spec.ts'] },
  { cell: 'restart (a tab, an app relaunch)', items: ['WP1.60'], specs: ['tests/e2e/codex-mode-restart.spec.ts'] },
  { cell: 'enable and disable round trips', items: ['WP1.60'], specs: ['tests/e2e/codex-mode-enable-disable.spec.ts'] },
  { cell: 'minimum real launch', items: ['WP1.60', 'WP1.2'], specs: ['tests/e2e/codex-real-launch.spec.ts'] },
]

describe('the matrix and its evidence (WP1.60)', () => {
  const record = readFileSync(resolve(ROOT, 'docs/wp1/evidence/mode-matrix.md'), 'utf8')
  const missing = (cells: typeof CELLS) => cells.flatMap((c) => c.specs.flatMap((s) => [
    ...(existsSync(resolve(ROOT, s)) ? [] : [`${c.cell}: ${s} does not exist`]),
    ...(record.includes(s) ? [] : [`${c.cell}: docs/wp1/evidence/mode-matrix.md does not name ${s}`]),
  ]))

  it('every cell has its e2e spec, and the evidence record names it', () => {
    expect(missing(CELLS), missing(CELLS).join('\n')).toEqual([])
    // Verify the verifier: a spec that does not exist, and one the record does
    // not name, are both caught.
    expect(missing([{ cell: 'x', items: ['WP1.60'], specs: ['tests/e2e/no-such-mode.spec.ts'] }])).toHaveLength(2)
    expect(missing([{ cell: 'x', items: ['WP1.60'], specs: ['tests/e2e/navigation.spec.ts'] }])).toEqual(['x: docs/wp1/evidence/mode-matrix.md does not name tests/e2e/navigation.spec.ts'])
  })

  it('every matrix item is a cell of it', () => {
    const items = new Set(CELLS.flatMap((c) => c.items))
    for (const id of ['WP1.1', 'WP1.2', 'WP1.3', 'WP1.60']) expect(items.has(id), id).toBe(true)
  })
})
