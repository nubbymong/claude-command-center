/**
 * The plan of the one-row bar, without React: which band, which cluster, which
 * section group, and whether a button can run here (ADR-018 D1, D3-D5, D9).
 */
import { describe, it, expect } from 'vitest'
import { planBar, planBand, inapplicability, clusterOf, chipTitle, clusterTitle, pinnedFirst } from '../../../src/renderer/components/command-bar/layout'
import { sessionCapabilities } from '../../../src/renderer/lib/session-capabilities'
import type { CustomCommand, CommandSection } from '../../../src/renderer/stores/commandStore'

const cmd = (over: Partial<CustomCommand> & { id: string }): CustomCommand => ({ label: over.id, prompt: 'x', scope: 'global', ...over })
const local = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
const codex = sessionCapabilities({ provider: 'codex', sessionType: 'local', configId: 'cfg' } as never)
const term = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg', shellOnly: true } as never)
const ssh = sessionCapabilities({ provider: 'claude', sessionType: 'ssh', configId: 'cfg', sshConfig: { host: 'box' } } as never)
const noConfig = sessionCapabilities({ provider: 'claude', sessionType: 'local' } as never)

describe('bands', () => {
  it('Global then Session; no Session band without a config', () => {
    expect(planBar([], [], local, 'cfg').map((b) => b.band)).toEqual(['global', 'config'])
    expect(planBar([], [], noConfig, undefined).map((b) => b.band)).toEqual(['global'])
  })
  it('a command sits in the band of its scope, in per-band order, pinned first', () => {
    const all = [
      cmd({ id: 'g2', order: 1 }), cmd({ id: 'g1', order: 0 }), cmd({ id: 'gp', order: 2, pinned: true }),
      cmd({ id: 'c1', scope: 'config', configId: 'cfg', order: 0 }), cmd({ id: 'other', scope: 'config', configId: 'elsewhere' }),
    ]
    const [g, s] = planBar(all, [], local, 'cfg')
    expect(g.chips.map((c) => c.id)).toEqual(['gp', 'g1', 'g2'])
    expect(s.chips.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('clusters inside a band follow the target, named for THIS session', () => {
  it('local Claude: prompt → agent, partner → partner, page → page', () => {
    expect(clusterOf(cmd({ id: 'p' }), local)).toBe('agent')
    expect(clusterOf(cmd({ id: 's', target: 'partner' }), local)).toBe('partner')
    expect(clusterOf(cmd({ id: 'pg', kind: 'page', pageUrl: 'http://x' }), local)).toBe('page')
  })
  it('terminal-only: a shell line aimed at the main pane IS the main shell; a legacy Global claude-target is a prompt', () => {
    expect(clusterOf(cmd({ id: 'm', target: 'claude', kind: 'shell' }), term)).toBe('main-shell')
    // legacy record without kind: a Session button of the terminal-only config = its shell line
    expect(clusterOf(cmd({ id: 'l', target: 'claude', scope: 'config', configId: 'cfg' }), term)).toBe('main-shell')
    // legacy Global claude-target: a prompt (inert here; it goes to overflow with a reason)
    expect(clusterOf(cmd({ id: 'g', target: 'claude' }), term)).toBe('agent')
  })
  it('cluster titles name the agent and the machine', () => {
    expect(clusterTitle('agent', codex)).toBe('These run in Codex')
    expect(clusterTitle('agent', ssh)).toBe('These run in Claude on box')
    expect(clusterTitle('partner', ssh)).toContain('this PC')
    expect(clusterTitle('main-shell', term)).toBe('These run in this shell')
  })
  it('sections group chips inside a cluster: unsectioned first, then the band\'s own sections in order', () => {
    const sections: CommandSection[] = [{ id: 'dep', name: 'Deploy', scope: 'global' }, { id: 'cfgsec', name: 'Mine', scope: 'config', configId: 'cfg' }]
    const all = [
      cmd({ id: 'a', target: 'partner', order: 0 }), cmd({ id: 'b', target: 'partner', sectionId: 'dep', order: 1 }),
      cmd({ id: 'c', target: 'partner', order: 2 }), cmd({ id: 'd', target: 'partner', sectionId: 'cfgsec', order: 3 }),
    ]
    const g = planBand('global', all, sections, local)
    const partner = g.clusters.find((c) => c.kind === 'partner')!
    expect(partner.groups.map((gr) => [gr.section?.name ?? null, gr.chips.map((c) => c.id)])).toEqual([
      [null, ['a', 'c', 'd']],   // d's section belongs to the config band, so here it is loose
      ['Deploy', ['b']],
    ])
    expect(g.sections.map((s) => s.id)).toEqual(['dep'])
  })
})

describe('applicability -- computed, never stored', () => {
  it('a prompt button cannot run where there is no agent; it is listed with the reason, not hidden', () => {
    const all = [cmd({ id: 'p' }), cmd({ id: 's', target: 'partner' })]
    const g = planBand('global', all, [], term)
    expect(g.chips.map((c) => c.id)).toEqual(['s'])
    expect(g.inapplicable.map((x) => [x.cmd.id, x.reason])).toEqual([['p', 'No agent in this session to read a prompt']])
  })
  it('a secret-bearing shell button whose shell is remote cannot run; a local partner can', () => {
    expect(inapplicability(cmd({ id: 'r', target: 'claude', kind: 'shell', hasSecretArg: true }), sessionCapabilities({ provider: 'claude', sessionType: 'ssh', shellOnly: true, configId: 'cfg' } as never))?.reason).toContain('this PC only')
    expect(inapplicability(cmd({ id: 'l', target: 'partner', hasSecretArg: true }), ssh)).toBeNull()
  })
  it('a page button always applies', () => {
    expect(inapplicability(cmd({ id: 'pg', kind: 'page', pageUrl: 'http://x' }), term)).toBeNull()
  })
})

describe('chip title = menu header, one string', () => {
  it('says kind, where it runs, scope, section and args', () => {
    const t = chipTitle(cmd({ id: 'Deploy', label: 'Deploy', target: 'partner', defaultArgs: ['-Env prod'] }), ssh, 'Deploy')
    expect(t).toBe('Deploy — Shell line · runs in the partner shell (this PC) · Global — every config · section Deploy · args: -Env prod (Ctrl+click to change for one run)')
  })
  it('a Codex prompt names Codex; a page names its url', () => {
    expect(chipTitle(cmd({ id: 'Fix', label: 'Fix' }), codex)).toContain('runs in the Codex terminal')
    expect(chipTitle(cmd({ id: 'D', label: 'Docs', kind: 'page', pageUrl: 'https://d/' }), local)).toContain('Opens https://d/ in the browser pane')
  })
  it('pinnedFirst keeps relative order within each half', () => {
    expect(pinnedFirst([cmd({ id: 'a' }), cmd({ id: 'b', pinned: true }), cmd({ id: 'c' }), cmd({ id: 'd', pinned: true })]).map((c) => c.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})
