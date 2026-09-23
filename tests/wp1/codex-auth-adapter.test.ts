// WP1.62 -- WP2 slice 3a (plan A7; design 9.2): `codex login status`
// is classified from its exit code and output alone; auth.json is never
// read, a printed key is never retained, and anything unexpected is an
// error, never "signed out". PURE.
import { describe, it, expect } from 'vitest'
import { parseCodexLoginStatus } from '../../src/main/providers/codex'

describe('codex login status', () => {
  it('classifies the pinned CLI outputs, on either stream', () => {
    expect(parseCodexLoginStatus(0, '', 'Logged in using ChatGPT\n')).toEqual({ state: 'signed-in', via: 'chatgpt' })
    expect(parseCodexLoginStatus(0, 'Logged in using ChatGPT\n', '')).toEqual({ state: 'signed-in', via: 'chatgpt' })
    expect(parseCodexLoginStatus(0, '', 'Logged in using an API key - sk-proj-***ABCD\n')).toEqual({ state: 'signed-in', via: 'api-key' })
    expect(parseCodexLoginStatus(0, 'Logged in using something new\n', '')).toEqual({ state: 'signed-in', via: 'unknown' })
    expect(parseCodexLoginStatus(1, '', 'Not logged in\n')).toEqual({ state: 'signed-out' })
  })

  it('never returns any part of the printed output', () => {
    const r = parseCodexLoginStatus(0, '', 'Logged in using an API key - sk-proj-SECRETSECRET\n')
    expect(JSON.stringify(r)).not.toMatch(/sk-|SECRET/)
  })

  it('strips terminal escapes and CRLF before matching', () => {
    expect(parseCodexLoginStatus(0, '\u001b[1mLogged in using ChatGPT\u001b[0m\r\n', '')).toEqual({ state: 'signed-in', via: 'chatgpt' })
  })

  it('an unexpected exit code or output is an error, never "signed out"', () => {
    expect(parseCodexLoginStatus(1, '', 'Error: failed to load config\n')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(2, '', 'Not logged in\n')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(null, '', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, 'Not logged in', '')).toEqual({ state: 'error' })
    // A line that merely mentions the phrase is not the status line.
    expect(parseCodexLoginStatus(0, 'warning: Logged in using ChatGPT is deprecated', '')).toEqual({ state: 'error' })
  })

  it('two status lines that could disagree are an error, whatever the exit code; a warning beside one is fine', () => {
    expect(parseCodexLoginStatus(0, 'Not logged in\nLogged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(1, 'Logged in using ChatGPT', 'Not logged in')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, 'Logged in using an API key - x\nLogged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '', 'WARNING: proceeding without the sandbox\nLogged in using ChatGPT')).toEqual({ state: 'signed-in', via: 'chatgpt' })
  })

  it('a Unicode lookalike, a NUL or a stray control sequence is not a status line', () => {
    expect(parseCodexLoginStatus(0, 'Lоgged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '\u0000Logged in using ChatGPT', '')).toEqual({ state: 'error' })
  })
})
