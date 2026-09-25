/**
 * The live SSH matrix (tests/live/statusline-harness.ts) keeps the debug logger
 * off the machine's real app data by setting CCC_E2E_DATA_DIR before it loads
 * any src/main module. Before that, it mocked the config and resources
 * directories but not the data directory, so every live run appended to the
 * real `AI Code Conductor/debug/app.log` (seen on the VM run at a7419119).
 *
 * The harness itself cannot run here (it drives real ssh against real hosts),
 * so this pins the mechanism it relies on, with the REAL debug logger and the
 * REAL data-paths: with the variable set, app.log resolves under it and the
 * registry is never read; without it, the logger goes to the installed app's
 * data folder, which is what the harness used to do. No file is written and no
 * process is spawned: fs and the registry are stubbed and only record.
 *
 * The mechanism alone does not prove the harness USES it, so the last block
 * reads the two live files that drive the real pty-manager as text and pins
 * the ordering the isolation depends on: the variable is assigned before the
 * first dynamic import of a `../../src/` module, and nothing from `src/` is
 * imported statically (a static import would load before the assignment).
 * Mutation to prove it can fail: delete the `process.env.CCC_E2E_DATA_DIR =
 * dataDir` line from either file, or move it below the dynamic imports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { join, resolve } from 'path'

vi.unmock('../../../src/main/debug-logger')

const h = vi.hoisted(() => ({ opened: [] as string[], registryReads: [] as string[] }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: () => true,
    mkdirSync: vi.fn(),
    statSync: () => ({ size: 0 }),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: (p: unknown) => { h.opened.push(String(p)); return 1 },
    createWriteStream: () => ({ write: () => true, end: vi.fn(), on: vi.fn(), destroyed: false }),
  }
})
vi.mock('../../../src/main/registry', () => ({
  readRegistry: (name: string) => { h.registryReads.push(name); return null },
  writeRegistry: vi.fn(),
  migrateRegistryKeys: vi.fn(),
}))

const E2E_DIR = join(process.platform === 'win32' ? 'C:\\ccc-live-data-test' : '/ccc-live-data-test', 'run-1')
const OLD_E2E = process.env.CCC_E2E_DATA_DIR
const OLD_DEV = process.env.CCC_DEV_DATA_DIR

afterEach(() => {
  if (OLD_E2E === undefined) delete process.env.CCC_E2E_DATA_DIR
  else process.env.CCC_E2E_DATA_DIR = OLD_E2E
  if (OLD_DEV === undefined) delete process.env.CCC_DEV_DATA_DIR
  else process.env.CCC_DEV_DATA_DIR = OLD_DEV
  h.opened.length = 0
  h.registryReads.length = 0
  vi.resetModules()
})

async function logOneLine(): Promise<void> {
  vi.resetModules()
  const { logInfo, closeDebugLogger } = await import('../../../src/main/debug-logger')
  logInfo('[live-harness-test] one line')
  closeDebugLogger()
}

describe('the live harness data-dir isolation (CCC_E2E_DATA_DIR)', () => {
  it('with the variable set, the real logger opens app.log under it and never reads the registry', async () => {
    delete process.env.CCC_DEV_DATA_DIR
    process.env.CCC_E2E_DATA_DIR = E2E_DIR
    await logOneLine()
    // getDataDirectory logs its own choice, so the first write opens the file
    // from inside that nested call too: every open, however many, is this path.
    expect(h.opened.length).toBeGreaterThan(0)
    for (const p of h.opened) expect(p).toBe(join(E2E_DIR, 'debug', 'app.log'))
    expect(h.registryReads).toEqual([])
  })

  it('without it, the logger resolves the installed app`s data folder (the pre-fix harness behaviour)', async () => {
    delete process.env.CCC_DEV_DATA_DIR
    delete process.env.CCC_E2E_DATA_DIR
    await logOneLine()
    expect(h.registryReads).toContain('DataDirectory')
    expect(h.opened.length).toBeGreaterThan(0)
    for (const p of h.opened) {
      expect(p.startsWith(E2E_DIR)).toBe(false)
      expect(p.endsWith(join('debug', 'app.log'))).toBe(true)
    }
  })
})

/** Module specifiers of the file's static `import` statements (type-only
 *  imports excluded: they are erased and load nothing). */
function staticImports(src: string): string[] {
  const out: string[] = []
  const re = /^import\s+(type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/gm
  for (const m of src.matchAll(re)) if (!m[1]) out.push(m[2])
  return out
}

describe('the live files set CCC_E2E_DATA_DIR before loading any src module', () => {
  const ROOT = resolve(__dirname, '..', '..', '..')
  const ASSIGN_RE = /^process\.env\.CCC_E2E_DATA_DIR = dataDir\s*$/m
  const FRESH_DIR_RE = /^const dataDir = mkdtempSync\(/m
  const FIRST_SRC_LOAD_RE = /\bawait import\(\s*['"]\.\.\/\.\.\/src\//
  // ANY quoted `../../src/` specifier, in any quote style, whatever loads it:
  // a static import, `export * from`, `await import(...)` with a string or a
  // template literal, `vi.importActual`, a vi.mock target. None may come before
  // the assignment (the vi.mock lines already sit after it; vitest hoists the
  // call, but its factory only runs when a later import loads the module).
  const ANY_SRC_SPECIFIER_RE = /['"`]\.\.\/\.\.\/src\//

  for (const file of ['tests/live/statusline-harness.ts', 'tests/live/ssh-multisession-repro.live.ts']) {
    it(file, async () => {
      const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
      const src = readFileSync(join(ROOT, file), 'utf8')
      const imports = staticImports(src)
      // The parser really read the import block (a vacuous pass is not a pass).
      expect(imports).toContain('vitest')
      expect(imports.filter((s) => s.includes('/src/'))).toEqual([])
      const fresh = src.search(FRESH_DIR_RE)
      const assign = src.search(ASSIGN_RE)
      const firstLoad = src.search(FIRST_SRC_LOAD_RE)
      const firstSpecifier = src.search(ANY_SRC_SPECIFIER_RE)
      expect(fresh, 'a per-run mkdtemp data dir').toBeGreaterThanOrEqual(0)
      expect(assign, 'the CCC_E2E_DATA_DIR assignment').toBeGreaterThan(fresh)
      expect(firstLoad, 'a dynamic import of src').toBeGreaterThan(0)
      expect(assign, 'assigned before the first src module loads').toBeLessThan(firstLoad)
      expect(firstSpecifier, 'a src specifier exists').toBeGreaterThan(0)
      expect(assign, 'assigned before ANY src specifier appears').toBeLessThan(firstSpecifier)
    })
  }
})
