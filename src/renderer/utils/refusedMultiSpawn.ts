// P3.13 (round 1, M7): main enforces the one-at-a-time rule from the SAVED
// config (src/main/launch-one-at-a-time.ts), and the screen's config can differ
// from it when a save did not land (the config-health banner says so). Then a
// launch the screen allowed is one main refuses, and the tab says "turn on
// Allow Multi Spawn for it" beside a toggle that already shows it on.
//
// On that refusal the renderer asks main for the saved configs and makes the
// screen's Allow Multi Spawn the saved one, so the toggle shows what main
// decides on and the tab's words are true. Only that one field of that one
// config changes, only on the screen: nothing is written, so an edit the user
// has not saved is theirs to save or lose as before.
import { useConfigStore } from '../stores/configStore'

export interface RefusedMultiSpawnDeps {
  /** The config's Allow Multi Spawn as the screen has it (undefined: not there). */
  onScreen: (configId: string) => { found: boolean; allowMultiSpawn: unknown }
  /** The saved configs main holds, or null when they could not be read. */
  readSaved: () => Promise<unknown[] | null>
  /** Make the screen's Allow Multi Spawn for this config the saved one. */
  setOnScreen: (configId: string, allowMultiSpawn: boolean | undefined) => void
}

const realDeps: RefusedMultiSpawnDeps = {
  onScreen: (configId) => {
    const c = useConfigStore.getState().configs.find((x) => x.id === configId)
    return { found: !!c, allowMultiSpawn: c?.allowMultiSpawn }
  },
  readSaved: async () => {
    const r = await window.electronAPI.config.loadAll()
    if (!r || r.readFailed || (r.failedKeys ?? []).includes('configs')) return null
    const configs = (r.data as { configs?: unknown } | undefined)?.configs
    return Array.isArray(configs) ? configs : null
  },
  setOnScreen: (configId, allowMultiSpawn) => {
    useConfigStore.setState((s) => ({ configs: s.configs.map((c) => (c.id === configId ? { ...c, allowMultiSpawn } : c)) }))
  },
}

/**
 * Called when main answered a spawn with `already-running`. Returns true when
 * the screen's toggle was corrected. Does nothing when the screen already
 * agrees with the saved config (the refusal is then simply true), when the
 * saved configs cannot be read, when the config is not on the screen, or when
 * the user changed the toggle while the saved configs were being read.
 */
export async function reconcileRefusedMultiSpawn(configId: string | undefined, deps: RefusedMultiSpawnDeps = realDeps): Promise<boolean> {
  if (typeof configId !== 'string' || configId === '') return false
  try {
    const screen = deps.onScreen(configId)
    if (!screen.found || screen.allowMultiSpawn !== true) return false
    const saved = await deps.readSaved()
    if (!saved) return false
    const mine = saved.find((c) => !!c && typeof c === 'object' && (c as { id?: unknown }).id === configId) as { allowMultiSpawn?: unknown } | undefined
    if (!mine || mine.allowMultiSpawn === true) return false
    // The read took a moment: the user may have changed the toggle (or removed the
    // config) meanwhile. Look again right before writing, and leave a change of
    // theirs alone.
    const now = deps.onScreen(configId)
    if (!now.found || now.allowMultiSpawn !== true) return false
    deps.setOnScreen(configId, mine.allowMultiSpawn === false ? false : undefined)
    return true
  } catch {
    return false
  }
}
