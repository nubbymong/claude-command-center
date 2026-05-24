import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

describe('Codex MCP TOML injection (P5 sub-item #8)', () => {
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

  describe('injectConductorVisionInCodexConfig', () => {
    it('appends a managed conductor block when config.toml does not exist', async () => {
      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)

      const tomlPath = join(codexHome, 'config.toml')
      expect(existsSync(tomlPath)).toBe(true)
      const written = readFileSync(tomlPath, 'utf-8')
      expect(written).toContain('[mcp_servers.conductor]')
      expect(written).toContain('url = "http://localhost:19333/mcp?source=codex"')
      expect(written).toContain('enabled = true')
      expect(written).toContain('# Managed by Claude Command Center')
    })

    it('appends to an existing config.toml without disturbing user content', async () => {
      const tomlPath = join(codexHome, 'config.toml')
      const userContent = '[mcp_servers.my-tool]\ncommand = "node"\nargs = ["a.js"]\n'
      writeFileSync(tomlPath, userContent, 'utf-8')

      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)

      const written = readFileSync(tomlPath, 'utf-8')
      // User content preserved
      expect(written).toContain('[mcp_servers.my-tool]')
      expect(written).toContain('command = "node"')
      // Our entry appended
      expect(written).toContain('[mcp_servers.conductor]')
    })

    it('is idempotent -- a second call does not duplicate the entry', async () => {
      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)
      mod.injectConductorVisionInCodexConfig(19333)

      const written = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
      const occurrences = (written.match(/\[mcp_servers\.conductor\]/g) ?? []).length
      expect(occurrences).toBe(1)
    })

    it('respects CODEX_HOME env var (verified via the test scaffold itself)', async () => {
      // beforeEach sets CODEX_HOME to a mkdtempSync path; this test confirms
      // the inject targets that path by inspecting where the file landed.
      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)

      expect(existsSync(join(codexHome, 'config.toml'))).toBe(true)
    })

    it('skips when CODEX_HOME directory does not exist', async () => {
      // Point CODEX_HOME at a non-existent path; rmSync ensures it.
      rmSync(codexHome, { recursive: true, force: true })
      expect(existsSync(codexHome)).toBe(false)

      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)

      // Should NOT have created the directory or written the file.
      expect(existsSync(codexHome)).toBe(false)
    })

    it('uses the port argument (caller-controlled, not hardcoded)', async () => {
      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(20999)

      const written = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
      expect(written).toContain('url = "http://localhost:20999/mcp?source=codex"')
    })

    it('refreshes the URL when the port changes between calls (mirrors Claude JSON overwrite semantics)', async () => {
      const mod = await importFresh()
      // First inject on port 19333, then user changes vision config and
      // we re-inject on 20999. Claude's settings.json gets the new value
      // via JSON overwrite; Codex TOML must too -- otherwise sessions
      // would call the stale port.
      mod.injectConductorVisionInCodexConfig(19333)
      mod.injectConductorVisionInCodexConfig(20999)

      const written = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
      expect(written).toContain('url = "http://localhost:20999/mcp?source=codex"')
      expect(written).not.toContain('url = "http://localhost:19333/mcp?source=codex"')
      const occurrences = (written.match(/\[mcp_servers\.conductor\]/g) ?? []).length
      expect(occurrences).toBe(1)
    })

    // P7.7.5 migration regression: re-injection must strip any legacy
    // [mcp_servers.conductor-vision] block left behind by a pre-rename CCC.
    it('strips a legacy conductor-vision block when injecting (P7.7.5 migration)', async () => {
      const tomlPath = join(codexHome, 'config.toml')
      const before = [
        '# Managed by Claude Command Center -- do not edit directly.',
        '[mcp_servers.conductor-vision]',
        'url = "http://localhost:19333/sse"',
        'enabled = true',
        '',
      ].join('\n')
      writeFileSync(tomlPath, before, 'utf-8')

      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19433)

      const after = readFileSync(tomlPath, 'utf-8')
      expect(after).not.toContain('[mcp_servers.conductor-vision]')
      expect(after).toContain('[mcp_servers.conductor]')
      expect(after).toContain('url = "http://localhost:19433/mcp?source=codex"')
    })
  })

  describe('removeConductorVisionFromCodexConfig', () => {
    it('strips the managed block but preserves surrounding user content', async () => {
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
      // Both surrounding sections survive intact.
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

      // Should NOT create an empty file.
      expect(existsSync(tomlPath)).toBe(false)
    })

    it('round-trips: inject then remove leaves the file empty (or close to it)', async () => {
      const mod = await importFresh()
      mod.injectConductorVisionInCodexConfig(19333)
      mod.removeConductorVisionFromCodexConfig()

      const after = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
      // After round-trip, only whitespace should remain (the inject path
      // adds a leading newline; the remove path collapses runs of blank
      // lines and trims leading newlines).
      expect(after.trim()).toBe('')
    })
  })
})
