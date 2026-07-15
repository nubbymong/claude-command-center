import { describe, it, expect } from 'vitest'
import { migrateTypography } from '../../src/renderer/stores/migrateTypography'

describe('migrateTypography', () => {
  it('seeds defaults when nothing present', () => {
    const t = migrateTypography({})
    expect(t.globalScale).toBe(1)
    expect(t.globalFontFamily).toBe('inter')
    expect(t.regions.status).toEqual({})
    expect(t.regions.panels).toEqual({})
  })

  it('maps legacy statusLine.fontSize 14 -> status scale ~1.17', () => {
    const t = migrateTypography({ statusLine: { fontSize: 14, font: 'sans' } as never })
    expect(t.regions.status.scale).toBeCloseTo(14 / 12, 2)
  })

  it('leaves status scale unset for the default 12', () => {
    const t = migrateTypography({ statusLine: { fontSize: 12, font: 'sans' } as never })
    expect(t.regions.status.scale).toBeUndefined()
  })

  it('clamps an extreme legacy size into the region range', () => {
    const t = migrateTypography({ statusLine: { fontSize: 40, font: 'sans' } as never })
    expect(t.regions.status.scale).toBe(1.2)
  })

  it('maps a legacy mono font to the status family', () => {
    const t = migrateTypography({ statusLine: { fontSize: 12, font: 'mono' } as never })
    expect(t.regions.status.fontFamily).toBe('mono')
  })

  it('existing typography wins over legacy migration', () => {
    const t = migrateTypography({
      typography: { globalScale: 1.2, globalFontFamily: 'serif', regions: { status: {}, sidebar: {}, header: {}, panels: {} } },
      statusLine: { fontSize: 16, font: 'mono' } as never,
    })
    expect(t.globalScale).toBe(1.2)
    expect(t.globalFontFamily).toBe('serif')
    expect(t.regions.status.scale).toBeUndefined()
  })

  it('does not share references with an existing regions object', () => {
    const src = { globalScale: 1, globalFontFamily: 'inter' as const, regions: { status: { scale: 1.1 }, sidebar: {}, header: {}, panels: {} } }
    const t = migrateTypography({ typography: src })
    t.regions.status.scale = 0.9
    expect(src.regions.status.scale).toBe(1.1)
  })
})
