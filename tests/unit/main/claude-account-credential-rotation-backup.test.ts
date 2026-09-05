// rc.14 review F6 (aicc_planning#50): a mid-session token ROTATION must reach
// the canonical backup, not only the session's exit.
//
// The canonical copy is what capture/restore puts back into a shared profile
// home after a /login switched it to another account. It used to be refreshed
// only at exit (and at add-account), while the CLI rotates the single-use
// refresh token during a long session -- so a restore mid-session installed a
// pre-rotation, already-spent token and stranded the account. The identity
// poll now watches the profile's `.credentials.json` mtime and re-snapshots
// canonical once a change has SETTLED: seen unchanged on the poll after it
// appeared (adversarial pass on #598 -- a /login writes the credential and
// identity files separately, and a snapshot taken between the writes mixed one
// account's identity with another's token). The identity file itself is NOT
// part of the stamp: the CLI rewrites it on ordinary turns, and waiting for it
// to go quiet would starve the backup for as long as the user is working.
// Stat only.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const { tmp, backup } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return {
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-rot-')),
    backup: vi.fn(),
  }
})
vi.mock('../../../src/main/account-profiles', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/account-profiles')>()),
  getProfileConfigDir: () => tmp,
  readProfileAccountEmail: () => 'same@account.test',
  backupProfileHomeToCanonical: (id: string) => backup(id),
}))

import * as identity from '../../../src/main/claude-account-identity'

const credsDir = path.join(tmp, '.claude')
const credsFile = path.join(credsDir, '.credentials.json')
const identityFile = path.join(tmp, '.claude.json')
let clock = Date.now()
/** A deterministic, strictly later mtime: coarse filesystem clocks could
 *  otherwise make two writes in one tick look like no change. */
function stamp(file: string) {
  clock += 5000
  fs.utimesSync(file, new Date(clock), new Date(clock))
}
function writeCreds(refreshToken: string) {
  fs.mkdirSync(credsDir, { recursive: true })
  fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken } }))
  stamp(credsFile)
}
function writeIdentity(email: string) {
  fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  stamp(identityFile)
}
const poll = () => identity.recheckAllAsync()

beforeEach(() => {
  identity._resetForTest()
  backup.mockClear()
  fs.rmSync(identityFile, { force: true })
})
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('canonical backup follows a credential rotation', () => {
  it('first observation records the stamp and backs nothing up; a rotation re-snapshots canonical once it has settled', async () => {
    writeCreds('rt-1')
    identity.startWatchingAccountIdentity('s1', 'profile-aaa111')
    await poll()
    expect(backup).not.toHaveBeenCalled()

    writeCreds('rt-2') // the CLI rotated the refresh token mid-session
    await poll()
    expect(backup).not.toHaveBeenCalled() // seen once: the file may still be moving
    await poll()
    expect(backup).toHaveBeenCalledTimes(1) // seen unchanged: settled
    expect(backup).toHaveBeenCalledWith('profile-aaa111')

    await poll() // nothing changed since
    expect(backup).toHaveBeenCalledTimes(1)
    identity.stopWatchingAccountIdentity('s1')
  })

  it('REGRESSION (adversarial pass on #598): the poll that first sees the credential move never snapshots, so a /login\'s identity write has a poll to land', async () => {
    writeCreds('rt-5')
    writeIdentity('same@account.test')
    identity.startWatchingAccountIdentity('s4', 'profile-aaa111')
    await poll()

    writeCreds('rt-6') // the CLI wrote the new credentials first...
    await poll()
    expect(backup).not.toHaveBeenCalled() // ...and nothing was snapshotted beside the OLD identity file
    writeIdentity('same@account.test') // ...the identity file lands before the next poll
    await poll()
    expect(backup).toHaveBeenCalledTimes(1) // the (email-guarded) backup judges the finished picture
    identity.stopWatchingAccountIdentity('s4')
  })

  it('REGRESSION (quality review of the #598 pass): an identity file rewritten on every poll never starves the backup', async () => {
    writeCreds('rt-7')
    writeIdentity('same@account.test')
    identity.startWatchingAccountIdentity('s6', 'profile-aaa111')
    await poll()

    writeCreds('rt-8')
    writeIdentity('same@account.test') // the CLI touches .claude.json on ordinary turns
    await poll()
    writeIdentity('same@account.test')
    await poll()
    expect(backup).toHaveBeenCalledTimes(1) // the credential file settled; the identity churn is irrelevant
    writeIdentity('same@account.test')
    await poll()
    expect(backup).toHaveBeenCalledTimes(1) // and churn alone never re-snapshots
    identity.stopWatchingAccountIdentity('s6')
  })

  it('a change that keeps moving is not snapshotted until it stops', async () => {
    writeCreds('rt-30')
    identity.startWatchingAccountIdentity('s7', 'profile-aaa111')
    await poll()
    writeCreds('rt-31')
    await poll()
    writeCreds('rt-32') // moved again before the settle poll
    await poll()
    expect(backup).not.toHaveBeenCalled()
    await poll()
    expect(backup).toHaveBeenCalledTimes(1)
    identity.stopWatchingAccountIdentity('s7')
  })

  it('a missing credentials file is simply not observed (no throw, no backup)', async () => {
    fs.rmSync(credsFile, { force: true })
    identity.startWatchingAccountIdentity('s2', 'profile-aaa111')
    await expect(poll()).resolves.toBeUndefined()
    expect(backup).not.toHaveBeenCalled()
    identity.stopWatchingAccountIdentity('s2')
  })

  it('a session with no profile (default home) is never stat-ed for a profile credential file', async () => {
    writeCreds('rt-3')
    identity.startWatchingAccountIdentity('s3', undefined)
    await poll()
    writeCreds('rt-4')
    await poll()
    await poll()
    expect(backup).not.toHaveBeenCalled()
    identity.stopWatchingAccountIdentity('s3')
  })

  it('is stat-only: the credential file\'s CONTENTS are never read by the follower', async () => {
    writeCreds('rt-20')
    const readFile = vi.spyOn(fs.promises, 'readFile')
    const readFileSync = vi.spyOn(fs, 'readFileSync')
    try {
      identity.startWatchingAccountIdentity('s5', 'profile-aaa111')
      await poll()
      writeCreds('rt-21')
      await poll()
      await poll()
      expect(backup).toHaveBeenCalledTimes(1)
      const touched = [...readFile.mock.calls, ...readFileSync.mock.calls].map((c) => String(c[0]))
      expect(touched.filter((p) => p.endsWith('.credentials.json'))).toEqual([])
    } finally {
      readFile.mockRestore()
      readFileSync.mockRestore()
      identity.stopWatchingAccountIdentity('s5')
    }
  })
})

describe('one rotation costs one backup, however many sessions share the account', () => {
  it('two watched sessions on the same profile: a rotation triggers exactly one canonical snapshot', async () => {
    writeCreds('rt-10')
    identity.startWatchingAccountIdentity('a1', 'profile-aaa111')
    identity.startWatchingAccountIdentity('a2', 'profile-aaa111')
    await poll()
    expect(backup).not.toHaveBeenCalled()
    writeCreds('rt-11')
    await poll()
    await poll()
    expect(backup).toHaveBeenCalledTimes(1)
    // Closing one session keeps the profile's stamp (the other still watches);
    // closing the last one drops it, so a later session observes afresh.
    identity.stopWatchingAccountIdentity('a1')
    writeCreds('rt-12')
    await poll()
    await poll()
    expect(backup).toHaveBeenCalledTimes(2)
    identity.stopWatchingAccountIdentity('a2')
  })
})
