// Usage track MP12 (owner decisions Q1.4, Q1.5; the approved canvas
// "Tokenomics with two providers", option A): what the Tokenomics page says
// about providers and accounts. Pure: the page, the filter bar and the tables
// read their labels, groups, notices and tooltips from here.
import type { AccountsSnapshot, AccountView } from '../../../shared/providers'
import type { IdentityColorKey } from '../../../shared/identity-colors'
import type { TkAccountPresent, TkAccountReread, TkProvider, TkSummary } from '../../../shared/types'
import { accountDisplayName } from '../../stores/providerAccountsStore'

export const TK_PROVIDERS: readonly TkProvider[] = ['claude', 'codex']
export const TK_PROVIDER_LABEL: Record<TkProvider, string> = { claude: 'Claude Code', codex: 'Codex' }
/** Each provider's colour on the page, as its ProviderMark has it. */
export const TK_PROVIDER_COLOR: Record<TkProvider, string> = { claude: 'var(--color-peach)', codex: 'var(--color-mauve)' }
/** Usage recorded to no account (Q1.4): older sessions, sessions run outside
 *  the app, and Codex history from before its folders were known. */
export const TK_NOT_RECORDED = 'Not recorded'
/** This computer's own Codex home (U3): its history, never its sign-in. */
export const TK_THIS_COMPUTER = "This computer's sign-in"
/** An account no longer in the registry. */
export const TK_REMOVED_ACCOUNT = 'Removed account'
/** The Codex KPI legend's tooltip (Q1.5, as the approved canvas words it). */
export const TK_CODEX_COST_NOTE = 'ChatGPT sign-in: API-equivalent estimate. API key: Estimate at API list prices.'
/** A cost with no price, said as briefly as the page's notice says it. */
export const TK_NO_PRICE_NOTE = 'No price yet, so not in the totals.'

/** The registry account an account key names, if the snapshot has it. */
export function tkAccountView(snapshot: AccountsSnapshot | null, accountKey: string): AccountView | undefined {
  const at = accountKey.indexOf(':')
  if (at <= 0) return undefined
  const provider = accountKey.slice(0, at)
  const id = accountKey.slice(at + 1)
  return snapshot?.accounts.find((a) => a.providerId === provider && a.id === id)
}

/** The identity colour of an account key's account, if it has one (the
 *  chip beside its name in the sessions table). */
export function tkAccountColourKey(snapshot: AccountsSnapshot | null, accountKey: string): IdentityColorKey | null {
  const account = tkAccountView(snapshot, accountKey)
  const key = account ? snapshot?.identities.find((i) => i.id === account.identityId)?.colourKey : undefined
  return typeof key === 'string' && key ? key as IdentityColorKey : null
}

/** An account key's label: its account's name ("(archived)" once archived),
 *  "This computer's sign-in", or "Not recorded". */
export function tkAccountLabel(snapshot: AccountsSnapshot | null, accountKey: string): string {
  if (accountKey === '') return TK_NOT_RECORDED
  if (accountKey === 'codex:external') return TK_THIS_COMPUTER
  const account = tkAccountView(snapshot, accountKey)
  if (!account) return TK_REMOVED_ACCOUNT
  const name = accountDisplayName(snapshot, account)
  return account.lifecycle === 'archived' ? `${name} (archived)` : name
}

/** The KPI split for these figures (MP12), or undefined when one provider
 *  is shown: the providers with usage here (a provider chosen in the filter
 *  is the only one), and those whose usage here has no price at all. */
export function tkKpiSplit(summary: TkSummary, present: readonly TkAccountPresent[], chosen?: TkProvider): {
  byProvider: TkSummary['kpisByProvider']; providers: TkProvider[]; noPrice: TkProvider[]
} | undefined {
  if (chosen) return undefined
  const providers = tkProvidersWithData(present)
  if (providers.length < 2) return undefined
  const noPrice = providers.filter((p) => summary.kpisByProvider[p].lifeToDateCostUsd === 0 && summary.unpriced.some((u) => u.provider === p))
  return { byProvider: summary.kpisByProvider, providers, noPrice }
}

/** The cost chart's series (MP12 round 1): of the split's providers, those
 *  with cost in the range shown (the chart plots cost), or none when fewer
 *  than two are left. */
export function tkSeriesInRange(providers: readonly TkProvider[] | undefined, daily: TkSummary['dailySeries']): TkProvider[] | undefined {
  const shown = (providers ?? []).filter((p) => daily.some((d) => (d.byProvider?.[p] ?? 0) > 0))
  return shown.length > 1 ? shown : undefined
}

/** The providers the stored usage has, in page order. */
export function tkProvidersWithData(present: readonly TkAccountPresent[]): TkProvider[] {
  return TK_PROVIDERS.filter((p) => present.some((a) => a.provider === p))
}

export interface TkAccountOption { value: string; provider: TkProvider; accountKey: string; label: string }
export interface TkAccountGroup { provider: TkProvider; label: string; options: TkAccountOption[] }

/** The value an Account filter option carries: its provider and its key
 *  ("Not recorded" is '' under either provider). */
export function tkAccountValue(provider: TkProvider, accountKey: string): string {
  return `${provider}|${accountKey}`
}
export function tkParseAccountValue(value: string): { provider: TkProvider; key: string } | null {
  const at = value.indexOf('|')
  if (at <= 0) return null
  const provider = value.slice(0, at)
  if (!(TK_PROVIDERS as readonly string[]).includes(provider)) return null
  return { provider: provider as TkProvider, key: value.slice(at + 1) }
}

/** The Account filter's groups (Q1.4): one per provider with usage (only
 *  the chosen one when a provider is chosen), each listing its accounts by
 *  name, then "This computer's sign-in", then "Not recorded" (under Codex as
 *  under Claude: MP9 round 1). */
export function tkAccountGroups(present: readonly TkAccountPresent[], snapshot: AccountsSnapshot | null, only?: TkProvider): TkAccountGroup[] {
  const groups: TkAccountGroup[] = []
  for (const provider of TK_PROVIDERS) {
    if (only && provider !== only) continue
    const mine = present.filter((a) => a.provider === provider)
    if (mine.length === 0) continue
    const named = mine
      .filter((a) => a.accountKey !== '' && a.accountKey !== 'codex:external')
      .map((a) => ({ value: tkAccountValue(provider, a.accountKey), provider, accountKey: a.accountKey, label: tkAccountLabel(snapshot, a.accountKey) }))
      .sort((x, y) => x.label.localeCompare(y.label))
    const options = [...named]
    if (mine.some((a) => a.accountKey === 'codex:external')) options.push({ value: tkAccountValue(provider, 'codex:external'), provider, accountKey: 'codex:external', label: TK_THIS_COMPUTER })
    if (mine.some((a) => a.accountKey === '')) options.push({ value: tkAccountValue(provider, ''), provider, accountKey: '', label: TK_NOT_RECORDED })
    groups.push({ provider, label: TK_PROVIDER_LABEL[provider], options })
  }
  return groups
}

/** A session's cost tooltip (Q1.5, as the approved canvas draws it): an
 *  API-equivalent estimate, except a Codex account signed in with an API key,
 *  estimated at list prices; no price, said so. */
export function tkCostTooltip(provider: TkProvider, accountKey: string, snapshot: AccountsSnapshot | null, costUsd: number | null): string {
  if (costUsd === null) return TK_NO_PRICE_NOTE
  if (provider === 'claude') return 'API-equivalent estimate'
  const account = tkAccountView(snapshot, accountKey)
  return account?.authMethod === 'apiKey' ? 'Estimate at API list prices' : 'API-equivalent estimate'
}

/** Tokens, compactly: 1.4M, 220k, 12. */
export function tkTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** "a", "a and b", "a, b and c". */
function joined(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The unpriced notice (Q1.4), or null: the models in these figures with no
 *  price and their tokens. */
export function tkUnpricedNotice(unpriced: TkSummary['unpriced'] | undefined): string | null {
  if (!unpriced || unpriced.length === 0) return null
  const models = [...new Set(unpriced.map((u) => u.model))]
  const tokens = unpriced.reduce((s, u) => s + (u.tokens || 0), 0)
  return `${joined(models)} ${models.length === 1 ? 'has' : 'have'} no price yet (${tkTokens(tokens)} tokens), so ${models.length === 1 ? 'its' : 'their'} cost is not in these figures.`
}

/** The one-off attribution notice (MP9 round 1, the decided wording), or
 *  null when it is not running: the totals are complete throughout; only the
 *  split fills in. */
export function tkRereadNotice(r: TkAccountReread | null | undefined): string | null {
  if (!r) return null
  const count = (unit: string) => (r.total > 0 ? `: ${r.done} of ${r.total} ${unit}` : '')
  return r.stage === 'reread'
    ? `Sorting Codex history by account${count('files')}. Totals are complete; the split by account fills in.`
    : `Sorting usage by account and provider${count('entries')}. Totals are complete; the split fills in.`
}
