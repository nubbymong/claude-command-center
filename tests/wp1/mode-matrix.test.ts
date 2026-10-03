// [host] WP1.1 / WP1.2 / WP1.3 / WP1.60 -- the mode matrix, contract half
// (P4.9, row 67). Each cell of the matrix -- a fresh install with Claude Code
// only, Codex only or both; an upgrade; a restart; an enable and disable
// round trip -- is checked here against the accounts service's own rules.
// The minimum real launch has no accounts-service case: its contract half is
// its e2e spec (tests/e2e/codex-real-launch.spec.ts, VM) and P4.8's
// codex-conformance job (CI); what of it is host-checkable is the spec's
// first-screen reader, checked below on screen text rendered from the 9.2
// probe captures. Every cell names the e2e spec that drives it in the real
// app (VM), and the evidence record's matrix table must say the same cells,
// items and specs. The real-CLI half of WP1.2 is also
// docs/wp1/evidence/real-cli-matrix.md (P4.10).
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
import {
  FIRST_SCREENS, selectedRow, liveFirstScreen, nextFirstScreen, confirmable, composerReady,
} from '../e2e/helpers/codex-first-screens'
import type { FirstScreenAnswer } from '../e2e/helpers/codex-first-screens'

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
// and the evidence record's matrix table says the same cell, items and specs:
// a cell with no spec, a spec that does not exist, or a table row that
// differs from this list (or is missing, or extra) fails here.
type Cell = { cell: string; items: string[]; specs: string[] }
const CELLS: Cell[] = [
  { cell: 'Fresh install, Claude Code only, no Codex installed', items: ['WP1.1'], specs: ['tests/e2e/onboarding-provider-select.spec.ts'] },
  { cell: 'Fresh install, Codex only', items: ['WP1.2'], specs: ['tests/e2e/onboarding-provider-select.spec.ts', 'tests/e2e/codex-session-creation.spec.ts'] },
  { cell: 'Fresh install, both', items: ['WP1.3'], specs: ['tests/e2e/onboarding-provider-select.spec.ts'] },
  { cell: 'Upgrade', items: ['WP1.60'], specs: ['tests/e2e/codex-reconfirm-upgrade.spec.ts'] },
  { cell: 'Restart: a tab, an app relaunch', items: ['WP1.60'], specs: ['tests/e2e/codex-mode-restart.spec.ts'] },
  { cell: 'Enable and disable round trips', items: ['WP1.60'], specs: ['tests/e2e/codex-mode-enable-disable.spec.ts'] },
  { cell: 'Minimum real launch', items: ['WP1.60', 'WP1.2'], specs: ['tests/e2e/codex-real-launch.spec.ts'] },
]

/** The rows of the record's "The mode matrix" table: the cell, its items and
 *  the specs named (in backticks) in its spec column. */
function matrixTable(record: string): Cell[] {
  const lines = record.split(/\r?\n/)
  const start = lines.findIndex((l) => /^## The mode matrix\b/.test(l))
  if (start < 0) return []
  const rows: Cell[] = []
  let seen = false
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    if (!line.startsWith('|')) { if (seen) break; continue }
    seen = true
    const cols = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cols.length < 3 || cols[0] === 'Cell' || /^-+$/.test(cols[0])) continue
    rows.push({
      cell: cols[0],
      items: cols[1].split(',').map((s) => s.trim()).filter(Boolean),
      specs: [...cols[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    })
  }
  return rows
}

/** Where the table and the cell list differ, one line each. */
function tableDiff(rows: Cell[], cells: Cell[]): string[] {
  const out: string[] = []
  for (const c of cells) {
    const r = rows.find((x) => x.cell === c.cell)
    if (!r) { out.push(`${c.cell}: no row in the record's matrix table`); continue }
    if (r.items.join(', ') !== c.items.join(', ')) out.push(`${c.cell}: the table has items ${r.items.join(', ')}, the cell ${c.items.join(', ')}`)
    if (r.specs.join(', ') !== c.specs.join(', ')) out.push(`${c.cell}: the table names ${r.specs.join(', ')}, the cell ${c.specs.join(', ')}`)
  }
  for (const r of rows) if (!cells.some((c) => c.cell === r.cell)) out.push(`${r.cell}: a table row that is no cell of the matrix`)
  return out
}

describe('the matrix and its evidence (WP1.60)', () => {
  const record = readFileSync(resolve(ROOT, 'docs/wp1/evidence/mode-matrix.md'), 'utf8')
  const missing = (cells: Cell[]) => cells.flatMap((c) => c.specs.flatMap((s) => (existsSync(resolve(ROOT, s)) ? [] : [`${c.cell}: ${s} does not exist`])))

  it('every cell has its e2e spec', () => {
    expect(missing(CELLS), missing(CELLS).join('\n')).toEqual([])
    // Verify the verifier: a spec that does not exist is caught.
    expect(missing([{ cell: 'x', items: ['WP1.60'], specs: ['tests/e2e/no-such-mode.spec.ts'] }])).toEqual(['x: tests/e2e/no-such-mode.spec.ts does not exist'])
  })

  it("the record's matrix table says every cell, with the same items and specs, and nothing else", () => {
    const rows = matrixTable(record)
    expect(rows.length).toBe(CELLS.length)
    expect(tableDiff(rows, CELLS), tableDiff(rows, CELLS).join('\n')).toEqual([])
    // Verify the verifier on the record itself, changed in memory: a row gone,
    // an item dropped, two cells' specs swapped (every path is still named in
    // the record, which is all a check for each path somewhere in it saw), and
    // a row that is no cell.
    const without = record.split(/\r?\n/).filter((l) => !l.startsWith('| Upgrade |')).join('\n')
    expect(tableDiff(matrixTable(without), CELLS)).toEqual(["Upgrade: no row in the record's matrix table"])
    const itemDropped = record.replace('| Minimum real launch | WP1.60, WP1.2 |', '| Minimum real launch | WP1.60 |')
    expect(tableDiff(matrixTable(itemDropped), CELLS)).toEqual(['Minimum real launch: the table has items WP1.60, the cell WP1.60, WP1.2'])
    const RESTART = 'tests/e2e/codex-mode-restart.spec.ts'
    const ROUND_TRIP = 'tests/e2e/codex-mode-enable-disable.spec.ts'
    const swapped = record.split(/\r?\n/).map((l) => (l.startsWith('| Restart') ? l.replace(RESTART, ROUND_TRIP) : l.startsWith('| Enable and disable') ? l.replace(ROUND_TRIP, RESTART) : l)).join('\n')
    expect(swapped.includes(RESTART) && swapped.includes(ROUND_TRIP)).toBe(true)
    expect(tableDiff(matrixTable(swapped), CELLS)).toEqual([
      `Restart: a tab, an app relaunch: the table names ${ROUND_TRIP}, the cell ${RESTART}`,
      `Enable and disable round trips: the table names ${RESTART}, the cell ${ROUND_TRIP}`,
    ])
    const extra = record.replace('| Upgrade |', '| Downgrade | WP1.60 | `tests/e2e/navigation.spec.ts` | x |\n| Upgrade |')
    expect(tableDiff(matrixTable(extra), CELLS)).toEqual(['Downgrade: a table row that is no cell of the matrix'])
  })

  it('every matrix item is a cell of it', () => {
    const items = new Set(CELLS.flatMap((c) => c.items))
    for (const id of ['WP1.1', 'WP1.2', 'WP1.3', 'WP1.60']) expect(items.has(id), id).toBe(true)
  })
})

// The minimum real launch's first-screen reader (tests/e2e/helpers/
// codex-first-screens.ts), by the rules of the 9.2 VM incident: the sandbox
// menu confirmed only on a selected "2.", Enter only on a verified row of the
// LIVE menu, each screen answered once, nothing typed before a ready
// composer. The screens are the real Codex's, rendered from the 9.2 probe's
// raw captures (0.155.1; 0.153.4 draws the same rows) at 160 x 38 with
// @xterm/headless; blank rows and the start-up art are left out, and the
// probe's folder reads C:\work\project. An answered menu left above the live
// one is the case the reader exists for (Codex draws in an inline viewport).
describe('the minimum real launch: its first-screen reader (WP1.60, WP1.2; 9.2 rules)', () => {
  const M = '\u203a'
  const BAR = '\u2502'
  const HEADER = [
    `${BAR} >_ OpenAI Codex (v0.155.1)                   ${BAR}`,
    `${BAR} model:     gpt-5.5 medium   /model to change ${BAR}`,
    `${BAR} directory: C:\\work\\project                  ${BAR}`,
  ]
  const FOOTER = '  gpt-5.5 medium \u00b7 C:\\work\\project'
  const TRUST = [
    "  Welcome to Codex, OpenAI's command-line coding agent",
    '',
    '> You are in C:\\work\\project',
    '',
    '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows',
    '  project-local config, hooks, and exec policies to load.',
    '',
    `${M} 1. Yes, continue`,
    '  2. No, quit',
    '',
    '  Press enter to continue and create a sandbox...',
  ]
  /** The sandbox menu with option `sel` selected (0: drawn, no row selected yet). */
  const sandboxMenu = (sel: 0 | 1 | 2) => [
    '  Set up the Codex agent sandbox to protect your files and control network access. Learn more <https://developers.openai.com/codex/windows>',
    '',
    `${sel === 1 ? M : ' '} 1. Set up default sandbox (requires Administrator permissions)`,
    `${sel === 2 ? M : ' '} 2. Use non-admin sandbox (higher risk if prompt injected)`,
    '  3. Quit',
    '',
    '  Press enter to confirm or esc to go back',
  ]
  const SANDBOX = (sel: 0 | 1 | 2) => [...HEADER, '', '', '  Tip: New Build faster with Codex.', '', '', ...sandboxMenu(sel)]
  /** Codex's hooks review (P3.10 VM probe rows), option `sel` selected. */
  const HOOKS = (sel: 1 | 3) => [
    '  Hooks need review',
    '  6 hooks are new or changed.',
    '  Hooks can run outside the sandbox after you trust them.',
    '',
    `${sel === 1 ? M : ' '} 1. Review hooks`,
    '  2. Trust all and continue',
    `${sel === 3 ? M : ' '} 3. Continue without trusting (hooks won't run)`,
    '',
    '  Press enter to confirm or esc to go back',
  ]
  const SETTING_UP = [...HEADER, '', '', '  Tip: New Build faster with Codex.', '', '\u2022 Setting up sandbox... (0s)', '  \u2514 Hang tight, this may take a few minutes', '', '', `${M} Input disabled until setup completes.`, '', FOOTER]
  const READY = [...HEADER, '', '', '  Tip: New Build faster with Codex.', '', '\u2022 Sandbox ready', '  Codex can now safely edit files and execute commands in your computer', '', '', `${M} Ask Codex to do anything`, '', FOOTER]
  const EARLY = [...HEADER, '', '', `${M} Ask Codex to do anything`, '', '  ? for shortcuts']
  const answeredSandbox = (rows: string[]): FirstScreenAnswer => ({ kind: 'sandbox', screen: rows.join('\n') })

  it('reads the selected row of a live menu, and confirms only the option the spec may', () => {
    expect(selectedRow(SANDBOX(1)).trim()).toBe(`${M} 1. Set up default sandbox (requires Administrator permissions)`)
    expect(selectedRow(SANDBOX(2)).trim()).toBe(`${M} 2. Use non-admin sandbox (higher risk if prompt injected)`)
    expect(confirmable(SANDBOX(2), 'sandbox').ok).toBe(true)
    // Never option 1 of the sandbox menu, the administrator set-up (OR6).
    expect(confirmable(SANDBOX(1), 'sandbox')).toMatchObject({ ok: false })
    expect(confirmable(SANDBOX(0), 'sandbox')).toMatchObject({ ok: false, row: '' })
    expect(confirmable(TRUST, 'trust').ok).toBe(true)
    expect(confirmable(HOOKS(1), 'hooks').ok).toBe(false)
    expect(confirmable(HOOKS(3), 'hooks').ok).toBe(true)
    // A screen is confirmed only as itself.
    expect(confirmable(SANDBOX(2), 'trust').ok).toBe(false)
    // A digit only moves the selection in the sandbox menu; Enter is never one of its keys.
    expect(FIRST_SCREENS.sandbox.keys).toEqual(['2'])
    expect(Object.values(FIRST_SCREENS).flatMap((r) => r.keys).some((k) => k.includes('\r'))).toBe(false)
  })

  it('an answered menu left above the live one: the LAST selected row, in the live menu, is the one read', () => {
    // The answered sandbox menu (option 2 selected) still on screen, a second
    // sandbox menu live under it with option 1 selected: Enter must not go.
    const second = [...SANDBOX(2), '', ...sandboxMenu(1)]
    expect(selectedRow(second).trim()).toBe(`${M} 1. Set up default sandbox (requires Administrator permissions)`)
    expect(confirmable(second, 'sandbox')).toMatchObject({ ok: false })
    // The live menu drawn but no row selected yet: the stale "2." is above the
    // live title, so it is never read as the live selection.
    const drawing = [...SANDBOX(2), '', ...sandboxMenu(0)]
    expect(confirmable(drawing, 'sandbox')).toMatchObject({ ok: false, row: '' })
    // The hooks review live under the answered sandbox menu: the live screen is
    // the review, and the stale "2." confirms nothing.
    const review = [...SANDBOX(2), '', ...HOOKS(1)]
    expect(liveFirstScreen(review)?.kind).toBe('hooks')
    expect(confirmable(review, 'sandbox').ok).toBe(false)
    expect(confirmable(review, 'hooks').ok).toBe(false)
    expect(confirmable([...SANDBOX(2), '', ...HOOKS(3)], 'hooks').ok).toBe(true)
    // The trust prompt's frame left above the live sandbox menu.
    expect(liveFirstScreen([...TRUST, ...SANDBOX(1)])?.kind).toBe('sandbox')
    expect(confirmable([...TRUST, ...SANDBOX(1)], 'trust').ok).toBe(false)
  })

  it('answers each screen once, never on a screen unchanged since the last answer', () => {
    expect(nextFirstScreen(TRUST, [])).toEqual({ act: 'answer', kind: 'trust' })
    expect(nextFirstScreen(SANDBOX(1), [{ kind: 'trust', screen: TRUST.join('\n') }])).toEqual({ act: 'answer', kind: 'sandbox' })
    // Unchanged since the answer: wait.
    expect(nextFirstScreen(SANDBOX(2), [answeredSandbox(SANDBOX(2))])).toMatchObject({ act: 'wait' })
    // The answered menu still on screen with the composer drawing under it:
    // wait, never a second "2" into whatever is live.
    expect(nextFirstScreen([...SANDBOX(2), '', ...EARLY], [answeredSandbox(SANDBOX(2))])).toMatchObject({ act: 'wait' })
    // A second sandbox menu is not answered (the probes show one; a second
    // would need its own option text): wait, and the run's bound stops it.
    expect(nextFirstScreen([...SANDBOX(2), '', ...sandboxMenu(1)], [answeredSandbox(SANDBOX(2))])).toMatchObject({ act: 'wait' })
    // The hooks review under the answered menu is a new screen: answered.
    expect(nextFirstScreen([...SANDBOX(2), '', ...HOOKS(1)], [answeredSandbox(SANDBOX(2))])).toEqual({ act: 'answer', kind: 'hooks' })
    expect(nextFirstScreen(READY, [answeredSandbox(SANDBOX(2))])).toEqual({ act: 'none' })
  })

  it('ready: no prompt on screen, the footer last, and the composer above it showing its placeholder', () => {
    expect(composerReady(READY)).toBe(true)
    // During the sandbox set-up the composer reads "Input disabled" over the
    // same footer: not ready.
    expect(composerReady(SETTING_UP)).toBe(false)
    // The composer drawn before the trust prompt, with no footer yet.
    expect(composerReady(EARLY)).toBe(false)
    expect(composerReady(TRUST)).toBe(false)
    expect(composerReady(SANDBOX(2))).toBe(false)
    // Something typed in the composer is not its placeholder.
    expect(composerReady(READY.map((l) => l.replace('Ask Codex to do anything', 'P310-PLAIN-67')))).toBe(false)
    // Any prompt still on screen holds it (9.2: no prompt on screen at all).
    expect(composerReady([...SANDBOX(2), ...READY])).toBe(false)
  })
})
