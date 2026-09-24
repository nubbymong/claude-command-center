import type { CodexOptions } from '../../stores/configStore'
import { useCodexAccountStore } from '../../stores/codexAccountStore'
import { CODEX_MODELS } from '../../codex-models'
import { NO_ACCOUNT, type AccountNotice, type AccountOption } from '../../utils/launchAccount'

/** The "Codex account" field (WP2 commit 6, canvas F6/F9). The dialog works
 *  out what it shows from the Accounts snapshot (utils/launchAccount.ts) and
 *  owns the value, so its validation and this field read the same answer. */
export interface CodexAccountFieldProps {
  /** The Accounts snapshot has arrived: without it nothing is listed or
   *  judged. */
  available: boolean
  value: string
  options: AccountOption[]
  /** The selected account when the list does not offer it. */
  unlisted?: { id: string; label: string }
  /** What the user must act on about the selected account. */
  notice?: AccountNotice
  /** There is no Codex account to start a session on. */
  noAccount: boolean
  /** Show the per-launch checkbox: a new config's launch, on an account
   *  that needs it. Never on an edit, which launches nothing. */
  askAck: boolean
  /** The confirmation's wording (names the email when known). */
  ackLabel: string
  ackChecked: boolean
  onChange: (accountId: string) => void
  onAckChange: (checked: boolean) => void
}

interface Props {
  value: CodexOptions
  onChange: (next: CodexOptions) => void
  onOpenSettings: () => void
  /** Settings, Accounts: where Codex accounts are added and looked after. */
  onOpenAccounts?: () => void
  account?: CodexAccountFieldProps
  /** "Codex 0.150.2 is too old for this app..." when discovery says so. */
  tooOld?: string | null
}

const MODELS = CODEX_MODELS
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const PRESETS = [
  { id: 'read-only' as const,    label: 'Read-only',    desc: 'Safe browsing -- no file writes' },
  { id: 'standard' as const,     label: 'Standard',     desc: 'Recommended -- workspace writes, prompts on tool use' },
  { id: 'auto' as const,         label: 'Auto',         desc: 'Workspace writes, no prompts' },
  { id: 'unrestricted' as const, label: 'Unrestricted', desc: 'Full machine access -- rare' },
]

const warnBox = { borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)', color: 'var(--status-warning)' }
const dangerBox = { borderColor: 'color-mix(in srgb, var(--status-danger) 40%, transparent)', background: 'color-mix(in srgb, var(--status-danger) 9%, transparent)', color: 'var(--status-danger)' }
const selectCls = 'w-full bg-[var(--surface-base)] border border-[var(--border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus-ring'

export function CodexFormFields({ value, onChange, onOpenSettings, onOpenAccounts, account, tooOld }: Props) {
  const installed = useCodexAccountStore((s) => s.installed)
  const openAccounts = onOpenAccounts ?? onOpenSettings
  const noAccount = !!account?.available && account.noAccount
  /** A notice as one sentence whose own words are the link, so "Open
   *  Accounts" never reads twice. */
  const notice = (n: AccountNotice) => (
    <>{n.lead}{' '}<button type="button" onClick={openAccounts} className="underline">{n.link}</button>{n.tail}</>
  )

  return (
    <div className="space-y-4 my-2">
      {!installed && !tooOld && (
        <div className="rounded-[9px] border p-3 text-xs leading-snug" style={warnBox}>
          Codex CLI is not installed.{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Open Settings for install instructions
          </button>
        </div>
      )}
      {tooOld && (
        <div className="rounded-[9px] border p-3 text-xs leading-snug" style={dangerBox} data-testid="codex-too-old">
          {tooOld}
        </div>
      )}
      {noAccount && (
        <div className="rounded-[9px] border p-3 text-xs leading-snug" style={warnBox} data-testid="codex-no-account">
          {notice(NO_ACCOUNT)}
        </div>
      )}

      {account?.available && !noAccount && (
        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1" htmlFor="codex-account">Codex account</label>
          <select
            id="codex-account"
            value={account.value}
            onChange={(e) => account.onChange(e.target.value)}
            className={selectCls}
            data-testid="codex-account-select"
          >
            {account.options.map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>
            ))}
            {account.unlisted && (
              <option key={account.unlisted.id} value={account.unlisted.id} disabled>{account.unlisted.label}</option>
            )}
          </select>
          {account.notice && (
            <div className="mt-2 rounded-[9px] border p-3 text-xs leading-snug" style={warnBox} data-testid="codex-account-notice">
              {notice(account.notice)}
            </div>
          )}
          {account.askAck && (
            <label
              className="mt-2 flex items-start gap-2.5 rounded-[9px] border px-3 py-2.5 text-[12.5px] leading-snug cursor-pointer"
              style={{ ...warnBox, color: 'var(--text-primary)' }}
              data-testid="codex-account-ack"
            >
              <input
                type="checkbox"
                checked={account.ackChecked}
                onChange={(e) => account.onAckChange(e.target.checked)}
                className="mt-0.5 rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                data-testid="codex-account-ack-checkbox"
              />
              <span>{account.ackLabel}</span>
            </label>
          )}
        </div>
      )}

      <div>
        <label className="block text-xs text-[var(--text-secondary)] mb-1">Model</label>
        <select
          value={value.model ?? 'gpt-5.5'}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          className={selectCls}
        >
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs text-[var(--text-secondary)] mb-1">Reasoning effort</label>
        <select
          value={value.reasoningEffort ?? 'medium'}
          onChange={(e) => onChange({ ...value, reasoningEffort: e.target.value as CodexOptions['reasoningEffort'] })}
          className={selectCls}
        >
          {EFFORTS.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
        </select>
      </div>

      <fieldset>
        <legend className="text-xs text-[var(--text-secondary)] mb-1">Permissions</legend>
        <div className="space-y-1">
          {PRESETS.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-[var(--surface-overlay)]">
              <input
                type="radio"
                name="codex-permissions"
                checked={value.permissionsPreset === p.id}
                onChange={() => onChange({ ...value, permissionsPreset: p.id })}
                className="mt-0.5 accent-[var(--brand)]"
              />
              <div>
                <div className="text-sm text-[var(--text-primary)]">{p.label}</div>
                <div className="text-xs text-[var(--text-secondary)]">{p.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}
