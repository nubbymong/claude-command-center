import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Regression suite for the credential/token file-mode hardening: several writers
// wrote token-bearing files with a bare writeFileSync — non-atomic and at the
// 0644 umask default — outside the atomic-secure path the pwfw/58r3 work
// established. This pins that every such writer now stages-and-renames owner-only.
//
// The mode itself is a POSIX no-op on Windows, so a raw stat assertion would pass
// vacuously on the primary CI runner. Instead we record the write OPTIONS (same
// fs-patch shape as credential-writer-fail-closed.test.ts): the atomicity check
// (staged `.tmp`, flag `wx`, no direct target write) fails against the unfixed
// code on EVERY platform, and the mode is additionally asserted on POSIX.

const rec = vi.hoisted(() => ({ writes: [] as Array<{ path: string; opts: unknown }> }))
function patchFs(real: Record<string, unknown>) {
  return {
    ...real,
    writeFileSync: (p: unknown, d: unknown, o: unknown) => {
      rec.writes.push({ path: String(p), opts: o })
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, d, o)
    },
  }
}
vi.mock('fs', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  const patched = patchFs((mod.default as Record<string, unknown>) ?? mod)
  return { ...patched, default: patched }
})
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  const patched = patchFs((mod.default as Record<string, unknown>) ?? mod)
  return { ...patched, default: patched }
})

const dirs = vi.hoisted(() => ({ resources: '' }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => dirs.resources }))
// generateRemoteSetupScript reads the live MCP port + per-session token; stub them.
vi.mock('../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19333,
  // GHSA-q83v: the shim embeds the per-session HMAC, not the raw secret.
  mcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

const { saveAllCredentials } = await import('../../src/main/credential-store')
const { writeCanonicalIdentity } = await import('../../src/main/account-profiles')
const { generateRemoteSetupScript } = await import('../../src/main/providers/claude/ssh-shim')

const isPosix = process.platform !== 'win32'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function stagingWrite(base: string): { path: string; opts: { flag?: string; mode?: number } } | undefined {
  const re = new RegExp(base.replace(/\./g, '\\.') + '\\.' + UUID + '\\.tmp$')
  return rec.writes.find((w) => re.test(w.path)) as never
}
function directWrite(base: string): boolean {
  return rec.writes.some((w) => w.path.endsWith('/' + base) || w.path.endsWith('\\' + base))
}

/** Every hardened writer: staged (.tmp, wx), never a direct target write, 0600 on POSIX. */
function expectHardened(base: string): void {
  const staged = stagingWrite(base)
  expect(staged, `${base} must be written through the atomic staging path`).toBeTruthy()
  expect(staged!.opts.flag).toBe('wx')
  expect(directWrite(base), `${base} must never be written directly (non-atomic / unhardened)`).toBe(false)
  if (isPosix) expect(staged!.opts.mode).toBe(0o600)
}

beforeEach(() => {
  rec.writes.length = 0
  dirs.resources = mkdtempSync(join(tmpdir(), 'ccc-cred-mode-'))
})
afterEach(() => {
  try { rmSync(dirs.resources, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('(A) ssh-credentials.json', () => {
  it('is written owner-only through the atomic helper, never a bare writeFileSync', () => {
    saveAllCredentials({ 'config-1': 'BASE64CIPHERTEXT==' })
    expectHardened('ssh-credentials.json')
  })
})

describe('(B) profile .claude.json (the OAuth-token file)', () => {
  it('canonical identity .claude.json is staged owner-only', () => {
    writeCanonicalIdentity('abcdef0123456789abcdef01', { claudeJson: '{"oauthAccount":{"accessToken":"secret"}}' })
    expectHardened('.claude.json')
  })
})

describe('(C) ssh-shim remote setup script', () => {
  const script = () => generateRemoteSetupScript('sess-abc123', null, {})

  it('creates the remote ~/.claude dir 0700', () => {
    expect(script()).toContain('mkdirSync(claudeDir,{recursive:true,mode:0o700})')
  })

  it('writes the remote mcp token file owner-only with a fresh create', () => {
    const s = script()
    expect(s).toContain('rmSync(mcpPath,{force:true})')
    expect(s).toMatch(/writeFileSync\(mcpPath,[^)]*,\{mode:0o600\}\)/)
    // The unfixed shape — a bare writeFileSync(mcpPath, literal) with no mode — is gone.
    expect(s).not.toMatch(/writeFileSync\(mcpPath,\$\{[^}]*\}\)\}catch/)
  })

  it('writes the remote per-session settings (hook token) owner-only', () => {
    const s = script()
    expect(s).toContain('rmSync(sesPath,{force:true})')
    expect(s).toContain('writeFileSync(sesPath,JSON.stringify(sesCfg,null,2),{mode:0o600})')
  })
})

describe('(D) insights kpis.json', () => {
  // The two writers live deep in run-orchestration functions that are impractical
  // to invoke in isolation, so pin the source: both go through the atomic helper
  // with 0600, and no bare writeFileSync of kpis.json survives (fails-first).
  const src = readFileSync(join(__dirname, '../../src/main/insights-runner.ts'), 'utf8')

  it('has no bare writeFileSync of kpis.json', () => {
    expect(src).not.toMatch(/[^c]writeFileSync\(\s*join\(archiveDir, 'kpis\.json'\)/)
  })

  it('writes kpis.json through the atomic helper with mode 0600 (both sites)', () => {
    const matches = src.match(/atomicWriteFileSync\(\s*join\(archiveDir, 'kpis\.json'\),[\s\S]*?\{ mode: 0o600 \}\)/g) ?? []
    expect(matches.length).toBe(2)
  })
})
