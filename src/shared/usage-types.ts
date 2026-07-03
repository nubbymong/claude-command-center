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
  /** Remaining balance in major units, when the API reports a cap/limit. */
  remaining: number | null
  /** Used credits in major units. */
  used: number
  /** Cap/limit in major units, when set. */
  limit: number | null
}

export interface ParsedUsage {
  buckets: UsageBucket[]
  /** Present ONLY when the account has paid credit enabled (user "added cash"). */
  credits?: CreditsInfo
}

export type AccountUsageStatus = 'ok' | 'needs-login' | 'error'

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
}
