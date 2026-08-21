/**
 * The one-row command bar's upgrade path for commands that already exist
 * (ADR-018 M1, M2, D13). Three pure steps, each returning the SAME array when
 * it changed nothing so a healthy launch writes nothing:
 *
 *   1. assignCommandOrder   -- give every command an `order` within its band
 *   2. dissolveGlobalSections -- a user section literally named "Global" whose
 *      buttons are all global merges into the fixed Global band (it was the
 *      "weird button" the owner wanted gone); a mixed one is renamed
 *   3. reviewCommandsForUpgrade -- tag commands that clash with the new model
 *      with `needsReview` reasons. NEVER changes a command's behaviour; the
 *      user fixes or dismisses each one from the dialog's banner.
 *
 * Step 3 runs ONCE (commandBarUi.upgradeReviewVersion); steps 1-2 are
 * idempotent and cheap, so they run every launch.
 */
import type { CustomCommand, CommandSection, CommandReviewReason } from '../stores/commandStore'
import { bandMembers } from '../stores/commandStore'
import { COMMAND_SECRET_TOKEN } from '../../shared/command-secret'

export const COMMAND_UPGRADE_VERSION = 1

/** Minimal config facts the review needs. */
export interface UpgradeConfigFact {
  id: string
  shellOnly?: boolean
  sessionType?: 'local' | 'ssh'
}

// ---------------------------------------------------------------------------
// 1. order

export function assignCommandOrder(commands: readonly CustomCommand[]): CustomCommand[] {
  const configIds = new Set<string | undefined>()
  for (const c of commands) if (c.scope === 'config') configIds.add(c.configId)
  const next = new Map<string, number>()
  const assign = (members: CustomCommand[]) => {
    // A band where every member already has an order is left exactly alone.
    // Otherwise every member takes the position it already occupies (existing
    // ordinals sort first, array position breaks ties), so nothing moves.
    if (members.every((c) => typeof c.order === 'number')) return
    members.forEach((c, i) => { if (c.order !== i) next.set(c.id, i) })
  }
  assign(bandMembers(commands, 'global'))
  for (const cfg of configIds) assign(bandMembers(commands, 'config', cfg))
  if (next.size === 0) return commands as CustomCommand[]
  return commands.map((c) => (next.has(c.id) ? { ...c, order: next.get(c.id) } : c))
}

// ---------------------------------------------------------------------------
// 2. "Global" sections

export interface DissolveResult {
  commands: CustomCommand[]
  sections: CommandSection[]
  /** Commands whose section was dissolved (they get a review tag). */
  dissolvedCommandIds: Set<string>
  /** Sections renamed to "Global (yours)" because their members were mixed. */
  renamedSectionIds: Set<string>
}

export function dissolveGlobalSections(commands: readonly CustomCommand[], sections: readonly CommandSection[]): DissolveResult {
  const dissolvedCommandIds = new Set<string>()
  const renamedSectionIds = new Set<string>()
  const dropIds = new Set<string>()
  let nextSections: CommandSection[] = sections as CommandSection[]
  let changedSections = false
  const out: CommandSection[] = []
  for (const s of sections) {
    if ((s.name ?? '').trim().toLowerCase() !== 'global') { out.push(s); continue }
    const members = commands.filter((c) => c.sectionId === s.id)
    if (members.every((c) => c.scope === 'global')) {
      dropIds.add(s.id)
      for (const m of members) dissolvedCommandIds.add(m.id)
      changedSections = true
    } else {
      out.push({ ...s, name: 'Global (yours)' })
      renamedSectionIds.add(s.id)
      changedSections = true
    }
  }
  if (changedSections) nextSections = out
  const nextCommands = dropIds.size === 0
    ? (commands as CustomCommand[])
    : commands.map((c) => (c.sectionId && dropIds.has(c.sectionId) ? { ...c, sectionId: undefined } : c))
  return { commands: nextCommands, sections: nextSections, dissolvedCommandIds, renamedSectionIds }
}

// ---------------------------------------------------------------------------
// 3. the review

const FLAG_NAME = /(^|[-/])(token|secret|password|passwd|pwd|api[-_]?key|apikey|bearer|auth|credential|client[-_]?secret|access[-_]?key|private[-_]?key|pat)(?=$|[\s=:])/i
const KEY_SHAPED = /^(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/
const HIGH_ENTROPY = /^[A-Za-z0-9+/_=-]{32,}$/

/** Does this argument look like it carries a credential in plain text? */
export function looksLikeSecretArg(arg: string): boolean {
  const a = (arg ?? '').trim()
  if (!a || a.includes(COMMAND_SECRET_TOKEN)) return false
  if (FLAG_NAME.test(a)) return true
  // A value on its own: "-Token" may be one chip and the value the next one.
  const value = a.replace(/^[-/]+[\w-]+[=:\s]+/, '')
  if (KEY_SHAPED.test(value)) return true
  // A long run of mixed letters and digits with no spaces reads as a key (hex
  // digests, base64 blobs, opaque tokens). Words and paths do not match.
  if (HIGH_ENTROPY.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value)) return true
  return false
}

function sameReasons(a: CommandReviewReason[] | undefined, b: CommandReviewReason[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((r, i) => r === b[i])
}

export function reviewCommandsForUpgrade(
  commands: readonly CustomCommand[],
  ctx: { configs: readonly UpgradeConfigFact[]; dissolvedCommandIds: ReadonlySet<string> },
): CustomCommand[] {
  const anyShellConfig = ctx.configs.some((c) => !!c.shellOnly)
  const sshConfigIds = new Set(ctx.configs.filter((c) => c.sessionType === 'ssh').map((c) => c.id))
  let changed = false
  const out = commands.map((c) => {
    const reasons: CommandReviewReason[] = []
    const isPage = c.kind === 'page'
    const isPrompt = !isPage && (c.target ?? 'claude') === 'claude'
    if (!isPage && !c.hasSecretArg && (c.defaultArgs ?? []).some(looksLikeSecretArg)) reasons.push('secret-like-arg')
    if (isPrompt && c.scope === 'global' && anyShellConfig) reasons.push('prompt-inert-on-shell-configs')
    if (ctx.dissolvedCommandIds.has(c.id)) reasons.push('section-dissolved')
    if (!isPage && c.target === 'partner' && c.scope === 'config' && c.configId && sshConfigIds.has(c.configId)) reasons.push('ssh-partner-is-local')
    if (reasons.length === 0) return c
    if (sameReasons(c.needsReview, reasons)) return c
    changed = true
    return { ...c, needsReview: reasons }
  })
  return changed ? out : (commands as CustomCommand[])
}

/** Plain words for a reason, for the dialog banner and the Settings list. */
export function describeReviewReason(reason: CommandReviewReason): string {
  switch (reason) {
    case 'secret-like-arg': return 'An argument looks like a token or password. Store it as a secret so it never reaches your shell history.'
    case 'prompt-inert-on-shell-configs': return 'This Global button sends a prompt, so it cannot run in your terminal-only sessions; it sits in their "more" list, greyed.'
    case 'section-dissolved': return 'Its section was named "Global" and has been merged into the Global band.'
    case 'ssh-partner-is-local': return 'On an SSH config the partner shell runs on this PC, not on the host -- check this is the shell you meant.'
  }
}
