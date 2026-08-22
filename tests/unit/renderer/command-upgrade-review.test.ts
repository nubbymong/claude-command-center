/**
 * Existing commands survive the one-row bar, and the ones that clash with the
 * new model are TAGGED for the user -- never changed behind their back
 * (ADR-018 D13, owner: "they may be running commands with arguments etc.").
 */
import { describe, it, expect } from 'vitest'
import {
  assignCommandOrder, dissolveGlobalSections, reviewCommandsForUpgrade, looksLikeSecretArg, describeReviewReason,
} from '../../../src/renderer/lib/command-upgrade'
import { bandMembers, type CustomCommand, type CommandSection } from '../../../src/renderer/stores/commandStore'

const cmd = (over: Partial<CustomCommand> & { id: string }): CustomCommand => ({ label: over.id, prompt: 'echo', scope: 'global', ...over })

describe('looksLikeSecretArg -- what gets flagged', () => {
  it('flags credential-named flags, with or without a value attached', () => {
    for (const a of ['-Token abc123', '--api-key=xyz', '--password hunter2', '--bearer', '/pat', '--client-secret=foo', 'Token=abc', '-Secret', '--password'])
      expect(looksLikeSecretArg(a), a).toBe(true)
    // a bare short flag is not a credential name
    expect(looksLikeSecretArg('-p')).toBe(false)
  })
  it('flags key-shaped values on their own (the value may be its own chip)', () => {
    expect(looksLikeSecretArg('sk-abcdefghijklmnop')).toBe(true)
    expect(looksLikeSecretArg('ghp_ABCDEFGHIJKLMNOPQRSTUV1234')).toBe(true)
    expect(looksLikeSecretArg('xoxb-1234567890-abcdefghij')).toBe(true)
    expect(looksLikeSecretArg('AKIAABCDEFGHIJKLMNOP')).toBe(true)
    expect(looksLikeSecretArg('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0')).toBe(true)
    expect(looksLikeSecretArg('deadbeefdeadbeefdeadbeefdeadbeef12')).toBe(true)
  })
  it('does NOT flag ordinary arguments, paths, or an argument already using {secret}', () => {
    for (const a of ['-Port 8080', '--verbose', '-Background', './scripts/run.ps1', '--env production', 'C:\\dev\\project', '--watch', '-t foo', '-Token {secret}', ''])
      expect(looksLikeSecretArg(a), a).toBe(false)
  })
})

describe('assignCommandOrder -- per band, from the position a command already has', () => {
  it('gives every command in a band an order equal to its current position, per band', () => {
    const before = [
      cmd({ id: 'g1' }), cmd({ id: 'c1', scope: 'config', configId: 'A' }), cmd({ id: 'g2' }),
      cmd({ id: 'c2', scope: 'config', configId: 'A' }), cmd({ id: 'b1', scope: 'config', configId: 'B' }),
    ]
    const after = assignCommandOrder(before)
    expect(after).not.toBe(before)
    expect(bandMembers(after, 'global').map((c) => [c.id, c.order])).toEqual([['g1', 0], ['g2', 1]])
    expect(bandMembers(after, 'config', 'A').map((c) => [c.id, c.order])).toEqual([['c1', 0], ['c2', 1]])
    expect(bandMembers(after, 'config', 'B').map((c) => [c.id, c.order])).toEqual([['b1', 0]])
  })
  it('returns the SAME array when every command already has an order, so nothing is written', () => {
    const before = [cmd({ id: 'g1', order: 0 }), cmd({ id: 'g2', order: 1 })]
    expect(assignCommandOrder(before)).toBe(before)
  })
  it('is idempotent', () => {
    const once = assignCommandOrder([cmd({ id: 'a' }), cmd({ id: 'b' })])
    expect(assignCommandOrder(once)).toBe(once)
  })
  it('respects an existing partial order: an unordered member sorts by its array position among the ordered ones', () => {
    const before = [cmd({ id: 'late', order: 5 }), cmd({ id: 'early', order: 1 }), cmd({ id: 'new' })]
    const after = assignCommandOrder(before)
    // 'new' sits at array index 2, between early (1) and late (5); nothing moves.
    expect(bandMembers(after, 'global').map((c) => c.id)).toEqual(['early', 'new', 'late'])
    expect(bandMembers(after, 'global').map((c) => c.order)).toEqual([0, 1, 2])
  })
})

describe('dissolveGlobalSections -- the "weird › Global buttons"', () => {
  const sec = (over: Partial<CommandSection> & { id: string; name: string }): CommandSection => ({ scope: 'global', ...over })

  it('dissolves a section named "Global" whose members are all global, clearing their sectionId', () => {
    const sections = [sec({ id: 's1', name: 'Global' }), sec({ id: 's2', name: 'Deploy' })]
    const commands = [cmd({ id: 'a', sectionId: 's1' }), cmd({ id: 'b', sectionId: 's1' }), cmd({ id: 'c', sectionId: 's2' })]
    const r = dissolveGlobalSections(commands, sections)
    expect(r.sections.map((s) => s.id)).toEqual(['s2'])
    expect(r.commands.find((c) => c.id === 'a')!.sectionId).toBeUndefined()
    expect(r.commands.find((c) => c.id === 'c')!.sectionId).toBe('s2')
    expect([...r.dissolvedCommandIds].sort()).toEqual(['a', 'b'])
  })
  it('is case-insensitive and tolerant of whitespace', () => {
    const r = dissolveGlobalSections([], [sec({ id: 's1', name: '  global ' })])
    expect(r.sections).toEqual([])
  })
  it('renames a "Global" section with MIXED members to "Global (yours)" and keeps it', () => {
    const sections = [sec({ id: 's1', name: 'Global', scope: 'config', configId: 'A' })]
    const commands = [cmd({ id: 'a', sectionId: 's1' }), cmd({ id: 'b', sectionId: 's1', scope: 'config', configId: 'A' })]
    const r = dissolveGlobalSections(commands, sections)
    expect(r.sections[0].name).toBe('Global (yours)')
    expect(r.renamedSectionIds.has('s1')).toBe(true)
    expect(r.commands).toBe(commands)
  })
  it('returns the same references when there is no such section', () => {
    const sections = [sec({ id: 's2', name: 'Deploy' })]
    const commands = [cmd({ id: 'a', sectionId: 's2' })]
    const r = dissolveGlobalSections(commands, sections)
    expect(r.sections).toBe(sections)
    expect(r.commands).toBe(commands)
  })
})

describe('reviewCommandsForUpgrade -- tagged, never changed', () => {
  const configs = [
    { id: 'claudeCfg', sessionType: 'local' as const },
    { id: 'termCfg', shellOnly: true, sessionType: 'local' as const },
    { id: 'sshCfg', sessionType: 'ssh' as const },
  ]
  const none = new Set<string>()

  it('tags an argument that looks like a secret on a shell button without one', () => {
    const before = [cmd({ id: 'd', target: 'partner', defaultArgs: ['-Token abc123xyz'] })]
    const after = reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })
    expect(after[0].needsReview).toEqual(['secret-like-arg'])
    // and nothing else about it changed
    expect({ ...after[0], needsReview: undefined }).toEqual({ ...before[0], needsReview: undefined })
  })
  it('does not tag a button that already stores its secret', () => {
    const before = [cmd({ id: 'd', target: 'partner', hasSecretArg: true, defaultArgs: ['-Token {secret}'] })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })).toBe(before)
  })
  it('scans the REMEMBERED (Ctrl+click) arguments too -- they are typed just the same (ADR-009 pass on #386)', () => {
    const before = [cmd({ id: 'r', target: 'partner', defaultArgs: ['-Env', 'prod'], lastCustomArgs: ['-Token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'] })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })[0].needsReview).toEqual(['secret-like-arg'])
  })
  /**
   * #371 — a shell button's own command line was the one typed field never
   * scanned. On a shell button that field is not a prompt; it is the line typed
   * into the terminal, and a whole invocation with a token in it is the most
   * natural thing to write there.
   */
  it('scans a SHELL button\'s command line, not just its arguments', () => {
    const before = [cmd({ id: 'sh', kind: 'shell', target: 'partner', prompt: 'curl -H "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123"' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })[0].needsReview).toEqual(['secret-like-arg'])
  })
  it('does not scan a PROMPT button\'s text -- a prompt is prose, and no reference is ever typed into one', () => {
    const before = [cmd({ id: 'pr', scope: 'config', configId: 'claudeCfg', prompt: 'explain the --password flag to me' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })).toBe(before)
  })
  it('scans a legacy shell button too -- written before `kind` existed, a partner target is what made it one', () => {
    const before = [cmd({ id: 'legacy', target: 'partner', prompt: 'deploy --api-key=AKIAABCDEFGHIJKLMNOP' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })[0].needsReview).toEqual(['secret-like-arg'])
  })
  it('does not tag a shell button whose command line already carries the token', () => {
    const before = [cmd({ id: 'sh2', kind: 'shell', target: 'partner', hasSecretArg: true, prompt: 'curl -H "Bearer {secret}"' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })).toBe(before)
  })
  it('tags a Global prompt button when the user has a terminal-only config, and not otherwise', () => {
    const before = [cmd({ id: 'p', scope: 'global' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })[0].needsReview).toEqual(['prompt-inert-on-shell-configs'])
    expect(reviewCommandsForUpgrade(before, { configs: [configs[0]], dissolvedCommandIds: none })).toBe(before)
  })
  it('tags a shell button scoped to an SSH config (its partner shell is on this PC)', () => {
    const before = [cmd({ id: 's', scope: 'config', configId: 'sshCfg', target: 'partner' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })[0].needsReview).toEqual(['ssh-partner-is-local'])
  })
  it('tags the members of a dissolved section', () => {
    const before = [cmd({ id: 'a', scope: 'config', configId: 'claudeCfg', target: 'partner' })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: new Set(['a']) })[0].needsReview).toEqual(['section-dissolved'])
  })
  it('a page button is never tagged for arguments or prompts', () => {
    const before = [cmd({ id: 'pg', kind: 'page', pageUrl: 'http://x', defaultArgs: ['-Token abc123xyz'] })]
    expect(reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })).toBe(before)
  })
  it('stacks reasons, is idempotent, and returns the same array when nothing new applies', () => {
    const before = [cmd({ id: 'd', scope: 'global', defaultArgs: ['--password hunter2'] })]
    const once = reviewCommandsForUpgrade(before, { configs, dissolvedCommandIds: none })
    expect(once[0].needsReview).toEqual(['secret-like-arg', 'prompt-inert-on-shell-configs'])
    expect(reviewCommandsForUpgrade(once, { configs, dissolvedCommandIds: none })).toBe(once)
  })
  it('every reason has words for the user', () => {
    for (const r of ['secret-like-arg', 'prompt-inert-on-shell-configs', 'section-dissolved', 'ssh-partner-is-local'] as const)
      expect(describeReviewReason(r).length).toBeGreaterThan(20)
  })
})
