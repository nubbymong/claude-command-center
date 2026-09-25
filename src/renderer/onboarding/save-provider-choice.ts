// WP2 commit 6e: saving which assistants the user runs. Kept apart from
// provider-choice.ts, which stays free of store imports for steps.ts.
import type { AccountsResult, ProviderId } from '../../shared/providers'
import { providerAccountActions, saveProviderSwitch, PERSIST_FAILED } from '../stores/providerAccountsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { choiceSettings, CODEX_ONLY_SETTINGS, type AssistantsChoice, type FirstRunOutcome } from './provider-choice'

// Main could not answer: it has no account list to decide with yet. Only
// that. Everything else is an answer and goes back to the caller as it is:
// a refusal (the last provider on, something in use), and `internal` too,
// an unexpected failure in main or a call that did not complete, which the
// user sees and can retry. Saving the setting over it would hide a failure
// main reported.
const NO_ANSWER: ReadonlySet<string> = new Set(['registry-unavailable'])

/**
 * Save the assistants page's choice: both keys, through the same path as the
 * Providers switch (main decides first, then the saved setting), so main and
 * the settings agree. Turning on comes before turning off, because main
 * refuses to turn off the last provider that is on.
 *
 * When main has no account list yet (`registry-unavailable`), the setting
 * is saved on its own: main reads the saved setting as each provider's
 * on/off, so the two agree once it can, and the first run is never stuck on
 * this page. Any other failure, `internal` included, is returned.
 */
export async function saveAssistantsChoice(choice: AssistantsChoice): Promise<AccountsResult> {
  const want = choiceSettings(choice)
  const on: Record<ProviderId, boolean> = { claude: want.claudeEnabled, codex: want.codexEnabled }
  const order: ProviderId[] = on.claude ? ['claude', 'codex'] : ['codex', 'claude']
  for (const id of order) {
    const r = await providerAccountActions.switchProvider(id, on[id])
    if (r.ok) continue
    if (!NO_ANSWER.has(r.code)) return r
    if (!(await saveProviderSwitch(id, on[id]))) return PERSIST_FAILED
  }
  return { ok: true }
}

/**
 * Apply what first-run setup handed back. App calls this once the stores
 * hold the loaded config, so nothing is written over a config that has not
 * been read (a settings file written before the first load would also stop
 * the one-time localStorage migration). The store changes at once; the save
 * to disk follows. Main reads the saved keys as each provider's on/off.
 */
export function applyFirstRunOutcome(outcome: FirstRunOutcome | undefined): Promise<unknown> | undefined {
  if (!outcome?.codexOnly) return undefined
  return useSettingsStore.getState().updateSettings({ ...CODEX_ONLY_SETTINGS })
}
