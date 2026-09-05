// rc.14 review F7 + adversarial pass on #598: the re-auth poll's generation
// stamp carries NO credential material across the bridge -- a stat-shaped string
// and a boolean, nothing from the file's contents -- and the reader refuses an
// invalid id itself, so a future caller that forgets the handler's check still
// cannot traverse out of the profiles root.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { _setRootsForTest, getProfileConfigDir, readProfileCredentialStamp } from '../../../src/main/account-profiles'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-stamp-'))
  _setRootsForTest({ resourcesDir: root, sharedRoot: path.join(root, '.claude') })
})
afterEach(() => {
  _setRootsForTest(null)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE'
const REFRESH = 'sk-ant-ort01-SECRET-REFRESH-VALUE'
function writeCreds(id: string, body: unknown): string {
  const dir = path.join(getProfileConfigDir(id), '.claude')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.credentials.json')
  fs.writeFileSync(file, JSON.stringify(body))
  return file
}

describe('readProfileCredentialStamp', () => {
  it('returns a stat stamp and a signed-in flag, and nothing from the file itself', () => {
    writeCreds('profile-a1', { claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: 1234, email: 'x@y.z' } })
    const r = readProfileCredentialStamp('profile-a1')
    expect(Object.keys(r).sort()).toEqual(['signedIn', 'stamp'])
    expect(r.signedIn).toBe(true)
    expect(r.stamp).toMatch(/^\d+:\d+$/)
    const serialized = JSON.stringify(r)
    for (const secret of ['SECRET', TOKEN, REFRESH, '1234', 'x@y.z']) expect(serialized).not.toContain(secret)
  })

  it('the stamp changes when the file is rewritten (that is what the re-auth poll keys on)', () => {
    const file = writeCreds('profile-a3', { claudeAiOauth: { accessToken: TOKEN } })
    const before = readProfileCredentialStamp('profile-a3').stamp
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN + '-rotated-longer' } }))
    const t = new Date(Date.now() + 10_000)
    fs.utimesSync(file, t, t)
    expect(readProfileCredentialStamp('profile-a3').stamp).not.toBe(before)
  })

  it('a file without tokens is not signed in; a missing file has no stamp', () => {
    writeCreds('profile-a2', { claudeAiOauth: { expiresAt: 1 } })
    expect(readProfileCredentialStamp('profile-a2')).toMatchObject({ signedIn: false })
    expect(readProfileCredentialStamp('profile-a2').stamp).toMatch(/^\d+:\d+$/)
    expect(readProfileCredentialStamp('profile-none')).toEqual({ stamp: null, signedIn: false })
  })

  it('an unparseable file still yields a stamp, and reads as not signed in', () => {
    const dir = path.join(getProfileConfigDir('profile-a4'), '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{ not json')
    expect(readProfileCredentialStamp('profile-a4')).toMatchObject({ signedIn: false })
  })

  it('refuses an invalid id itself (the IPC handler is not the only gate)', () => {
    for (const id of ['..', '../x', '..\\..\\.claude', 'C:\\Users\\nicho', '', 'P1', 'x'.repeat(129)]) {
      expect(() => readProfileCredentialStamp(id), JSON.stringify(id)).toThrow()
    }
  })
})
