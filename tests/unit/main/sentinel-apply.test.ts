// A model entry Sentinel proposes (or one hand-edited into its findings)
// follows the same name rule as the model picker of the family's provider,
// before it can reach the registry: Claude Code's picker writes a value into a
// live session as `/model <v>`, and the other provider's picker offers only
// ids its launch takes. The refusal is a fixed text that never repeats the
// value. Beside tests/unit/sentinel-apply.test.ts, which covers the rest of
// the Apply gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { validateProposal } from '../../../src/main/sentinel/sentinel-apply'
import { _initRegistryForTest, getRegistry } from '../../../src/main/model-registry-service'
import { followsModelPickerRule, isWritablePickerValue, PICKER_VALUE_RE } from '../../../src/shared/model-registry'
import * as rendererOptions from '../../../src/renderer/lib/claude-cli-options'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-names-')); _initRegistryForTest(dir) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const RULE = 'model name holds characters a model name cannot'
const claudeEntry = {
  id: 'claude-new-1', patterns: ['new-1'], family: 'sonnet', label: 'New 1',
  provenance: { addedBy: 'sentinel' as const, date: '2026-10-07' },
}
const otherEntry = {
  id: 'gpt-new-1', patterns: ['gpt-new-1'], family: 'codex', label: 'GPT New 1',
  provenance: { addedBy: 'sentinel' as const, date: '2026-10-07' },
}
const check = (e: object) => validateProposal(getRegistry(), e as never)

// Unsafe characters are built from code points, never written literally.
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const ESC = String.fromCharCode(27)

describe('a proposed model name follows the picker\'s rule (a Claude Code family)', () => {
  const badIds = [
    `claude-new-1${LF}x`, `claude-new-1${CR}`, `${ESC}[2Jclaude`,
    'claude new 1', 'claude-new-1 ',
    'claude;new', 'claude|new', 'claude&new', 'claude$new', 'claude`new`', "claude'new", 'claude"new', 'claude(new)', 'claude<new>',
    'claude/new', 'claude\\new', 'claude:new', 'c'.repeat(65),
  ]
  for (const id of badIds) {
    it(`refuses the id ${JSON.stringify(id)} with the fixed text, never the value`, () => {
      const r = check({ ...claudeEntry, id, patterns: ['zz-new-only'] })
      expect(r.ok).toBe(false)
      expect(r.error).toBe(RULE)
    })
  }
  for (const alias of [`new${LF}1`, 'new 1', 'new;1', 'new/1', '']) {
    it(`refuses the alias ${JSON.stringify(alias)}`, () => {
      const r = check({ ...claudeEntry, aliases: ['fresh-alias', alias] })
      expect(r.ok).toBe(false)
      expect(r.error).toBe(RULE)
    })
  }
  it('takes ordinary ids and aliases, the bracketed context-size form included', () => {
    expect(check(claudeEntry).ok).toBe(true)
    expect(check({ ...claudeEntry, id: 'claude-new-1[1m]' }).ok).toBe(true)
    expect(check({ ...claudeEntry, id: 'claude-new-1.5_beta', aliases: ['new1', 'new1[1m]'] }).ok).toBe(true)
  })
})

describe('a proposed model name follows the picker\'s rule (the other provider\'s family)', () => {
  for (const id of [`gpt-new${LF}x`, 'gpt new', 'gpt;new', 'gpt\\new', '-gpt-new', '.gpt-new', '/gpt-new', 'gpt[1m]', 'g'.repeat(65)]) {
    it(`refuses the id ${JSON.stringify(id)}`, () => {
      const r = check({ ...otherEntry, id, patterns: ['zz-other-only'] })
      expect(r.ok).toBe(false)
      expect(r.error).toBe(RULE)
    })
  }
  it('refuses an alias its picker would not take', () => {
    expect(check({ ...otherEntry, aliases: [`x${LF}y`] }).error).toBe(RULE)
  })
  it('takes the ids its picker offers, a provider prefix or a tag included', () => {
    expect(check(otherEntry).ok).toBe(true)
    expect(check({ ...otherEntry, id: 'gpt-oss:20b', patterns: ['gpt-oss:20b'] }).ok).toBe(true)
    expect(check({ ...otherEntry, id: 'local/model-x', patterns: ['local/model-x'] }).ok).toBe(true)
  })
})

describe('a proposed entry\'s fields are of the right kind', () => {
  it('refuses an id, label or family that is not text, saying so', () => {
    for (const e of [{ ...claudeEntry, label: 42 }, { ...claudeEntry, family: ['sonnet'] }, { ...claudeEntry, id: ['claude-new-1'] }]) {
      expect(check(e), JSON.stringify(e)).toEqual({ ok: false, error: 'id, label, family must be text' })
    }
  })
  it('refuses aliases that are not a list', () => {
    expect(check({ ...claudeEntry, aliases: 'zzz' }).ok).toBe(false)
    expect(check({ ...claudeEntry, aliases: { 0: 'zzz' } }).ok).toBe(false)
  })
})

describe('a refusal names a proposal\'s pattern and family as plain text', () => {
  const RLO = String.fromCharCode(0x202e)
  const hidden = new RegExp(`[${LF}${CR}${ESC}${RLO}]`)
  it('a pattern that does not compile', () => {
    const r = check({ ...claudeEntry, patterns: [`^new-1${RLO}(${LF}x`] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^anchored pattern does not compile: \^new-1/)
    expect(r.error).not.toMatch(hidden)
  })
  it('a pattern that would also match a model the registry knows', () => {
    const known = getRegistry().models[0].id
    const r = check({ ...claudeEntry, patterns: [`^${known.slice(0, 4)}${ESC}?`] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/re-matches already-known model/)
    expect(r.error).not.toMatch(hidden)
  })
  it('a family the registry does not hold', () => {
    const r = check({ ...claudeEntry, family: `ghost${CR}${LF}${RLO}x` })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^family "ghost/)
    expect(r.error).not.toMatch(hidden)
  })
})

describe('one rule for the picker and the proposal', () => {
  it('the renderer\'s picker reads the same rule main applies', () => {
    expect(rendererOptions.isWritablePickerValue).toBe(isWritablePickerValue)
    expect(rendererOptions.PICKER_VALUE_RE).toBe(PICKER_VALUE_RE)
  })
  it('the provider is the family\'s, as the code decides it', () => {
    expect(followsModelPickerRule('opus', 'opus[1m]')).toBe(true)
    expect(followsModelPickerRule('opus', 'gpt-oss:20b')).toBe(false)
    expect(followsModelPickerRule('codex', 'gpt-oss:20b')).toBe(true)
    expect(followsModelPickerRule('codex', 'opus[1m]')).toBe(false)
    // An unknown or missing family is Claude Code's, as familyProvider says.
    expect(followsModelPickerRule('ghost', 'opus[1m]')).toBe(true)
    expect(followsModelPickerRule(undefined, 'x y')).toBe(false)
  })
})
