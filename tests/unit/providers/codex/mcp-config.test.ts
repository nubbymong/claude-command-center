import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

// Module-under-test is imported lazily after CODEX_HOME is set in
// beforeEach so each test gets its own isolated dir. mkdtempSync hands us
// a unique path so concurrent tests do not collide.
let codexHome: string
async function importFresh() {
  vi.resetModules()
  return import('../../../../src/main/providers/codex/mcp-config')
}

// U6: CCC no longer WRITES conductor into the user's global ~/.codex/config.toml
// (Codex gets the conductor MCP per-spawn via `-c` overrides in buildCodexSpawn).
// removeConductorVisionFromCodexConfig is the boot + quit HEAL that strips any
// stale managed block a pre-U6 build left behind.
describe('removeConductorVisionFromCodexConfig (Codex config heal)', () => {
  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-mcp-'))
    process.env.CODEX_HOME = codexHome
  })

  afterEach(() => {
    delete process.env.CODEX_HOME
    try {
      rmSync(codexHome, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  it('strips the current managed conductor block, preserving user content', async () => {
    const tomlPath = join(codexHome, 'config.toml')
    const before = [
      '[mcp_servers.my-tool]',
      'command = "node"',
      '',
      '# Managed by Claude Command Center -- do not edit directly.',
      '[mcp_servers.conductor]',
      'url = "http://localhost:19333/mcp?source=codex&token=tok"',
      'enabled = true',
      '',
      '[mcp_servers.other-tool]',
      'command = "python"',
      '',
    ].join('\n')
    writeFileSync(tomlPath, before, 'utf-8')

    const mod = await importFresh()
    mod.removeConductorVisionFromCodexConfig()

    const after = readFileSync(tomlPath, 'utf-8')
    expect(after).not.toContain('[mcp_servers.conductor]')
    expect(after).not.toContain('Managed by Claude Command Center')
    expect(after).toContain('[mcp_servers.my-tool]')
    expect(after).toContain('[mcp_servers.other-tool]')
  })

  it('strips a legacy conductor-vision block, preserving surrounding user content', async () => {
    const tomlPath = join(codexHome, 'config.toml')
    const before = [
      '[mcp_servers.my-tool]',
      'command = "node"',
      'args = ["a.js"]',
      '',
      '# Managed by Claude Command Center -- do not edit directly.',
      '[mcp_servers.conductor-vision]',
      'url = "http://localhost:19333/sse"',
      'enabled = true',
      '',
      '[mcp_servers.other-tool]',
      'command = "python"',
      'args = ["b.py"]',
      '',
    ].join('\n')
    writeFileSync(tomlPath, before, 'utf-8')

    const mod = await importFresh()
    mod.removeConductorVisionFromCodexConfig()

    const after = readFileSync(tomlPath, 'utf-8')
    expect(after).not.toContain('[mcp_servers.conductor-vision]')
    expect(after).not.toContain('Managed by Claude Command Center')
    expect(after).toContain('[mcp_servers.my-tool]')
    expect(after).toContain('command = "node"')
    expect(after).toContain('[mcp_servers.other-tool]')
    expect(after).toContain('command = "python"')
  })

  it('is a no-op when the managed block is absent', async () => {
    const tomlPath = join(codexHome, 'config.toml')
    const userContent = '[mcp_servers.my-tool]\ncommand = "node"\n'
    writeFileSync(tomlPath, userContent, 'utf-8')

    const mod = await importFresh()
    mod.removeConductorVisionFromCodexConfig()

    const after = readFileSync(tomlPath, 'utf-8')
    expect(after).toBe(userContent)
  })

  it('is a no-op when config.toml does not exist', async () => {
    const tomlPath = join(codexHome, 'config.toml')
    expect(existsSync(tomlPath)).toBe(false)

    const mod = await importFresh()
    mod.removeConductorVisionFromCodexConfig()

    expect(existsSync(tomlPath)).toBe(false)
  })
})
