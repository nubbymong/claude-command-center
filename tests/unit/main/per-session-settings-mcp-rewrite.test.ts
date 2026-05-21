/**
 * P7.2 regression: writeLocalSessionSettings must rewrite the
 * mcpServers.conductor-vision.url to point at this CCC instance's
 * actual MCP server port (not the value cloned from the global
 * ~/.claude/settings.json). Effect: sessions spawned by dev CCC reach
 * dev's MCP server (19433) even if the user's global settings.json
 * says 19333.
 *
 * Other mcpServers entries are preserved verbatim. Settings without
 * an mcpServers block are tolerated (no rewrite needed).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock getConductorMcpPort BEFORE importing the module under test so the
// rewrite path picks up the mocked port.
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19433,
}))

const { writeLocalSessionSettings } = await import('../../../src/main/hooks/per-session-settings')

describe('per-session-settings mcpServers URL rewrite (P7.2)', () => {
  let tmpHome: string
  let claudeDir: string
  let realHomedir: typeof os.homedir

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-mcp-rewrite-'))
    claudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    realHomedir = os.homedir
    ;(os as any).homedir = () => tmpHome
  })

  afterEach(() => {
    ;(os as any).homedir = realHomedir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('rewrites conductor-vision.url to the instance port', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        'conductor-vision': { url: 'http://localhost:19333/sse' },
      },
    }))
    const sesPath = writeLocalSessionSettings('sid-1')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written.mcpServers['conductor-vision'].url).toBe('http://localhost:19433/sse')
  })

  it('preserves other mcpServers entries verbatim', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        'conductor-vision': { url: 'http://localhost:19333/sse' },
        'other-server': { url: 'http://example.com/sse', extra: 'preserve-me' },
      },
    }))
    const sesPath = writeLocalSessionSettings('sid-2')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written.mcpServers['other-server']).toEqual({
      url: 'http://example.com/sse',
      extra: 'preserve-me',
    })
  })

  // P7.7.2: per-session settings are now self-contained -- create the
  // conductor-vision entry from scratch if global lacks it. Prevents
  // the dev-exit / prod-still-running stale-removeMcpSettings race.
  it('creates conductor-vision entry when global has no mcpServers block (P7.7.2)', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: [] },
    }))
    const sesPath = writeLocalSessionSettings('sid-3')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written.permissions).toEqual({ allow: [] })
    expect(written.mcpServers['conductor-vision'].url).toBe('http://localhost:19433/sse')
  })

  it('creates conductor-vision entry when settings.json is missing entirely (P7.7.2)', () => {
    const sesPath = writeLocalSessionSettings('sid-4')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written.mcpServers['conductor-vision'].url).toBe('http://localhost:19433/sse')
  })

  it('creates conductor-vision entry when mcpServers exists but lacks conductor-vision (P7.7.2)', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        'other-server': { url: 'http://example.com/sse' },
      },
    }))
    const sesPath = writeLocalSessionSettings('sid-5')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written.mcpServers['conductor-vision'].url).toBe('http://localhost:19433/sse')
    expect(written.mcpServers['other-server']).toEqual({ url: 'http://example.com/sse' })
  })
})
