import React, { useMemo, useRef, useState } from 'react'
import type { TerminalConfig, ConfigGroup, ConfigSection } from '../../stores/configStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'
import {
  buildCardStacks,
  completeQuery,
  describeConfig,
  excludeRunning,
  launchAllTargets,
  makeNameLookup,
  searchConfigs,
  type CardStack,
} from './savedConfigsView'
import {
  ConfigGlyphIcon,
  RunningFootnote,
  SavedConfigsEmpty,
  SavedConfigsSearch,
  useLaunchSelection,
  useScrollSelectedIntoView,
} from './SavedConfigsSearch'

// The CARDS view of the Saved Configs panel (#362, option B on the canvas):
// one card per config, the identity colour a solid swatch carrying the type
// glyph, a second line saying what the config is, stacks per group with a
// count chip and launch-all. Running configs are not listed. A search box with
// inline completion sits on top; type -> arrow -> Enter launches.

interface Props {
  configs: TerminalConfig[]
  groups: ConfigGroup[]
  sections: ConfigSection[]
  /** Ids of configs with a live session -- never shown, never launched by launch-all. */
  runningIds: ReadonlySet<string>
  onLaunch: (config: TerminalConfig) => void
  onLaunchMany: (configs: TerminalConfig[]) => void
  onContextMenu: (e: React.MouseEvent, configId: string) => void
  focusRequest?: number
}

export default function SavedConfigsCards({ configs, groups, sections, runningIds, onLaunch, onLaunchMany, onContextMenu, focusRequest }: Props) {
  const [query, setQuery] = useState('')
  const theme = useResolvedTheme()
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const isBlocked = (c: TerminalConfig) => codexOff && c.provider === 'codex'
  const listRef = useRef<HTMLDivElement>(null)

  const lookup = useMemo(() => makeNameLookup(groups, sections), [groups, sections])
  const launchable = useMemo(() => excludeRunning(configs, runningIds), [configs, runningIds])
  const visible = useMemo(() => searchConfigs(launchable, query, lookup), [launchable, query, lookup])
  const stacks = useMemo(() => buildCardStacks(visible, groups, sections), [visible, groups, sections])
  const flat = useMemo(() => stacks.flatMap((s) => s.configs), [stacks])
  const completion = completeQuery(query, visible.map((c) => c.label))

  const launch = (c: TerminalConfig) => { if (!isBlocked(c)) onLaunch(c) }
  const sel = useLaunchSelection(flat, launch)
  useScrollSelectedIntoView(listRef, sel.selected)

  const launchStack = (stack: CardStack) => {
    const targets = launchAllTargets(stack.configs, runningIds, isBlocked)
    if (targets.length > 0) onLaunchMany(targets)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" data-ux-id="saved-configs-cards">
      <SavedConfigsSearch
        value={query}
        onChange={(v) => { setQuery(v); sel.setSelected(-1) }}
        completion={completion}
        onMove={sel.move}
        onEnter={sel.enter}
        focusRequest={focusRequest}
        hint={query ? `${visible.length} of ${launchable.length}` : undefined}
      />
      <div ref={listRef} role="listbox" aria-label="Saved configs" className="overflow-y-auto pb-2 flex-1 min-h-0">
        <SavedConfigsEmpty total={configs.length} launchable={launchable.length} visible={visible.length} query={query} />
        {stacks.map((stack) => (
          <div key={stack.id} className="mb-1" data-ux-id="saved-configs-stack" data-stack-kind={stack.kind}>
            {stack.sectionTitle && (
              <div className="flex items-center gap-2 px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                {stack.sectionTitle}
                <span className="flex-1 h-px" style={{ background: 'var(--border-subtle)' }} />
              </div>
            )}
            <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {stack.kind === 'pinned' && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-blue">
                  <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                </svg>
              )}
              <span className="truncate">{stack.title}</span>
              <span
                className="ml-auto inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              >
                {stack.configs.length}
                {stack.launchAll && (
                  <>
                    <span aria-hidden>&middot;</span>
                    <button
                      type="button"
                      onClick={() => launchStack(stack)}
                      className="hover:underline focus-ring rounded"
                      style={{ color: 'var(--status-success)' }}
                      title={`Launch every config in ${stack.title} that is not already running`}
                      data-ux-id="saved-configs-launch-all"
                    >
                      launch all
                    </button>
                  </>
                )}
              </span>
            </div>
            {stack.configs.map((config) => {
              const index = flat.indexOf(config)
              const selected = index === sel.selected
              const blocked = isBlocked(config)
              const d = describeConfig(config)
              const swatch = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
              const second = [d.kind, d.where, d.detail].filter(Boolean).join(' · ')
              return (
                <div
                  key={config.id}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={blocked || undefined}
                  data-ux-id="saved-config-card"
                  data-config-id={config.id}
                  tabIndex={-1}
                  onClick={() => launch(config)}
                  onMouseEnter={() => sel.setSelected(index)}
                  onContextMenu={(e) => onContextMenu(e, config.id)}
                  className={`group relative grid grid-cols-[30px_1fr] items-center gap-2.5 mx-2 my-1 rounded-lg border px-2 py-1.5 min-h-[46px] transition-colors ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  style={{
                    borderColor: selected ? 'color-mix(in srgb, var(--brand) 55%, transparent)' : 'var(--border-subtle)',
                    background: selected ? 'color-mix(in srgb, var(--brand) 10%, var(--surface-raised))' : 'var(--surface-raised)',
                    opacity: blocked ? 0.6 : 1,
                  }}
                  title={blocked ? CODEX_OFF_LAUNCH_REASON : second}
                >
                  <span
                    className="w-[30px] h-[30px] rounded-md grid place-items-center shrink-0"
                    style={{ background: swatch, color: 'var(--color-crust)' }}
                    aria-hidden
                  >
                    <ConfigGlyphIcon glyph={d.glyph} size={13} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{config.label}</span>
                    <span className="block text-[10px] truncate mt-px" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{d.kind}</span>
                      {d.where && <> &middot; {d.where}</>}
                      {d.detail && <> &middot; {d.detail}</>}
                      {blocked && <> &middot; Codex off</>}
                    </span>
                  </span>
                  {config.pinned && stack.kind !== 'pinned' && (
                    <span className="absolute top-1 right-1.5 text-blue" aria-hidden>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
                    </span>
                  )}
                  {!blocked && (
                    <span
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ background: 'color-mix(in srgb, var(--status-success) 16%, transparent)', color: 'var(--status-success)' }}
                      aria-hidden
                      title="Launch"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        <RunningFootnote hidden={configs.length - launchable.length} />
      </div>
    </div>
  )
}
