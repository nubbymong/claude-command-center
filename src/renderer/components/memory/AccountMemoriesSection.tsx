import React from 'react'
import type { AccountMemories } from '../../../shared/account-memories'
import type { ProviderId } from '../../../shared/types'
import { TypeBadge, fmt, fmtRel } from './memory-ui'

/** One account's memories, with the name it is shown under. */
export interface LabelledAccountMemories {
  entry: AccountMemories
  label: string
}

interface Props {
  /** The provider these accounts belong to, as the app names it. */
  providerName: string
  providerId: ProviderId
  accounts: LabelledAccountMemories[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** How a provider's memories are turned on, for an account that has none. */
const TURN_ON_HINT: Partial<Record<ProviderId, string>> = {
  codex: 'Codex keeps memories off by default; turn them on in Codex with /memories.',
}

/**
 * WP2 PR 4, P4.4 (row 55): each account's own memories, below Claude's
 * dashboard on the Memory page, one card per account under the account's
 * name. Read-only for now: a file opens in the reading drawer, which offers
 * no frontmatter edit (these files carry a heading) and no Delete until its
 * VM check (ACCOUNT_MEMORY_DELETE_SHOWN).
 */
export function AccountMemoriesSection({ providerName, providerId, accounts, selectedId, onSelect }: Props) {
  if (accounts.length === 0) return null
  return (
    <section
      aria-label={`${providerName} memories`}
      className="rounded-xl p-4 mt-5"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        {providerName} memories, by account
      </div>
      <div className="space-y-4">
        {accounts.map(({ entry, label }) => (
          <div key={entry.accountId} data-account-memories={entry.accountId}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="font-mono text-xs text-text truncate">{label}</span>
              {entry.state === 'present' && (
                <span className="font-mono text-[10px] text-overlay0">
                  {entry.files.length} file{entry.files.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {entry.state === 'none' ? (
              <div className="text-[11px] text-overlay0" data-memory-state="none">
                No memories in this account. {TURN_ON_HINT[providerId] ?? ''}
              </div>
            ) : entry.state === 'unreadable' ? (
              <div className="text-[11px] text-overlay0" data-memory-state="unreadable">
                This account's memories folder could not be read: it is not a plain folder.
              </div>
            ) : entry.files.length === 0 ? (
              <div className="text-[11px] text-overlay0" data-memory-state="empty">
                Memories are on, and none have been written yet.
              </div>
            ) : (
              <div>
                {entry.files.map((m) => (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    data-memory-id={m.id}
                    onClick={() => onSelect(m.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSelect(m.id) }}
                    className={`grid grid-cols-[auto_minmax(0,1.4fr)_minmax(0,2fr)_auto] items-center gap-2.5 px-3 py-2 rounded cursor-pointer transition-colors mb-0.5 ${
                      selectedId === m.id ? 'bg-[rgba(137,180,250,0.1)]' : 'hover:bg-[rgba(137,180,250,0.05)]'
                    }`}
                  >
                    <TypeBadge type={m.type} />
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-text truncate">{m.name}</div>
                      <div className="font-mono text-[10px] text-overlay0 truncate">{m.relPath}</div>
                    </div>
                    <div className="text-[11px] text-overlay1 truncate">{m.description}</div>
                    <div className="text-right font-mono text-[10px] text-overlay0 shrink-0">
                      <div>{fmt(m.size)}</div>
                      <div>{fmtRel(m.modified)}</div>
                    </div>
                  </div>
                ))}
                {entry.truncated && (
                  <div className="text-[10px] text-overlay0 mt-1">
                    Showing the first {entry.files.length} files.
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
