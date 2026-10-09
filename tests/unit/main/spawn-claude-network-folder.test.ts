// A Claude Code session in a network folder (src/main/spawn-claude-command.ts
// buildClaudeLaunchCommand): cmd.exe cannot start in a share or a device path
// (two leading slashes of either kind), so a launch line that would start
// Claude Code's npm launcher (claude.cmd) in such a folder is refused with the
// reason, on every route that starts it there: a fresh launch, an exact
// resume, and the picker's fallback when the picker is not deployed. The
// native claude.exe starts there as before, so does every drive folder, and
// the picker itself (node takes a network folder; the picker refuses its own
// launch there, resume-picker-network-folder). Pure: nothing is started.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildClaudeLaunchCommand, CLAUDE_NETWORK_FOLDER_REFUSAL } from '../../../src/main/spawn-claude-command'

const SENTENCE = 'Cannot start Claude Code in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the native Claude Code.'
const NETWORK = ['\\\\srv\\share\\project', '//srv/share/project', '\\/srv\\share', '\\\\?\\C:\\project', '\\\\?\\UNC\\srv\\share\\project', '\\\\.\\C:\\project']
const SHIM = 'C:\\npm\\claude.cmd'
const EXE = 'C:\\native\\claude.exe'
const PICKER = 'C:\\res\\scripts\\resume-picker.js'
const UUID = '11111111-2222-3333-4444-555555555555'

type Route = { name: string; useResumePicker: boolean; pickerScript: string | null; resumeUuid?: string; askPrompt?: boolean }
// Every line that starts Claude Code itself.
const ROUTES: Route[] = [
  { name: 'fresh', useResumePicker: false, pickerScript: null },
  { name: 'ask', useResumePicker: false, pickerScript: null, askPrompt: true },
  { name: 'exact resume', useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID },
  { name: 'picker not deployed', useResumePicker: true, pickerScript: null },
]
const build = (cwd: string, claudeBin: string, r: Route, platform = 'win32') => buildClaudeLaunchCommand({
  platform, cwd, claudeBin, extraFlags: ' --model opus', agentsFlag: '', useResumePicker: r.useResumePicker, pickerScript: r.pickerScript, resumeUuid: r.resumeUuid, askPrompt: r.askPrompt,
})

describe('a network folder on the npm launcher route is refused with the reason', () => {
  it('every route that starts the npm launcher itself, in a share or a device path, either slash', () => {
    for (const r of ROUTES) {
      for (const cwd of NETWORK) {
        expect(() => build(cwd, SHIM, r), `${r.name} ${cwd}`).toThrow(SENTENCE)
        expect(() => build(cwd, 'C:\\npm\\CLAUDE.BAT', r), `${r.name} ${cwd}`).toThrow(SENTENCE)
      }
    }
  })

  it('the sentence is exported, and it is the one the resume picker says', () => {
    expect(CLAUDE_NETWORK_FOLDER_REFUSAL).toBe(SENTENCE)
    const picker = readFileSync(join(__dirname, '../../../scripts/resume-picker.js'), 'utf8')
    expect(picker).toContain(`'${SENTENCE}'`)
  })
})

describe('everything else starts as before', () => {
  it('the npm launcher in a drive folder', () => {
    expect(build('C:\\proj', SHIM, ROUTES[0])).toBe("Set-Location 'C:\\proj'; & 'C:\\npm\\claude.cmd' --model opus; exit")
    expect(build('z:/proj', SHIM, ROUTES[2])).toBe(`Set-Location 'z:/proj'; & 'C:\\npm\\claude.cmd' --resume ${UUID} --model opus; exit`)
  })

  it('the native claude.exe in a network folder', () => {
    for (const r of ROUTES) {
      for (const cwd of NETWORK) expect(build(cwd, EXE, r), `${r.name} ${cwd}`).toContain(`Set-Location '${cwd}'; & '${EXE}'`)
    }
  })

  it('the picker line in a network folder: node starts there, and the picker decides', () => {
    for (const cwd of NETWORK) {
      expect(build(cwd, SHIM, { name: 'picker', useResumePicker: true, pickerScript: PICKER })).toBe(`Set-Location '${cwd}'; node '${PICKER}' --model opus; exit`)
    }
  })

  it('macOS and Linux: no cmd.exe, nothing changes', () => {
    expect(build('//srv/share', '/usr/local/bin/claude.cmd', ROUTES[0], 'posix')).toBe("cd '//srv/share' && '/usr/local/bin/claude.cmd' --model opus; exit")
  })
})
