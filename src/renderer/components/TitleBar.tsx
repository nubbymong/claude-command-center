import React, { useEffect, useState, useRef, useCallback } from 'react'
import type { AccountProfile } from '../../shared/types'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

const STATUS_COLORS: Record<string, string> = {
  operational: 'bg-green',
  degraded_performance: 'bg-yellow',
  partial_outage: 'bg-peach',
  major_outage: 'bg-red',
}

const STATUS_LABELS: Record<string, string> = {
  operational: 'Operational',
  degraded_performance: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
}

export default function TitleBar({ sidebarOpen, onToggleSidebar }: Props) {
  const [maximized, setMaximized] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<string | null>(null)

  // Account switcher state
  const [accountOpen, setAccountOpen] = useState(false)
  const [accounts, setAccounts] = useState<AccountProfile[]>([])
  const [activeAccount, setActiveAccount] = useState<AccountProfile | null>(null)
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setMaximized)
    const unsub = window.electronAPI.window.onMaximizedChanged(setMaximized)
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.serviceStatus.onUpdate((data) => {
      setServiceStatus(data.status)
    })
    return unsub
  }, [])

  const refreshAccounts = useCallback(async () => {
    const [list, active] = await Promise.all([
      window.electronAPI.account.list(),
      window.electronAPI.account.getActive(),
    ])
    setAccounts(list)
    setActiveAccount(active)
  }, [])

  // Load accounts on dropdown open
  useEffect(() => {
    if (accountOpen) refreshAccounts()
  }, [accountOpen, refreshAccounts])

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!accountOpen) return
    const handleClick = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [accountOpen])

  const handleSwitch = async (id: string) => {
    const result = await window.electronAPI.account.switch(id)
    if (result.ok) {
      await refreshAccounts()
      setAccountOpen(false)
    }
  }

  const handleSaveAs = async (id: 'primary' | 'secondary', label: string) => {
    const result = await window.electronAPI.account.saveCurrentAs(id, label)
    if (result.ok) {
      await refreshAccounts()
    }
  }

  const accountTooltip = activeAccount
    ? `Account: ${activeAccount.label}`
    : 'Account Switcher'

  return (
    <div className="titlebar-drag flex items-center h-10 bg-crust px-3 shrink-0">
      <div className="titlebar-no-drag flex items-center gap-1 mr-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        {/* Account switcher */}
        <div ref={accountRef} className="relative">
          <button
            onClick={() => setAccountOpen(prev => !prev)}
            className="p-1.5 rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
            title={accountTooltip}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          {accountOpen && (
            <div className="absolute left-0 top-full mt-1 w-56 bg-surface0 border border-surface1 rounded-lg shadow-lg z-50 py-1 text-sm">
              {/* Switch to Primary */}
              <button
                onClick={() => handleSwitch('primary')}
                className="w-full px-3 py-1.5 text-left hover:bg-surface1 flex items-center gap-2 text-text disabled:opacity-40"
                disabled={!accounts.some(a => a.id === 'primary')}
              >
                <span className="w-4 text-center text-green">
                  {activeAccount?.id === 'primary' ? '\u2713' : ''}
                </span>
                <span>Primary</span>
                {accounts.find(a => a.id === 'primary') && (
                  <span className="ml-auto text-xs text-overlay0 truncate max-w-[80px]">
                    {accounts.find(a => a.id === 'primary')!.label}
                  </span>
                )}
              </button>

              {/* Switch to Secondary */}
              <button
                onClick={() => handleSwitch('secondary')}
                className="w-full px-3 py-1.5 text-left hover:bg-surface1 flex items-center gap-2 text-text disabled:opacity-40"
                disabled={!accounts.some(a => a.id === 'secondary')}
              >
                <span className="w-4 text-center text-green">
                  {activeAccount?.id === 'secondary' ? '\u2713' : ''}
                </span>
                <span>Secondary</span>
                {accounts.find(a => a.id === 'secondary') && (
                  <span className="ml-auto text-xs text-overlay0 truncate max-w-[80px]">
                    {accounts.find(a => a.id === 'secondary')!.label}
                  </span>
                )}
              </button>

              {/* Divider */}
              <div className="border-t border-surface1 my-1" />

              {/* Save current as Primary */}
              <button
                onClick={() => handleSaveAs('primary', 'Primary')}
                className="w-full px-3 py-1.5 text-left hover:bg-surface1 text-overlay1 hover:text-text"
              >
                <span className="ml-6">Save current as Primary</span>
              </button>

              {/* Save current as Secondary */}
              <button
                onClick={() => handleSaveAs('secondary', 'Secondary')}
                className="w-full px-3 py-1.5 text-left hover:bg-surface1 text-overlay1 hover:text-text"
              >
                <span className="ml-6">Save current as Secondary</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 text-center text-xs text-overlay1 font-medium">
        Claude Command Center <span className="text-yellow/70">Beta</span>
      </div>

      <div className="titlebar-no-drag flex items-center gap-1">
        {serviceStatus && (
          <div
            className={`w-2 h-2 rounded-full ${STATUS_COLORS[serviceStatus] || 'bg-overlay0'}`}
            title={`Claude Code: ${STATUS_LABELS[serviceStatus] || serviceStatus}`}
          />
        )}
        <button
          onClick={() => window.electronAPI.window.minimize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        <button
          onClick={() => window.electronAPI.window.maximize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text"
        >
          {maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="3.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M3.5 3.5V2.5C3.5 2.22 3.72 2 4 2H9.5C9.78 2 10 2.22 10 2.5V8C10 8.28 9.78 8.5 9.5 8.5H9" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          )}
        </button>
        <button
          onClick={() => window.electronAPI.window.close()}
          className="p-2 hover:bg-red rounded transition-colors text-overlay1 hover:text-white"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  )
}
