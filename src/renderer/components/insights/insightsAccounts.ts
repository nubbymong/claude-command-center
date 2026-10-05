// WP2 PR 4, P4.7 (row 68): which accounts the Insights page offers a run
// on, and how it names them (mockup D6, D7, D12, C1 A; approved on the Agent
// Canvas 2026-10-05). Pure helpers over the account profiles (Claude Code)
// and the Accounts snapshot (Codex), so the picker, the run picker's labels
// and Run all can never disagree.
//
// - Claude Code's accounts are the account profiles, as the page always
//   listed them; with none, Claude Code's own sign-in is one choice while
//   Claude Code is on.
// - Codex's are the list the New session and New agent dialogs use
//   (sessionAccountOptions): active accounts only, the Codex default first,
//   then by name, a blocked one listed but not offered; "(Codex)" after a
//   name that does not already say Codex, and "- confirm at launch" where a
//   run needs its own confirmation. With Codex off or not set up, none.
// - The picker shows with two or more accounts across both assistants.
// - Run all counts every account of every assistant that is on, less an
//   account whose runs need their own confirmation (main names it under
//   "Left out of this comparison").
// No default export (project convention).
import type { AccountsSnapshot, AccountView } from '../../../shared/providers'
import { accountDisplayName } from '../../stores/providerAccountsStore'
import { sessionAccountOptions, launchNeedsAcknowledgement, accountEmail } from '../../utils/launchAccount'

/** One account the page can run a report on. */
export interface InsightsAccountChoice {
  /** The picker's value: `claude:<profile id>` (`claude:` for Claude Code's
   *  own sign-in when there are no profiles) or `codex:<account id>`. */
  value: string
  provider: 'claude' | 'codex'
  /** The profile id or the Codex account id; '' for Claude Code's own sign-in. */
  id: string
  label: string
  /** Listed, not offered (a blocked Codex account). */
  disabled: boolean
  /** A run on it asks its own confirmation first (D12). */
  needsAck: boolean
  /** This computer's own Codex sign-in. */
  external: boolean
  email?: string
}

/** A Codex account's name as Insights shows it: "(Codex)" after it unless
 *  it already says Codex. */
export function codexAccountLabel(name: string): string {
  const n = name.trim() || 'Codex account'
  return /codex/i.test(n) ? n : `${n} (Codex)`
}

/** The Codex accounts the picker lists (see the module comment). */
export function codexAccountChoices(snapshot: AccountsSnapshot | null, codexUsable: boolean): InsightsAccountChoice[] {
  if (!codexUsable) return []
  return sessionAccountOptions(snapshot, 'codex').map((o) => {
    const a = snapshot?.accounts.find((x) => x.id === o.id) as AccountView | undefined
    const needsAck = !!a && launchNeedsAcknowledgement(a)
    let label = codexAccountLabel(o.name)
    if (needsAck) label += ' - confirm at launch'
    if (o.disabled) label += ' (Needs attention)'
    const email = accountEmail(a)
    return { value: `codex:${o.id}`, provider: 'codex', id: o.id, label, disabled: o.disabled, needsAck, external: !!a?.external, ...(email ? { email } : {}) }
  })
}

/** Claude Code's accounts the picker lists: every profile (as the page
 *  always listed them, also while Claude Code is off, when a run on one says
 *  why it cannot start), or Claude Code's own sign-in while it is on and
 *  there are no profiles. */
export function claudeAccountChoices(
  profiles: ReadonlyArray<{ id: string; accountEmail: string; name?: string; isPrimary?: boolean }>,
  labelForProfile: (p: { accountEmail: string; name?: string; isPrimary?: boolean }) => string,
  claudeOn: boolean,
): InsightsAccountChoice[] {
  if (profiles.length === 0) {
    return claudeOn ? [{ value: 'claude:', provider: 'claude', id: '', label: 'Claude Code', disabled: false, needsAck: false, external: false }] : []
  }
  return profiles.map((p) => ({ value: `claude:${p.id}`, provider: 'claude', id: p.id, label: labelForProfile(p), disabled: false, needsAck: false, external: false }))
}

/** The choice a new page starts on: Claude Code's primary while Claude Code
 *  is on (as before), else the first Codex account offered, else Claude
 *  Code's first (its run then says why it cannot start). */
export function defaultInsightsChoice(claude: InsightsAccountChoice[], codex: InsightsAccountChoice[], claudeOn: boolean, primaryProfileId: string): InsightsAccountChoice | null {
  const primary = claude.find((c) => c.id === primaryProfileId) ?? claude[0]
  if (claudeOn && primary) return primary
  return codex.find((c) => !c.disabled) ?? primary ?? null
}

/** How many accounts Run all runs: Claude Code's profiles while it is on,
 *  and every Codex account offered that needs no confirmation of its own. */
export function runAllCount(claude: InsightsAccountChoice[], codex: InsightsAccountChoice[], claudeOn: boolean): number {
  const claudeCount = claudeOn ? claude.filter((c) => c.id !== '').length : 0
  return claudeCount + codex.filter((c) => !c.disabled && !c.needsAck).length
}

/** A Codex run's account name in the run picker (D6): the account's name
 *  with "(Codex)", or what the run recorded, else "Codex". */
export function codexRunAccountName(snapshot: AccountsSnapshot | null, accountId: string | undefined, recordedEmail: string | undefined): string {
  const a = accountId ? snapshot?.accounts.find((x) => x.id === accountId && x.providerId === 'codex') : undefined
  if (a) return codexAccountLabel(accountDisplayName(snapshot, a))
  return recordedEmail ? codexAccountLabel(recordedEmail) : 'Codex'
}
