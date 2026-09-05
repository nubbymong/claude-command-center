// rc.14 review F6 (aicc_planning#50): a mid-session token ROTATION must reach
// the canonical backup, not only the session's exit.
//
// The canonical copy is what capture/restore puts back into a shared profile
// home after a /login switched it to another account. It used to be refreshed
// only at exit (and at add-account), while the CLI rotates the single-use
// refresh token during a long session -- so a restore mid-session installed a
// pre-rotation, already-spent token and stranded the account. The identity
// poll now watches the profile's `.credentials.json` mtime and re-snapshots
// canonical on every change after the first observation. Stat only.
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
let clock = Date.now()
function writeCreds(refreshToken: string) {
  fs.mkdirSync(credsDir, { recursive: true })
  fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken } }))
  // A deterministic, strictly later mtime: coarse filesystem clocks could
  // otherwise make two writes in one tick look like no change.
  clock += 5000
  fs.utimesSync(credsFile, new Date(clock), new Date(clock))
}

beforeEach(() => {
  identity._resetForTest()
  backup.mockClear()
})
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('canonical backup follows a credential rotation', () => {
  it('first observation records the mtime and backs nothing up; a rotation then re-snapshots canonical once', async () => {
    writeCreds('rt-1')
    identity.startWatchingAccountIdentity('s1', 'profile-aaa111')
    await identity.recheckAllAsync()
    expect(backup).not.toHaveBeenCalled()

    writeCreds('rt-2') // the CLI rotated the refresh token mid-session
    await identity.recheckAllAsync()
    expect(backup).toHaveBeenCalledTimes(1)
    expect(backup).toHaveBeenCalledWith('profile-aaa111')

    await identity.recheckAllAsync() // nothing changed since
    expect(backup).toHaveBeenCalledTimes(1)
    identity.stopWatchingAccountIdentity('s1')
  })

  it('a missing credentials file is simply not observed (no throw, no backup)', async () => {
    fs.rmSync(credsFile, { force: true })
    identity.startWatchingAccountIdentity('s2', 'profile-aaa111')
    await expect(identity.recheckAllAsync()).resolves.toBeUndefined()
    expect(backup).not.toHaveBeenCalled()
    identity.stopWatchingAccountIdentity('s2')
  })

  it('a session with no profile (default home) is never stat-ed for a profile credential file', async () => {
    writeCreds('rt-3')
    identity.startWatchingAccountIdentity('s3', undefined)
    await identity.recheckAllAsync()
    writeCreds('rt-4')
    await identity.recheckAllAsync()
    expect(backup).not.toHaveBeenCalled()
    identity.stopWatchingAccountIdentity('s3')
  })
})
