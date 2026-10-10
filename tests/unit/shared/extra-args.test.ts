// A Claude Code session's extra CLI arguments: the rule the session dialog,
// the pty:spawn schema and the restore sanitizer share (src/shared/extra-args.ts).
// Options the app sets, and options that change the conversation, where or how
// it runs, its permission mode or the settings it reads, are refused in any
// spelling, shown in the CLI's help or not; so is a word Claude would read as a
// command, or as a server to run the session on. Option names follow the option
// table of the Claude Code builds in use (2.1.290 to 2.1.293) and the argument
// checks of 2.1.291 to 2.1.293. Pure; nothing is launched.
import { describe, it, expect } from 'vitest'
import { claudeExtraArgsProblem, codexExtraArgsProblem, extraArgsRefineOk } from '../../../src/shared/extra-args'

const refused = (v: string): void => {
  expect(claudeExtraArgsProblem(v), JSON.stringify(v)).not.toBeNull()
  expect(extraArgsRefineOk(v), JSON.stringify(v)).toBe(false)
}
const taken = (v: string): void => {
  expect(claudeExtraArgsProblem(v), JSON.stringify(v)).toBeNull()
  expect(extraArgsRefineOk(v), JSON.stringify(v)).toBe(true)
}

describe('Claude extra CLI arguments: what passes (options the app leaves to the user)', () => {
  const ok = [
    '', '   ',
    '--verbose', '--debug', '--debug=api,hooks', '--ide', '-d', '-h', '--chrome', '--no-chrome', '--CHROME', '--brief',
    '--add-dir=docs', '--add-dir ./docs', '--add-dir .\\docs', '--add-dir /home/me/project', '--add-dir C:\\Users\\me\\project',
    '--add-dir=/srv', '--add-dir /srv/', '--add-dir 2026', '--add-dir=a@b', '--add-dir /srv/a  --add-dir /srv/b',
    '--allowedTools=Bash,Edit', '--allowed-tools=Bash', '--disallowedTools=WebFetch', '--tools=default',
    '--name=review', '--fallback-model=sonnet', '--append-system-prompt-file=notes.md', '--betas=x',
    '--remote-control', '--rc', '--remote-control-session-name-prefix=desk', '--REMOTE-CONTROL',
    '--tag a,b,c', '--foo=bar', 'C:\\Users\\me\\thing.json',
    // options near a refused family that change none of those things
    '--plan-mode-instructions=notes', '--replay-user-messages', '--debug-to-stderr', '--prompt-suggestions=false',
    '--advisor=opus', '--ref=main', '--disable-slash-commands', '--system-prompt-snapshot=off', '--version',
  ]
  for (const v of ok) it(`takes ${JSON.stringify(v)}`, () => taken(v))
})

describe('every option that changes the conversation, where or how it runs, its permission mode or the settings it reads is refused, shown in the help or not', () => {
  const classes: Record<string, string[]> = {
    // what the conversation hears and is: its agent, a team it joins, messages pushed into it, text put into its input
    conversation: [
      '--agent=reviewer', '--agent-id=x', '--agent-name=x', '--agent-type=x', '--agent-color=red', '--team-name=x',
      '--teammate-mode=tmux', '--parent-session-id=x', '--channels=x', '--watch-artifact=x', '--watch-artifact-no-autoreact=x',
      '--messaging-socket-path=x', '--prefill=x', '--prefill-b64=eA', '--reply-on-resume',
    ],
    // the folder, the terminal or the machine it runs in
    where: [
      '--deep-link-origin', '--deep-link-cwd-b64=eA', '--deep-link-repo=o/r', '--deep-link-last-fetch=1', '--handle-uri=x',
      '--tmux', '--tmux=classic', '--routine=x',
    ],
    // a program drives it instead of the terminal, or it runs something other than a conversation
    how: [
      '--await-claim', '--await-initialize', '--session-mirror', '--init', '--init-only', '--maintenance',
      '--preload', '--bg-spare', '--bg-pty-host', '--daemon-worker', '--eval-mock-server', '--claude-in-chrome-mcp',
      '--chrome-native-host', '--gh-standin', '--update', '--upgrade',
    ],
    permissionMode: ['--plan-mode-required'],
    settings: ['--bare', '--safe-mode', '--restricted', '--client-data-url=https://example.test/c'],
  }
  for (const [cls, words] of Object.entries(classes)) {
    for (const v of words) {
      it(`refuses ${JSON.stringify(v)} (${cls})`, () => {
        refused(v)
        expect(claudeExtraArgsProblem(v)).toMatch(/is set by the app/)
      })
    }
  }
  it('refuses them anywhere in the list, in another case and with a backslash', () => {
    for (const v of ['--verbose --deep-link-origin', '--Deep-Link-Cwd-B64=eA', '--deep-link-cwd\\-b64=eA', '--add-dir=docs --safe-mode']) refused(v)
  })
  it('the message names the option and every class', () => {
    expect(claudeExtraArgsProblem('--verbose --prefill-b64=eA')).toBe(
      '"--prefill-b64=eA" is set by the app, or changes the conversation, where or how it runs, its permission mode or the settings it reads')
  })
})

describe('a Codex session refuses its CLI\'s helper modes the same way', () => {
  for (const v of ['--codex-run-as-apply-patch', '--codex-run-as-x', '--CODEX-RUN-AS-APPLY-PATCH', '--search --codex-run-as-apply-patch']) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      expect(codexExtraArgsProblem(v)).toMatch(/is set by the app/)
    })
  }
  it('still takes its other options', () => {
    expect(codexExtraArgsProblem('--search --add-dir=docs')).toBeNull()
  })
})

describe('an option the app sets is refused in any spelling', () => {
  const managed = [
    // set by the app
    '--model=x', '--model x.y', '--effort=high', '--permission-mode=plan', '--settings=x.json', '--setting-sources=user',
    '--mcp-config=x.json', '--strict-mcp-config', '--agents=x.json', '--plugin-dir=x', '--plugin-dir-no-mcp=x',
    '--plugin-url=https://example.test/p.zip',
    // the conversation a launch runs, and where it runs
    '--resume', '--resume=x', '--resume-session-at=x', '--resume-drops-turn=x', '--continue',
    '--session-id=11111111-1111-1111-1111-111111111111', '--fork-session', '--from-pr=12', '--teleport', '--rewind-files=x',
    '--worktree', '--worktree=x', '--cloud', '--cloud=x', '--remote', '--remote=x', '--environment=x', '--pool=x',
    '--attach-serve=x', '--background', '--bg', '--desktop',
    // permissions
    '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--dangerously-load-development-channels=x',
    '--dangerously-anything-else', '--permission-prompt-tool=x', '--permission-prompts=none',
    '--inherit-permission-mode=bypassPermissions', '--enable-auto-mode',
    // where settings are read from
    '--managed-settings=x', '--project-config-root=x',
    // a session that answers once and exits
    '--print', '--output-format=json', '--input-format=stream-json', '--sdk-url=wss://example.test',
    // shortened, extended with a hyphen, another case, backslashes
    '--resum', '--res', '--r', '--perm', '--sett', '--mod', '--p', '--agent', '--model-x', '--settings-x', '--print-x',
    '--RESUME', '--Model=x', '--Dangerously-Skip-Permissions', '--res\\ume', '\\--resume', '--se\\tting\\s=x', '--model\\=x',
    // malformed names, and names a shell or the CLI might cut short
    '--', '---resume', '--=x', '--resume.x', '--resume:x', '--resume,x', '--resume+x', '--resume@x', '--resume/x',
    // anywhere in the list, not only first
    '--verbose --resume', '--add-dir=/srv --print', '--ide --session-id=x',
  ]
  for (const v of managed) it(`refuses ${JSON.stringify(v)}`, () => refused(v))

  it('says the option is the app\'s, and names it', () => {
    expect(claudeExtraArgsProblem('--verbose --resume=x')).toMatch(/"--resume=x" is set by the app/)
  })
})

describe('a managed option\'s one-letter form is refused, and a short option stands alone', () => {
  const shorts = ['-c', '-r', '-p', '-w', '-C', '-R', '-P', '-W', '-\\r', '--verbose -r',
    // clusters and attached values: one letter alone, or the long form
    '-rx', '-r=x', '-cp', '-pc', '-dr', '-r.x', '-d.r', '-', '-1', '-ab']
  for (const v of shorts) it(`refuses ${JSON.stringify(v)}`, () => refused(v))

  it('says how to give a short option', () => {
    expect(claudeExtraArgsProblem('-dr')).toMatch(/short option on its own/)
    expect(claudeExtraArgsProblem('-r')).toMatch(/is set by the app/)
  })
})

describe('a word claude would read as a command is refused', () => {
  const words = ['mcp', 'update', 'doctor', 'install', 'setup-token', 'config', 'plugin', 'auth', 'login', 'logout',
    'agents', 'remote-control', 'ultrareview', 'MCP', 'Update', 'up\\date', 'x1-y', '--verbose mcp', '--add-dir docs']
  for (const v of words) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      refused(v)
      expect(claudeExtraArgsProblem(v)).toMatch(/one of its commands/)
    })
  }
  const slash = ['/logout', '/login', '/model', '/plugin:command', '/mcp__server__prompt', '/a_b', '/x.y', '/x=y', '/', '/LOGOUT',
    '\\/logout', '--verbose /logout', '--add-dir /srv']
  for (const v of slash) {
    it(`refuses the slash command shape ${JSON.stringify(v)}`, () => {
      refused(v)
      expect(claudeExtraArgsProblem(v)).toMatch(/one of its commands/)
    })
  }
  it('says the word is the opening prompt, and how to give a folder as the value of --add-dir', () => {
    const m = claudeExtraArgsProblem('--add-dir docs')
    expect(m).toMatch(/opening prompt/)
    expect(m).toMatch(/--add-dir=docs/)
    expect(m).toMatch(/--add-dir \.\/docs/)
    expect(claudeExtraArgsProblem('/srv')).toMatch(/--add-dir \/srv\//)
  })
})

describe('a word that names a server for the session to run on is refused, in any spelling', () => {
  const addresses = [
    'cc://server.example:8443', 'cc+unix:///tmp/s.sock', 'CC://server.example', 'Cc+Unix:///tmp/s.sock',
    // a backslash a POSIX shell drops, anywhere in the scheme or before it
    'cc\\://server.example', 'c\\c://server.example', '\\cc+unix:///tmp/s.sock', 'cc:\\/\\/server.example',
    // anywhere in the list, after an option or another word
    '--add-dir=docs cc://server.example', '--verbose cc+unix:///tmp/s.sock', 'notes.md cc://server.example',
    // any scheme of two or more characters, so a later one is refused too
    'https://example.test/x', 'ws://example.test', 'x1+y.z-w:rest', 'ab:',
  ]
  for (const v of addresses) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      refused(v)
      expect(claudeExtraArgsProblem(v)).toMatch(/starts with an address/)
    })
  }
  it('names the word, and says how to give an option a value', () => {
    expect(claudeExtraArgsProblem('--verbose cc://server.example')).toBe(
      '"cc://server.example": a word that starts with an address (such as name://) can name a server for Claude to run the session on; give an option\'s value after an = sign (--option=value)')
  })
  it('a drive letter is a folder, and a word with no address passes', () => {
    for (const v of ['C:\\Users\\me\\thing.json', 'C:/Users/me/thing.json', 'c:', 'D:docs', 'c\\:docs', '--add-dir C:\\Users\\me\\project',
      '--add-dir D:/work', 'notes.md', '--tag=ab:c', '--foo=bar:baz', '--add-dir=docs']) taken(v)
  })
})

describe('a word PowerShell would expand is refused', () => {
  for (const v of ['@home', '@args', '--verbose @x', '@']) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      refused(v)
      expect(claudeExtraArgsProblem(v)).toMatch(/PowerShell/)
    })
  }
})

describe('a word that starts or ends with a comma is refused; a comma inside a word is the word\'s own', () => {
  const edge = [
    ',--resume', ',--permission-mode=bypassPermissions', ',-p', ',--settings=C:/x.json', ',mcp', ',', ',,', 'x,',
    '--verbose ,--resume', '--add-dir=docs,', 'continue, .', '\\,--resume', ',\\--resume', 'x,\\ --verbose', '--debug=api,hooks ,x',
  ]
  for (const v of edge) {
    it(`refuses ${JSON.stringify(v)}`, () => {
      refused(v)
      expect(claudeExtraArgsProblem(v)).toMatch(/": a word may not start or end with a comma; give a comma only inside a word, such as --allowedTools=Bash,Edit$/)
    })
  }
  it('takes a comma inside a word', () => {
    for (const v of ['--allowedTools=Bash,Edit', '--debug=api,hooks', '--tag a,b,c', '--add-dir=a,b', '1,2']) taken(v)
  })
  it('names the word and states the rule, with a word it takes', () => {
    expect(claudeExtraArgsProblem('--verbose ,--resume')).toBe('",--resume": a word may not start or end with a comma; give a comma only inside a word, such as --allowedTools=Bash,Edit')
  })
})

describe('the character guard comes first', () => {
  it('refuses a shell or cmd.exe character, a trailing backslash, a value over the cap and a value that is not text', () => {
    for (const v of ['--add-dir a;b', '--add-dir $HOME', '--add-dir "x y"', '--add-dir a%b', '--add-dir a&b', '--add-dir a|b',
      '--add-dir C:\\x\\', `--add-dir ./${'x'.repeat(520)}`]) {
      expect(claudeExtraArgsProblem(v), JSON.stringify(v)).not.toBeNull()
    }
    expect(extraArgsRefineOk('--verbose \\')).toBe(false)
    for (const v of [7, null, ['--verbose'], {}]) expect(claudeExtraArgsProblem(v), JSON.stringify(v)).not.toBeNull()
  })
})
