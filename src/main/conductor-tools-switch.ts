// The built-in tools switches (Settings, General, Built-in Tools), read the
// one way every reader of them reads them: from a CHECKED read of the saved
// settings, so a settings file that is there but cannot be read or parsed is
// told apart from a fresh install that has no file yet.
//
//  - no settings file (a fresh install): the built-in tools are on, every
//    group on;
//  - settings read and parsed: the master is on unless it is saved off, and a
//    group is on unless it is saved off (an absent key is on, so settings
//    saved before the switches existed keep them on);
//  - settings that are there but cannot be read or parsed, or that hold
//    something other than an object: the built-in tools are OFF and no group
//    is known, until a later read succeeds. Said once per run in the log.
//
// The file is never moved aside from here (quarantineUnparseable: false):
// what happens to a settings file that does not parse is the settings load's
// call, not a tools reader's.
import { readConfigChecked, type ConfigReadOutcome } from './config-manager'
import { logWarn } from './debug-logger'

export interface ConductorToolSwitchState {
  /** The master switch: whether the built-in tools reach a session at all. */
  master: boolean
  /** The per-group switches as saved (a group absent here is on); null when
   *  the settings could not be read, and the master is then off. */
  switches: Record<string, boolean> | null
}

let unreadableLogged = false

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The saved group switches: only true/false values count (anything else
 *  reads as absent, so on, as before). */
function groupSwitches(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!isPlainObject(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    // A plain assignment to `__proto__` already ignores a boolean; the name
    // is skipped so a later rewrite (defineProperty, fromEntries) cannot
    // carry it as a key of its own either.
    if (typeof value === 'boolean' && key !== '__proto__') out[key] = value
  }
  return out
}

/** The switches a checked settings read gives. Pure but for the one log line
 *  per run when the read gave nothing usable. */
export function conductorToolSwitchesOf(read: { outcome: ConfigReadOutcome; value: unknown }): ConductorToolSwitchState {
  if (read.outcome === 'absent') return { master: true, switches: {} }
  if (read.outcome === 'ok' && isPlainObject(read.value)) {
    return { master: read.value.conductorToolsEnabled !== false, switches: groupSwitches(read.value.conductorTools) }
  }
  if (!unreadableLogged) {
    unreadableLogged = true
    const why = read.outcome === 'ok' ? 'not a settings object' : read.outcome
    logWarn(`[conductor-tools] the saved settings could not be used (${why}): the built-in tools stay off until they can be read`)
  }
  return { master: false, switches: null }
}

/** The switches a settings value its caller has already read gives: an
 *  object reads as above; anything else is settings that cannot be used. */
export function conductorToolSwitchesOfSettings(settings: unknown): ConductorToolSwitchState {
  return conductorToolSwitchesOf({ outcome: 'ok', value: settings })
}

/** One checked read of the saved settings: the switches it gives, and the
 *  settings themselves for a reader that needs another saved value from the
 *  same read (null unless the read gave a settings object). */
export function readConductorToolSettings(): { tools: ConductorToolSwitchState; settings: Record<string, unknown> | null } {
  let read: { outcome: ConfigReadOutcome; value: unknown }
  try {
    read = readConfigChecked<unknown>('settings', { quarantineUnparseable: false })
  } catch {
    // A reader that throws has not read anything: no answer is not "on".
    read = { outcome: 'failed', value: null }
  }
  const tools = conductorToolSwitchesOf(read)
  return { tools, settings: tools.switches !== null && isPlainObject(read.value) ? read.value : null }
}

/** The built-in tools switches, read now. */
export function readConductorToolSwitches(): ConductorToolSwitchState {
  return readConductorToolSettings().tools
}

/** Whether the built-in tools are on now: off while the settings cannot be read. */
export function conductorToolsMasterOn(): boolean {
  return readConductorToolSwitches().master
}
