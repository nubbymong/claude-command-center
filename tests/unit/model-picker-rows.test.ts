import { describe, it, expect, vi } from 'vitest'
import {
  buildModelPickerRows,
  groupPickerRows,
  buildEffortRows,
  familyDisplayLabel,
  resolvePickedModelId,
  resolveModelInfo,
  mergeRegistry,
  ALIAS_GROUP_LABEL,
  type ModelRegistry,
  type OverlayModelEntry,
} from '../../src/shared/model-registry'
import { shortModelName, isModelActive, isWritablePickerValue } from '../../src/renderer/lib/claude-cli-options'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry

describe('buildModelPickerRows (#385)', () => {
  it('puts every alias row first, in dropdown order', () => {
    const rows = buildModelPickerRows(reg)
    const aliases = rows.filter((r) => r.kind === 'alias')
    expect(aliases.map((r) => r.value)).toEqual(reg.dropdown.map((d) => d.value))
    expect(rows.slice(0, aliases.length).every((r) => r.kind === 'alias')).toBe(true)
    expect(aliases.every((r) => r.group === ALIAS_GROUP_LABEL)).toBe(true)
  })

  it('derives a pinned row for every launchable model', () => {
    const pinned = buildModelPickerRows(reg).filter((r) => r.kind === 'pinned')
    const launchable = reg.models.filter((m) => m.pickable !== false)
    expect(pinned.map((r) => r.value).sort()).toEqual(launchable.map((m) => m.id).sort())
    expect(pinned.find((r) => r.value === 'claude-opus-4-6')!.label).toBe('Opus 4.6')
  })

  it('skips entries that are matchers rather than launchable models', () => {
    expect(buildModelPickerRows(reg).some((r) => r.value === 'codex-family')).toBe(false)
  })

  it('groups pins under their family, ordered by the alias rows', () => {
    const groups = groupPickerRows(buildModelPickerRows(reg))
    expect(groups.map((g) => g.title)).toEqual(['Latest', 'Opus', 'Fable', 'Sonnet', 'Haiku'])
    expect(groups[1].rows.every((r) => r.family === 'opus')).toBe(true)
  })

  it('never offers the same value twice', () => {
    const values = buildModelPickerRows(reg).map((r) => r.value)
    expect(new Set(values).size).toBe(values.length)
  })

  // The acceptance criterion from the issue.
  it('a Sentinel-added overlay model appears with NO code change', () => {
    const proposed: OverlayModelEntry = {
      id: 'claude-opus-6', patterns: ['opus-6'], family: 'opus', label: 'Opus 6',
      provenance: { addedBy: 'sentinel', date: '2026-09-01' },
    }
    const merged = mergeRegistry(reg, { models: [proposed] })
    const rows = buildModelPickerRows(merged)
    const row = rows.find((r) => r.value === 'claude-opus-6')
    expect(row).toBeTruthy()
    expect(row!.label).toBe('Opus 6')
    expect(row!.group).toBe('Opus')
    expect(row!.kind).toBe('pinned')
  })

  it('a user-added model in a brand-new family still gets a group', () => {
    const merged = mergeRegistry(reg, {
      models: [{
        id: 'claude-nova-1', patterns: ['nova'], family: 'nova', label: 'Nova 1',
        provenance: { addedBy: 'user', date: '2026-09-01' },
      }],
    })
    const row = buildModelPickerRows(merged).find((r) => r.value === 'claude-nova-1')
    expect(row!.group).toBe('Nova')       // falls back to the family key, capitalised
  })

  // Q3: registry-overlay.json is hand-editable and only validated on APPLY, so
  // a malformed entry reaches the pickers intact.
  it('skips a malformed overlay entry instead of crashing both pickers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      ...reg,
      models: [
        ...reg.models,
        { id: 'claude-broken-1', patterns: ['b'], label: 'Broken' } as unknown as ModelRegistry['models'][number],
        { patterns: ['c'], family: 'opus', label: 'No id' } as unknown as ModelRegistry['models'][number],
        { id: '', patterns: ['d'], family: 'opus', label: 'Empty id' } as ModelRegistry['models'][number],
      ],
    }
    expect(() => buildModelPickerRows(broken)).not.toThrow()
    const rows = buildModelPickerRows(broken)
    expect(rows.some((r) => r.value === 'claude-broken-1')).toBe(false)
    // The healthy entries are unaffected.
    expect(rows.some((r) => r.value === 'claude-opus-4-6')).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('survives a registry with no dropdown and no models', () => {
    const empty = { models: [], families: {}, effortLevels: [], dropdown: [] } as ModelRegistry
    expect(buildModelPickerRows(empty)).toEqual([])
    expect(groupPickerRows([])).toEqual([])
  })

  it('familyDisplayLabel capitalises, and falls back to the key', () => {
    expect(familyDisplayLabel(reg, 'opus')).toBe('Opus')
    expect(familyDisplayLabel(reg, 'nope')).toBe('Nope')
  })
})

describe('buildEffortRows (#385)', () => {
  it('marks unsupported levels for a version-faithful match', () => {
    const rows = buildEffortRows(reg, 'claude-haiku-4-5')
    expect(rows.map((r) => r.value)).toEqual(reg.effortLevels.map((e) => e.value))
    expect(rows.filter((r) => r.supported).map((r) => r.value)).toEqual(['low', 'medium', 'high'])
  })

  it('trusts an alias match (aliases name an exact entry)', () => {
    expect(buildEffortRows(reg, 'haiku').filter((r) => r.supported)).toHaveLength(3)
  })

  it('does NOT trust a fuzzy pattern match — it would claim another version\'s efforts', () => {
    // "Opus 4.6" is a statusline display name; it pattern-matches the newest
    // Opus entry, so its effort list must not be applied.
    expect(buildEffortRows(reg, 'Opus 4.6').every((r) => r.supported)).toBe(true)
  })

  it('enables everything for an unknown model or a model with no effort list', () => {
    expect(buildEffortRows(reg, 'who-knows').every((r) => r.supported)).toBe(true)
    expect(buildEffortRows(reg, 'claude-opus-5').every((r) => r.supported)).toBe(true)
    expect(buildEffortRows(reg, undefined).every((r) => r.supported)).toBe(true)
  })
})

describe('shortModelName with a registry (footer pill shows the pinned name)', () => {
  it('uses the curated label for a version-faithful match', () => {
    expect(shortModelName('claude-opus-4-6', reg)).toBe('Opus 4.6')
    // The regex alone flattens this to "Opus 4.8" and loses the variant.
    expect(shortModelName('claude-opus-4-8-fast', reg)).toBe('Opus 4.8 Fast')
    expect(shortModelName('opus', reg)).toBe('Opus 5')
  })

  it('never uses a fuzzy pattern label (it would claim the wrong version)', () => {
    expect(shortModelName('Opus 4.6', reg)).toBe('Opus 4.6')
    expect(shortModelName('foo-opus-bar', reg)).toBe('Opus')
  })

  it('behaves exactly as before when no registry is passed', () => {
    expect(shortModelName('claude-opus-4-6')).toBe('Opus 4.6')
    expect(shortModelName('Opus 4.7 (1M context)')).toBe('Opus 4.7 (1M context)')
    expect(shortModelName(undefined)).toBe('default')
  })
})

// Q2: the footer popover only gets the statusline display name, which can never
// match version-faithfully — without this the effort gating there is inert.
describe('resolvePickedModelId (#385)', () => {
  it('places a statusline display name on its exact entry', () => {
    expect(resolvePickedModelId(reg, 'Opus 4.6')).toBe('claude-opus-4-6')
    expect(resolvePickedModelId(reg, 'Opus 4.8 Fast')).toBe('claude-opus-4-8-fast')
    expect(resolvePickedModelId(reg, 'Opus 4.7 (1M context)')).toBe('claude-opus-4-7')
  })

  it('prefers the first reading that can be placed, and falls through', () => {
    // Statusline silent at spawn -> the id the session was launched with.
    expect(resolvePickedModelId(reg, undefined, 'claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(resolvePickedModelId(reg, 'Opus 4.5', 'claude-opus-4-6')).toBe('claude-opus-4-5')
    expect(resolvePickedModelId(reg, 'something else', 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  it('resolves aliases and exact ids too', () => {
    expect(resolvePickedModelId(reg, 'opus')).toBe('claude-opus-5')
    expect(resolvePickedModelId(reg, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('returns undefined when nothing can be placed, so gating stays permissive', () => {
    expect(resolvePickedModelId(reg, 'who knows')).toBeUndefined()
    expect(resolvePickedModelId(reg, undefined, null, '')).toBeUndefined()
    expect(buildEffortRows(reg, resolvePickedModelId(reg, 'who knows')).every((r) => r.supported)).toBe(true)
  })

  it('makes the footer effort gating actually bite', () => {
    // The regression this fixes: 'Opus 4.6' alone left every level enabled.
    const viaDisplayName = buildEffortRows(reg, 'Opus 4.6')
    expect(viaDisplayName.every((r) => r.supported)).toBe(true)
    const viaResolved = buildEffortRows(reg, resolvePickedModelId(reg, 'Opus 4.6'))
    expect(viaResolved.find((r) => r.value === 'xhigh')!.supported).toBe(false)
  })
})

// ADR-009 MAJOR-2 on #404. matchEntry's pattern step did `for (const p of
// m.patterns)`, and the Q3 guard that skips a malformed entry lives in
// buildModelPickerRows, NOT in the matcher. So an entry with no `patterns` —
// including a legitimately ALIAS-ONLY one — threw `TypeError: m.patterns is not
// iterable` out of both buildModelPickerRows AND resolvePickedModelId. The
// second one is the damaging path: SessionStatusStrip calls it on EVERY render
// with the statusline-supplied model name, so one such entry, or one model name
// the registry could not place, took the whole footer strip down.
describe('an entry with no patterns never crashes a render (#404 MAJOR-2)', () => {
  /** The shape a user may reasonably hand-write into registry-overlay.json. */
  const aliasOnly = {
    id: 'claude-opus-9', family: 'opus', label: 'Opus 9', aliases: ['opus9'],
    provenance: { addedBy: 'user' as const, date: '2026-09-01' },
  } as unknown as OverlayModelEntry
  const bare = {
    id: 'claude-opus-8', family: 'opus', label: 'Opus 8',
    provenance: { addedBy: 'user' as const, date: '2026-09-01' },
  } as unknown as OverlayModelEntry

  const merged = mergeRegistry(reg, { models: [aliasOnly, bare] })

  it('(a) buildModelPickerRows does not crash, and still offers the entry', () => {
    expect(() => buildModelPickerRows(merged)).not.toThrow()
    const rows = buildModelPickerRows(merged)
    expect(rows.find((r) => r.value === 'claude-opus-8')!.label).toBe('Opus 8')
    expect(rows.find((r) => r.value === 'claude-opus-9')!.group).toBe('Opus')

    // buildModelPickerRows reaches the matcher via its family-ordering pass
    // (resolveModelInfo on every ALIAS row). With the shipped `dropdown` every
    // alias resolves by id/alias/prefix and never reaches the pattern step, so
    // an alias row that CANNOT be placed is what exposes the same throw here.
    const withGhostAlias = {
      ...merged,
      dropdown: [...merged.dropdown, { value: 'ghost-alias', label: 'Ghost' }],
    }
    expect(() => buildModelPickerRows(withGhostAlias)).not.toThrow()
    expect(buildModelPickerRows(withGhostAlias).some((r) => r.value === 'ghost-alias')).toBe(true)
  })

  it('(b) resolvePickedModelId falls back safely instead of throwing', () => {
    // An unplaceable statusline reading walks the matcher all the way to the
    // pattern step, which is where the throw was.
    expect(() => resolvePickedModelId(merged, 'some unplaceable name')).not.toThrow()
    expect(resolvePickedModelId(merged, 'some unplaceable name')).toBeUndefined()
    expect(resolvePickedModelId(merged, 'Sonnet 9000', 'not-a-model-at-all')).toBeUndefined()
  })

  it('(c) buildEffortRows falls back to "all supported" instead of throwing', () => {
    expect(() => buildEffortRows(merged, 'some unplaceable name')).not.toThrow()
    expect(buildEffortRows(merged, 'some unplaceable name').every((r) => r.supported)).toBe(true)
    expect(buildEffortRows(merged, resolvePickedModelId(merged, 'nope')).every((r) => r.supported)).toBe(true)
  })

  it('keeps a legitimately alias-only entry reachable by id, alias and prefix', () => {
    // This is why the fix is in the matcher rather than "drop entries with no
    // patterns at load": dropping them would make these three lookups fail.
    expect(resolvePickedModelId(merged, 'claude-opus-9')).toBe('claude-opus-9')
    expect(resolvePickedModelId(merged, 'opus9')).toBe('claude-opus-9')
    expect(resolvePickedModelId(merged, 'claude-opus-9-20260901')).toBe('claude-opus-9')
    expect(resolvePickedModelId(merged, 'Opus 8')).toBe('claude-opus-8')
  })

  it('leaves every healthy entry matching exactly as before', () => {
    expect(resolvePickedModelId(merged, 'Opus 4.6')).toBe('claude-opus-4-6')
    expect(resolveModelInfo(merged, 'claude-opus-4-6').matchKind).toBe('exact')
    // A pattern hit on a healthy entry still works with a patternless one present.
    expect(resolveModelInfo(merged, 'some opus build').matchKind).toBe('pattern')
  })

  it('survives every other shape a hand-edited overlay can produce', () => {
    const junk = {
      ...reg,
      models: [
        null,
        undefined,
        { id: 'claude-junk-1', family: 'opus', label: 'J1', patterns: 'not-an-array' },
        { id: 'claude-junk-2', family: 'opus', label: 'J2', patterns: [null, 42, ''] },
        { id: 'claude-junk-3', family: 'opus', label: 'J3', aliases: 'junk' },
        { id: 42, family: 'opus', label: 'J4', patterns: ['j4'] },
        ...reg.models,
      ],
    } as unknown as ModelRegistry
    expect(() => buildModelPickerRows(junk)).not.toThrow()
    expect(() => resolvePickedModelId(junk, 'some unplaceable name')).not.toThrow()
    expect(() => buildEffortRows(junk, 'some unplaceable name')).not.toThrow()
    expect(() => resolveModelInfo(junk, 'some unplaceable name')).not.toThrow()
    expect(resolvePickedModelId(junk, 'some unplaceable name')).toBeUndefined()
    // `aliases: 'junk'` must not substring-match via String.prototype.includes.
    expect(resolvePickedModelId(junk, 'jun')).toBeUndefined()
    // Healthy entries still resolve.
    expect(resolvePickedModelId(junk, 'claude-opus-4-6')).toBe('claude-opus-4-6')
  })
})

// ADR-009 MINOR on #404. SessionStatusStrip writes a picker row's value into a
// LIVE PTY as a slash-command LINE (`/model <v>\n`) with no schema in front of
// it, and the pinned rows are derived from a hand-editable registry overlay.
describe('isWritablePickerValue — the charset the PTY boundary enforces (#404)', () => {
  it('accepts every value the pickers actually offer', () => {
    for (const row of buildModelPickerRows(reg)) {
      expect(isWritablePickerValue(row.value), `row ${row.value}`).toBe(true)
    }
    for (const level of reg.effortLevels) {
      expect(isWritablePickerValue(level.value), `effort ${level.value}`).toBe(true)
    }
    expect(isWritablePickerValue('opus[1m]')).toBe(true)
  })

  it('rejects a value that would inject a second line into the PTY', () => {
    expect(isWritablePickerValue('claude-opus-5\n/exit')).toBe(false)
    expect(isWritablePickerValue('claude-opus-5\r/exit')).toBe(false)
    expect(isWritablePickerValue('claude-opus-5 && rm -rf /')).toBe(false)
    expect(isWritablePickerValue('claude-opus-5;whoami')).toBe(false)
    expect(isWritablePickerValue('')).toBe(false)
    expect(isWritablePickerValue('x'.repeat(65))).toBe(false)
    expect(isWritablePickerValue(undefined)).toBe(false)
    expect(isWritablePickerValue(42)).toBe(false)
  })

  it('an overlay-injected id reaches the picker but is not writable', () => {
    const merged = mergeRegistry(reg, {
      models: [{
        id: 'claude-opus-9\n/exit', patterns: ['x'], family: 'opus', label: 'Evil',
        provenance: { addedBy: 'user', date: '2026-09-01' },
      } as OverlayModelEntry],
    })
    const row = buildModelPickerRows(merged).find((r) => r.label === 'Evil')
    expect(row).toBeTruthy()                        // the picker still lists it
    expect(isWritablePickerValue(row!.value)).toBe(false)  // the write path refuses it
  })
})

describe('isModelActive with pinned rows (#385)', () => {
  it('ticks the pinned row that is actually running', () => {
    expect(isModelActive('claude-opus-4-6', 'Opus 4.6', reg)).toBe(true)
    expect(isModelActive('claude-opus-4-8', 'Opus 4.6', reg)).toBe(false)
  })

  it('does not tick the family alias when a different version is pinned', () => {
    // 'opus' means the newest Opus (5); a running 4.6 is not that.
    expect(isModelActive('opus', 'Opus 4.6', reg)).toBe(false)
    expect(isModelActive('opus', 'Opus 5', reg)).toBe(true)
  })

  it('still separates the 1M variant from the 200k one', () => {
    expect(isModelActive('opus[1m]', 'Opus 5 (1M context)', reg)).toBe(true)
    expect(isModelActive('opus', 'Opus 5 (1M context)', reg)).toBe(false)
    expect(isModelActive('opus[1m]', 'Opus 5', reg)).toBe(false)
  })

  it('a bare family reading only ticks the alias row', () => {
    expect(isModelActive('opus', 'Opus', reg)).toBe(true)
    expect(isModelActive('claude-opus-4-6', 'Opus', reg)).toBe(false)
  })

  it('does not cross families', () => {
    expect(isModelActive('claude-sonnet-4-6', 'Opus 4.6', reg)).toBe(false)
    expect(isModelActive('haiku', 'Sonnet 4.6', reg)).toBe(false)
  })

  // Q6: "Opus 4.8 Fast" carries version 4.8 too, so a family+version comparison
  // ticked both Opus 4.8 and Opus 4.8 Fast — two different models.
  it('does not tick the plain variant when the Fast variant is running', () => {
    expect(isModelActive('claude-opus-4-8-fast', 'Opus 4.8 Fast', reg)).toBe(true)
    expect(isModelActive('claude-opus-4-8', 'Opus 4.8 Fast', reg)).toBe(false)
    expect(isModelActive('claude-opus-4-8-fast', 'Opus 4.8', reg)).toBe(false)
  })

  it('keeps the old family-level behaviour when no registry is passed', () => {
    expect(isModelActive('opus', 'Opus 4.8', undefined)).toBe(true)
    expect(isModelActive('sonnet', 'Sonnet 4.6')).toBe(true)
    expect(isModelActive('opus', '')).toBe(false)
  })
})
