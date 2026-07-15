/**
 * Canonical Codex model list. Single source of truth for both
 * SessionDialog/CodexFormFields and the terminal toolbar. Order is the
 * display order in dropdowns (newest -> oldest, with -mini and -codex
 * variants grouped near their family).
 */
export const CODEX_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
] as const

export type CodexModel = typeof CODEX_MODELS[number]
