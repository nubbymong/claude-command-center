/**
 * The Codex model and effort pickers' rows (P3.8, rows 39 and 40), for the
 * session dialog's Codex fields and the command bar's Codex model pill.
 *
 * The catalogue is the model registry's, as Claude's is: the codex family's
 * models in resources/model-registry.json, which are the models the supported
 * Codex CLI lists in its own model picker (resources/codex-model-catalogue.json,
 * checked by Sentinel), in its order. A hand-kept list lived here until P3.8.
 */
import { buildModelPickerRows, type ModelRegistry } from '../shared/model-registry'
import { effortsForModel } from './lib/claude-cli-options'

export interface CodexPickerOption {
  value: string
  label: string
  disabled?: boolean
}

/** The value that means "no override": Codex's own default model, or the
 *  model's own default effort (the spawn passes no flag for it). */
export const CODEX_DEFAULT = ''

/**
 * The Codex models to offer: Default, then the registry's Codex models, then
 * `current` when it is a model the list no longer offers (a config saved with
 * one), so the picker shows what the config or session actually holds rather
 * than silently displaying another row.
 */
export function codexModelOptions(registry: ModelRegistry, current?: string | null): CodexPickerOption[] {
  const rows = buildModelPickerRows(registry, 'codex')
  const out: CodexPickerOption[] = [
    { value: CODEX_DEFAULT, label: 'Default: follows Codex' },
    ...rows.map((r) => ({ value: r.value, label: r.label })),
  ]
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: `${current} (not in the list)` })
  return out
}

/**
 * The efforts to offer for `model`: Default, then Codex's levels, each level
 * that model does not support disabled (Claude's rule: greyed, never hidden).
 */
export function codexEffortOptions(registry: ModelRegistry, model: string | null | undefined): CodexPickerOption[] {
  return [
    { value: CODEX_DEFAULT, label: 'Default' },
    ...effortsForModel(registry, model || null, 'codex').map((e) => ({ value: e.value, label: e.label, ...(e.disabled ? { disabled: true } : {}) })),
  ]
}

/** True when `model` runs `effort`: Default always does; a level Codex's list
 *  does not hold (a legacy 'none' or 'minimal') never does, so a model change
 *  or a load clamps it to Default, as Claude's effort is clamped. */
export function codexEffortSupported(registry: ModelRegistry, model: string | null | undefined, effort: string | null | undefined): boolean {
  if (!effort) return true
  return effortsForModel(registry, model || null, 'codex').some((e) => e.value === effort && !e.disabled)
}
