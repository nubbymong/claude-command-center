// tests/unit/renderer/session-launch.test.ts
import { describe, it, expect } from 'vitest'
import { shouldGateAccountChoice, canSwitchAccountForSession, sshMappedProfileId, formatSpawnError, resolveResumeAccountMode, shouldPredetermineRestoredAccount, sessionAgentName } from '../../../src/renderer/utils/sessionLaunch'
import fs from 'node:fs'
import path from 'node:path'

describe('the partner strip names the tab\'s own assistant (walk fix N4)', () => {
  it('Codex for a Codex tab; Claude for a Claude tab or one with no provider, as before', () => {
    expect(sessionAgentName('codex')).toBe('Codex')
    expect(sessionAgentName('claude')).toBe('Claude')
    expect(sessionAgentName(undefined)).toBe('Claude')
  })
  it('App\'s partner strip says it for the tab it sits in, in its note, its button and its title', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toContain('const agentName = sessionAgentName(session.provider)')
    expect(app).toContain('Partner terminal &mdash; a plain shell, not {agentName}</span>')
    expect(app).toContain('title={`Back to the ${agentName} terminal`}')
    expect(app).toMatch(/\n\s*Back to \{agentName\}\n\s*<\/button>/)
    expect(app).not.toContain('not Claude</span>')
    expect(app).not.toMatch(/\n\s*Back to Claude\n/)
  })

  // P3.7, the C item "narrow-window overlap" (row 64): the GitHub button
  // floats over the pane's top-right corner (GitHubPanel's gh-fab: absolute
  // top-2 right-2, 32px from 8px in; its geometry is pinned in
  // terminalview-account-launch.test.tsx), and the strip's way back sat in
  // that corner. The strip keeps it clear as the switch note does (pr-12,
  // 48px); the note wraps rather than pushing the button, which never shrinks.
  // jsdom cannot hit-test, so the rule is pinned in the markup.
  it('keeps the floating GitHub button\'s corner clear at any width: the note wraps, the way back never shrinks under the button', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const at = app.indexOf('data-ux-id="partner-identity-strip"')
    expect(at).toBeGreaterThan(0)
    const open = app.slice(app.lastIndexOf('<div', at), at)
    const stripClasses = (/className="([^"]*)"/.exec(open)?.[1] ?? '').split(/\s+/)
    expect(stripClasses.filter((c) => /^(px|pl|pr)-/.test(c))).toEqual(['pl-3', 'pr-12'])
    const body = app.slice(at, app.indexOf('</div>', at))
    expect((/<span className="([^"]*)">Partner terminal/.exec(body)?.[1] ?? '').split(/\s+/)).toContain('min-w-0')
    const button = (/<button[\s\S]*?className="([^"]*)"/.exec(body)?.[1] ?? '').split(/\s+/)
    expect(button).toEqual(expect.arrayContaining(['ml-auto', 'shrink-0', 'whitespace-nowrap']))
  })
})

describe('shouldGateAccountChoice', () => {
  it('gates a Claude session with >= 2 account profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2, provider: 'claude' })).toBe(true)
  })
  it('does NOT gate a Codex session even with >= 2 profiles (BUG-1: account isolation is Claude-only)', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 3, provider: 'codex' })).toBe(false)
  })
  it('treats an unspecified provider as Claude', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2 })).toBe(true)
  })
  it('does not gate with fewer than 2 profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 1, provider: 'claude' })).toBe(false)
  })
  it('does not gate shell-only panes', () => {
    expect(shouldGateAccountChoice({ shellOnly: true, hasSession: true, profileCount: 2, provider: 'claude' })).toBe(false)
  })
  it('does not gate when there is no session record', () => {
    expect(shouldGateAccountChoice({ hasSession: false, profileCount: 2, provider: 'claude' })).toBe(false)
  })
  it('does NOT gate an SSH session even if provider is Claude (remote host uses its own login)', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2, provider: 'claude', isSsh: true })).toBe(false)
  })
})

describe('resolveResumeAccountMode (#446)', () => {
  it("returns 'ask' only for the exact string 'ask'", () => {
    expect(resolveResumeAccountMode('ask')).toBe('ask')
  })
  it("defaults to 'auto-last' for absent/unknown/legacy values", () => {
    for (const v of [undefined, null, '', 'auto-last', 'AUTO', 'Ask', 1, {}, true]) {
      expect(resolveResumeAccountMode(v)).toBe('auto-last')
    }
  })
})

describe('shouldPredetermineRestoredAccount (#446)', () => {
  it('predetermines (auto-last) by default and for any non-ask value', () => {
    for (const v of [undefined, null, 'auto-last', 'anything', 1]) {
      expect(shouldPredetermineRestoredAccount(v)).toBe(true)
    }
  })
  it("does NOT predetermine under 'ask' (the gate opens per restored session)", () => {
    expect(shouldPredetermineRestoredAccount('ask')).toBe(false)
  })
})

describe('canSwitchAccountForSession', () => {
  it('allows a local Claude session with >= 2 profiles', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', profileCount: 2 })).toBe(true)
  })
  it('treats an unspecified provider as Claude', () => {
    expect(canSwitchAccountForSession({ profileCount: 2 })).toBe(true)
  })
  it('does NOT allow a Codex session (account isolation is Claude-only)', () => {
    expect(canSwitchAccountForSession({ provider: 'codex', profileCount: 3 })).toBe(false)
  })
  it('does NOT allow an SSH session (remote host uses its own login)', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', isSsh: true, profileCount: 3 })).toBe(false)
  })
  it('does not allow with fewer than 2 profiles', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', profileCount: 1 })).toBe(false)
  })
  it('refuses shell-only panes (the add-account /login shell must never switch profile)', () => {
    expect(canSwitchAccountForSession({ provider: 'claude', shellOnly: true, profileCount: 2 })).toBe(false)
  })
})

describe('sshMappedProfileId (harmonise-remote: SSH → local profile)', () => {
  const profiles = [
    { id: 'p1', accountEmail: 'me@work.co' },
    { id: 'p2', accountEmail: 'other@x.com' },
  ]

  it('maps an SSH session to the local profile whose email matches its live accountEmail', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'me@work.co' }, profiles)).toBe('p1')
  })
  it('falls back to the setup-sentinel sshRemoteAccount when there is no live accountEmail', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', sshRemoteAccount: 'other@x.com' }, profiles)).toBe('p2')
  })
  it('prefers the live accountEmail over the sshRemoteAccount snapshot', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'me@work.co', sshRemoteAccount: 'other@x.com' }, profiles)).toBe('p1')
  })
  it('returns undefined when no local profile matches the remote account', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'stranger@nowhere.dev' }, profiles)).toBeUndefined()
  })
  it('returns undefined when the SSH session reports no remote account at all', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude' }, profiles)).toBeUndefined()
  })
  it('is SSH-only: a LOCAL session never maps (its own profile drives affordances)', () => {
    expect(sshMappedProfileId({ sessionType: 'local', provider: 'claude', accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })
  it('is Claude-only: an SSH Codex session never maps (auth is not profile-scoped)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'codex', accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })
  it('never maps a shell-only SSH pane (no in-session /login to act on)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', shellOnly: true, accountEmail: 'me@work.co' }, profiles)).toBeUndefined()
  })

  // First-connect fallback: the launch profileId stands in ONLY while no
  // remote identity has arrived. Once an email is known, the email mapping
  // alone decides — a stand-in must never fabricate affordances for a remote
  // account that deliberately matched nothing (Double Review F1).
  it('falls back to the launch profileId while NO remote identity has arrived yet', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', profileId: 'p1' }, profiles)).toBe('p1')
  })
  it('rejects a launch profileId that no longer exists (deleted profile)', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', profileId: 'p9' }, profiles)).toBeUndefined()
  })
  it('a KNOWN remote identity matching no profile stays unmapped — the launch profileId never stands in', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'stranger@nowhere.dev', profileId: 'p1' }, profiles)).toBeUndefined()
  })
  it('an email match always wins over a differing launch profileId', () => {
    expect(sshMappedProfileId({ sessionType: 'ssh', provider: 'claude', accountEmail: 'other@x.com', profileId: 'p1' }, profiles)).toBe('p2')
  })
})

describe('formatSpawnError', () => {
  it('surfaces the underlying Error message', () => {
    expect(formatSpawnError(new Error('Codex CLI not found on PATH. Install with npm i -g @openai/codex')))
      .toContain('Codex CLI not found on PATH')
  })
  it('strips the IPC invoke wrapper noise', () => {
    expect(formatSpawnError(new Error("Error invoking remote method 'pty:spawn': Error: boom"))).toBe('boom')
  })
  it('handles a non-Error value', () => {
    expect(formatSpawnError('plain failure')).toBe('plain failure')
  })
  it('falls back for a nullish error', () => {
    expect(formatSpawnError(undefined)).toBe('unknown error')
  })
})
