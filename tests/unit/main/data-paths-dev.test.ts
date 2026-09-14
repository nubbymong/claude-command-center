import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'path'

// Test the REAL data-paths (the global setup mocks it); keep debug-logger mocked
// so logInfo() stays a no-op and the test never touches the real log dir.
vi.unmock('../../../src/main/data-paths')
vi.unmock('../../../src/main/ipc/setup-handlers')

// The DEV data-dir override isolates a dev instance (npm run dev / ccc) from a
// live prod install. Because getDataDirectory() caches on first call, each case
// resets modules and re-imports with the env pre-set.
describe('data-paths DEV isolation (CCC_DEV_DATA_DIR)', () => {
  const OLD = process.env.CCC_DEV_DATA_DIR

  afterEach(() => {
    if (OLD === undefined) delete process.env.CCC_DEV_DATA_DIR
    else process.env.CCC_DEV_DATA_DIR = OLD
    vi.resetModules()
  })

  it('overrides the data dir, marks it configured (skips wizard), and roots resources under it', async () => {
    const devDir = process.platform === 'win32' ? 'C:\\tmp\\ccc-dev-test' : '/tmp/ccc-dev-test'
    process.env.CCC_DEV_DATA_DIR = devDir
    vi.resetModules()
    const mod = await import('../../../src/main/data-paths')

    expect(mod.getDataDirectory()).toBe(devDir)
    expect(mod.isDataDirFromRegistry()).toBe(true) // treated as configured
    expect(mod.getResourcesDirectory()).toBe(join(devDir, 'resources'))
  })

  it('E2E override takes precedence over the DEV override', async () => {
    const e2e = process.platform === 'win32' ? 'C:\\tmp\\ccc-e2e' : '/tmp/ccc-e2e'
    process.env.CCC_E2E_DATA_DIR = e2e
    process.env.CCC_DEV_DATA_DIR = process.platform === 'win32' ? 'C:\\tmp\\ccc-dev' : '/tmp/ccc-dev'
    vi.resetModules()
    const mod = await import('../../../src/main/data-paths')
    expect(mod.getDataDirectory()).toBe(e2e)
    delete process.env.CCC_E2E_DATA_DIR
  })
})
