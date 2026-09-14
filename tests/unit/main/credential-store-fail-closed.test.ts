/**
 * The credential store never writes over a file it could not read (ADR-009 pass
 * on #386). `ssh-credentials.json` holds every SSH password, sudo password and
 * command-button secret as ciphertext. An unreadable file (a scanner holding
 * it, a permissions hiccup, a torn write, corruption) used to read as `{}`,
 * and the next save or delete -- a command deleted from the bar, a secret
 * switched off -- wrote that `{}` back, destroying them all. Now: a missing file
 * is "no credentials yet" and is created; an unreadable one makes save/delete
 * return false and write nothing; callers are told the truth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dirs = vi.hoisted(() => ({ config: '' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}))
vi.mock('../../../src/main/config-manager', () => ({ getConfigDir: () => dirs.config, ensureConfigDir: () => {} }))
vi.mock('../../../src/main/account-profiles', async () => {
  const fs = await import('fs')
  return { atomicWriteSecure: (p: string, data: string) => { fs.writeFileSync(p, data, 'utf8') } }
})

const { saveCredential, deleteCredential, loadCredential, readCredentialsFile } = await import('../../../src/main/credential-store')

let dir: string
const file = () => join(dir, 'ssh-credentials.json')
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccc-cred-')); dirs.config = dir })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a missing file is "no credentials yet"', () => {
  it('save creates it, load decrypts, delete removes the key and leaves the rest', () => {
    expect(readCredentialsFile()).toEqual({})
    expect(saveCredential('cfg-a', 'pw-a')).toBe(true)
    expect(saveCredential('cmd1_cmdsecret', 'tok')).toBe(true)
    expect(loadCredential('cfg-a')).toBe('pw-a')
    expect(deleteCredential('cmd1_cmdsecret')).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ 'cfg-a': Buffer.from('enc:pw-a').toString('base64') })
  })

  it('deleting a key that is not there is true and writes nothing', () => {
    expect(deleteCredential('nope')).toBe(true)
    expect(existsSync(file())).toBe(false)
  })
})

describe('an unreadable file is never written over', () => {
  const garbage = '{"cfg-a":"' // torn write
  it('save returns false and the bytes on disk are untouched', () => {
    writeFileSync(file(), garbage, 'utf8')
    expect(readCredentialsFile()).toBeNull()
    expect(saveCredential('cfg-b', 'pw-b')).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(garbage)
  })

  it('delete returns false and the bytes on disk are untouched', () => {
    writeFileSync(file(), garbage, 'utf8')
    expect(deleteCredential('cfg-a')).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(garbage)
  })

  it('a file that parses to something other than an object is unreadable too', () => {
    writeFileSync(file(), '["cfg-a"]', 'utf8')
    expect(readCredentialsFile()).toBeNull()
    expect(saveCredential('cfg-a', 'x')).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('["cfg-a"]')
  })

  it('read-only callers still get an empty map rather than a throw', () => {
    writeFileSync(file(), garbage, 'utf8')
    expect(loadCredential('cfg-a')).toBeNull()
  })
})
