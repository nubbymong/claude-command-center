// P3.2 (row 7): the identity editor, opened from any account row's avatar
// chip, whatever its provider (canvas "Accounts: identities across providers" v1,
// option B, approved 2026-09-26; design 5.1, 5.2, WP1.40). One small panel:
// name, colour (the identity swatch set), group, and the accounts linked to
// this identity with Unlink and "Link another account". Name, colour and
// group are the identity's, so they show on every linked account.
//
// Claude's own list keeps names in profiles.json and colours in the
// email-keyed setting every chip reads: the registry writes a name through
// to the profile, and a colour for an account with an email is applied here
// to that setting, as the Claude registry port expects the renderer to do
// (src/main/providers/claude/legacy-store.ts). While the account list is not
// available, a Claude row still edits its name and colour the way it always
// did (the legacy fallback below).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountView, AccountsSnapshot } from '../../../../shared/providers'
import { IDENTITY_COLOR_KEYS, resolveIdentityColor, type IdentityColorKey } from '../../../../shared/identity-colors'
import { canonicaliseEmail } from '../../../../shared/account-chip-color'
import { useResolvedTheme } from '../../../hooks/useThemeController'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useAccountProfilesStore } from '../../../stores/accountProfilesStore'
import {
  providerAccountActions, providerView, identityOf, linkedAccounts, linkedAccountLabel, linkCandidates, canLinkIdentity, accountDisplayName,
} from '../../../stores/providerAccountsStore'
import { ProviderMark } from '../../sidebar/Badges'
import { ErrorLine, RowButton } from './accounts-ui'

const GAP = 6
const NEW_GROUP = '__new-group__'

/** The legacy fallback for a Claude row while the account list is not
 *  available: its name and colour, edited the way the row always did. */
export interface LegacyIdentityEdit {
  name: string
  colourKey: IdentityColorKey
  /** A colour needs the account's email (it is keyed by it). */
  canColour: boolean
  rename: (name: string) => Promise<string | null>
  recolour: (key: IdentityColorKey) => Promise<string | null>
}

/** An account mirrored from a provider's own list keeps that list's record
 *  current too. Claude's is the only such list: its profiles (names) and the
 *  email-keyed colour setting every chip reads (the registry writes a name
 *  through; a colour for an account with an email is the renderer's to
 *  write, see legacy-store.ts). */
const mirrored = (a: Pick<AccountView, 'legacyLinked'>) => a.legacyLinked

/** Mirror an identity colour to the email-keyed setting of each mirrored
 *  account given that has an email. */
async function mirrorClaudeColours(accounts: readonly AccountView[], key: IdentityColorKey): Promise<void> {
  const emails = accounts
    .filter((a) => mirrored(a) && a.lifecycle !== 'archived' && a.providerLabel?.trim())
    .map((a) => canonicaliseEmail(a.providerLabel!))
  if (!emails.length) return
  const { settings, updateSettings } = useSettingsStore.getState()
  const current = settings.accountColourOverrides ?? {}
  if (emails.every((e) => current[e] === key)) return
  const next = { ...current }
  for (const e of emails) next[e] = key
  await updateSettings({ accountColourOverrides: next })
}

/** Claude names live in profiles.json: re-read them after a change the
 *  registry wrote through. */
async function refreshClaudeProfiles(snapshot: AccountsSnapshot | null, identityId: string): Promise<void> {
  if (!(snapshot?.accounts ?? []).some((a) => mirrored(a) && a.identityId === identityId)) return
  await useAccountProfilesStore.getState().hydrate()
}

export function IdentityEditor({ anchor, account, snapshot, legacy, onClose, testId }: {
  /** The chip it opens from: the panel is placed under it. */
  anchor: React.RefObject<HTMLElement | null>
  /** The registry account (null in the legacy fallback). */
  account: AccountView | null
  snapshot: AccountsSnapshot | null
  legacy?: LegacyIdentityEdit
  onClose: () => void
  testId: string
}) {
  const theme = useResolvedTheme()
  const panelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [linkId, setLinkId] = useState('')

  const identity = account ? identityOf(snapshot, account) : undefined
  const registry = !!(account && identity)
  // This computer's own sign-in is always named for what it is, whatever its
  // identity is called: its name is not edited here.
  const editsName = registry ? !account!.external : !!legacy
  const initialName = registry ? (identity!.friendlyName ?? '') : (legacy?.name ?? '')
  const [name, setName] = useState(initialName)
  const committed = useRef(initialName)
  useEffect(() => { setName(initialName); committed.current = initialName }, [initialName])
  const colourKey = (registry ? identity!.colourKey : legacy?.colourKey) as IdentityColorKey | undefined
  const title = registry ? accountDisplayName(snapshot, account!) : (legacy?.name || 'Account')

  // Placed from the chip once rendered (its height decides above or below).
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!a || !panel) return
    const h = panel.getBoundingClientRect().height
    const w = panel.getBoundingClientRect().width
    const below = a.bottom + GAP
    const top = below + h <= window.innerHeight || a.top - GAP - h < 0 ? below : a.top - GAP - h
    setPos({ top, left: Math.max(0, Math.min(a.left, window.innerWidth - w)) })
  }, [anchor])

  useLayoutEffect(() => {
    if (!pos) return
    const first = nameRef.current ?? panelRef.current?.querySelector<HTMLElement>('button, select, input')
    first?.focus()
  }, [pos])

  const close = useCallback(() => { onClose(); (anchor.current as HTMLElement | null)?.focus() }, [onClose, anchor])
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    }
    const onResize = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose, close, anchor])

  const run = async (op: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    const failed = await op()
    setBusy(false)
    if (failed) setError(failed)
  }

  const commitName = () => {
    const next = name.trim()
    if (next === committed.current.trim()) return
    committed.current = name
    void run(async () => {
      if (!registry) return legacy ? legacy.rename(next) : null
      const r = await providerAccountActions.updateIdentity({ identityId: identity!.id, friendlyName: next || null })
      if (!r.ok) { setName(identity!.friendlyName ?? ''); committed.current = identity!.friendlyName ?? ''; return r.message }
      await refreshClaudeProfiles(snapshot, identity!.id)
      return null
    })
  }

  const pickColour = (key: IdentityColorKey) => {
    if (key === colourKey) return
    void run(async () => {
      if (!registry) return legacy ? legacy.recolour(key) : null
      const r = await providerAccountActions.updateIdentity({ identityId: identity!.id, colourKey: key })
      if (!r.ok) return r.message
      await mirrorClaudeColours((snapshot?.accounts ?? []).filter((a) => a.identityId === identity!.id), key)
      return null
    })
  }

  const pickGroup = (value: string) => {
    if (value === NEW_GROUP) { setNewGroup(''); return }
    setNewGroup(null)
    void run(async () => {
      const r = await providerAccountActions.updateIdentity({ identityId: identity!.id, groupId: value || null })
      return r.ok ? null : r.message
    })
  }

  const addGroup = () => {
    const groupName = (newGroup ?? '').trim()
    if (!groupName) return
    void run(async () => {
      const g = await providerAccountActions.createGroup(groupName)
      if (!g.ok) return g.message
      const r = await providerAccountActions.updateIdentity({ identityId: identity!.id, groupId: g.groupId })
      if (!r.ok) return r.message
      setNewGroup(null)
      return null
    })
  }

  const unlink = (other: AccountView) => {
    void run(async () => {
      const r = await providerAccountActions.unlinkIdentity(other.id)
      if (!r.ok) return r.message
      await refreshClaudeProfiles(snapshot, identity!.id)
      return null
    })
  }

  const link = () => {
    const other = linkCandidates(snapshot, account!).find((a) => a.id === linkId)
    if (!other) return
    void run(async () => {
      const r = await providerAccountActions.linkIdentity(other.id, identity!.id)
      if (!r.ok) return r.message
      setLinkId('')
      // The account linked here now shows this identity's colour: a Claude
      // one's email-keyed setting follows (the snapshot in hand predates the link).
      if (mirrored(other)) {
        await mirrorClaudeColours([other], identity!.colourKey as IdentityColorKey)
        await useAccountProfilesStore.getState().hydrate()
      }
      return null
    })
  }

  const providerName = (a: AccountView) => providerView(snapshot, a.providerId)?.displayName ?? a.providerId
  const linked = registry ? linkedAccounts(snapshot, account!) : []
  const candidates = registry ? linkCandidates(snapshot, account!) : []
  const groups = registry ? [...(snapshot?.groups ?? [])].sort((a, b) => a.order - b.order) : []
  const swatch = colourKey ? resolveIdentityColor(colourKey, theme) : 'var(--text-muted)'

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Edit ${title}`}
      className="fixed z-[80] w-[300px] rounded-xl border p-3.5 flex flex-col gap-3 text-[12.5px]"
      style={{
        top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden',
        background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', boxShadow: '0 14px 36px rgba(0,0,0,.45)',
      }}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        <span className="w-3 h-3 rounded-[3px] shrink-0" style={{ background: swatch }} aria-hidden />
        <span className="truncate">{title}</span>
      </div>
      {editsName && (
        <label className="grid grid-cols-[58px_1fr] items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitName() } }}
            maxLength={120}
            placeholder="A name you will recognise"
            disabled={busy}
            className="w-full bg-crust/60 border border-surface0/80 rounded-lg px-2.5 py-1 text-[12.5px] text-text focus-ring-strong focus:border-blue/50 placeholder:text-[var(--text-muted)] transition-colors"
            data-testid={`${testId}-name`}
          />
        </label>
      )}
      {(registry || legacy?.canColour) && (
        <div className="grid grid-cols-[58px_1fr] items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <span>Colour</span>
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Colour">
            {IDENTITY_COLOR_KEYS.map((k) => {
              const hex = resolveIdentityColor(k, theme)
              const isSelected = k === colourKey
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`Colour ${k}`}
                  title={k}
                  disabled={busy}
                  onClick={() => pickColour(k)}
                  data-testid={`${testId}-colour-${k}`}
                  className="w-4 h-4 rounded-full transition-transform focus-ring-strong-outset"
                  style={{
                    backgroundColor: hex,
                    boxShadow: isSelected ? `0 0 0 2px var(--surface-overlay), 0 0 0 4px ${hex}` : undefined,
                    transform: isSelected ? 'scale(1.2)' : undefined,
                  }}
                />
              )
            })}
          </div>
        </div>
      )}
      {registry && (
        <div className="grid grid-cols-[58px_1fr] items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <span>Group</span>
          <div className="flex flex-col gap-1.5">
            <select
              value={newGroup !== null ? NEW_GROUP : (identity!.groupId ?? '')}
              onChange={(e) => pickGroup(e.target.value)}
              disabled={busy}
              aria-label="Group"
              className="w-full bg-crust/60 border border-surface0/80 rounded-lg px-2.5 py-1 text-[12.5px] text-text focus-ring-strong focus:border-blue/50 placeholder:text-[var(--text-muted)] transition-colors"
              data-testid={`${testId}-group`}
            >
              <option value="">None</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value={NEW_GROUP}>New group...</option>
            </select>
            {newGroup !== null && (
              <div className="flex items-center gap-1.5">
                <input
                  value={newGroup}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup() } }}
                  maxLength={60}
                  placeholder="Group name"
                  aria-label="New group name"
                  className="w-full bg-crust/60 border border-surface0/80 rounded-lg px-2.5 py-1 text-[12.5px] text-text focus-ring-strong focus:border-blue/50 placeholder:text-[var(--text-muted)] transition-colors"
                  data-testid={`${testId}-new-group`}
                />
                <RowButton onClick={addGroup} disabled={busy || !newGroup.trim()} testId={`${testId}-add-group`}>Add</RowButton>
              </div>
            )}
          </div>
        </div>
      )}
      {registry && canLinkIdentity(account!) && (
        <div className="flex flex-col gap-1.5" data-testid={`${testId}-linked`}>
          <div className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <ProviderMark providerId={account!.providerId} size={14} />
            <span className="truncate">{providerName(account!)}: {linkedAccountLabel(snapshot, account!)}</span>
            <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>this account</span>
          </div>
          {linked.map((a) => (
            <div key={a.id} className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <ProviderMark providerId={a.providerId} size={14} />
              <span className="truncate">{providerName(a)}: {linkedAccountLabel(snapshot, a)}</span>
              <span className="ml-auto"><RowButton onClick={() => unlink(a)} disabled={busy} testId={`${testId}-unlink-${a.id}`}>Unlink</RowButton></span>
            </div>
          ))}
          {candidates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
                disabled={busy}
                aria-label="Link another account"
                className="w-full bg-crust/60 border border-surface0/80 rounded-lg px-2.5 py-1 text-[12.5px] text-text focus-ring-strong focus:border-blue/50 placeholder:text-[var(--text-muted)] transition-colors"
                data-testid={`${testId}-link-select`}
              >
                <option value="">Link another account</option>
                {candidates.map((a) => <option key={a.id} value={a.id}>{providerName(a)}: {linkedAccountLabel(snapshot, a)}</option>)}
              </select>
              <RowButton onClick={link} disabled={busy || !linkId} testId={`${testId}-link`}>Link</RowButton>
            </div>
          )}
        </div>
      )}
      {error && <ErrorLine testId={`${testId}-error`}>{error}</ErrorLine>}
      {registry && (
        <div className="text-[11.5px] pt-2" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-strong)' }}>
          Name, colour and group show on every linked account.
        </div>
      )}
    </div>,
    document.body,
  )
}
