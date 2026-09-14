/**
 * The pure plan of the one-row command bar (ADR-018 D1, D3, D4, D5, D9):
 * which band each user command sits in, which target cluster inside the band,
 * which section group inside the cluster, and whether it can run here at all.
 * No React in this file so the rules are testable on their own.
 */
import type { CustomCommand, CommandSection } from '../../stores/commandStore'
import { bandMembers, type CommandBand } from '../../lib/command-bands'
import { describeTarget, type SessionCapabilities, type CommandTarget } from '../../lib/session-capabilities'

/** Where a button's text goes. 'agent' = the agent in the main pane; 'main-shell' =
 *  the main pane when it IS a shell; 'partner' = the partner shell; 'page' = the browser. */
export type ClusterKind = 'agent' | 'main-shell' | 'partner' | 'page'

export type EffectiveKind = 'prompt' | 'shell' | 'page'

/**
 * What a button DOES, for records old and new. New records store `kind`; an
 * old record is read off `target` (partner = a shell line) and, for a
 * claude-target button, off its scope: a Session button of a terminal-only
 * config is that shell's own line, anything else is a prompt. (ADR-018 D6)
 */
export function effectiveKind(cmd: Pick<CustomCommand, 'kind' | 'target' | 'scope' | 'hasSecretArg'>, caps: SessionCapabilities): EffectiveKind {
  if (cmd.kind === 'page' || cmd.kind === 'shell' || cmd.kind === 'prompt') return cmd.kind
  if (cmd.target === 'partner') return 'shell'
  // A secret argument only ever existed on a shell line (beta.16 allowed one on
  // a Global main-shell button of a terminal-only session): reading such a
  // record as a prompt would let the next save delete its keychain value.
  if (cmd.hasSecretArg) return 'shell'
  return caps.mainPaneIsShell && cmd.scope === 'config' ? 'shell' : 'prompt'
}

export function clusterOf(cmd: CustomCommand, caps: SessionCapabilities): ClusterKind {
  const kind = effectiveKind(cmd, caps)
  if (kind === 'page') return 'page'
  if (cmd.target === 'partner') return 'partner'
  // A shell line aimed at the main pane (a terminal-only session's own shell).
  if (kind === 'shell') return 'main-shell'
  return 'agent'
}

/** The order clusters appear inside a band. */
export const CLUSTER_ORDER: readonly ClusterKind[] = ['agent', 'main-shell', 'partner', 'page']

export interface Inapplicable {
  reason: string
}

/**
 * Can this button run in THIS session? Computed, never stored (D5). A button that
 * cannot run leaves the row and sits greyed in its band's overflow with the
 * reason, so nothing is ever hidden silently and old data is untouched.
 */
export function inapplicability(cmd: CustomCommand, caps: SessionCapabilities): Inapplicable | null {
  const kind = effectiveKind(cmd, caps)
  if (kind === 'page') return null
  const target: CommandTarget = cmd.target === 'partner' ? 'partner' : 'claude'
  if (kind === 'prompt' && !caps.agent) return { reason: 'No agent in this session to read a prompt' }
  if (kind === 'shell' && target === 'claude' && !caps.mainPaneIsShell) return { reason: 'This shell line was made for a terminal-only session; here the main pane is an agent' }
  if (cmd.hasSecretArg && !caps.canDeliverSecret(target)) return { reason: 'Secret values reach shells on this PC only' }
  return null
}

export interface SectionGroup {
  section: CommandSection | null   // null = unsectioned (always first)
  chips: CustomCommand[]
}
export interface Cluster {
  kind: ClusterKind
  groups: SectionGroup[]
  /** Every applicable chip of the cluster in row order (pinned first). */
  chips: CustomCommand[]
}
export interface BandPlan {
  band: CommandBand
  label: string
  clusters: Cluster[]
  /** Applicable chips of the whole band, in row order (pinned first, then order). */
  chips: CustomCommand[]
  /** Buttons that cannot run here, with the reason, for the overflow list. */
  inapplicable: Array<{ cmd: CustomCommand; reason: string }>
  sections: CommandSection[]
}

/** Pinned chips form the leading run of a band; the rest keep their order. */
export function pinnedFirst(cmds: readonly CustomCommand[]): CustomCommand[] {
  return [...cmds.filter((c) => c.pinned), ...cmds.filter((c) => !c.pinned)]
}

function sectionsForBand(sections: readonly CommandSection[], band: CommandBand, configId?: string): CommandSection[] {
  // A section is bound to its scope band, not to a pane (the old `target`
  // field is ignored as a filter -- D6).
  return sections.filter((s) => band === 'global' ? s.scope === 'global' : (s.scope === 'config' && s.configId === configId))
}

export function planBand(
  band: CommandBand,
  all: readonly CustomCommand[],
  sections: readonly CommandSection[],
  caps: SessionCapabilities,
  configId?: string,
): BandPlan {
  const members = bandMembers(all, band, configId)
  const bandSections = sectionsForBand(sections, band, configId)
  const sectionIds = new Set(bandSections.map((s) => s.id))
  const applicable: CustomCommand[] = []
  const inapplicable: BandPlan['inapplicable'] = []
  for (const c of members) {
    const why = inapplicability(c, caps)
    if (why) inapplicable.push({ cmd: c, reason: why.reason })
    else applicable.push(c)
  }
  const ordered = pinnedFirst(applicable)
  const clusters: Cluster[] = []
  for (const kind of CLUSTER_ORDER) {
    const chips = ordered.filter((c) => clusterOf(c, caps) === kind)
    if (chips.length === 0) continue
    // Unsectioned first, then sections in the order the user keeps them. A
    // command whose section is not visible in this band (orphan) is unsectioned.
    const groups: SectionGroup[] = []
    const loose = chips.filter((c) => !c.sectionId || !sectionIds.has(c.sectionId))
    if (loose.length) groups.push({ section: null, chips: loose })
    for (const s of bandSections) {
      const mine = chips.filter((c) => c.sectionId === s.id)
      if (mine.length) groups.push({ section: s, chips: mine })
    }
    clusters.push({ kind, groups, chips })
  }
  return {
    band,
    label: band === 'global' ? 'Global' : 'Session',
    clusters,
    chips: clusters.flatMap((c) => c.chips),
    inapplicable,
    sections: bandSections,
  }
}

export function planBar(
  all: readonly CustomCommand[],
  sections: readonly CommandSection[],
  caps: SessionCapabilities,
  configId?: string,
): BandPlan[] {
  const plans = [planBand('global', all, sections, caps)]
  // A session with no saved config has no Session band (Ask Conductor, a resumed folder).
  if (configId) plans.push(planBand('config', all, sections, caps, configId))
  return plans
}

/** What the mark before a cluster says on hover. */
export function clusterTitle(kind: ClusterKind, caps: SessionCapabilities): string {
  switch (kind) {
    case 'agent': return caps.mainRunsOn === 'remote' ? `These run in ${caps.agentName} on ${caps.remoteHost ?? 'the host'}` : `These run in ${caps.agentName}`
    case 'main-shell': return caps.mainRunsOn === 'remote' ? `These run in this shell on ${caps.remoteHost ?? 'the host'}` : 'These run in this shell'
    case 'partner': return caps.panesOnDifferentMachines ? 'These run in the partner shell — on this PC, not the host' : 'These run in the partner shell'
    case 'page': return 'These open a page in the browser pane, from this PC'
  }
}

/** The one string a chip's tooltip and its menu header share (D4). */
export function chipTitle(cmd: CustomCommand, caps: SessionCapabilities, sectionName?: string): string {
  const kind = effectiveKind(cmd, caps)
  const kindWord = kind === 'page' ? 'Page' : kind === 'shell' ? 'Shell line' : 'Prompt'
  const where = kind === 'page'
    ? `Opens ${cmd.pageUrl ?? '(no page set)'} in the browser pane. Types nothing`
    : `runs in ${describeTarget(caps, cmd.target === 'partner' ? 'partner' : 'claude')}`
  const scope = cmd.scope === 'global' ? 'Global — every config' : 'Session — this config only'
  const parts = [`${cmd.label} — ${kindWord}`, where, scope]
  if (sectionName) parts.push(`section ${sectionName}`)
  if (cmd.kind !== 'page' && cmd.defaultArgs?.length) parts.push(`args: ${cmd.defaultArgs.join(' ')} (Ctrl+click to change for one run)`)
  return parts.join(' · ')
}
