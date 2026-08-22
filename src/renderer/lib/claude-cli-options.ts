// Shared Claude Code CLI options — kept in sync with `claude --help` and with
// Anthropic's Claude Code model configuration support article (the reference
// for which models/efforts we offer, per the owner on #385):
//   https://support.claude.com/en/articles/11940350-claude-code-model-configuration
//
// Claude Code's `--model` flag and `/model` slash command accept both family
// ALIASES (`opus`, `sonnet`, `haiku`, `opus[1m]`) — which always resolve to the
// newest model in each family — and PINNED versioned ids (`claude-opus-4-6`).
// The picker offers both: alias rows first, then the pinned versions grouped
// under their family. The pinned rows are derived from the registry's `models`,
// so a Sentinel/user overlay entry shows up with no code change.

import {
  buildModelPickerRows,
  buildEffortRows,
  groupPickerRows,
  resolveModelInfo,
  normalizeModelLabel,
  type ModelRegistry,
  type ModelPickerRow,
} from '../../shared/model-registry'

export interface OptionItem {
  label: string
  value: string
  hint?: string
}

/** A picker section: the group heading plus its rows. */
export interface ModelOptionGroup {
  title: string
  items: OptionItem[]
}

// Registry-derived model and effort lists. Components should derive these via
// useRegistryStore((s) => s.registry) so dropdowns hot-reload on registry updates.

/** Picker rows grouped for a popover or a <select> with <optgroup>s. */
export function modelGroupsFromRegistry(reg: ModelRegistry): ModelOptionGroup[] {
  return groupPickerRows(buildModelPickerRows(reg)).map((g) => ({
    title: g.title,
    items: g.rows.map((r: ModelPickerRow) => ({ label: r.label, value: r.value, hint: r.hint })),
  }))
}

/**
 * Effort rows for a specific model, each carrying `disabled` for a level that
 * model does not support. Levels are disabled rather than dropped so the list
 * keeps a stable shape; an unknown or fuzzily-matched model enables everything
 * (see buildEffortRows).
 */
export function effortsForModel(
  reg: ModelRegistry,
  modelId: string | undefined | null,
): (OptionItem & { disabled?: boolean })[] {
  return buildEffortRows(reg, modelId).map((e) => ({
    label: e.label, value: e.value, hint: e.hint,
    ...(e.supported ? {} : { disabled: true }),
  }))
}

/**
 * The charset the PTY IPC boundary already enforces for a `--model` value
 * (`src/main/ipc/pty-handlers.ts`), mirrored for values written into a LIVE PTY
 * as a slash command (`/model <v>`, `/effort <v>`).
 *
 * That path has no schema in front of it. The pinned picker rows are derived
 * from the registry, and `registry-overlay.json` is a hand-editable user file
 * whose entries are validated on APPLY rather than on load — so an id carrying a
 * newline would be written into the PTY as a second, attacker-chosen line.
 * Defence in depth (the overlay is a local file, not remote input), and it costs
 * a regex. Legit values: 'opus', 'opus[1m]', 'claude-opus-4-8', 'xhigh'.
 */
export const PICKER_VALUE_RE = /^[a-zA-Z0-9._[\]-]+$/

/** True when `v` is safe to write into a PTY as a slash-command argument. */
export function isWritablePickerValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && PICKER_VALUE_RE.test(v)
}

export const PERMISSION_MODES: OptionItem[] = [
  { label: 'Ask permissions', value: 'default', hint: 'Claude asks before most actions' },
  { label: 'Accept edits', value: 'acceptEdits', hint: 'Auto-accept file edits, ask for others' },
  { label: 'Auto', value: 'auto', hint: 'Auto-accept most actions' },
  { label: 'Plan mode', value: 'plan', hint: 'Read-only, no file edits' },
  { label: "Don't ask", value: 'dontAsk', hint: 'Accept everything without asking' },
  { label: 'Bypass', value: 'bypassPermissions', hint: 'Skip every permission prompt' },
]

export const PERMISSION_MODE_LABELS: Record<string, string> = Object.fromEntries(
  PERMISSION_MODES.map((m) => [m.value, m.label]),
)

// Resolve a display string for the given model identifier. `name` is whatever
// the statusline hook reported (display_name ?? id) — prefer the former since
// Claude Code already computes a pretty label like "Opus 4.7 (1M context)".
// Falls back to a regex that strips `claude-` and reshapes versioned IDs,
// so new families don't require a code change.
//
// When a registry is supplied and it matched the id VERSION-faithfully (exact
// id / alias / id-prefix), the registry's curated label wins: that is what puts
// the pinned name on the footer pill ("Opus 4.8 Fast", which the regex below
// would flatten to "Opus 4.8"). A fuzzy `pattern` hit is never trusted for a
// label — it would claim the wrong version (#385).
export function shortModelName(name?: string, registry?: ModelRegistry): string {
  if (!name) return 'default'

  if (registry) {
    const info = resolveModelInfo(registry, name)
    if (info.known && info.matchKind !== 'pattern') return info.label
  }

  // Statusline's display_name comes capitalised and space-separated. Pass
  // through untouched so we don't mangle a label Claude Code already picked.
  if (/^[A-Z]/.test(name)) return name

  const lower = name.toLowerCase()
  const familyMatch = lower.match(/(opus|sonnet|haiku|fable)/)
  if (!familyMatch) {
    return name.replace(/^claude-/, '').replace(/-/g, ' ')
  }
  const family = familyMatch[1]
  const familyCap = family.charAt(0).toUpperCase() + family.slice(1)
  // Two-part versions (opus-4-8 -> "4.8") and single-part families (fable-5 -> "5").
  const versionMatch = lower.match(/-(\d+)(?:-(\d+))?/)
  const version = versionMatch ? (versionMatch[2] ? `${versionMatch[1]}.${versionMatch[2]}` : versionMatch[1]) : ''
  const contextHint = /\[1m\]|1m context/i.test(lower) ? '1M' : ''
  return [familyCap, version, contextHint].filter(Boolean).join(' ')
}

/**
 * Match a picker row against the active statusline reading so the dropdown can
 * mark the currently-running model.
 *
 * The 1M variant discriminates first: `opus[1m]` and `opus` resolve to the same
 * id, so only the context reading separates them.
 *
 * Beyond that, a PINNED row must not be marked active just because the family
 * matches — "Opus 4.6" running should not tick "Opus 4.8". Passing the registry
 * enables that version-faithful comparison; without it the original family-level
 * behaviour is kept for the alias rows.
 */
export function isModelActive(optionValue: string, activeModel: string, registry?: ModelRegistry): boolean {
  if (!activeModel) return false
  const active = activeModel.toLowerCase()
  const wantsOneM = optionValue.includes('[1m]')
  const isOneM = /\[1m\]|1m context|\b1m\b/.test(active)

  if (registry) {
    const opt = resolveModelInfo(registry, optionValue)
    if (opt.known) {
      if (opt.family && !active.includes(opt.family)) return false
      if (wantsOneM !== isOneM) return false
      const act = resolveModelInfo(registry, activeModel)
      // Both sides pinned to a real entry: compare canonical ids.
      if (act.known && act.matchKind !== 'pattern') return opt.id === act.id
      // The active reading is a display name we can only fuzzily place
      // ("Opus 4.6"). Compare it to the row's label as a whole rather than by
      // family+version: "Opus 4.8 Fast" carries version 4.8 too, and matching
      // on the version alone ticked both Opus 4.8 and Opus 4.8 Fast — two
      // different models (review Q6).
      const reading = normalizeModelLabel(activeModel)
      // A reading with no version at all ("Opus") names a family, not a
      // release, so only the family alias row can claim it.
      if (!/\d/.test(reading)) return opt.matchKind === 'alias'
      return normalizeModelLabel(opt.label) === reading
    }
  }

  if (optionValue.startsWith('opus')) {
    if (!active.includes('opus')) return false
    return wantsOneM ? isOneM : !isOneM
  }
  if (optionValue === 'sonnet') return active.includes('sonnet')
  if (optionValue === 'haiku') return active.includes('haiku')
  if (optionValue === 'fable') return active.includes('fable')
  return false
}
