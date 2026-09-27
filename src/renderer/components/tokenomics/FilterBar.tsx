import React, { useState, useEffect, useRef, useId } from 'react'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'
import type { TkRange } from '../../stores/tokenomicsStore'
import { useProviderAccountsStore } from '../../stores/providerAccountsStore'
import { tkAccountGroups, tkAccountValue, tkParseAccountValue, tkProvidersWithData, TK_PROVIDER_LABEL } from './tk-labels'
import { ProviderMark } from '../sidebar/Badges'

const RANGE_OPTIONS: Array<{ label: string; value: TkRange }> = [
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: 'All', value: 'all' },
]

export function FilterBar() {
  const filter = useTokenomicsStore((s) => s.filter)
  const summary = useTokenomicsStore((s) => s.summary)
  const setConfig = useTokenomicsStore((s) => s.setConfig)
  const accounts = useTokenomicsStore((s) => s.accounts)
  const setProvider = useTokenomicsStore((s) => s.setProvider)
  const setAccount = useTokenomicsStore((s) => s.setAccount)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  // Usage track MP12 (Q1.4): Provider only when both providers have usage;
  // Account grouped by provider, with "Not recorded" and "This computer's
  // sign-in" where they have usage.
  const providers = tkProvidersWithData(accounts)
  const groups = tkAccountGroups(accounts, snapshot, filter.provider)
  const accountValue = filter.account ? tkAccountValue(filter.account.provider, filter.account.key) : '__all__'
  const setRange = useTokenomicsStore((s) => s.setRange)
  const setSearch = useTokenomicsStore((s) => s.setSearch)
  const providerLabelId = useId()
  const accountSelectId = useId()

  const costByConfig = summary?.costByConfig ?? []

  // Local search state + debounce
  const [localSearch, setLocalSearch] = useState(filter.search ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep local in sync if filter.search changes externally (e.g. range reset)
  useEffect(() => {
    setLocalSearch(filter.search ?? '')
  }, [filter.search])

  const handleSearchChange = (value: string) => {
    setLocalSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearch(value)
    }, 300)
  }

  // Cleanup debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  // The config dropdown value: undefined = "All configs", null = "External / no config", string = a configId
  const configValue = filter.configId === undefined
    ? '__all__'
    : filter.configId === null
    ? '__null__'
    : filter.configId

  const handleConfigChange = (raw: string) => {
    if (raw === '__all__') {
      setConfig(undefined)
    } else if (raw === '__null__') {
      setConfig(null)
    } else {
      setConfig(raw)
    }
  }

  return (
    <div
      className="flex items-center gap-3 flex-wrap px-4 py-2 mb-4 rounded-lg"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      {/* Provider segmented control (MP12) */}
      {providers.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span id={providerLabelId} className="text-[11px] text-overlay0 uppercase tracking-wider">Provider</span>
          <div
            role="group"
            aria-labelledby={providerLabelId}
            className="flex rounded overflow-hidden"
            style={{ border: '1px solid var(--border-subtle)' }}
            data-testid="tk-provider-filter"
          >
            {[undefined, ...providers].map((p) => {
              const active = filter.provider === p
              return (
                <button
                  key={p ?? 'all'}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setProvider(p)}
                  className="px-2.5 py-0.5 text-xs transition-colors inline-flex items-center gap-1.5"
                  style={{
                    background: active ? 'var(--accent)' : 'var(--surface-stage)',
                    color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {p && <ProviderMark providerId={p} size={14} />}
                  {p ? TK_PROVIDER_LABEL[p] : 'All'}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Account dropdown, grouped by provider (MP12) */}
      {groups.length > 0 && (
        <div className="flex items-center gap-1.5">
          <label htmlFor={accountSelectId} className="text-[11px] text-overlay0 uppercase tracking-wider">Account</label>
          <select
            id={accountSelectId}
            value={accountValue}
            onChange={(e) => setAccount(e.target.value === '__all__' ? undefined : tkParseAccountValue(e.target.value) ?? undefined)}
            className="text-xs rounded px-2 py-0.5 outline-none max-w-[200px]"
            style={{
              background: 'var(--surface-stage)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
            data-testid="tk-account-filter"
          >
            <option value="__all__">All accounts</option>
            {groups.map((g) => (
              <optgroup key={g.provider} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {/* Config dropdown */}
      {costByConfig.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-overlay0 uppercase tracking-wider">Config</span>
          <select
            value={configValue}
            onChange={(e) => handleConfigChange(e.target.value)}
            className="text-xs rounded px-2 py-0.5 outline-none max-w-[180px]"
            style={{
              background: 'var(--surface-stage)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            <option value="__all__">All configs</option>
            {costByConfig.map((c) => (
              <option key={c.configId ?? '__null__'} value={c.configId ?? '__null__'}>
                {c.configId === null ? 'External / no config' : c.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Range segmented control */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-overlay0 uppercase tracking-wider">Range</span>
        <div
          className="flex rounded overflow-hidden"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          {RANGE_OPTIONS.map(({ label, value }) => {
            const active = filter.range === value
            return (
              <button
                key={value}
                onClick={() => setRange(value)}
                className="px-2.5 py-0.5 text-xs transition-colors"
                style={{
                  background: active ? 'var(--accent)' : 'var(--surface-stage)',
                  color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Search input */}
      <div className="flex items-center gap-1.5 flex-1 min-w-[140px] max-w-xs">
        <span className="text-[11px] text-overlay0 uppercase tracking-wider shrink-0">Search</span>
        <input
          type="text"
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="model, project…"
          className="flex-1 text-xs rounded px-2 py-0.5 outline-none placeholder:text-overlay0"
          style={{
            background: 'var(--surface-stage)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)',
            minWidth: 0,
          }}
        />
      </div>
    </div>
  )
}
