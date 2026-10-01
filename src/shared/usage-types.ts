// Shared usage-overview types (main producer, renderer consumer). Kept free of
// any Node/DOM imports so both processes can import it.

export type UsageSeverity = 'normal' | 'warning' | 'critical' | string

export interface UsageBucket {
  /** Stable-ish key for React lists + de-dupe (kind + model label). */
  key: string
  /** Display label: "5h", "Weekly", or the model name ("Fable", "Sonnet"). */
  label: string
  /** 'session' | 'weekly' — used for ordering + grouping. */
  group: string
  /** 0-100. */
  percent: number
  /** ISO reset timestamp, or '' when absent. */
  resetsAt: string
  /** API-provided colour hint; the renderer may map this or use its own ramp. */
  severity: UsageSeverity
}

export interface CreditsInfo {
  /** ISO-4217 currency (e.g. "GBP", "USD"). */
  currency: string
  /** Remaining balance in major units, when the API reports a cap/limit/balance. */
  remaining: number | null
  /** Used credits in major units. */
  used: number
  /** Cap/limit in major units, when set. */
  limit: number | null
  /** Whether paid credit is currently active for this account. */
  enabled: boolean
  /** e.g. "out_of_credits" — shown when disabled so the user knows why. */
  disabledReason?: string
}

export interface ParsedUsage {
  buckets: UsageBucket[]
  /** Present ONLY when the account has paid credit enabled (user "added cash"). */
  credits?: CreditsInfo
}

/**
 * One allowance window of a provider reading, already validated: whatever
 * produced it dropped anything it could not trust (usage track MP2).
 */
export interface AllowanceWindow {
  /** Length in minutes (300 = 5 hours, 10080 = a week); null when not reported. */
  windowMinutes: number | null
  /** Share used, 0-100. */
  usedPercent: number
  /** When the window resets, epoch ms; null when not reported. */
  resetsAt: number | null
}

/** One metered limit of an account and its windows (at least one is set). */
export interface AllowanceLimit {
  /** The provider's id for the limit; the account-wide default comes first. */
  limitId: string
  /** The display name the provider gives a separate limit, or null. */
  limitName: string | null
  /** When THIS limit was last reported, epoch ms; null when unknown. A
   *  session that moved to another model's limit leaves this one's figure
   *  behind, with its own, older time. */
  readingAt: number | null
  primary: AllowanceWindow | null
  secondary: AllowanceWindow | null
}

/** An account's credits as one reading reports them: a count of the
 *  provider's own credits, NOT money (P3.1 evidence answer 7; ADR-023), so it
 *  is not a `CreditsInfo` and carries no currency. Validated: a flag that is
 *  not a boolean drops the whole of it, a balance that is not a plain decimal
 *  becomes null; nothing is repaired. `balance` is null when the reading
 *  names none. */
export interface AllowanceCredits {
  hasCredits: boolean
  unlimited: boolean
  balance: number | null
}

/** An account's allowances as one reading, provider-neutral. */
export interface AllowanceReading {
  limits: AllowanceLimit[]
  /** The plan as the provider reports it ('plus', 'pro', ...), from the known list only. */
  planType: string | null
  /** How old the reading is as a whole, epoch ms: the OLDEST of its limits'
   *  times (the event time for a session's transcript, the read time for a
   *  live read), so an "as of" built on it never looks fresher than any
   *  figure it shows; null when unknown. */
  readingAt: number | null
  /** The account's credits count, when the reading carries one; the key is
   *  omitted when it does not. In a merge the newest reading that has one
   *  wins, as the plan does. */
  credits?: AllowanceCredits
}

// ChatGPT plans as a ChatGPT sign-in reports them: the PlanType list of the
// app-server schema, identical in CLI 0.153.4, 0.155.1 and 0.157.1. 'unknown'
// is left out on purpose: an unknown plan shows no pill rather than the word
// "Unknown".
const PLAN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Business',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
})

/** The plan pill's text for a reported plan type, or null when the plan is
 *  missing or not one this build knows (unknown stays unknown). */
export function planLabelFor(planType: unknown): string | null {
  if (typeof planType !== 'string' || !Object.prototype.hasOwnProperty.call(PLAN_LABELS, planType)) return null
  return PLAN_LABELS[planType]
}

// 'inactive' = the account is parked (isAccountActive false): the usage page
// still lists it, greyed, but it is never network-polled or token-refreshed and
// offers no sign-in. See fetchAccountUsage's early return.
// 'off' = the provider is switched off, or its setting could not be read
// (D5 of the usage UX): nothing was read for the account, no credential, no
// refresh and no request.
export type AccountUsageStatus = 'ok' | 'needs-login' | 'error' | 'inactive' | 'off'

export interface AccountUsage {
  profileId: string
  email: string | null
  name: string
  isPrimary: boolean
  status: AccountUsageStatus
  buckets: UsageBucket[]
  credits?: CreditsInfo
  /** epoch ms when this data was fetched. */
  fetchedAt: number
  /** short reason for a non-ok status (for the UI hint). */
  detail?: string
  /** True when `status: 'ok'` figures are served from cache — a live refresh
   *  couldn't complete but the account is still signed in. */
  stale?: boolean
  /** Whether the account is active (selectable). False = parked: the page greys
   *  it and offers no sign-in, and it is not polled/refreshed. Undefined is
   *  treated as active by the renderer, so a main process that predates this
   *  field never greys a card. Mirrors AccountProfile.active / isAccountActive. */
  active?: boolean
}
