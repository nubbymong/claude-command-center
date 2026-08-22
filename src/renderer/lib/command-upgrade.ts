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
import { bandMembers } from './command-bands'
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

/** The one-click "Make this argument a secret" plan: which argument value leaves
 *  for the keychain and what the arguments look like afterwards. */
export interface SecretMove {
  /** The chip that now carries `{secret}` (the value chip, or the flag+value chip). */
  index: number
  /** The plaintext that goes to the keychain. */
  value: string
  /** The arguments after the move. */
  args: string[]
}

const BARE_FLAG = /^[-/]+[\w-]+$/
const FLAG_SEP_VALUE = /^([-/]+[\w-]+)([=:])(.+)$/

/**
 * Decide what "Make this argument a secret" moves (ADR-009 pass on #386: the
 * first cut took the first flagged chip and guessed). Rules, in order: a chip
 * whose VALUE is key-shaped wins over a chip that merely names a secret flag;
 * `--token=V` / `/Token:V` keep their joiner (`--token={secret}`) because the
 * tool may not accept a space; a chip holding several `-flag value` pairs
 * replaces the value after the LAST secret-named flag; a bare `-Token` takes the
 * next chip as its value and is skipped when there is no next chip (the value
 * is not there to move); a chip already holding `{secret}` is never a candidate.
 * Returns null when nothing can be moved -- the button is then not offered.
 */
export function planSecretMove(args: readonly string[]): SecretMove | null {
  const tryAt = (i: number): SecretMove | null => {
    const a = (args[i] ?? '').trim()
    if (!a || a.includes(COMMAND_SECRET_TOKEN)) return null
    const next = [...args]
    if (BARE_FLAG.test(a)) {
      const v = args[i + 1]
      if (v === undefined || BARE_FLAG.test(v.trim()) || v.includes(COMMAND_SECRET_TOKEN)) return null
      next[i + 1] = COMMAND_SECRET_TOKEN
      return { index: i + 1, value: v, args: next }
    }
    const sep = a.match(FLAG_SEP_VALUE)
    if (sep) { next[i] = `${sep[1]}${sep[2]}${COMMAND_SECRET_TOKEN}`; return { index: i, value: sep[3].trim(), args: next } }
    if (/\s/.test(a)) {
      // Several words in one chip: replace the value after the last secret-named flag.
      const words = a.split(/\s+/)
      for (let j = words.length - 2; j >= 0; j--) {
        if (BARE_FLAG.test(words[j]) && FLAG_NAME.test(words[j]) && !BARE_FLAG.test(words[j + 1])) {
          const value = words[j + 1]
          words[j + 1] = COMMAND_SECRET_TOKEN
          next[i] = words.join(' ')
          return { index: i, value, args: next }
        }
      }
      // No flag inside: the last word is the value.
      const value = words[words.length - 1]
      words[words.length - 1] = COMMAND_SECRET_TOKEN
      next[i] = words.join(' ')
      return { index: i, value, args: next }
    }
    next[i] = COMMAND_SECRET_TOKEN
    return { index: i, value: a, args: next }
  }
  const candidates = args.map((a, i) => ({ a: (a ?? '').trim(), i })).filter(({ a }) => looksLikeSecretArg(a))
  // A key-shaped VALUE first (the chip that IS the secret), then anything else that can move.
  for (const { a, i } of candidates) {
    if (BARE_FLAG.test(a)) continue
    const plan = tryAt(i)
    if (plan && looksLikeSecretArg(plan.value) && !BARE_FLAG.test(plan.value)) return plan
  }
  for (const { i } of candidates) {
    const plan = tryAt(i)
    if (plan) return plan
  }
  return null
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
    // Remembered (Ctrl+click) arguments are typed too, so they are scanned too.
    // So is a SHELL button's command line (#371): on a shell button that field
    // is not a prompt, it is the line typed into the terminal, and a whole
    // invocation with a token in it is the most natural thing to write there —
    // `curl -H "Bearer ghp_..."`. It was the one typed field never scanned.
    // A record written before `kind` existed carries no kind, and a partner
    // target is what made it a shell line then — the same widening
    // `effectiveKind` does, minus the parts that need a live session.
    const isShellLine = !isPage && (c.kind === 'shell' || (!c.kind && c.target === 'partner'))
    // Split into words: `looksLikeSecretArg` judges ONE argument (its key-shape
    // and entropy rules are anchored), so handing it a whole command line would
    // match nothing. The words are what the chips would have been.
    const shellLine = isShellLine ? (c.prompt ?? '').split(/\s+/).filter(Boolean) : []
    if (!isPage && !c.hasSecretArg && [...shellLine, ...(c.defaultArgs ?? []), ...(c.lastCustomArgs ?? [])].some(looksLikeSecretArg)) reasons.push('secret-like-arg')
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
