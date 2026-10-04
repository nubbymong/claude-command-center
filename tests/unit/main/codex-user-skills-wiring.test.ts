/// <reference types="vite/client" />
// [host] WP2 PR 4 (row 51; section 10 question 5, answered C; review B-S5):
// the app's canvas skills copied into this computer's own Codex folder are
// removed when Codex or the built-in tools are turned off, and kept current
// while both are on, at the places main's start-up wires
// (src/main/canvas/codex-user-skills.ts is tested on its own in
// codex-user-skills.test.ts). main/index.ts runs only in the booted app, so
// the two calls are pinned by its text, as settings-saved-accounts-wiring
// does for the accounts service:
//  - the start pass, wired once at start with the saved settings read as they
//    are (unreadable is no answer), Codex's switch in force, and the accounts
//    service's change announcements (the Providers switch);
//  - every settings save, in its own try so another hook's failure never
//    skips it.
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

/** The call, up to the parenthesis that closes it (counted, so a call inside
 *  its argument does not end it). */
function callBody(src: string, call: string): string {
  const at = src.indexOf(call)
  if (at < 0) return ''
  let depth = 0
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1)
  }
  return ''
}

describe('the copies in this computer\'s Codex folder follow the switches (question 5, C)', () => {
  it('[host] main\'s start-up wires the start pass: the saved settings as read, Codex\'s switch, and the accounts service\'s changes', () => {
    const body = callBody(indexSource, 'startCodexUserSkills({')
    expect(body).not.toBe('')
    expect(body).toMatch(/settings: \(\) => \{[\s\S]*readConfigChecked<Record<string, unknown>>\('settings', \{ quarantineUnparseable: false \}\)[\s\S]*r\.outcome === 'ok'[\s\S]*: null/)
    expect(body).toMatch(/codexOn: \(\) => providerOnNow\('codex'\)/)
    expect(body).toMatch(/subscribe: \(listener\) => getAccountsService\(\)\?\.subscribe\(listener\)/)
    // Imported from the module that does the work, not a stand-in.
    expect(indexSource).toMatch(/import \{[^}]*\bstartCodexUserSkills\b[^}]*\bcodexUserSkillsSettingsChanged\b[^}]*\} from '\.\/canvas\/codex-user-skills'/)
  })

  it('[host] every settings save applies the switches to the copies, in its own try', () => {
    const start = indexSource.indexOf('onSettingsSaved:')
    expect(start).toBeGreaterThan(-1)
    const body = indexSource.slice(start, indexSource.indexOf('})', start))
    expect(body).toMatch(/try \{ codexUserSkillsSettingsChanged\(\) \} catch \(err\) \{ logError\(/)
  })
})
