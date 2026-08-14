import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * BEHAVIOURAL tests for the destructive half of build/installer.nsh.
 *
 * The sibling brand-identity-guard.test.ts asserts that the guards are PRESENT.
 * Presence is not enough and was measured not to be: every deletion mutant went
 * red, and every POLARITY mutant stayed green — including `${If} $R8 == 1`
 * rewritten to `${If} "1" == "1"` immediately before `RMDir /r`, which compiled,
 * ran, and destroyed a junction target, a source checkout and the user's
 * CONFIG/settings.json with the suite still green.
 *
 * So this compiles the REAL macros out of build/installer.nsh with the REAL
 * makensis, runs them over a real fixture tree (junction, source checkout, data
 * directory, a directory named like an uninstaller, a triple-nested legacy
 * chain) and asserts which paths survive and which do not. A flipped guard
 * changes what is on disk afterwards, which is the only thing that can catch it.
 *
 * Sandboxing, because this executes RMDir /r and writes to the registry for
 * real:
 *   - every path lives under a mkdtemp directory that is removed afterwards;
 *   - `Software\<brand>` reads/writes are rewritten to `Software\CccProbe\…`
 *     and that key is deleted afterwards;
 *   - `$DESKTOP` / `$SMPROGRAMS` are rewritten to a fixture directory so the
 *     shortcut deletion cannot reach the real user's Desktop or Start Menu.
 *
 * Skips (does not fail) when makensis is unavailable, so non-Windows CI is
 * unaffected — with a tripwire below that fails if it skips on a machine that
 * plainly does have it.
 */

const NSH = join(__dirname, '../../../build/installer.nsh')

/** Macros lifted verbatim out of build/installer.nsh into the probe script. */
const PROBE_MACROS = [
  'IsLegacyBrandFolder',
  'IsChainFolder',
  'IsSameOrInside',
  'PathsOverlap',
  'CanonPathPair',
  'PathsOverlapCanon',
  'FindLegacyRoot',
  'ReadUserPath',
  'CccGetInQuotes',
  'RemoveLegacyInstall',
  'ProveLegacyInstallRoot',
  'ClassifyUninstallRecord',
  'ForgetPreviousInstallIn',
  'ForgetBrokenPreviousInstall',
  'SuspendUninstallRecordIn',
  'CaptureRecordedUninstaller',
  'RetargetRecordedInstallLocation',
  'customHeader',
  'customInit',
  'customInstall',
  'AdoptLegacyValue',
]

const PROBE_REG_KEY = 'HKCU\\Software\\CccProbe'

function nsisCacheRoot(): string | null {
  const local = process.env.LOCALAPPDATA
  return local ? join(local, 'electron-builder', 'Cache', 'nsis') : null
}

function findMakensis(): string | null {
  if (process.platform !== 'win32') return null
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const cache = nsisCacheRoot()
  if (cache && existsSync(cache)) {
    // Newest first, so a refreshed cache wins over a stale one.
    const versions = readdirSync(cache)
      .filter((n) => n.startsWith('nsis-'))
      .sort()
      .reverse()
    for (const v of versions) {
      const exe = join(cache, v, 'makensis.exe')
      if (existsSync(exe)) return exe
    }
  }
  for (const p of [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return null
}

const MAKENSIS = findMakensis()

describe('installer.nsh behavioural probe — availability', () => {
  it('finds makensis wherever electron-builder cached it', () => {
    // The whole point of this file is that it RUNS. If the locator quietly
    // stops finding a compiler that is obviously present, everything below
    // turns into a green no-op and the guards go back to being untested.
    const cache = nsisCacheRoot()
    const cachePresent =
      process.platform === 'win32' && cache !== null && existsSync(cache) &&
      readdirSync(cache).some((n) => n.startsWith('nsis-'))
    if (cachePresent) expect(MAKENSIS).not.toBeNull()
    else expect(true).toBe(true) // nothing to find; the suite below skips
  })
})

/** One probe run's inputs. Everything is read at RUNTIME from an ini file, so
 *  the two probe executables are compiled once and re-used by every scenario. */
interface ProbeConfig {
  instdir: string
  parent: string
  data: string
  res: string
  legacyUninstaller: string
  linkRoot: string
  dparam: string
  installMode: string
  inner: boolean
  repage: boolean
  shortenInstdir: boolean
  abort: boolean
  seedFromRegistry: boolean
}

function extractMacros(): string {
  const src = readFileSync(NSH, 'utf-8')
  const text = PROBE_MACROS.map((name) => {
    const m = src.match(new RegExp(`^!macro ${name}\\b[\\s\\S]*?^!macroend`, 'm'))
    if (!m) throw new Error(`macro ${name} not found in build/installer.nsh`)
    return m[0]
  }).join('\n\n')

  return text
    // Sandbox the app's own registry keys — the probe must never touch the real ones.
    .replace(/Software\\(AI Code Conductor|Claude Command Center|Claude Conductor)/g,
      'Software\\CccProbe\\$1')
    // ...and never the real user's shortcuts.
    .replace(/\$DESKTOP/g, '$cccProbeLinkRoot')
    .replace(/\$SMPROGRAMS/g, '$cccProbeLinkRoot')
}

function probeScript(mode: 'sweep' | 'e2e', out: string, cfg: string, log: string): string {
  const readCfg = (v: string, key: string) => `  ReadINIStr ${v} "${cfg}" "probe" "${key}"`

  const body = mode === 'sweep'
    ? `
  StrCpy $INSTDIR $cccProbeInstDir
  \${If} $cccProbeShorten == "1"
    GetFullPathName /SHORT $R0 "$INSTDIR"
    \${If} $R0 != ""
      StrCpy $INSTDIR "$R0"
    \${EndIf}
    ClearErrors
  \${EndIf}
  FileWrite $cccProbeLog "instdir=$INSTDIR$\\r$\\n"
  StrCpy $R3 $cccProbeData
  StrCpy $R4 $cccProbeRes
  StrCpy $cccLegacyUninstaller $cccProbeLegacyUninst
  StrCpy $R2 $cccProbeParent
  !insertmacro RemoveLegacyInstall "$R2\\Claude Conductor Beta" "Claude Conductor Beta"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Command Center Beta" "Claude Command Center Beta"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Command Center" "Claude Command Center"
  !insertmacro RemoveLegacyInstall "$R2\\Claude Conductor" "Claude Conductor"
`
    : `
  ; initMultiUser: $INSTDIR is seeded from the recorded install location.
  StrCpy $INSTDIR $cccProbeInstDir
  \${If} $cccProbeSeedReg == "1"
    ReadRegStr $0 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $0 != ""
      StrCpy $INSTDIR "$0"
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "seed=$INSTDIR$\\r$\\n"

  !insertmacro customInit
  ReadRegStr $9 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  FileWrite $cccProbeLog "afterInit=$INSTDIR$\\r$\\n"
  FileWrite $cccProbeLog "installLocationAfterInit=$9$\\r$\\n"
  FileWrite $cccProbeLog "captured=$cccLegacyUninstaller$\\r$\\n"

  ; Interactive run: the install-mode page's Leave callback re-runs
  ; setInstallModePerUser, which re-seeds $INSTDIR from the same value.
  \${If} $cccProbeRepage == "1"
    ReadRegStr $0 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $0 != ""
      StrCpy $INSTDIR "$0"
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "afterPage=$INSTDIR$\\r$\\n"

  \${If} $cccProbeAbort == "1"
    ; The wizard is cancelled after customInit — MUI's abort callback.
    Call CccRestoreInstallLocation
    ReadRegStr $7 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $8 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    FileWrite $cccProbeLog "restoredInstallLocation=$7$\\r$\\n"
    FileWrite $cccProbeLog "restoredUninstallString=$8$\\r$\\n"
    Goto cccProbeFinished

  \${EndIf}

  ; installSection.nsh: CHECK_APP_RUNNING, guarded by \${ifNot} \${UAC_IsInnerInstance}.
  \${If} $cccProbeInner != "1"
    !insertmacro ForgetBrokenPreviousInstall
  \${EndIf}

  ; installSection.nsh: uninstallOldVersion — where the OLD uninstaller is run,
  ; with _?=<installationDir> resolved exactly as installUtil.nsh:155-176 does.
  ReadRegStr $1 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCpy $2 ""
  \${If} $1 != ""
    !insertmacro CccGetInQuotes "$1" $3
    ReadRegStr $2 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
    \${If} $2 == ""
      \${GetParent} "$3" $2
    \${EndIf}
  \${EndIf}
  FileWrite $cccProbeLog "oldUninstallString=$1$\\r$\\n"
  FileWrite $cccProbeLog "oldUninstallTarget=$2$\\r$\\n"

  ; installApplicationFiles + registryAddInstallInfo.
  CreateDirectory "$INSTDIR"
  FileOpen $4 "$INSTDIR\\AI Code Conductor.exe" w
  FileWrite $4 "new"
  FileClose $4
  FileOpen $4 "$INSTDIR\\Uninstall AI Code Conductor.exe" w
  FileWrite $4 "new"
  FileClose $4
  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$INSTDIR\\Uninstall AI Code Conductor.exe" /currentuser'

  !insertmacro customInstall

  ReadRegStr $5 HKCU "\${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $6 HKCU "\${INSTALL_REGISTRY_KEY}" "InstallLocation"
  FileWrite $cccProbeLog "arpUninstallString=$5$\\r$\\n"
  FileWrite $cccProbeLog "arpInstallLocation=$6$\\r$\\n"
  FileWrite $cccProbeLog "final=$INSTDIR$\\r$\\n"
  cccProbeFinished:
`

  return `Unicode true
SetCompress off
RequestExecutionLevel user
SilentInstall silent
Name "CccInstallerProbe"
OutFile "${out}"
InstallDir "$TEMP\\ccc-nsis-probe-unused"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP_FILENAME "AI Code Conductor"
!define INSTALL_REGISTRY_KEY "Software\\CccProbe\\Install"
!define UNINSTALL_REGISTRY_KEY "Software\\CccProbe\\Uninstall"

Var installMode
Var cccProbeLog
Var cccProbeInner
Var cccProbeRepage
Var cccProbeShorten
Var cccProbeAbort
Var cccProbeSeedReg
Var cccProbeInstDir
Var cccProbeParent
Var cccProbeData
Var cccProbeRes
Var cccProbeLegacyUninst
Var cccProbeLinkRoot
Var cccProbeD

; multiUser.nsh's UAC predicate, driven by the ini instead of a real elevation.
!define UAC_IsInnerInstance \`$cccProbeInner == "1"\`

; multiUser.nsh's /D= reader, driven by the ini instead of StdUtils.
!macro GetDParameter outVar
  StrCpy \${outVar} $cccProbeD
!macroend

${extractMacros()}

!insertmacro customHeader

Page instfiles

Section "probe"
  SetShellVarContext current
${readCfg('$cccProbeInstDir', 'instdir')}
${readCfg('$cccProbeParent', 'parent')}
${readCfg('$cccProbeData', 'data')}
${readCfg('$cccProbeRes', 'res')}
${readCfg('$cccProbeLegacyUninst', 'legacyUninstaller')}
${readCfg('$cccProbeLinkRoot', 'linkRoot')}
${readCfg('$cccProbeD', 'dparam')}
${readCfg('$cccProbeInner', 'inner')}
${readCfg('$cccProbeRepage', 'repage')}
${readCfg('$cccProbeShorten', 'shortenInstdir')}
${readCfg('$cccProbeAbort', 'abort')}
${readCfg('$cccProbeSeedReg', 'seedFromRegistry')}
${readCfg('$installMode', 'installMode')}
  ClearErrors
  FileOpen $cccProbeLog "${log}" w
${body}
  FileWrite $cccProbeLog "done=1$\\r$\\n"
  FileClose $cccProbeLog
SectionEnd
`
}

// ---------------------------------------------------------------- harness ---

let work = ''
const sweepExe = () => join(work, 'probe-sweep.exe')
const e2eExe = () => join(work, 'probe-e2e.exe')
const cfgPath = () => join(work, 'probe.ini')
const logPath = () => join(work, 'probe.log')

function compile(mode: 'sweep' | 'e2e', out: string) {
  const nsi = join(work, `probe-${mode}.nsi`)
  writeFileSync(nsi, probeScript(mode, out, cfgPath(), logPath()))
  try {
    execFileSync(MAKENSIS as string, ['/V2', nsi], { encoding: 'utf-8', stdio: 'pipe' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    throw new Error(`makensis failed for ${mode}:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  }
}

function run(mode: 'sweep' | 'e2e', cfg: Partial<ProbeConfig>): Record<string, string> {
  const merged: ProbeConfig = {
    instdir: '', parent: '', data: '', res: '', legacyUninstaller: '', linkRoot: '',
    dparam: '', installMode: 'CurrentUser', inner: false, repage: false,
    shortenInstdir: false, abort: false, seedFromRegistry: true, ...cfg,
  }
  writeFileSync(cfgPath(), [
    '[probe]',
    `instdir=${merged.instdir}`,
    `parent=${merged.parent}`,
    `data=${merged.data}`,
    `res=${merged.res}`,
    `legacyUninstaller=${merged.legacyUninstaller}`,
    `linkRoot=${merged.linkRoot}`,
    `dparam=${merged.dparam}`,
    `installMode=${merged.installMode}`,
    `inner=${merged.inner ? 1 : 0}`,
    `repage=${merged.repage ? 1 : 0}`,
    `shortenInstdir=${merged.shortenInstdir ? 1 : 0}`,
    `abort=${merged.abort ? 1 : 0}`,
    `seedFromRegistry=${merged.seedFromRegistry ? 1 : 0}`,
    '',
  ].join('\r\n'))
  rmSync(logPath(), { force: true })
  execFileSync(mode === 'sweep' ? sweepExe() : e2eExe(), [], { encoding: 'utf-8', stdio: 'pipe' })
  const out: Record<string, string> = {}
  for (const line of readFileSync(logPath(), 'utf-8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  if (out.done !== '1') throw new Error(`probe did not complete: ${JSON.stringify(out)}`)
  return out
}

const dir = (p: string) => mkdirSync(p, { recursive: true })
const file = (p: string, c = 'x') => { dir(dirname(p)); writeFileSync(p, c) }
const junction = (link: string, target: string) =>
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' })

function regClear() {
  try { execFileSync('reg', ['delete', PROBE_REG_KEY, '/f'], { stdio: 'pipe' }) } catch { /* absent */ }
}
function regSet(sub: string, name: string, value: string) {
  execFileSync('reg',
    ['add', `${PROBE_REG_KEY}\\${sub}`, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    { stdio: 'pipe' })
}

/** A fresh fixture root per scenario; RMDir /r makes them single-use. */
function scenario(name: string) {
  const root = join(work, name)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  const links = join(root, 'links')
  dir(links)
  return { root, programs: join(root, 'Programs'), links }
}

/** The triple-nested shape this whole change exists to clean up. */
function nestedChain(programs: string) {
  return join(programs, 'Claude Conductor Beta', 'Claude Command Center Beta', 'AI Code Conductor')
}

describe.skipIf(!MAKENSIS)('installer.nsh behavioural probe', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ccc-nsis-probe-'))
    regClear()
    compile('sweep', sweepExe())
    compile('e2e', e2eExe())
  }, 120_000)

  afterAll(() => {
    regClear()
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  })

  it('sweeps the nested legacy tree and nothing else', () => {
    const { root, programs, links } = scenario('guards')
    dir(join(programs, 'AI Code Conductor'))

    // (a) the owner's real shape: the uninstaller exists ONLY at the leaf.
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))

    // (b) a junction whose target holds a perfectly good uninstaller.
    dir(join(root, 'junction-target'))
    file(join(root, 'junction-target', 'keep.txt'))
    file(join(root, 'junction-target', 'Uninstall AI Code Conductor.exe'))
    junction(join(programs, 'Claude Command Center'), join(root, 'junction-target'))

    // (c) a source checkout, with a DIRECTORY named like an uninstaller.
    file(join(programs, 'Claude Conductor', 'src', 'index.ts'))
    dir(join(programs, 'Claude Conductor', 'Uninstall trick.exe'))

    // (d) the user's data directory, which is also a legacy-named sibling AND
    //     contains a real uninstaller, so only the overlap check saves it.
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))

    file(join(links, 'Claude Conductor Beta.lnk'))
    file(join(links, 'Claude Conductor.lnk'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data,
      res: join(root, 'res'),
      linkRoot: links,
    })

    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(false)
    expect(existsSync(join(links, 'Claude Conductor Beta.lnk'))).toBe(false)
    // junction, and above all the tree it points at
    expect(existsSync(join(programs, 'Claude Command Center'))).toBe(true)
    expect(existsSync(join(root, 'junction-target', 'keep.txt'))).toBe(true)
    // source checkout — a directory called "Uninstall trick.exe" is not proof
    expect(existsSync(join(programs, 'Claude Conductor', 'src', 'index.ts'))).toBe(true)
    // user data
    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
    // and the install we just made
    expect(existsSync(join(programs, 'AI Code Conductor'))).toBe(true)
    expect(existsSync(join(links, 'Claude Conductor.lnk'))).toBe(true)
  }, 60_000)

  it('refuses a data directory recorded with forward slashes', () => {
    const { root, programs, links } = scenario('slash')
    dir(join(programs, 'AI Code Conductor'))
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: data.replace(/\\/g, '/'),
      res: join(root, 'res'),
      linkRoot: links,
    })

    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
  }, 60_000)

  it('refuses everything when the data/resources directories are unreadable', () => {
    // HKCU-only reads come back empty on an all-users install elevated by a
    // different admin. Empty must mean "cannot tell", not "no overlap".
    const { programs, links } = scenario('unknown-data')
    dir(join(programs, 'AI Code Conductor'))
    const data = join(programs, 'Claude Command Center Beta')
    file(join(data, 'CONFIG', 'settings.json'), '{}')
    file(join(data, 'Uninstall AI Code Conductor.exe'))
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: '',
      res: '',
      linkRoot: links,
    })

    expect(existsSync(join(data, 'CONFIG', 'settings.json'))).toBe(true)
    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(true)
  }, 60_000)

  it('never sweeps $INSTDIR, even spelled as an 8.3 short name', () => {
    const { root, programs, links } = scenario('shortname')
    const target = join(programs, 'Claude Conductor')
    file(join(target, 'Uninstall AI Code Conductor.exe'))
    file(join(target, 'app.asar'))
    dir(join(root, 'data'))
    dir(join(root, 'res'))

    const log = run('sweep', {
      instdir: target,
      parent: programs,
      data: join(root, 'data'),
      res: join(root, 'res'),
      linkRoot: links,
      shortenInstdir: true,
    })

    // Only meaningful where the volume actually generates 8.3 names.
    if (log.instdir.toLowerCase() !== target.toLowerCase()) {
      expect(log.instdir).toMatch(/~1/)
    }
    expect(existsSync(join(target, 'app.asar'))).toBe(true)
  }, 60_000)

  it('accepts the uninstaller the replaced install recorded as proof', () => {
    // No "Uninstall *.exe" anywhere in the tree — the only evidence is the path
    // the ARP record named, captured by customInit before it was rewritten.
    const { root, programs, links } = scenario('recorded')
    dir(join(programs, 'AI Code Conductor'))
    const leaf = nestedChain(programs)
    dir(leaf)
    file(join(leaf, 'unins000.exe'))
    file(join(programs, 'Claude Conductor', 'src', 'index.ts'))
    dir(join(root, 'data'))
    dir(join(root, 'res'))

    run('sweep', {
      instdir: join(programs, 'AI Code Conductor'),
      parent: programs,
      data: join(root, 'data'),
      res: join(root, 'res'),
      linkRoot: links,
      legacyUninstaller: join(leaf, 'unins000.exe'),
    })

    expect(existsSync(join(programs, 'Claude Conductor Beta'))).toBe(false)
    // ...and the record proves nothing about a folder it does not name.
    expect(existsSync(join(programs, 'Claude Conductor', 'src', 'index.ts'))).toBe(true)
  }, 60_000)

  /** The owner's real case, start to finish. */
  function upgradeFixture(name: string, uninstallerName = 'Uninstall AI Code Conductor.exe') {
    const s = scenario(name)
    const leaf = nestedChain(s.programs)
    dir(leaf)
    file(join(leaf, uninstallerName))
    file(join(leaf, 'app.asar'))
    file(join(s.root, 'data', 'CONFIG', 'settings.json'), '{}')
    dir(join(s.root, 'res'))

    regClear()
    regSet('Install', 'InstallLocation', leaf)
    regSet('Uninstall', 'UninstallString', `"${join(leaf, uninstallerName)}" /currentuser`)
    // Only the LEGACY brand key has them, so customInstall's AdoptLegacyValue is
    // what makes the data-directory guard usable at all.
    regSet('Claude Command Center', 'DataDirectory', join(s.root, 'data'))
    regSet('Claude Command Center', 'ResourcesDirectory', join(s.root, 'res'))
    return { ...s, leaf, uninstaller: join(leaf, uninstallerName), expected: join(s.programs, 'AI Code Conductor') }
  }

  for (const [label, opts] of [
    ['silently (/S)', { repage: false }],
    ['interactively', { repage: true }],
  ] as const) {
    it(`upgrades a triple-nested install ${label}`, () => {
      const f = upgradeFixture(`e2e-${opts.repage ? 'interactive' : 'silent'}`)
      const log = run('e2e', { instdir: f.expected, parent: f.programs, linkRoot: f.links, ...opts })
      regClear()

      // relocated out of the legacy tree, and the relocation SURVIVED the
      // install-mode page re-reading InstallLocation
      expect(log.afterInit).toBe(f.expected)
      expect(log.afterPage).toBe(f.expected)
      // the old uninstaller is never run
      expect(log.oldUninstallString).toBe('')
      expect(log.oldUninstallTarget).toBe('')
      // the old tree is GONE — the regression this change exists to fix
      expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
      // ...and the ARP record points at the new install
      expect(log.arpInstallLocation).toBe(f.expected)
      expect(log.arpUninstallString).toContain(f.expected)
      expect(existsSync(join(f.expected, 'AI Code Conductor.exe'))).toBe(true)
      // user data untouched
      expect(existsSync(join(f.root, 'data', 'CONFIG', 'settings.json'))).toBe(true)
    }, 60_000)
  }

  it('carries the recorded uninstaller across the commit point as proof', () => {
    // Nothing in the tree matches "Uninstall *.exe", so the ONLY thing that can
    // prove the folder is an install of this app is the path the ARP record
    // named — and by the time customInstall runs, the commit point has cleared
    // that record and registryAddInstallInfo has written a new one pointing at
    // $INSTDIR. customInit capturing it in .onInit is the whole mechanism.
    const f = upgradeFixture('e2e-recorded', 'unins000.exe')
    const log = run('e2e', { instdir: f.expected, parent: f.programs, linkRoot: f.links })
    regClear()

    expect(log.captured).toBe(f.uninstaller)
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
  }, 60_000)

  it('leaves an install location recorded OUTSIDE the legacy tree alone', () => {
    // appId is frozen, so a per-user and a per-machine install share the key
    // PATH but are two separate installations. Retargeting a record that does
    // not name the tree being replaced would point the OTHER installation's
    // uninstaller — and its own next upgrade — at this run's directory.
    const s = scenario('e2e-foreign-record')
    const leaf = nestedChain(s.programs)
    dir(leaf)
    file(join(leaf, 'Uninstall AI Code Conductor.exe'))
    const foreign = join(s.programs, 'Elsewhere', 'AI Code Conductor')
    file(join(foreign, 'Uninstall AI Code Conductor.exe'))
    file(join(s.root, 'data', 'CONFIG', 'settings.json'), '{}')
    dir(join(s.root, 'res'))

    regClear()
    regSet('Install', 'InstallLocation', foreign)
    regSet('Claude Command Center', 'DataDirectory', join(s.root, 'data'))
    regSet('Claude Command Center', 'ResourcesDirectory', join(s.root, 'res'))

    const log = run('e2e', {
      instdir: leaf, parent: s.programs, linkRoot: s.links, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(join(s.programs, 'AI Code Conductor'))
    expect(log.installLocationAfterInit).toBe(foreign)
  }, 60_000)

  it('never aims the old uninstaller at the new directory in the elevated inner instance', () => {
    // installSection.nsh:35-37 skips CHECK_APP_RUNNING for ${UAC_IsInnerInstance},
    // so the commit-point clear never runs there while customInit's retarget
    // does — which pointed uninstallOldVersion's _?= at the NEW directory and
    // had the old uninstaller RMDir /r it before installApplicationFiles.
    const f = upgradeFixture('e2e-inner')
    const log = run('e2e', {
      instdir: f.expected, parent: f.programs, linkRoot: f.links,
      inner: true, repage: true, installMode: 'all',
    })
    regClear()

    expect(log.afterPage).toBe(f.expected)
    expect(log.oldUninstallTarget).not.toBe(f.expected)
    expect(log.oldUninstallString).toBe('')
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(false)
    expect(existsSync(join(f.root, 'data', 'CONFIG', 'settings.json'))).toBe(true)
  }, 60_000)

  it('puts the retargeted and suspended registry values back when the wizard is cancelled', () => {
    // customInit rewrites InstallLocation (and, in the elevated inner instance,
    // removes UninstallString) inside .onInit — long before the user commits.
    // Both are the uninstaller's only way home: a dangling InstallLocation makes
    // a later Add/Remove-Programs uninstall delete nothing and then drop the
    // entry, and a missing UninstallString removes the uninstall button.
    const f = upgradeFixture('e2e-abort')
    const log = run('e2e', {
      instdir: f.expected, parent: f.programs, linkRoot: f.links,
      inner: true, repage: true, installMode: 'all', abort: true,
    })
    regClear()

    expect(log.afterInit).toBe(f.expected) // the retarget did happen...
    expect(log.restoredInstallLocation).toBe(f.leaf) // ...and was undone
    expect(log.restoredUninstallString)
      .toBe(`"${join(f.leaf, 'Uninstall AI Code Conductor.exe')}" /currentuser`)
  }, 60_000)

  it('never relocates an explicit /D= directory', () => {
    const f = upgradeFixture('e2e-dparam-relocate')
    const log = run('e2e', {
      instdir: f.leaf, parent: f.programs, linkRoot: f.links,
      dparam: f.leaf, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(f.leaf)
  }, 60_000)

  it('never sweeps the siblings of an explicit /D= directory', () => {
    // initMultiUser applies /D= last, so $INSTDIR is the operator's directory
    // and its siblings are not this installer's business — the same reasoning
    // that already suppresses the relocation.
    const f = upgradeFixture('e2e-dparam-sweep')
    const custom = join(f.programs, 'Custom Location')
    dir(custom)
    const log = run('e2e', {
      instdir: custom, parent: f.programs, linkRoot: f.links,
      dparam: custom, seedFromRegistry: false,
    })
    regClear()

    expect(log.afterInit).toBe(custom)
    expect(existsSync(join(f.programs, 'Claude Conductor Beta'))).toBe(true)
  }, 60_000)
})
