import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Real-fs security tests for the legacy-version manager (P0.3 path traversal).
// getResourcesDirectory is mocked to an isolated mkdtemp dir so a traversal
// version string can be PROVEN not to escape <resources>/claude-versions/.
vi.mock('../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-legacy-sec-'))
  return { getResourcesDirectory: () => dir, registerSetupHandlers: () => {} }
})

const { getResourcesDirectory } = await import('../../src/main/ipc/setup-handlers')
const { removeVersion, resolveVersionBinary, isVersionInstalled, installVersion, listInstalledVersions } =
  await import('../../src/main/legacy-version-manager')

const resourcesDir = getResourcesDirectory()
const versionsDir = path.join(resourcesDir, 'claude-versions')

function makeInstalledVersion(version: string): void {
  const binDir = path.join(versionsDir, version, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  // Cover both platform branches of resolveVersionBinary.
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo claude')
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\necho claude')
}

beforeEach(() => {
  fs.rmSync(versionsDir, { recursive: true, force: true })
  fs.mkdirSync(versionsDir, { recursive: true })
})

describe('legacy-version-manager path traversal (P0.3)', () => {
  it('removeVersion refuses to delete a path outside the versions dir', () => {
    const sentinel = path.join(resourcesDir, 'sentinel.txt')
    fs.writeFileSync(sentinel, 'do not delete me')

    const result = removeVersion('../sentinel.txt')

    expect(result).toBe(false)
    // The smoking gun: the file outside claude-versions must still exist.
    expect(fs.existsSync(sentinel)).toBe(true)
  })

  it('removeVersion refuses a deeper traversal', () => {
    const sentinelDir = path.join(resourcesDir, 'outside')
    fs.mkdirSync(sentinelDir, { recursive: true })
    fs.writeFileSync(path.join(sentinelDir, 'keep.txt'), 'keep')

    expect(removeVersion('..\\outside')).toBe(false)
    expect(removeVersion('../outside')).toBe(false)
    expect(fs.existsSync(sentinelDir)).toBe(true)
  })

  it('removeVersion refuses a valid-but-not-installed version', () => {
    expect(removeVersion('9.9.9')).toBe(false)
  })

  it('resolveVersionBinary returns null for a traversal string (no spawn target escape)', () => {
    expect(resolveVersionBinary('../../../etc/passwd')).toBeNull()
    expect(resolveVersionBinary('..\\..\\Windows\\System32')).toBeNull()
    expect(isVersionInstalled('../../evil')).toBe(false)
  })

  it('installVersion rejects an invalid version without touching the filesystem outside', async () => {
    const before = fs.readdirSync(resourcesDir).sort()

    const result = await installVersion('../../evil')

    expect(result.ok).toBe(false)
    // No stray directory created anywhere under resources.
    expect(fs.readdirSync(resourcesDir).sort()).toEqual(before)
  })

  it('still lists and removes a genuinely installed version (happy path preserved)', () => {
    makeInstalledVersion('1.2.3')

    expect(listInstalledVersions().map((v) => v.version)).toContain('1.2.3')
    expect(isVersionInstalled('1.2.3')).toBe(true)

    expect(removeVersion('1.2.3')).toBe(true)
    expect(fs.existsSync(path.join(versionsDir, '1.2.3'))).toBe(false)
  })
})
