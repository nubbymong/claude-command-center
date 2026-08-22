import React, { useMemo, useState } from 'react'
import { useCommandStore, type CustomCommand } from '../../stores/commandStore'
import { useCommandBarStore, CORE_TOOL_IDS, type CoreToolId } from '../../stores/commandBarStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useConfigStore } from '../../stores/configStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useMagicButtonStore } from '../../stores/magicButtonStore'
import { sessionCapabilities, describeTarget, type SessionCapabilities } from '../../lib/session-capabilities'
import { effectiveKind } from '../command-bar/layout'
import { CommandChip } from '../command-bar/chips'
import { ConfirmCard } from '../command-bar/menus'
import { commandSecretKey } from '../../../shared/command-secret'
import { COLOR_SWATCHES } from '../SessionDialog'
import { Toggle } from '../SettingsPage'
import CommandDialog from '../CommandDialog'

/**
 * Settings → Custom Commands (ADR-018 D11), kept deliberately SMALL -- owner:
 * "useful, not Nth-degree optionality". Four cards and nothing else:
 *   1. Command bar  -- one row / two rows then fold; show the command bar
 *   2. Core tools   -- where hidden tools come back (Logs notes the privacy toggle)
 *   3. Snap         -- colour + auto-delete, moved here from Snap's right-click
 *   4. Commands     -- a plain searchable list: Edit / Delete, "Needs review" filter
 * Explicitly NOT here: density, default-icon style, applies-to chips, bulk
 * operations, a sections panel, a secrets list, import/export.
 */

const TOOL_LABEL: Record<CoreToolId, string> = { snap: 'Snap', canvas: 'Canvas', logs: 'Logs', browser: 'Browser', partner: 'Partner', notes: 'Notes' }
const TOOL_NOTE: Partial<Record<CoreToolId, string>> = {
  snap: 'not in terminal-only sessions',
  logs: 'also needs General → Index conversation logs',
}

function Card({ title, sub, children, testId }: { title: string; sub?: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="settings-card overflow-hidden" data-testid={testId}>
      <div className="px-4 py-2.5 border-b settings-divider">
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">{title}</h3>
        {sub && <p className="text-[11px] text-overlay0 mt-0.5">{sub}</p>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const GENERIC_CAPS = sessionCapabilities({ provider: 'claude', sessionType: 'local' } as never)

export function CustomCommandsTab() {
  // ---- 1. command bar ---------------------------------------------------------
  const barState = useCommandBarStore((s) => s.state)
  const setOverflow = useCommandBarStore((s) => s.setOverflow)
  const setBarCollapsed = useCommandBarStore((s) => s.setBarCollapsed)
  const showCoreTool = useCommandBarStore((s) => s.showCoreTool)
  const overflow = barState.overflow
  const hidden = barState.hiddenCoreTools
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)

  // ---- 2. core tools ------------------------------------------------------------
  const sessions = useSessionStore((s) => s.sessions)
  const sessionLabel = (id: string) => sessions.find((s) => s.id === id)?.label ?? 'a closed session'

  // ---- 3. snap --------------------------------------------------------------------
  const snap = useMagicButtonStore((s) => s.settings)
  const updateSnap = useMagicButtonStore((s) => s.updateSettings)

  // ---- 4. commands ------------------------------------------------------------------
  const { commands, sections, removeCommand, updateCommand } = useCommandStore()
  const configs = useConfigStore((s) => s.configs)
  const [query, setQuery] = useState('')
  const [onlyReview, setOnlyReview] = useState(false)
  const [editing, setEditing] = useState<CustomCommand | null>(null)
  const [deleting, setDeleting] = useState<CustomCommand | null>(null)

  const configById = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs])
  const capsFor = (cmd: CustomCommand): SessionCapabilities => {
    const cfg = cmd.scope === 'config' && cmd.configId ? configById.get(cmd.configId) : undefined
    return cfg ? sessionCapabilities({ provider: cfg.provider, sessionType: cfg.sessionType, shellOnly: cfg.shellOnly, configId: cfg.id, sshConfig: cfg.sshConfig } as never) : GENERIC_CAPS
  }
  const q = query.trim().toLowerCase()
  const rows = commands.filter((c) => (!onlyReview || !!c.needsReview?.length) && (!q || c.label.toLowerCase().includes(q) || (c.prompt || '').toLowerCase().includes(q)))
  const reviewCount = commands.filter((c) => c.needsReview?.length).length

  const deleteCommand = (cmd: CustomCommand) => {
    void window.electronAPI.credentials.delete(commandSecretKey(cmd.id))
    removeCommand(cmd.id)
    setDeleting(null)
  }

  return (
    <div className="space-y-4" data-testid="custom-commands-tab">
      <Card title="Command bar" sub="How the row behaves. Two rows take about two terminal lines." testId="settings-command-bar">
        <div className="space-y-2" role="radiogroup" aria-label="Overflow">
          {([['fold', 'One row — buttons that don\'t fit fold into "N more"'], ['wrap2', 'Two rows, then fold']] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface0/30 transition-colors cursor-pointer">
              <input type="radio" name="command-bar-overflow" checked={overflow === value} onChange={() => setOverflow(value)} className="accent-blue" data-testid={`settings-overflow-${value}`} />
              <span className="text-sm text-text leading-tight">{label}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3 px-3 py-2 mt-1 rounded-lg hover:bg-surface0/30 transition-colors">
          <Toggle on={!barState.barCollapsed} onClick={() => setBarCollapsed(!barState.barCollapsed)} label="Show the command bar" />
          <div className="min-w-0">
            <div className="text-sm text-text leading-tight">Show the command bar</div>
            <div className="text-[11px] text-overlay0 leading-tight">Off hides the whole row under every session; the bar's right-click menu has the same switch.</div>
          </div>
        </div>
      </Card>

      <Card title="Core tools" sub="Hidden tools come back here. A tool that cannot work in a kind of session is greyed there, not hidden." testId="settings-core-tools">
        <div className="space-y-0.5">
          {CORE_TOOL_IDS.map((tool) => {
            const everywhere = hidden.everywhere.includes(tool)
            const inSessions = Object.entries(hidden.bySession).filter(([, tools]) => tools.includes(tool)).map(([id]) => id)
            const note = tool === 'logs' && !loggingEnabled ? 'off — General → Index conversation logs is off' : TOOL_NOTE[tool]
            return (
              <div key={tool} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface0/30 transition-colors" data-testid={`settings-core-${tool}`}>
                <span className="text-sm text-text w-20 shrink-0">{TOOL_LABEL[tool]}</span>
                <span className="text-[11px] text-overlay0 flex-1 min-w-0 truncate" data-testid={`settings-core-${tool}-status`}>
                  {everywhere ? 'Hidden everywhere' : inSessions.length ? `Hidden in ${inSessions.length} session${inSessions.length === 1 ? '' : 's'} (${inSessions.map(sessionLabel).join(', ')})` : 'Shown'}
                  {note ? ` · ${note}` : ''}
                </span>
                {(everywhere || inSessions.length > 0) && (
                  <button type="button" onClick={() => showCoreTool(tool, 'everywhere')} className="text-[11px] text-blue hover:text-blue/80 shrink-0" data-testid={`settings-core-${tool}-show`}>
                    Show everywhere
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      <Card title="Snap" sub="Moved here from Snap's right-click; that right-click now comes here — one editor for these keys." testId="settings-snap">
        <div className="space-y-3">
          <div>
            <div className="text-sm text-text mb-1.5">Button colour</div>
            <div className="flex flex-wrap gap-1.5" data-testid="settings-snap-colours">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => updateSnap({ screenshotColor: c })}
                  aria-label={`Colour ${c}`}
                  aria-pressed={snap.screenshotColor === c}
                  className={`w-5 h-5 rounded-md border-2 transition-all ${snap.screenshotColor === c ? 'border-text scale-110' : 'border-transparent hover:border-overlay0'}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Toggle on={snap.autoDeleteDays != null} onClick={() => updateSnap({ autoDeleteDays: snap.autoDeleteDays == null ? 7 : null })} label="Delete screenshots automatically" />
            <div className="text-sm text-text">Delete screenshots after</div>
            <input
              type="number"
              value={snap.autoDeleteDays ?? 7}
              disabled={snap.autoDeleteDays == null}
              onChange={(e) => updateSnap({ autoDeleteDays: Math.min(365, Math.max(1, parseInt(e.target.value) || 1)) })}
              className="w-16 px-2 py-1 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue disabled:opacity-40"
              min={1}
              max={365}
              data-testid="settings-snap-days"
            />
            <span className="text-xs text-overlay1">days</span>
          </div>
        </div>
      </Card>

      <Card title="Commands" sub="Every button across every config. Right-click on the bar edits one; this is where you find many." testId="settings-commands">
        <div className="flex items-center gap-3 mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a command…"
            className="flex-1 max-w-[320px] h-7 px-2.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
            data-testid="settings-commands-search"
          />
          <label className="flex items-center gap-2 text-[11px] text-overlay1 cursor-pointer select-none">
            <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} className="accent-blue" data-testid="settings-commands-review-filter" />
            Needs review{reviewCount ? ` (${reviewCount})` : ''}
          </label>
        </div>
        {rows.length === 0 ? (
          <div className="text-[11px] text-overlay0 px-1" data-testid="settings-commands-empty">{commands.length === 0 ? 'No command buttons yet — add one from the bar\'s Add button.' : 'Nothing matches.'}</div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((cmd) => {
              const caps = capsFor(cmd)
              const kind = effectiveKind(cmd, caps)
              const kindWord = kind === 'page' ? 'Page' : kind === 'shell' ? 'Shell line' : 'Prompt'
              const runsIn = kind === 'page' ? 'the browser pane' : describeTarget(caps, cmd.target === 'partner' ? 'partner' : 'claude')
              const showsIn = cmd.scope === 'global' ? 'Global' : (configById.get(cmd.configId ?? '')?.label ?? 'a deleted config')
              const section = sections.find((s) => s.id === cmd.sectionId)?.name
              return (
                <div key={cmd.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-surface0/30 transition-colors" data-testid="settings-command-row" data-command-id={cmd.id}>
                  <CommandChip cmd={cmd} caps={caps} onClick={() => setEditing(cmd)} onContextMenu={(e) => { e.preventDefault(); setEditing(cmd) }} tabIndex={-1} />
                  <span className="text-[11px] text-overlay0 flex-1 min-w-0 truncate">
                    {kindWord} · runs in {runsIn} · shows in {showsIn}{section ? ` · section ${section}` : ''}
                  </span>
                  <button type="button" onClick={() => setEditing(cmd)} className="text-[11px] text-blue hover:text-blue/80 shrink-0" data-testid="settings-command-edit">Edit</button>
                  <button type="button" onClick={() => setDeleting(cmd)} className="text-[11px] text-red hover:text-red/80 shrink-0" data-testid="settings-command-delete">Delete</button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {editing && (
        <CommandDialog
          initial={editing}
          configId={editing.configId}
          configName={editing.configId ? configById.get(editing.configId)?.label : undefined}
          capabilities={capsFor(editing)}
          onConfirm={(data, argSecret) => {
            updateCommand(editing.id, { ...data, needsReview: undefined })
            const key = commandSecretKey(editing.id)
            if (data.hasSecretArg && argSecret) void window.electronAPI.credentials.save(key, argSecret)
            else if (!data.hasSecretArg) void window.electronAPI.credentials.delete(key)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmCard
          testId="confirm-delete"
          title={`Delete "${deleting.label}"?`}
          body={deleting.scope === 'global' ? <>This button is <b>Global</b> — it disappears from every config.{deleting.hasSecretArg ? ' Its secret is removed from the keychain.' : ''}</> : <>It disappears from its config.{deleting.hasSecretArg ? ' Its secret is removed from the keychain.' : ''}</>}
          actions={[{ label: 'Delete', danger: true, testId: 'confirm-delete-ok', onClick: () => deleteCommand(deleting) }]}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
