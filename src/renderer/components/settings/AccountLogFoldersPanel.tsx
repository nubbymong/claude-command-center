import React, { useEffect, useState } from 'react'
import type { AccountLogFolderKind, AccountLogFolderOpenResult, AccountLogFolders } from '../../../shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderAccountsStore, accountDisplayName, ACCOUNT_NAME_FALLBACK } from '../../stores/providerAccountsStore'
import { usesCodex } from '../../onboarding/provider-choice'

/** What a failed open says, by main's code. */
export const LOG_FOLDER_RESULT_TEXT: Readonly<Record<Exclude<AccountLogFolderOpenResult, { ok: true }>['code'], string>> = {
  'unknown-account': 'This account is no longer listed.',
  'not-set': "This account's config.toml no longer sets log_dir.",
  'not-found': 'That folder does not exist yet. Codex makes it when it first writes a log there.',
  refused: 'The app did not open or show that folder: it is not a plain local folder, or it could not be shown.',
}

const BUTTON_TEXT: Readonly<Record<AccountLogFolderKind, string>> = {
  log: 'Open log folder',
  'log-dir': 'Show log_dir folder',
}

/**
 * WP2 PR 4, P4.4 (row 56): each Codex account's own log folders, beside the
 * app's "Open log folder" in Settings, General, Debug Logging. Main lists them
 * by account and KIND and opens one (a log_dir: shows it in the folder that
 * holds it) by the same key: no path ever passes through here. Shown while Codex is in use and has an account.
 */
export function AccountLogFoldersPanel() {
  const codexOn = useSettingsStore((s) => usesCodex(s.settings))
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const revision = snapshot?.revision
  const [rows, setRows] = useState<AccountLogFolders[] | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!codexOn) return
    const list = window.electronAPI?.debug?.accountLogFolders
    if (typeof list !== 'function') return
    let live = true
    list()
      .then((r) => { if (live) setRows(Array.isArray(r) ? r : []) })
      .catch(() => { if (live) setRows([]) })
    return () => { live = false }
  }, [codexOn, revision])

  if (!codexOn || !rows || rows.length === 0) return null

  const nameOf = (accountId: string): string => {
    const account = snapshot?.accounts.find((a) => a.id === accountId)
    return account ? accountDisplayName(snapshot, account) : ACCOUNT_NAME_FALLBACK
  }
  const open = async (accountId: string, folder: AccountLogFolderKind) => {
    const key = `${accountId}:${folder}`
    let r: AccountLogFolderOpenResult
    try {
      r = await window.electronAPI.debug.openAccountLogFolder({ accountId, folder })
    } catch {
      r = { ok: false, code: 'refused' }
    }
    setNotes((n) => ({ ...n, [key]: r && r.ok === false ? LOG_FOLDER_RESULT_TEXT[r.code] ?? LOG_FOLDER_RESULT_TEXT.refused : '' }))
  }

  return (
    <div className="mt-3" data-testid="account-log-folders">
      <div className="text-[11px] font-medium text-[var(--text-secondary)]">Codex log folders</div>
      <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
        Each Codex account keeps its own logs: the sign-in log (codex-login.log) in its log folder, and the session log (codex-tui.log) there too unless the account's config.toml sets log_dir. A log_dir folder is shown selected in the folder that holds it, not opened.
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {rows.map((row) => (
          <li key={row.accountId} data-account={row.accountId}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] text-[var(--text-primary)] truncate">{nameOf(row.accountId)}</span>
              {row.folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  data-folder={folder}
                  onClick={() => { void open(row.accountId, folder) }}
                  className="text-[11px] text-blue hover:text-blue/80 transition-colors"
                >
                  {BUTTON_TEXT[folder]}
                </button>
              ))}
            </div>
            {row.folders.map((folder) => notes[`${row.accountId}:${folder}`] ? (
              <p key={folder} role="status" className="text-[10px] text-[var(--text-muted)] mt-0.5">{notes[`${row.accountId}:${folder}`]}</p>
            ) : null)}
          </li>
        ))}
      </ul>
    </div>
  )
}
