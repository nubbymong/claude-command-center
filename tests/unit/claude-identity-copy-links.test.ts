// WP2 PR 4 review fix pass (L2): after a sign-out of a Claude profile ran, the
// credential copy in the profile's identity folder is removed link-safely
// (removeProfileIdentityCredentials): a link or junction where the app made a
// folder is refused and nothing is removed through it; a link AT the copy is
// removed as the link, never its target.
//
// HOST QUARANTINE: this suite plants junctions and symbolic links in a temp
// folder. It runs in CI and on the VM, never on the owner's workstation. [CI]
// [VM] It starts no process and reads no real home folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const profiles = await import('../../src/main/account-profiles')

const ID = 'profile-lnk-123'
let sandbox = ''
let root = ''
let outside = ''

/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkDir(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(join(os.tmpdir(), 'ccc-identity-links-'))
  profiles._setRootsForTest({ resourcesDir: join(sandbox, 'res'), sharedRoot: join(sandbox, '.claude') })
  root = profiles.getProfilesRoot()
  fs.mkdirSync(root, { recursive: true })
  outside = join(sandbox, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(join(outside, '.credentials.json'), 'TARGET')
})
afterEach(() => {
  profiles._setRootsForTest(null)
  if (sandbox.startsWith(join(os.tmpdir(), 'ccc-identity-links-'))) fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('removeProfileIdentityCredentials: link-safe [CI] [VM]', () => {
  it('an identity folder that is a link is refused and nothing behind it is removed', () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    linkDir(outside, join(root, ID, 'identity'))
    expect(profiles.removeProfileIdentityCredentials(ID)).toBe(false)
    expect(fs.readFileSync(join(outside, '.credentials.json'), 'utf8')).toBe('TARGET')
  })

  it('a profile folder that is a link is refused and nothing behind it is removed', () => {
    fs.mkdirSync(join(outside, 'identity'), { recursive: true })
    fs.writeFileSync(join(outside, 'identity', '.credentials.json'), 'TARGET2')
    linkDir(outside, join(root, ID))
    expect(profiles.removeProfileIdentityCredentials(ID)).toBe(false)
    expect(fs.readFileSync(join(outside, 'identity', '.credentials.json'), 'utf8')).toBe('TARGET2')
  })

  it('a link at the copy itself is removed as the link; its target stays', () => {
    fs.mkdirSync(join(root, ID, 'identity'), { recursive: true })
    const at = join(root, ID, 'identity', '.credentials.json')
    try {
      fs.symlinkSync(join(outside, '.credentials.json'), at, 'file')
    } catch {
      // A file symlink needs a privilege Windows may not grant; a junction to a
      // folder at the same name stands in for it.
      linkDir(outside, at)
    }
    expect(profiles.removeProfileIdentityCredentials(ID)).toBe(true)
    expect(() => fs.lstatSync(at)).toThrow()
    expect(fs.readFileSync(join(outside, '.credentials.json'), 'utf8')).toBe('TARGET')
  })
})
