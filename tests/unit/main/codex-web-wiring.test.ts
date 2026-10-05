/// <reference types="vite/client" />
// [host] WP2 PR 4, P4.6 second half (row 58): main's start-up wires a Codex
// account's chatgpt.com web session exactly as its guarantees need.
// main/index.ts runs only in the booted app, so the wiring is pinned by its
// text (as codex-user-skills-wiring and settings-saved-accounts-wiring pin
// theirs); each wired function is tested on its own elsewhere:
//  - the archive hook is registered BEFORE the accounts service exists, so no
//    archive can run without clearing the web session first;
//  - the account's panes close before its partition is wiped, and its record
//    is forgotten after;
//  - the codexWeb channels are registered with the app window, and a pane
//    opens only for a Codex session holding that account's launch lease.
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

/** The call, up to the parenthesis that closes it (counted). */
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

describe('[host] the chatgpt.com web session is wired at start', () => {
  it('the archive hook is registered before the accounts service is made', () => {
    const hook = indexSource.indexOf('onBeforeAccountArchive(prepareCodexWebArchive)')
    const service = indexSource.indexOf('initProviderAccounts({')
    expect(hook).toBeGreaterThan(0)
    expect(service).toBeGreaterThan(0)
    expect(hook).toBeLessThan(service)
    expect(indexSource).toMatch(/import \{[^}]*\bonBeforeAccountArchive\b[^}]*\} from '\.\/providers\/core'/)
    expect(indexSource).toMatch(/import \{[^}]*\bprepareCodexWebArchive\b[^}]*\} from '\.\/account-web\/codex-web-session'/)
  })

  it('the panes close before a wipe, and the record goes after it', () => {
    expect(indexSource).toContain('onCodexWebSessionClosing(closeCodexAccountPanes)')
    expect(indexSource).toContain('onCodexWebSessionCleared(removeCodexWebSession)')
    // Never the panes only after the wipe.
    expect(indexSource).not.toContain('onCodexWebSessionCleared(closeCodexAccountPanes)')
    expect(indexSource).toMatch(/import \{[^}]*\bcloseCodexAccountPanes\b[^}]*\} from '\.\/account-web\/account-pane'/)
    expect(indexSource).toMatch(/import \{[^}]*\bremoveCodexWebSession\b[^}]*\} from '\.\/account-web\/codex-web-store'/)
  })

  it('the channels answer the app window, and bind a pane to a Codex session holding the account', () => {
    const body = callBody(indexSource, 'registerCodexWebHandlers(getWindow')
    expect(body).not.toBe('')
    expect(body).toMatch(/sessionRunsUnder: \(sessionId, accountId\) => isCodexPtySession\(sessionId\) && getConsumerLeases\(\)\.sessionsHolding\(accountId\)\.includes\(sessionId\)/)
    expect(indexSource).toMatch(/import \{[^}]*\bgetConsumerLeases\b[^}]*\} from '\.\/provider-account-registry'/)
    expect(indexSource).toMatch(/import \{[^}]*\bregisterCodexWebHandlers\b[^}]*\} from '\.\/ipc\/codex-web-handlers'/)
  })
})
