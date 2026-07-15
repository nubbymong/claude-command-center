/**
 * U3: CCC no longer WRITES the conductor entry into the user's global
 * ~/.claude.json -- CCC sessions get it per-session via --mcp-config
 * (writeLocalSessionMcpConfig). At boot it HEALS a stale entry left by a pre-U3
 * version or a crash. removeMcpSettings is that heal: strip conductor (+ legacy
 * conductor-vision) while preserving every other mcpServers entry and every
 * other top-level key.
 *
 * Uses the tmp-HOME env idiom (os.homedir() resolves USERPROFILE/HOME at call
 * time) so we don't depend on which `os` wrapper the module captured.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { removeMcpSettings } from '../../../src/main/conductor-mcp-server'

describe('removeMcpSettings -- global conductor MCP heal (U3)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'u3-heal-'))
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const cjPath = () => path.join(tmpHome, '.claude.json')

  it('strips a stale conductor entry, preserving other servers and top-level keys', () => {
    fs.writeFileSync(
      cjPath(),
      JSON.stringify({
        oauthAccount: { email: 'x@y.z' },
        mcpServers: {
          conductor: { type: 'sse', url: 'http://localhost:19333/sse?token=abc' },
          'other-server': { type: 'sse', url: 'http://example.com/sse' },
        },
      }),
    )
    removeMcpSettings()
    const cj = JSON.parse(fs.readFileSync(cjPath(), 'utf-8'))
    expect(cj.mcpServers.conductor).toBeUndefined()
    expect(cj.mcpServers['other-server']).toEqual({ type: 'sse', url: 'http://example.com/sse' })
    expect(cj.oauthAccount).toEqual({ email: 'x@y.z' })
  })

  it('also strips the legacy conductor-vision entry (and drops an emptied mcpServers)', () => {
    fs.writeFileSync(
      cjPath(),
      JSON.stringify({ mcpServers: { 'conductor-vision': { type: 'sse', url: 'http://old' } } }),
    )
    removeMcpSettings()
    const cj = JSON.parse(fs.readFileSync(cjPath(), 'utf-8'))
    expect(cj.mcpServers).toBeUndefined()
  })

  it('is a no-op when there is no conductor entry', () => {
    fs.writeFileSync(
      cjPath(),
      JSON.stringify({ mcpServers: { other: { type: 'sse', url: 'u' } }, foo: 1 }),
    )
    removeMcpSettings()
    const cj = JSON.parse(fs.readFileSync(cjPath(), 'utf-8'))
    expect(cj.mcpServers.other).toEqual({ type: 'sse', url: 'u' })
    expect(cj.foo).toBe(1)
  })
})
