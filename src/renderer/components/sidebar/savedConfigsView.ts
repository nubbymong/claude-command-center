// Saved Configs panel — the pure half of the two alternative views (#362).
//
// The owner's decision (book item 40): build BOTH the "cards" view and the
// "find + categories" view from the design-pass canvas, chosen in Settings;
// both get a search box with auto-complete; both EXCLUDE configs whose
// session is already running; launch-all stays for a group. The existing
// hierarchical list stays the default, untouched.
//
// Everything that can be reasoned about without a DOM lives here so it can be
// unit-tested flat: which configs are running, what a query matches, what the
// inline completion says, how cards stack, what the category chips are, and
// which configs a "launch all" may actually start.

import type { TerminalConfig, ConfigGroup, ConfigSection } from '../../stores/configStore'
import type { Session } from '../../stores/sessionStore'

/** The three ways the panel can lay out saved configs. `list` is today's view. */
export type SavedConfigsView = 'list' | 'cards' | 'find'

export const SAVED_CONFIGS_VIEW_OPTIONS: ReadonlyArray<{ value: SavedConfigsView; label: string }> = [
  { value: 'list', label: 'List -- sections and groups (default)' },
  { value: 'cards', label: 'Cards -- one card per config, stacked by group' },
  { value: 'find', label: 'Find -- search box with category chips' },
]

/** Absent or unknown (an older settings file, a hand edit) => the default list. */
export function resolveSavedConfigsView(value: unknown): SavedConfigsView {
  return value === 'cards' || value === 'find' ? value : 'list'
}

// ---------------------------------------------------------------------------
// Running sessions

/**
 * Ids of the saved configs that currently have a live session. The Ask
 * Conductor session is deliberately config-less (see sessionStore.Session.kind)
 * and is skipped here too, so it can never hide a config.
 */
export function runningConfigIds(sessions: ReadonlyArray<Pick<Session, 'configId' | 'kind'>>): Set<string> {
  const ids = new Set<string>()
  for (const s of sessions) {
    if (s.kind === 'ask') continue
    if (s.configId) ids.add(s.configId)
  }
  return ids
}

/** The configs that may appear in a launch list: those without a running session. */
export function excludeRunning<T extends { id: string }>(configs: ReadonlyArray<T>, running: ReadonlySet<string>): T[] {
  return configs.filter((c) => !running.has(c.id))
}

// ---------------------------------------------------------------------------
// Names and search

export interface ConfigNames {
  groupName?: string
  /** The EFFECTIVE section: the group's section when grouped, else the config's own. */
  sectionName?: string
}

/** A lookup from config to its (effective) group and section names. */
export function makeNameLookup(
  groups: ReadonlyArray<ConfigGroup>,
  sections: ReadonlyArray<ConfigSection>,
): (config: TerminalConfig) => ConfigNames {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const sectionById = new Map(sections.map((s) => [s.id, s]))
  return (config) => {
    const group = config.groupId ? groupById.get(config.groupId) : undefined
    const sectionId = group ? group.sectionId : config.sectionId
    const section = sectionId ? sectionById.get(sectionId) : undefined
    return { groupName: group?.name, sectionName: section?.name }
  }
}

/** The text a query is matched against: label, group, section, directory, SSH host. */
export function configSearchFields(config: TerminalConfig, names: ConfigNames): string[] {
  const fields = [config.label, names.groupName, names.sectionName, config.workingDirectory]
  if (config.sshConfig) fields.push(config.sshConfig.host, `${config.sshConfig.username}@${config.sshConfig.host}`)
  return fields.filter((f): f is string => !!f)
}

/**
 * Every whitespace-separated token of the query must appear (case-insensitively)
 * in at least one field. "work check" therefore finds "Checkout service" in the
 * Work group, while a single unbroken substring still behaves as before.
 */
export function matchesQuery(config: TerminalConfig, query: string, names: ConfigNames): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const fields = configSearchFields(config, names).map((f) => f.toLowerCase())
  return tokens.every((t) => fields.some((f) => f.includes(t)))
}

export function searchConfigs(
  configs: ReadonlyArray<TerminalConfig>,
  query: string,
  lookup: (config: TerminalConfig) => ConfigNames,
): TerminalConfig[] {
  if (!query.trim()) return [...configs]
  return configs.filter((c) => matchesQuery(c, query, lookup(c)))
}

/**
 * Inline auto-complete: the first label that begins with what was typed,
 * returned with the TYPED prefix kept verbatim so the ghost text lines up under
 * the caret regardless of case. `null` when nothing completes (empty query, no
 * prefix match, or the typed text already IS the label).
 */
export function completeQuery(query: string, labels: ReadonlyArray<string>): string | null {
  if (!query) return null
  const q = query.toLowerCase()
  for (const label of labels) {
    if (label.length > query.length && label.toLowerCase().startsWith(q)) {
      return query + label.slice(query.length)
    }
  }
  return null
}

/** Arrow-key movement over a flat list: clamps at both ends, never wraps. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  const base = current < 0 ? (delta > 0 ? -1 : length) : current
  return Math.min(length - 1, Math.max(0, base + delta))
}

// ---------------------------------------------------------------------------
// Describing a config in words (the second line on a card)

export type ConfigGlyph = 'claude' | 'codex' | 'shell' | 'ssh'

export interface ConfigDescription {
  /** "Claude", "Codex", "Terminal only", "Claude over SSH", ... */
  kind: string
  /** Directory tail for local configs, user@host for SSH. */
  where: string
  /** Model / effort / command, when the config names one. */
  detail?: string
  glyph: ConfigGlyph
}

/** The last two path segments, so "F:\ccc-wt\46d46697" reads as "ccc-wt\46d46697". */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 2) return parts.join('/') || p
  const sep = p.includes('\\') ? '\\' : '/'
  return parts.slice(-2).join(sep)
}

export function describeConfig(config: TerminalConfig): ConfigDescription {
  const isSsh = config.sessionType === 'ssh'
  const base = config.shellOnly ? 'Terminal only' : config.provider === 'codex' ? 'Codex' : 'Claude'
  const kind = isSsh ? `${base} over SSH` : base
  const where = isSsh && config.sshConfig
    ? `${config.sshConfig.username}@${config.sshConfig.host}`
    : shortPath(config.workingDirectory || '')
  let detail: string | undefined
  if (config.shellOnly) detail = config.terminalOptions?.command || undefined
  else if (config.provider === 'codex') detail = config.codexOptions?.reasoningEffort || config.codexOptions?.model || undefined
  else detail = config.claudeOptions?.effortLevel || config.claudeOptions?.model || config.effortLevel || config.model || undefined
  const glyph: ConfigGlyph = isSsh ? 'ssh' : config.shellOnly ? 'shell' : config.provider === 'codex' ? 'codex' : 'claude'
  return { kind, where, detail, glyph }
}

// ---------------------------------------------------------------------------
// Cards: stacks

export interface CardStack {
  id: string
  kind: 'pinned' | 'section' | 'group' | 'loose'
  title: string
  /** Shown once above the first stack of each section (groups inside it carry their own title). */
  sectionTitle?: string
  configs: TerminalConfig[]
  /** Only group and section stacks launch-all, and only when there is more than one to launch. */
  launchAll: boolean
}

/**
 * Order: Pinned (pulled out of their groups, as on the canvas), then each
 * section's groups and its loose configs, then unsectioned groups, then the
 * loose ungrouped rest as "Ungrouped". Empty stacks are dropped. A stale
 * groupId/sectionId (pointing at something deleted) counts as loose, which is
 * how the list view renders it too.
 */
export function buildCardStacks(
  configs: ReadonlyArray<TerminalConfig>,
  groups: ReadonlyArray<ConfigGroup>,
  sections: ReadonlyArray<ConfigSection>,
): CardStack[] {
  const stacks: CardStack[] = []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const sectionIds = new Set(sections.map((s) => s.id))
  const pinned = configs.filter((c) => c.pinned)
  const rest = configs.filter((c) => !c.pinned)
  if (pinned.length > 0) stacks.push({ id: 'pinned', kind: 'pinned', title: 'Pinned', configs: pinned, launchAll: false })

  const groupStack = (g: ConfigGroup, sectionTitle?: string): CardStack | null => {
    const inGroup = rest.filter((c) => c.groupId === g.id)
    if (inGroup.length === 0) return null
    return { id: `group:${g.id}`, kind: 'group', title: g.name, sectionTitle, configs: inGroup, launchAll: inGroup.length > 1 }
  }

  for (const section of sections) {
    let first = true
    const take = (s: CardStack | null) => {
      if (!s) return
      if (first) { s.sectionTitle = section.name; first = false } else { delete s.sectionTitle }
      stacks.push(s)
    }
    for (const g of groups.filter((g) => g.sectionId === section.id)) take(groupStack(g, section.name))
    const loose = rest.filter((c) => !(c.groupId && groupById.has(c.groupId)) && c.sectionId === section.id)
    if (loose.length > 0) take({ id: `section:${section.id}`, kind: 'section', title: section.name, configs: loose, launchAll: loose.length > 1 })
  }

  for (const g of groups.filter((g) => !g.sectionId || !sectionIds.has(g.sectionId))) {
    const s = groupStack(g)
    if (s) stacks.push(s)
  }

  const ungrouped = rest.filter((c) =>
    !(c.groupId && groupById.has(c.groupId)) && !(c.sectionId && sectionIds.has(c.sectionId)),
  )
  if (ungrouped.length > 0) stacks.push({ id: 'loose', kind: 'loose', title: 'Ungrouped', configs: ungrouped, launchAll: false })
  return stacks
}

// ---------------------------------------------------------------------------
// Find: categories

export interface Category {
  id: string
  kind: 'all' | 'pinned' | 'section' | 'group'
  label: string
  count: number
}

export const ALL_CATEGORY_ID = 'all'
export const PINNED_CATEGORY_ID = 'pinned'

/** The configs a category chip stands for. Sections include their groups' configs. */
export function configsInCategory(
  configs: ReadonlyArray<TerminalConfig>,
  category: Pick<Category, 'id' | 'kind'>,
  groups: ReadonlyArray<ConfigGroup>,
): TerminalConfig[] {
  switch (category.kind) {
    case 'all': return [...configs]
    case 'pinned': return configs.filter((c) => !!c.pinned)
    case 'group': {
      const gid = category.id.slice('group:'.length)
      return configs.filter((c) => c.groupId === gid)
    }
    case 'section': {
      const sid = category.id.slice('section:'.length)
      const groupIds = new Set(groups.filter((g) => g.sectionId === sid).map((g) => g.id))
      return configs.filter((c) => (c.groupId ? groupIds.has(c.groupId) : c.sectionId === sid))
    }
  }
}

/**
 * Chips: All, Pinned (when any), then each section, then each group -- only
 * those with at least one config in the list handed in, so counts agree with
 * what the rows show (pass the already running-excluded set).
 */
export function buildCategories(
  configs: ReadonlyArray<TerminalConfig>,
  groups: ReadonlyArray<ConfigGroup>,
  sections: ReadonlyArray<ConfigSection>,
): Category[] {
  const out: Category[] = [{ id: ALL_CATEGORY_ID, kind: 'all', label: 'All', count: configs.length }]
  const pinned = configs.filter((c) => c.pinned).length
  if (pinned > 0) out.push({ id: PINNED_CATEGORY_ID, kind: 'pinned', label: 'Pinned', count: pinned })
  for (const s of sections) {
    const cat: Category = { id: `section:${s.id}`, kind: 'section', label: s.name, count: 0 }
    cat.count = configsInCategory(configs, cat, groups).length
    if (cat.count > 0) out.push(cat)
  }
  for (const g of groups) {
    const cat: Category = { id: `group:${g.id}`, kind: 'group', label: g.name, count: 0 }
    cat.count = configsInCategory(configs, cat, groups).length
    if (cat.count > 0) out.push(cat)
  }
  return out
}

// ---------------------------------------------------------------------------
// Launch all

/**
 * What "launch all" may start: the candidates minus anything already running
 * and anything the caller says is blocked (the Codex master off). Running is
 * re-checked here rather than trusted from the list, so a stack or chip built
 * a moment ago can never double-launch a config that has since started.
 */
export function launchAllTargets<T extends { id: string }>(
  candidates: ReadonlyArray<T>,
  running: ReadonlySet<string>,
  isBlocked: (config: T) => boolean = () => false,
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const c of candidates) {
    if (seen.has(c.id) || running.has(c.id) || isBlocked(c)) continue
    seen.add(c.id)
    out.push(c)
  }
  return out
}
