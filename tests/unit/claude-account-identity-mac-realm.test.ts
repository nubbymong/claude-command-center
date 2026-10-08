// @vitest-environment node
//
// The /login watcher (claude-account-identity, recheckAll) on macOS with the
// experimental multi-account setting on: a realm session's identity lives in
// <home>/.claude/.claude.json and a /login there raises the new-account
// prompt exactly as on win32; the PRIMARY's identity is the real
// ~/.claude.json, its chip follows a /login, and no prompt is raised (capture
// of the normal sign-in is refused -- profileDetectionCapturable).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }] },
}))
vi.mock('../../src/main/account-color', () => ({ colourForEmail: () => 'mauve' }))

import { _setRootsForTest, getProfileConfigDir, upsertProfile, setMacMultiAccountProbe } from '../../src/main/account-profiles'
import { captureClaudeAccount, startWatchingAccountIdentity, recheckAll, getClaudeAccount, _resetClaudeAccounts } from '../../src/main/claude-account-identity'
import { IPC } from '../../src/shared/ipc-channels'

let tmp = ''
const realPlatform = process.platform
const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

function write(file: string, email: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  if (before && fs.statSync(file).mtimeMs === before) { const t = new Date(before + 1000); fs.utimesSync(file, t, t) }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-mac-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'realhome', '.claude') })
  fs.mkdirSync(path.join(tmp, 'realhome', '.claude'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
  _resetClaudeAccounts()
  sent.length = 0
  upsertProfile({ id: 'profile-prim-1', name: 'P', accountEmail: 'p@x.com', createdAt: 1, isPrimary: true })
  upsertProfile({ id: 'profile-real-1', name: 'R', accountEmail: 'a@x.com', createdAt: 2 })
})
afterEach(() => {
  asPlatform(realPlatform)
  setMacMultiAccountProbe(() => false)
  _setRootsForTest(null)
  _resetClaudeAccounts()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

const detected = () => sent.filter((s) => s.channel === IPC.ACCOUNT_NEW_DETECTED)

describe('macOS, setting on', () => {
  beforeEach(() => { asPlatform('darwin'); setMacMultiAccountProbe(() => true) })

  it('a realm session: /login in its config dir raises the new-account prompt', () => {
    const idFile = path.join(path.resolve(getProfileConfigDir('profile-real-1'), '.claude').normalize('NFC'), '.claude.json')
    write(idFile, 'a@x.com')
    captureClaudeAccount('s1', 'profile-real-1')
    startWatchingAccountIdentity('s1', 'profile-real-1')
    recheckAll()
    write(idFile, 'b@x.com')
    recheckAll()
    expect(getClaudeAccount('s1')).toBe('b@x.com')
    expect(detected()).toEqual([{ channel: IPC.ACCOUNT_NEW_DETECTED, payload: { sessionId: 's1', profileId: 'profile-real-1', email: 'b@x.com' } }])
  })

  it('the primary: the chip follows the real ~/.claude.json, and no capture prompt is raised', () => {
    const idFile = path.join(tmp, 'realhome', '.claude.json')
    write(idFile, 'p@x.com')
    captureClaudeAccount('s2', 'profile-prim-1')
    expect(getClaudeAccount('s2')).toBe('p@x.com')
    startWatchingAccountIdentity('s2', 'profile-prim-1')
    recheckAll()
    write(idFile, 'b@x.com')
    recheckAll()
    expect(getClaudeAccount('s2')).toBe('b@x.com')
    expect(detected()).toEqual([])
  })
})

describe('win32 (setting on or off): unchanged', () => {
  it('a /login in the profile home raises the prompt, primary or not', () => {
    asPlatform('win32')
    setMacMultiAccountProbe(() => true)
    const idFile = path.join(getProfileConfigDir('profile-prim-1'), '.claude.json')
    write(idFile, 'p@x.com')
    captureClaudeAccount('s3', 'profile-prim-1')
    startWatchingAccountIdentity('s3', 'profile-prim-1')
    recheckAll()
    write(idFile, 'b@x.com')
    recheckAll()
    expect(detected()).toHaveLength(1)
  })
})
