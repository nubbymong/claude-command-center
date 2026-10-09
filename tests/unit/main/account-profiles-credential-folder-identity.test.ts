// An account's sign-in folder that is replaced after its owner-only check is
// never taken as checked: the check holds a verdict for the folder it read (by
// its file identity), so a folder put in its place -- another real folder at
// the same path -- reads as unchecked until it is checked again, and a write
// into it is refused as still being checked, never let through on the earlier
// pass. Both the read a launch makes first (profileCredentialFoldersChecked)
// and the verdict a write reads (credentialFoldersVerdict) are pinned.
//
// Host-safe: no link or junction is planted and no process starts (every
// child_process entry point throws); the owner-only rule is replaced through
// the test seam; the folders are real, in this worker's temp folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const execFileSync = vi.fn(no)
  const execFile = vi.fn(no)
  const spawn = vi.fn(no)
  const spawnSync = vi.fn(no)
  const execSync = vi.fn(no)
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})

import {
  _setRootsForTest, _setCredentialFolderRuleForTest, getProfileConfigDir, getAccountIdentityDir,
  checkProfileCredentialFolders, profileCredentialFoldersChecked, credentialFoldersVerdict, CREDENTIAL_FOLDER_PENDING,
} from '../../../src/main/account-profiles'

const ID = 'profile-mabc123-a1b2c3'
const PREFIX = 'ccc-credential-folder-identity-'
let base = ''
let claudeDir = ''
let identityDir = ''

/** The rule as the app's would answer for folders it made owner-only: each
 *  missing one made inside its parent, every one passed. */
const madeAndPassed = (dirs: readonly string[]) => dirs.map((dir) => {
  if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
  return { dir, ok: true, detail: 'owner-only' }
})

/** Another real folder made at the folder's path, the old one moved aside
 *  first and removed after, so the two exist at once and the file system
 *  cannot give the new one the old one's identity. */
function replaceFolder(dir: string): void {
  const before = fs.statSync(dir, { bigint: true })
  const aside = dir + '.aside'
  fs.renameSync(dir, aside)
  fs.mkdirSync(dir)
  fs.rmSync(aside, { recursive: true, force: true })
  const after = fs.statSync(dir, { bigint: true })
  // The premise: the file system gave the new folder another identity.
  expect(`${after.dev}:${after.ino}`).not.toBe(`${before.dev}:${before.ino}`)
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const resourcesDir = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(shared, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot: shared })
  _setCredentialFolderRuleForTest(null)
  const home = getProfileConfigDir(ID)
  claudeDir = path.join(home, '.claude')
  identityDir = getAccountIdentityDir(ID)
  fs.mkdirSync(claudeDir, { recursive: true })
})

afterEach(() => {
  _setCredentialFolderRuleForTest(null)
  _setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe('a sign-in folder replaced after its check is not taken as checked', () => {
  it.each(['claude', 'identity'] as const)('the %s folder replaced by another real folder reads unchecked until it is checked again', async (which) => {
    _setCredentialFolderRuleForTest(async (dirs) => madeAndPassed(dirs))
    await checkProfileCredentialFolders(ID)
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
    replaceFolder(which === 'claude' ? claudeDir : identityDir)
    expect(profileCredentialFoldersChecked(ID)).toBe(false)
    await checkProfileCredentialFolders(ID)
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
  })

  it.each(['claude', 'identity'] as const)('a write into the %s folder replaced after its pass is refused as still being checked, never let through', async (which) => {
    _setCredentialFolderRuleForTest(async (dirs) => madeAndPassed(dirs))
    await checkProfileCredentialFolders(ID)
    const dir = which === 'claude' ? claudeDir : identityDir
    expect(credentialFoldersVerdict([dir])).toEqual({ ok: true })
    replaceFolder(dir)
    expect(credentialFoldersVerdict([dir])).toEqual({ ok: false, message: CREDENTIAL_FOLDER_PENDING })
  })
})
