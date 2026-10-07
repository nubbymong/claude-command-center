// P3.8 (rows 39, 40): the Codex model catalogue comes from the model registry,
// as Claude's does, and each Codex model offers its own effort levels.
//
// The Codex rows are the list-visible models of the supported Codex CLI's own
// catalogue (the models catalogue bundled in the 0.153.4 binary, read as bytes;
// resources/codex-model-catalogue.json), with each model's supported reasoning
// levels. Claude's pickers never show a Codex row, and Codex's never a Claude one.
import { describe, it, expect } from 'vitest'
import {
  buildModelPickerRows,
  buildEffortRows,
  groupPickerRows,
  familyProvider,
  effortLevelsFor,
  mergeRegistry,
  evaluateCodexModelCoverage,
  isCodexModelId,
  type ModelRegistry,
  type ExpectedModelSet,
  type OverlayModelEntry,
} from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'
import catalogueJson from '../../resources/codex-model-catalogue.json'

const reg = baselineJson as unknown as ModelRegistry
const catalogue = catalogueJson as unknown as ExpectedModelSet

const CODEX_IDS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']

describe('Codex model catalogue from the registry (row 39)', () => {
  it('offers the list-visible models of the Codex CLI catalogue, in its order, under one Codex group', () => {
    const rows = buildModelPickerRows(reg, 'codex')
    expect(rows.map((r) => r.value)).toEqual(CODEX_IDS)
    expect(rows.every((r) => r.kind === 'pinned' && r.family === 'codex')).toBe(true)
    expect(groupPickerRows(rows).map((g) => g.title)).toEqual(['Codex'])
    expect(rows.find((r) => r.value === 'gpt-6-astra')!.label).toBe('GPT-6-Astra')
  })

  it('never offers the codex-family matcher, a Claude alias or a Claude model to Codex', () => {
    const values = buildModelPickerRows(reg, 'codex').map((r) => r.value)
    expect(values).not.toContain('codex-family')
    expect(values.some((v) => v.startsWith('claude-') || ['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]'].includes(v))).toBe(false)
  })

  it("never offers a Codex model in Claude's picker", () => {
    const values = buildModelPickerRows(reg).map((r) => r.value)
    for (const id of CODEX_IDS) expect(values).not.toContain(id)
    expect(buildModelPickerRows(reg, 'claude').map((r) => r.value)).toEqual(values)
  })

  it('places the codex family with Codex and every other family with Claude', () => {
    expect(familyProvider('codex')).toBe('codex')
    for (const f of ['opus', 'sonnet', 'haiku', 'fable', 'gpt', undefined, null]) expect(familyProvider(f)).toBe('claude')
  })

  it('a registry overlay cannot move a Codex model into the Claude picker by redefining the codex family', () => {
    const merged = mergeRegistry(reg, { families: { codex: { label: 'codex', color: '#fff' } } })
    expect(buildModelPickerRows(merged).map((r) => r.value)).not.toContain('gpt-5.5')
    expect(buildModelPickerRows(merged, 'codex').map((r) => r.value)).toEqual(CODEX_IDS)
  })

  it('a Codex model added by an overlay reaches the Codex picker with no code change', () => {
    const added: OverlayModelEntry = {
      id: 'gpt-6-nova', patterns: [], family: 'codex', label: 'GPT-6-Nova', efforts: ['low', 'medium'],
      provenance: { addedBy: 'user', date: '2026-09-29' },
    }
    const merged = mergeRegistry(reg, { models: [added] })
    expect(buildModelPickerRows(merged, 'codex').map((r) => r.value)).toContain('gpt-6-nova')
    expect(buildModelPickerRows(merged).map((r) => r.value)).not.toContain('gpt-6-nova')
  })

  // P3.8 round 1 (R1): the Codex picker offers only ids a launch takes, and
  // which provider a shipped model belongs to is the code's, not an overlay's.
  it('never offers a Codex id the launch would refuse', () => {
    const bad = ['gpt 7', '-c', 'g'.repeat(65), 'gpt-7\r\n', 'gpt-7\u202etxt', 'a/../../x ']
    const merged = mergeRegistry(reg, { models: bad.map((id) => ({ id, patterns: [], family: 'codex', label: id, provenance: { addedBy: 'user' as const, date: '2026-09-29' } })) })
    const offered = buildModelPickerRows(merged, 'codex').map((r) => r.value)
    for (const id of bad) expect(offered, JSON.stringify(id)).not.toContain(id)
    expect(offered).toEqual(CODEX_IDS)
    expect(isCodexModelId('gpt-5.5')).toBe(true)
    for (const id of bad) expect(isCodexModelId(id), JSON.stringify(id)).toBe(false)
  })

  it('an overlay cannot move a shipped Codex model into a Claude family, nor a shipped Claude model into the codex family', () => {
    const prov = { addedBy: 'user' as const, date: '2026-09-29' }
    const toClaude = mergeRegistry(reg, { models: [{ id: 'gpt-5.5', patterns: [], family: 'opus', label: 'GPT-5.5', provenance: prov }] })
    expect(buildModelPickerRows(toClaude).map((r) => r.value)).not.toContain('gpt-5.5')
    expect(buildModelPickerRows(toClaude, 'codex').map((r) => r.value)).toContain('gpt-5.5')
    const opus = reg.models.find((m) => m.id === 'claude-opus-5')!
    const toCodex = mergeRegistry(reg, { models: [{ ...opus, family: 'codex', provenance: prov }] })
    expect(buildModelPickerRows(toCodex).map((r) => r.value)).toEqual(buildModelPickerRows(reg).map((r) => r.value))
    expect(buildModelPickerRows(toCodex, 'codex').map((r) => r.value)).toEqual(CODEX_IDS)
    // The same provider is still the overlay's to change (a Sentinel or user edit of a shipped model).
    const relabelled = mergeRegistry(reg, { models: [{ id: 'gpt-5.5', patterns: [], family: 'codex', label: 'GPT-5.5 (edited)', provenance: prov }] })
    expect(buildModelPickerRows(relabelled, 'codex').find((r) => r.value === 'gpt-5.5')!.label).toBe('GPT-5.5 (edited)')
  })

  it('covers the shipped Codex catalogue snapshot exactly', () => {
    const r = evaluateCodexModelCoverage(reg, catalogue)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.extra).toEqual([])
    expect(catalogue.models.map((m) => m.id)).toEqual(CODEX_IDS)
  })
})

describe('Codex effort levels per model (row 40)', () => {
  it("offers Codex's own levels, not Claude's", () => {
    expect(effortLevelsFor(reg, 'codex').map((l) => l.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(effortLevelsFor(reg, 'claude').map((l) => l.value)).toEqual(reg.effortLevels.map((l) => l.value))
  })

  it("a registry with no Codex levels offers Codex none, never Claude's", () => {
    const bare = { ...reg, providerEffortLevels: undefined }
    expect(effortLevelsFor(bare, 'codex')).toEqual([])
    expect(buildEffortRows(bare, 'gpt-5.5', 'codex')).toEqual([])
  })

  it('marks the levels a model does not support, as the Codex CLI catalogue lists them', () => {
    const supported = (id: string) => buildEffortRows(reg, id, 'codex').filter((r) => r.supported).map((r) => r.value)
    expect(supported('gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(supported('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(supported('gpt-5.6-terra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(supported('gpt-5.6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(supported('gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(supported('gpt-5.2')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('keeps the list shape and enables every level for a model it cannot place (Claude rule)', () => {
    const rows = buildEffortRows(reg, 'gpt-9-unknown', 'codex')
    expect(rows.map((r) => r.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(rows.every((r) => r.supported)).toBe(true)
    expect(buildEffortRows(reg, '', 'codex').every((r) => r.supported)).toBe(true)
  })

  it("never gates one provider's levels by the other provider's model", () => {
    // A Codex model asked about with Claude's levels, and a Claude model with Codex's, is not this
    // provider's model: nothing is disabled on its account.
    expect(buildEffortRows(reg, 'gpt-5.5').every((r) => r.supported)).toBe(true)
    expect(buildEffortRows(reg, 'claude-opus-4-5', 'codex').every((r) => r.supported)).toBe(true)
  })

  it("leaves Claude's effort gating as it was", () => {
    const rows = buildEffortRows(reg, 'claude-opus-4-6')
    expect(rows.map((r) => r.value)).toEqual(reg.effortLevels.map((l) => l.value))
    expect(rows.filter((r) => r.supported).map((r) => r.value)).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('every Codex model lists only levels the Codex level list knows', () => {
    const known = new Set(effortLevelsFor(reg, 'codex').map((l) => l.value))
    for (const m of reg.models.filter((x) => x.family === 'codex' && x.pickable !== false)) {
      expect(m.efforts && m.efforts.length).toBeTruthy()
      for (const e of m.efforts!) expect(known.has(e)).toBe(true)
    }
  })
})
