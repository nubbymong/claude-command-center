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

  // Load accounts on mount and on dropdown open
  useEffect(() => { refreshAccounts() }, [refreshAccounts])
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

  const handleRename = async (id: string, currentLabel: string) => {
    const newLabel = prompt('Account name:', currentLabel)
    if (newLabel && newLabel !== currentLabel) {
      const result = await window.electronAPI.account.rename(id, newLabel)
      if (result.ok) await refreshAccounts()
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
            <div className="absolute left-0 top-full mt-1 w-72 bg-surface0 border border-surface1 rounded-lg shadow-lg z-50 py-1 text-sm">
              {accounts.length === 0 && (
                <div className="px-3 py-2 text-overlay0 italic">Detecting account...</div>
              )}
              {accounts.map((acct) => {
                const isActive = activeAccount?.id === acct.id
                return (
                  <div
                    key={acct.id}
                    className={`flex items-center hover:bg-surface1 ${isActive ? 'bg-surface1/50' : ''}`}
                  >
                    <button
                      onClick={() => !isActive && handleSwitch(acct.id)}
                      className="flex-1 px-3 py-2 text-left flex items-center gap-2 text-text"
                    >
                      <span className="w-4 text-center text-green shrink-0">
                        {isActive ? '\u2713' : ''}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">{acct.label}</span>
                        <span className="text-xs text-overlay0 capitalize">{acct.id}</span>
                      </div>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRename(acct.id, acct.label) }}
                      className="px-2 py-1 mr-1 text-overlay0 hover:text-text rounded hover:bg-surface0"
                      title="Rename"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                )
              })}

              {accounts.length < 2 && (
                <>
                  <div className="border-t border-surface1 my-1" />
                  <button
                    onClick={() => {
                      const nextSlot = accounts.find(a => a.id === 'primary') ? 'secondary' : 'primary'
                      handleSaveAs(nextSlot as 'primary' | 'secondary', nextSlot === 'primary' ? 'Primary' : 'Secondary')
                    }}
                    className="w-full px-3 py-1.5 text-left hover:bg-surface1 text-overlay1 hover:text-text"
                  >
                    <span className="ml-6">Save current as {accounts.find(a => a.id === 'primary') ? 'Secondary' : 'Primary'}</span>
                  </button>
                </>
              )}
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
