// Shared Claude Code CLI options — kept in sync with `claude --help` rather
// than hardcoded to specific model versions. Claude Code's `--model` flag and
// `/model` slash command both accept aliases (`opus`, `sonnet`, `haiku`,
// `opus[1m]`), and those aliases always resolve to the latest model in each
// family. Using aliases here means the dropdown never goes stale when
// Anthropic ships a new model.

export interface OptionItem {
  label: string
  value: string
  hint?: string
}

export const MODELS: OptionItem[] = [
  { label: 'Opus', value: 'opus', hint: 'Latest Opus (200k context)' },
  { label: 'Opus 1M', value: 'opus[1m]', hint: 'Latest Opus (1M context)' },
  { label: 'Sonnet', value: 'sonnet', hint: 'Latest Sonnet' },
  { label: 'Haiku', value: 'haiku', hint: 'Latest Haiku' },
]

export const EFFORTS: OptionItem[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra high', value: 'xhigh' },
  { label: 'Max', value: 'max' },
]

export const PERMISSION_MODES: OptionItem[] = [
  { label: 'Ask permissions', value: 'default', hint: 'Claude asks before most actions' },
  { label: 'Accept edits', value: 'acceptEdits', hint: 'Auto-accept file edits, ask for others' },
  { label: 'Auto', value: 'auto', hint: 'Auto-accept most actions' },
  { label: 'Plan mode', value: 'plan', hint: 'Read-only, no file edits' },
  { label: "Don't ask", value: 'dontAsk', hint: 'Accept everything without asking' },
  { label: 'Bypass', value: 'bypassPermissions', hint: 'Skip every permission prompt' },
]

export const MODE_LABELS: Record<string, string> = Object.fromEntries(
  PERMISSION_MODES.map((m) => [m.value, m.label]),
)

// Resolve a display string for the given model identifier. `name` is whatever
// the statusline hook reported (display_name ?? id) — prefer the former since
// Claude Code already computes a pretty label like "Opus 4.7 (1M context)".
// Falls back to a regex that strips `claude-` and reshapes versioned IDs,
// so new families don't require a code change.
export function shortModelName(name?: string): string {
  if (!name) return 'default'

  // Statusline's display_name comes capitalised and space-separated. Pass
  // through untouched so we don't mangle a label Claude Code already picked.
  if (/^[A-Z]/.test(name)) return name

  const lower = name.toLowerCase()
  const familyMatch = lower.match(/(opus|sonnet|haiku)/)
  if (!familyMatch) {
    return name.replace(/^claude-/, '').replace(/-/g, ' ')
  }
  const family = familyMatch[1]
  const familyCap = family.charAt(0).toUpperCase() + family.slice(1)
  const versionMatch = lower.match(/-(\d+)-(\d+)/)
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : ''
  const contextHint = /\[1m\]|1m context/i.test(lower) ? '1M' : ''
  return [familyCap, version, contextHint].filter(Boolean).join(' ')
}

// Match a model alias or display name against the active statusline reading
// so the dropdown can mark the currently-running model. Family match on its
// own is enough for the non-1M variants; `opus[1m]` needs explicit `1m`/`1M`
// detection to not false-match plain `opus`.
export function isModelActive(optionValue: string, activeModel: string): boolean {
  if (!activeModel) return false
  const active = activeModel.toLowerCase()
  const wantsOneM = optionValue.includes('[1m]')
  const isOneM = /\[1m\]|1m context|\b1m\b/.test(active)
  if (optionValue.startsWith('opus')) {
    if (!active.includes('opus')) return false
    return wantsOneM ? isOneM : !isOneM
  }
  if (optionValue === 'sonnet') return active.includes('sonnet')
  if (optionValue === 'haiku') return active.includes('haiku')
  return false
}
