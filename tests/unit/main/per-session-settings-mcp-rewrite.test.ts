/**
 * P7.7.3 regression: per-session MCP config writer.
 *
 * Claude CLI ignores mcpServers in --settings files; MCP server config must
 * come from --mcp-config <path> or ~/.claude.json. writeLocalSessionMcpConfig
 * writes the --mcp-config file with canonical schema (type: "sse").
 *
 * The companion writeLocalSessionSettings function no longer carries
 * mcpServers (it was dead code under --settings) -- the test for that case
 * pins the absence to prevent regression.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock getConductorMcpPort BEFORE importing the module under test so the
// writer picks up the mocked port. Mutable via the exported setter below
// so individual tests can exercise the port=0 edge case.
let mockedPort = 19433
const MOCK_SECRET = 'a'.repeat(64)
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => mockedPort,
  getConductorMcpSecret: () => MOCK_SECRET,
}))

const {
  writeLocalSessionSettings,
  writeLocalSessionMcpConfig,
  getLocalSessionMcpConfigPath,
} = await import('../../../src/main/hooks/per-session-settings')

describe('per-session MCP config writer (P7.7.3)', () => {
  let tmpHome: string
  let claudeDir: string
  let realHomedir: typeof os.homedir

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-mcp-cfg-'))
    claudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    realHomedir = os.homedir
    ;(os as any).homedir = () => tmpHome
    mockedPort = 19433
  })

  afterEach(() => {
    ;(os as any).homedir = realHomedir
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes conductor with canonical schema (type: "sse", url) including cccSessionId + token query', () => {
    // P7.7.10: URL bakes ?cccSessionId=<sid> so the server can resolve the
    // CCC session from the SSE transport instead of trusting an LLM arg.
    // R-DEC-3: URL also carries &token=<secret> so the request authenticates
    // against the per-launch MCP secret.
    const cfgPath = writeLocalSessionMcpConfig('sid-1')
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    expect(written.mcpServers['conductor']).toEqual({
      type: 'sse',
      url: `http://localhost:19433/sse?cccSessionId=sid-1&token=${MOCK_SECRET}`,
    })
  })

  it('embeds the per-launch MCP secret as a token query param (R-DEC-3)', () => {
    const cfgPath = writeLocalSessionMcpConfig('sid-tok')
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    expect(written.mcpServers['conductor'].url).toContain(`token=${MOCK_SECRET}`)
  })

  it('URL-encodes special characters in the sessionId (P7.7.10)', () => {
    const cfgPath = writeLocalSessionMcpConfig('sess+one space')
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    // encodeURIComponent maps "+" -> "%2B" and " " -> "%20"
    expect(written.mcpServers['conductor'].url).toBe(
      `http://localhost:19433/sse?cccSessionId=sess%2Bone%20space&token=${MOCK_SECRET}`,
    )
  })

  it('writes to ~/.claude/mcp-<sid>.json (distinct from settings file)', () => {
    const cfgPath = writeLocalSessionMcpConfig('sid-2')
    expect(cfgPath).toBe(getLocalSessionMcpConfigPath('sid-2'))
    expect(cfgPath).toContain(path.join('.claude', 'mcp-sid-2.json'))
  })

  it('sanitises unsafe characters in sessionId', () => {
    const cfgPath = writeLocalSessionMcpConfig('sid/with..slash')
    expect(path.basename(cfgPath)).toBe('mcp-sid_with__slash.json')
    expect(fs.existsSync(cfgPath)).toBe(true)
  })

  it('writes distinct files for different sessions', () => {
    const a = writeLocalSessionMcpConfig('sid-a')
    const b = writeLocalSessionMcpConfig('sid-b')
    expect(a).not.toBe(b)
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  })

  it('settings file no longer carries mcpServers (was dead code under --settings)', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: {
        'conductor': { url: 'http://localhost:19333/sse' },
        'other-server': { url: 'http://example.com/sse' },
      },
    }))
    const sesPath = writeLocalSessionSettings('sid-3')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    // The clone preserves every top-level key including mcpServers verbatim;
    // we just no longer mutate it. This is intentional -- claude.exe will
    // ignore it anyway since --settings doesn't load mcpServers.
    expect(written.mcpServers).toEqual({
      'conductor': { url: 'http://localhost:19333/sse' },
      'other-server': { url: 'http://example.com/sse' },
    })
  })

  it('writes empty mcpServers when port is 0 (MCP server not yet bound)', () => {
    mockedPort = 0
    const cfgPath = writeLocalSessionMcpConfig('sid-port-zero')
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    expect(written.mcpServers).toEqual({})
  })

  it('settings file preserves the user global verbatim', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash'] },
      statusLine: { type: 'command', command: 'echo hi' },
      effortLevel: 'high',
    }))
    const sesPath = writeLocalSessionSettings('sid-4')
    const written = JSON.parse(fs.readFileSync(sesPath, 'utf-8'))
    expect(written).toEqual({
      permissions: { allow: ['Bash'] },
      statusLine: { type: 'command', command: 'echo hi' },
      effortLevel: 'high',
    })
  })
})
