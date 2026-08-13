import { describe, it, expect, beforeEach, vi } from 'vitest'

// A token that has been world-readable since the feature shipped stays burned
// after you chmod it — anything that could read it already has. So a fixed build
// must MINT A NEW ONE once, not re-permission the old one. The stored record
// carries a version marker; anything without it is discarded.

const h = vi.hoisted(() => ({
  stored: null as { secret?: string; v?: number } | null,
  saved: [] as Array<{ secret?: string; v?: number }>,
  warnings: [] as string[]
}))

vi.mock('../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'conductorSecret' ? h.stored : null),
  saveConfig: (key: string, value: any) => { if (key === 'conductorSecret') h.saved.push(value); return true }
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
  logWarn: (m: string) => { h.warnings.push(String(m)) }
}))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', registerSetupHandlers: () => {} }))
vi.mock('../../src/main/clipboard-file', () => ({ mimeForImage: () => 'image/png' }))
vi.mock('../../src/main/providers/codex/mcp-config', () => ({ removeConductorVisionFromCodexConfig: () => {} }))
vi.mock('../../src/main/vision-manager', () => ({ getGlobalManager: () => null, startGlobalVision: () => {}, launchBrowser: () => {} }))
vi.mock('../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../src/main/codex-review-mcp-tool', () => ({ registerCodexReviewTool: () => {} }))

const HEX64 = /^[0-9a-f]{64}$/
const LEGACY = 'a'.repeat(64)

async function freshSecret(): Promise<string> {
  vi.resetModules()
  const { getConductorMcpSecret } = await import('../../src/main/conductor-mcp-server')
  return getConductorMcpSecret()
}

beforeEach(() => {
  h.stored = null
  h.saved = []
  h.warnings = []
})

describe('the MCP auth secret rotates once, off any pre-fix build', () => {
  it('DISCARDS a stored secret with no version marker and mints a new one', async () => {
    // Exactly what a vulnerable build left behind: a valid-looking token, no `v`.
    h.stored = { secret: LEGACY }

    const got = await freshSecret()

    expect(got).not.toBe(LEGACY)
    expect(got).toMatch(HEX64)
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].v).toBe(2)
    // It must say so: a silent rotation looks identical to a bug when a live
    // session suddenly fails MCP auth.
    expect(h.warnings.join(' ')).toMatch(/rotating the auth secret/i)
  })

  it('KEEPS a secret already written by a fixed build', async () => {
    h.stored = { secret: LEGACY, v: 2 }

    const got = await freshSecret()

    expect(got).toBe(LEGACY)
    expect(h.saved).toHaveLength(0) // no churn, so live sessions keep working
    expect(h.warnings.join(' ')).not.toMatch(/rotating/i)
  })

  it('mints one when there is nothing stored at all', async () => {
    h.stored = null

    const got = await freshSecret()

    expect(got).toMatch(HEX64)
    expect(h.saved[0].v).toBe(2)
  })

  it('does not accept a malformed stored value just because it is versioned', async () => {
    h.stored = { secret: 'not-hex', v: 2 }

    const got = await freshSecret()

    expect(got).not.toBe('not-hex')
    expect(got).toMatch(HEX64)
  })
})
