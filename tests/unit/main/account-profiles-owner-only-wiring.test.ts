// The account sign-in folders' owner-only check is wired into the app: the
// main process turns it on at start and runs the start's profile steps that
// write a sign-in only once every profile's folders are checked, and a managed
// launch held for its project check waits for its own profile's folder check
// too, so the launch reads a verdict; the account list the window reads at
// start, and a Claude session that names no account (it runs on the primary
// account those steps may still be making), wait for those profile steps; and
// the Claude sign-in check and sign-out wait for their account's folder check.
// Read from the source: the start sequence runs inside Electron's ready
// handler, the launches inside the terminal manager and IPC handlers, none of
// which a unit test here starts; the behaviour itself is pinned in
// account-profiles-owner-only-credentials.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/** A source file with its whole-line comments taken out (they may hold parentheses). */
function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** The argument text of the call whose opening parenthesis is at `open`. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error('unbalanced call')
}

const count = (text: string, needle: string) => text.split(needle).length - 1

describe('at start the profile steps that write a sign-in run only after every profile\'s folders are checked', () => {
  const src = code('src/main/index.ts')
  const CALL = 'startOwnerOnlyCredentialFolders('
  const STEPS = ['runFirstRunCapture()', 'cleanupSessionHomes()', 'syncPrimaryCredentialsWithGlobal()']

  it('the main process turns the check on, once, from the account profiles module', () => {
    expect(src).toMatch(/import \{[^}]*\bstartOwnerOnlyCredentialFolders\b[^}]*\} from '\.\/account-profiles'/)
    expect(count(src, CALL)).toBe(1)
  })

  it('every such step runs inside the check\'s continuation and nowhere else', () => {
    const at = src.indexOf(CALL)
    expect(at).toBeGreaterThan(-1)
    const inside = argsAt(src, at + CALL.length - 1)
    for (const step of STEPS) {
      expect(count(inside, step)).toBe(1)
      expect(count(src, step)).toBe(1)
    }
  })

  it('the check starts after the layout migration and the junction repair, which write no sign-in', () => {
    const at = src.indexOf(CALL)
    for (const before of ['migrateProfilesToHomeLayout()', 'repairSharedProjectJunctions()']) {
      expect(src.indexOf(before)).toBeGreaterThan(-1)
      expect(src.indexOf(before)).toBeLessThan(at)
    }
  })
})

describe('a managed launch held for its project check waits for its profile\'s folder check too', () => {
  const src = code('src/main/pty-manager.ts')

  it('the terminal manager waits for the profile\'s check while the launch is held', () => {
    expect(src).toMatch(/import \{[^}]*\bcheckProfileCredentialFolders\b[^}]*\} from '\.\/account-profiles'/)
    // Where the launch is held: from the folders its project check reads to the hold itself.
    const from = src.search(/=\s*managedLaunchGateDirs\(sessionId/)
    expect(from).toBeGreaterThan(-1)
    expect(src.indexOf('deferSpawnUntil(', from)).toBeGreaterThan(from)
    const held = src.slice(from, src.indexOf('deferSpawnUntil(', from))
    expect(held).toMatch(/await\s+(?:Promise\.all\(\[[^\]]*\bcheckProfileCredentialFolders\(|checkProfileCredentialFolders\()/)
  })
})

describe('the account list the window reads at start waits for the start\'s profile steps', () => {
  const src = code('src/main/ipc/account-profiles-handlers.ts')

  it('the list handler waits for the start\'s profile steps (the first sign-in capture among them) before it reads the list', () => {
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsSettled\b[^}]*\} from '\.\.\/account-profiles'/)
    const CALL = 'handle(IPC.ACCOUNT_PROFILES_LIST,'
    expect(count(src, CALL)).toBe(1)
    const body = argsAt(src, src.indexOf(CALL) + 'handle'.length)
    expect(body).toMatch(/await\s+startProfileStepsSettled\(\)[\s\S]*\blistProfiles\(\)/)
  })
})

describe('a Claude session that names no account waits for the start\'s profile steps before it starts', () => {
  const src = code('src/main/ipc/pty-handlers.ts')
  const body = src.slice(src.indexOf('const spawnSession = async ('), src.indexOf("ipcMain.handle('pty:spawn'"))

  it('a local Claude launch naming no account is held as a prepared spawn while the steps are still to run, and waits for them before it starts', () => {
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsPending\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(src).toMatch(/import \{[^}]*\bstartProfileStepsSettled\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(body.length).toBeGreaterThan(0)
    // Decided for a local Claude launch that names no account, while the steps are pending.
    const hold = body.match(/const (\w+) = launchProvider === 'claude' && !options\?\.ssh && !options\?\.profileId && startProfileStepsPending\(\)/)
    expect(hold).not.toBeNull()
    const name = hold![1]
    // Held as a prepared spawn, so a close or a newer spawn of the tab supersedes it while it waits.
    expect(body).toMatch(new RegExp(`const preparation = [^\\n]*\\b${name}\\b[^\\n]*\\? beginSpawnPreparation\\(`))
    // It waits for the steps before the closed-or-superseded check, so nothing starts for a tab closed meanwhile.
    const wait = body.search(new RegExp(`if \\(${name}\\) await startProfileStepsSettled\\(\\)`))
    expect(wait).toBeGreaterThan(-1)
    const superseded = body.indexOf('closed or superseded while its spawn was prepared')
    expect(superseded).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(superseded)
  })
})

describe('the Claude sign-in check and sign-out run only once their account\'s sign-in folders have a verdict', () => {
  const src = code('src/main/account-web/claude-cli-auth.ts')

  it('each waits for the account\'s folder check, when its folders have no verdict yet, before it builds the account\'s environment', () => {
    expect(src).toMatch(/import \{[^}]*\bcheckProfileCredentialFolders\b[^}]*\} from '\.\.\/account-profiles'/)
    expect(src).toMatch(/import \{[^}]*\bprofileCredentialFoldersChecked\b[^}]*\} from '\.\.\/account-profiles'/)
    for (const launchId of ['auth-status', 'auth-logout']) {
      const at = src.indexOf(`launchId: '${launchId}'`)
      expect(at, launchId).toBeGreaterThan(-1)
      expect(count(src, `launchId: '${launchId}'`), launchId).toBe(1)
      const fn = src.lastIndexOf('async function ', at)
      expect(src.slice(fn, at), launchId).toMatch(/if \(!profileCredentialFoldersChecked\(profileId\)\) await checkProfileCredentialFolders\(profileId\)/)
    }
  })
})

// Only the account sign-in folders have what is inside them read and put
// right (secureSignInFoldersWindows); every other caller of the owner-only
// rule -- the other assistant's managed folders and its hook folders -- gets
// the folders' own rights only (secureOwnerOnlyFolders), so a folder those
// callers secure never has what an account keeps inside it judged or reset.
describe('only the account sign-in folders have what is inside them read', () => {
  /** Every TypeScript file below `dir`, by its path from the repository root. */
  const files = (dir: string): string[] => fs.readdirSync(path.join(__dirname, '..', '..', '..', dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))

  it('the account rule asks for it, with the home mirror\'s links left out; no other source calls the rule with what is inside, or the rule\'s parts directly', () => {
    const ap = code('src/main/account-profiles.ts')
    expect(ap).toContain('const signInFolderRule: CredentialFolderRule = (dirs) => secureSignInFoldersWindows(dirs, homeMirrorLinks(dirs))')
    expect(ap).toContain('rule: CredentialFolderRule = signInFolderRule,')
    const sources = files(path.join('src', 'main')).filter((f) => path.basename(f) !== 'owner-only-folders.ts')
    expect(sources.length).toBeGreaterThan(10)
    for (const f of sources) {
      const src = code(f)
      if (path.basename(f) !== 'account-profiles.ts') expect(src, f).not.toMatch(/secureSignInFoldersWindows/)
      expect(src, f).not.toMatch(/secureFoldersWindows\s*\(|secureFoldersNative\s*\(/)
    }
    // The hook folders get the folders' own rule.
    expect(code('src/main/index.ts')).toContain('getResourcesDirectory(), secureOwnerOnlyFolders)')
  })
})
