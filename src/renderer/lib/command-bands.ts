/**
 * Pure helpers over command records -- kept OUT of the store module so code
 * that mocks the store (every command-bar test) still gets them.
 */
import type { CustomCommand } from '../stores/commandStore'

/** The two bands a user command can live in. The band IS the scope. */
export type CommandBand = 'global' | 'config'

export function bandOf(cmd: Pick<CustomCommand, 'scope'>): CommandBand {
  return cmd.scope === 'global' ? 'global' : 'config'
}

/** The commands of one band, in their ordinal order (array position breaks ties). */
export function bandMembers(all: readonly CustomCommand[], band: CommandBand, configId?: string): CustomCommand[] {
  const members = all.filter((c) => band === 'global' ? c.scope === 'global' : (c.scope === 'config' && c.configId === configId))
  return members
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.order ?? a.i) - (b.c.order ?? b.i) || a.i - b.i)
    .map((x) => x.c)
}
