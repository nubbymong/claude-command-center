// WP1.38. Exact-head review, BLOCKER 1: a malformed authority manifest must reach the
// user as the "cannot start" dialog, not as a main process that died while its
// modules were loading.
//
// `index.ts` cannot be executed in a unit test (it boots the app), so this
// follows its REAL static import graph instead: every module `index.ts`
// imports that can reach the authority manifest is imported here, with the
// manifest corrupted, in the order `index.ts` names them -- which is what the
// main process does before `app.whenReady()`. Each import must SUCCEED. Then
// the guarded call, `composeProviders()`, must throw the manifest error, and
// `index.ts` must make that call inside the `try` whose `catch` shows the dialog
// and exits. The first two halves execute; the third is pinned by shape, as the
// rest of `index.ts`'s wiring is (window-ipc-registered-once.test.ts).
//
// The graph is computed, not listed, so a new static import that drags the
// manifest into module evaluation by another route is covered without an edit.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(__dirname, '..', '..')
const ENTRY = path.join(REPO, 'src', 'main', 'index.ts')
const MANIFEST_MODULE = path.join(REPO, 'src', 'main', 'providers', 'claude', 'authority-manifest.ts')
const MANIFEST_JSON = '../../src/main/providers/claude/claude-authority-manifest.json'

/** Local VALUE imports of a module (type-only imports are erased and never evaluate). */
function localImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m[1]) continue
    const spec = m[2] ?? m[3]
    if (!spec.startsWith('.')) continue
    const base = path.resolve(path.dirname(file), spec)
    const hit = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find((c) => existsSync(c) && statSync(c).isFile())
    if (hit) out.push(hit)
  }
  return out
}

/** index.ts's direct imports from which the manifest module is reachable, in source order. */
function entryImportsReachingManifest(): string[] {
  const graph = new Map<string, string[]>()
  const walk = (f: string) => {
    if (graph.has(f)) return
    graph.set(f, localImports(f))
    for (const d of graph.get(f)!) walk(d)
  }
  walk(ENTRY)
  const memo = new Map<string, boolean>()
  const reaches = (f: string, seen = new Set<string>()): boolean => {
    if (f === MANIFEST_MODULE) return true
    if (memo.has(f)) return memo.get(f)!
    if (seen.has(f)) return false
    seen.add(f)
    const r = (graph.get(f) ?? []).some((d) => reaches(d, seen))
    seen.delete(f)
    memo.set(f, r)
    return r
  }
  return [...new Set(graph.get(ENTRY)!)].filter((d) => reaches(d))
}

afterEach(() => {
  vi.doUnmock(MANIFEST_JSON)
  vi.resetModules()
})

describe('a malformed authority manifest is reported inside the startup boundary (exact-head review, BLOCKER 1)', () => {
  it('index.ts reaches the manifest through its static imports -- the premise of the defect', () => {
    const chain = entryImportsReachingManifest().map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    expect(chain, 'index.ts no longer imports anything that reaches the manifest; re-derive this test').not.toEqual([])
    expect(chain).toContain('src/main/providers/compose.ts')
  })

  it('every module index.ts imports on the way to the manifest LOADS with the manifest corrupted', async () => {
    vi.resetModules()
    vi.doMock(MANIFEST_JSON, () => ({ default: { schemaVersion: 2, provenance: {}, entries: [], digest: 'nope' } }))
    for (const file of entryImportsReachingManifest()) {
      await expect(import(/* @vite-ignore */ file), `importing ${path.relative(REPO, file)} threw while the main process was loading`).resolves.toBeDefined()
    }
  })

  it('...and the guarded call, composeProviders(), is where the manifest error surfaces', async () => {
    vi.resetModules()
    vi.doMock(MANIFEST_JSON, () => ({ default: { schemaVersion: 2, provenance: {}, entries: [], digest: 'nope' } }))
    const { composeProviders } = await import('../../src/main/providers/compose')
    expect(() => composeProviders()).toThrow(/Claude authority manifest is unusable/)
  })

  it('with the real manifest, composition succeeds and the Claude package carries the ambient list', async () => {
    vi.resetModules()
    const { composeProviders } = await import('../../src/main/providers/compose')
    const { tryGetProviderPackage } = await import('../../src/main/providers/core')
    composeProviders()
    const claude = tryGetProviderPackage('claude')
    expect(claude?.ambientAuthVariables).toContain('ANTHROPIC_API_KEY')
  })

  it('index.ts makes that call inside the try whose catch shows the dialog and exits', () => {
    const src = readFileSync(ENTRY, 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('      composeProviders()\n')
    expect(at, 'composeProviders() is no longer called at the startup boundary').toBeGreaterThan(0)
    const tryAt = src.lastIndexOf('try {', at)
    expect(src.slice(tryAt, at).trim(), 'composeProviders() is not the first statement of its try').toBe('try {')
    const catchBody = src.slice(at, src.indexOf('\n    }\n', at))
    expect(catchBody).toContain('} catch (err) {')
    expect(catchBody).toContain('dialog.showErrorBox(')
    expect(catchBody).toContain('app.exit(1)')
    // ...and composition happens once, there: a second, unguarded call would
    // reopen the defect by another door.
    expect(src.split('composeProviders()').length - 1).toBe(1)
  })
})
