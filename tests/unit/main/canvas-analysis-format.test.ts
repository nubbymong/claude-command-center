// The analysis chunk must be a real ES module.
//
// This exists because it wasn't. The chunk was bundled as an IIFE while the
// bridge consumed it with a dynamic import(), so `ensureAnalysis()` threw on
// every snapshot: axe-core never ran, all eleven advertised rules silently never
// evaluated, and 600 KB shipped dead. Nothing failed — the degradation path was
// the only path, and the "graceful degradation" test asserted it happily.
//
// So this guard does not test the loader. It evaluates the ACTUAL SERVED STRING
// as a module and demands the API the loader expects.

import { describe, it, expect } from 'vitest'
import analysisSource from 'virtual:canvas-analysis'
import bridgeSource from 'virtual:canvas-bridge'

async function importSource(source: string): Promise<Record<string, unknown>> {
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
  return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>
}

describe('the served analysis chunk', () => {
  it('is an ES module exposing exactly the API analysis-loader reads', async () => {
    const mod = await importSource(analysisSource)
    expect(typeof mod.run).toBe('function')
    expect(typeof mod.getRole).toBe('function')
    expect(typeof mod.version).toBe('string')
  })

  it('carries a real axe-core, not a stub', async () => {
    const mod = await importSource(analysisSource)
    expect(String(mod.version)).toMatch(/^\d+\.\d+\.\d+/)
    expect(analysisSource.length).toBeGreaterThan(100_000)
  })

  it('keeps axe out of the always-injected bridge', () => {
    // The split is the whole reason the bridge can ride in every document.
    expect(bridgeSource.length * 4).toBeLessThan(analysisSource.length)
    expect(bridgeSource).toContain('__cccCanvasBridge')
  })

  it('the bridge imports the chunk by URL at runtime rather than inlining it', () => {
    expect(bridgeSource).toContain('/__ccc__/canvas-analysis.js')
    expect(bridgeSource).toMatch(/import\(/)
  })
})
