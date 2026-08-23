import React, { useMemo, useRef, useState } from 'react'
import type { TerminalConfig, ConfigGroup, ConfigSection } from '../../stores/configStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'
import { SessionTypeBadge, SshBadge } from './Badges'
import {
  ALL_CATEGORY_ID,
  buildCategories,
  completeQuery,
  configsInCategory,
  excludeRunning,
  launchAllTargets,
  makeNameLookup,
  searchConfigs,
} from './savedConfigsView'
import {
  RunningFootnote,
  SavedConfigsEmpty,
  SavedConfigsSearch,
  useLaunchSelection,
  useScrollSelectedIntoView,
} from './SavedConfigsSearch'

// The FIND + CATEGORIES view of the Saved Configs panel (#362, option C on the
// canvas): a find box with inline completion on top, groups and sections as
// filter chips instead of nested headers, and one flat list of rows beneath.
// Running configs are not listed. Launch-all lives on the active group or
// section chip. Type -> arrow -> Enter launches.

interface Props {
  configs: TerminalConfig[]
  groups: ConfigGroup[]
  sections: ConfigSection[]
  runningIds: ReadonlySet<string>
  onLaunch: (config: TerminalConfig) => void
  onLaunchMany: (configs: TerminalConfig[]) => void
  onEdit: (config: TerminalConfig) => void
  onDelete: (config: TerminalConfig) => void
  onContextMenu: (e: React.MouseEvent, configId: string) => void
  focusRequest?: number
}

export default function SavedConfigsFind({ configs, groups, sections, runningIds, onLaunch, onLaunchMany, onEdit, onDelete, onContextMenu, focusRequest }: Props) {
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState(ALL_CATEGORY_ID)
  const theme = useResolvedTheme()
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const isBlocked = (c: TerminalConfig) => codexOff && c.provider === 'codex'
  const listRef = useRef<HTMLDivElement>(null)

  const lookup = useMemo(() => makeNameLookup(groups, sections), [groups, sections])
  const launchable = useMemo(() => excludeRunning(configs, runningIds), [configs, runningIds])
  const categories = useMemo(() => buildCategories(launchable, groups, sections), [launchable, groups, sections])
  // A chip can vanish under the selection (its last config started running, the
  // group was deleted): fall back to All rather than filtering on a ghost.
  const category = categories.find((c) => c.id === categoryId) ?? categories[0]
  const inCategory = useMemo(() => configsInCategory(launchable, category, groups), [launchable, category, groups])
  const visible = useMemo(() => searchConfigs(inCategory, query, lookup), [inCategory, query, lookup])
  const completion = completeQuery(query, visible.map((c) => c.label))

  const launch = (c: TerminalConfig) => { if (!isBlocked(c)) onLaunch(c) }
  const sel = useLaunchSelection(visible, launch)
  useScrollSelectedIntoView(listRef, sel.selected)

  const launchAllCount = (category.kind === 'group' || category.kind === 'section')
    ? launchAllTargets(visible, runningIds, isBlocked).length
    : 0
  const launchAll = () => {
    const targets = launchAllTargets(visible, runningIds, isBlocked)
    if (targets.length > 0) onLaunchMany(targets)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" data-ux-id="saved-configs-find">
      <SavedConfigsSearch
        value={query}
        onChange={(v) => { setQuery(v); sel.setSelected(-1) }}
        completion={completion}
        onMove={sel.move}
        onEnter={sel.enter}
        focusRequest={focusRequest}
        hint={query ? `${visible.length} of ${inCategory.length}` : undefined}
      />
      {categories.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 shrink-0" role="group" aria-label="Filter by category" data-ux-id="saved-configs-categories">
          {categories.map((cat) => {
            const active = cat.id === category.id
            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={active}
                onClick={() => { setCategoryId(cat.id); sel.setSelected(-1) }}
                className="rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-4 focus-ring transition-colors"
                style={active
                  ? { background: 'color-mix(in srgb, var(--brand) 16%, transparent)', borderColor: 'color-mix(in srgb, var(--brand) 60%, transparent)', color: 'var(--brand)' }
                  : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                data-ux-id="saved-configs-category"
                data-category-kind={cat.kind}
              >
                {cat.label}
                <span className="ml-1 font-medium opacity-80">{cat.count}</span>
              </button>
            )
          })}
          {launchAllCount > 1 && (
            <button
              type="button"
              onClick={launchAll}
              className="ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-4 focus-ring"
              style={{ borderColor: 'color-mix(in srgb, var(--status-success) 50%, transparent)', color: 'var(--status-success)' }}
              title={`Launch every listed config in ${category.label} that is not already running`}
              data-ux-id="saved-configs-launch-all"
            >
              Launch all {launchAllCount}
            </button>
          )}
        </div>
      )}
      <div ref={listRef} role="listbox" aria-label="Saved configs" className="overflow-y-auto px-2 pb-2 flex-1 min-h-0">
        <SavedConfigsEmpty total={configs.length} launchable={launchable.length} visible={visible.length} query={query} />
        {visible.map((config, index) => {
          const selected = index === sel.selected
          const blocked = isBlocked(config)
          const names = lookup(config)
          const where = category.kind === 'group' ? names.sectionName : (names.groupName ?? names.sectionName)
          const bar = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
          return (
            <div
              key={config.id}
              role="option"
              aria-selected={selected}
              aria-disabled={blocked || undefined}
              data-ux-id="saved-config-row"
              data-config-id={config.id}
              tabIndex={-1}
              onClick={() => launch(config)}
              onMouseEnter={() => sel.setSelected(index)}
              onContextMenu={(e) => onContextMenu(e, config.id)}
              className={`group relative flex items-center gap-2 rounded-md pl-3 pr-2 h-[30px] transition-colors ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              style={{
                background: selected ? 'color-mix(in srgb, var(--brand) 10%, var(--surface-raised))' : undefined,
                boxShadow: selected ? 'inset 2px 0 0 var(--brand)' : undefined,
                opacity: blocked ? 0.6 : 1,
              }}
              title={blocked ? CODEX_OFF_LAUNCH_REASON : config.label}
            >
              <span className="absolute left-0 top-[7px] bottom-[7px] w-[3px] rounded-r" style={{ background: bar }} aria-hidden />
              {config.sessionType === 'ssh'
                ? <SshBadge />
                : <SessionTypeBadge kind={config.shellOnly ? 'shell' : config.provider === 'codex' ? 'codex' : 'claude'} />}
              <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                {config.label}
                {where && <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{where}</span>}
                {blocked && <span className="ml-1.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>Codex off</span>}
              </span>
              {config.pinned && (
                <span className="text-blue shrink-0" aria-hidden title="Pinned">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
                </span>
              )}
              {/* Hover actions on a flat panel at the row's tail (the canvas's
                  "same as A"). Stop propagation so edit/delete never also launch. */}
              <span
                className="absolute right-1.5 flex items-center gap-0.5 rounded pl-3 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity"
                style={{ background: 'linear-gradient(to left, var(--surface-overlay) 70%, transparent)' }}
                onClick={(e) => e.stopPropagation()}
              >
                {!blocked && (
                  <button type="button" onClick={() => launch(config)} className="p-1 rounded hover:bg-surface1 focus-ring" style={{ color: 'var(--status-success)' }} title="Launch">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
                  </button>
                )}
                <button type="button" onClick={() => onEdit(config)} className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text focus-ring" title="Edit">
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z" /></svg>
                </button>
                <button type="button" onClick={() => onDelete(config)} className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red focus-ring" title="Delete">
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" /></svg>
                </button>
              </span>
            </div>
          )
        })}
        <RunningFootnote hidden={configs.length - launchable.length} />
      </div>
    </div>
  )
}
