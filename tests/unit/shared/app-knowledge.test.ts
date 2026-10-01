/**
 * The rules `app-knowledge.ts` states about itself, enforced.
 *
 * This file is the SINGLE SOURCE for two user-facing surfaces: the in-app
 * Feature Guide, and the documentation folder the Ask Conductor session is
 * launched in. So its contents are read by users and pasted into a Claude
 * session's context, and its header lays down rules accordingly: user
 * documentation only, no internal paths, no build secrets, no architecture
 * internals, no em dashes. None of that was checked by anything.
 */
import { describe, it, expect } from 'vitest'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'
import { TIPS_LIBRARY } from '../../../src/renderer/tips-library'
import { trainingSteps } from '../../../src/renderer/training-steps'

describe('app knowledge is publishable', () => {
  it('has unique, stable-looking ids and a title and body for every section', () => {
    const ids = APP_KNOWLEDGE_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.id, `${s.id} id shape`).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(s.title.trim().length, `${s.id} has a title`).toBeGreaterThan(0)
      expect(s.body.trim().length, `${s.id} has a body`).toBeGreaterThan(80)
    }
  })

  it('uses no em dashes', () => {
    // The file's own rule. They read badly in the terminal-rendered Feature
    // Guide and this text is public-facing.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} em dash`).not.toMatch(/—/)
    }
  })

  it('leaks no absolute or personal paths', () => {
    // A Windows drive path, a POSIX absolute path or a home reference here
    // would be one developer's machine, shipped to every user and pasted into
    // an agent's context.
    //
    // Checked by SEGMENT as well as by separator, because a Windows path
    // pasted into a JS string loses its backslashes to escape processing:
    // 'C:\Users\you' is the four characters C, :, U... at runtime. Matching
    // only on a separator misses exactly the mistake someone would make.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} drive path`).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(text, `${s.id} mangled drive path`).not.toMatch(/\b[A-Za-z]:[\\/]?(Users|home|Documents)/i)
      expect(text, `${s.id} home path`).not.toMatch(/(^|\s)~[\\/]/)
      expect(text, `${s.id} users path`).not.toMatch(/[\\/](home|Users)[\\/]/)
      expect(text, `${s.id} windows profile dir`).not.toMatch(/AppData|Roaming|ProgramData/i)
      // A generic POSIX absolute path, which the checks above do not cover.
      // Two segments minimum, so the slash commands this text legitimately
      // names (/config) are not false positives.
      expect(text, `${s.id} posix absolute path`).not.toMatch(/(^|\s)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)
    }
  })

  it('names no source files or internal modules', () => {
    // "architecture internals" in practice means naming the code. A user
    // cannot act on `src/main/…`, and Ask Conductor quoting it is worse.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      const text = `${s.title} ${s.body}`
      expect(text, `${s.id} source path`).not.toMatch(/\bsrc\//)
      expect(text, `${s.id} source file`).not.toMatch(/\.tsx?\b/)
    }
  })

  it('carries no "not affiliated with Anthropic" line (#383)', () => {
    // Owner call 2026-08-22: the disclaimer is gone from the app and docs, and
    // this text is pasted into the Ask Conductor session, so it must not keep
    // repeating it from there.
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(`${s.title} ${s.body}`, `${s.id} affiliation line`).not.toMatch(/affiliated|endorsed by/i)
    }
  })

  it('explains which settings file wins, and that a running session keeps its own', () => {
    // The concept behind #314: a setting that appears to do nothing is
    // usually being overridden, and a change never reaches a session that is
    // already running. Both have to be findable by asking in plain English.
    const section = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'settings-scope')
    expect(section, 'settings-scope section exists').toBeTruthy()
    const body = section!.body

    // The precedence chain, weakest to strongest, each named.
    for (const file of ['settings.local.json', 'settings.json', 'organisation']) {
      expect(body, `mentions ${file}`).toContain(file)
    }
    expect(body, 'says the nearest one wins').toMatch(/nearest|strongest|wins/i)
    expect(body, 'says /config writes the project-local file').toContain('/config')
    // Both halves of "when it takes effect", asserted separately: an
    // alternation passed here even with the running-session claim deleted,
    // because "starts" appears elsewhere in the same paragraph.
    expect(body, 'says settings are read at session start').toMatch(/when a session starts/i)
    expect(body, 'says a running session is unaffected').toMatch(/already running/i)

    // The multi-account wrinkle, which is ours and documented nowhere else.
    expect(body, 'says the personal file is copied per account').toMatch(/copied|copy/i)
    expect(body, 'says which things are shared instead').toMatch(/shared/i)
  })
})

// P3.10 round 1 (S2): the Feature Guide and Ask Conductor say what P3.10 made
// true: the Session Watchdog covers local Codex sessions too, under the one
// switch, without the safeguard check; and Codex's one-time Hooks need review
// step is explained where a user would look (what to choose, what declining
// costs, how to trust later).
describe('app knowledge after P3.10 (round 1, S2)', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body

  it('the Session Watchdog covers Codex sessions under the one switch, and says what differs', () => {
    const w = body('session-watchdog')
    expect(w).not.toMatch(/only for Claude sessions/i)
    expect(w).not.toMatch(/never a plain terminal, a Codex session/i)
    expect(w).toMatch(/for Codex sessions/)
    expect(w).toMatch(/one Session Watchdog switch in Settings covers both assistants/)
    expect(w).toMatch(/safeguard check does not apply to Codex/)
    // Round 4 (P6): the overload backoff as the defaults and What's New give it.
    expect(w).toMatch(/from 30 seconds up to 5 minutes/)
    expect(w).toMatch(/gives up after two hours of waiting in all/)
    expect(w).not.toMatch(/capped number of attempts/)
  })

  it('Codex\'s hooks review is explained: what to choose, what declining costs, how to trust later', () => {
    const k = body('known-issues')
    expect(k).toMatch(/Hooks need review/)
    expect(k).toMatch(/Trust all and continue/)
    expect(k).toMatch(/Continue without trusting/)
    expect(k).toMatch(/attention dot does not light up/)
    expect(k).toMatch(/To trust them later/)
    // Round 2 (R9): it says the hooks send the app each event's details, as Claude Code's do.
    expect(k).toMatch(/sends the app, on this computer only, the details Codex gives each of these events, as Claude Code.s hooks do/)
    // Round 3 (F8): a tool that has run sends its result too, and the hooks also feed the notification rules.
    expect(k).toMatch(/or has run \(the same, and what it returned\)/)
    expect(k).toMatch(/for the attention dot, for its notification rules and to follow which conversation/)
    expect(k).not.toMatch(/only tells the app/)
  })
})

// P3.11 (row 62): a Codex config takes extra CLI arguments; the Feature Guide
// and Ask Conductor say how they reach Codex and what the app refuses, and how
// to give a folder named with a plain word. Round 1 (S3, B2, Q1): the rule on
// its own terms; the dialog says why and Save waits; a saved value that is
// refused is dropped when the session starts (it starts without it).
describe('app knowledge after P3.11', () => {
  it('says a Codex config takes extra CLI arguments, one argument per word, and what is refused', () => {
    const s = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'sessions')!.body
    expect(s).toMatch(/For Codex, each word of the extra CLI arguments reaches Codex as one argument/)
    expect(s).toMatch(/the model, -c and the other settings flags, the permission and working-folder flags/)
    expect(s).toMatch(/a profile, another provider or endpoint/)
    expect(s).toMatch(/one of its commands/)
    expect(s).toMatch(/--add-dir=docs/)
    expect(s).toMatch(/What the app sets, or what changes the account, is refused: the model/)
    expect(s).toMatch(/the dialog says why under the field, and Save waits until it is fixed/)
    expect(s).toMatch(/a saved value that is refused is dropped when the session starts, and the session starts without it/)
    expect(s).toMatch(/--add-dir \.\/docs/)
    expect(s).not.toMatch(/does not start/)
    expect(s).not.toMatch(/as the app.s own flags are for Claude Code/)
  })
})

// P3.12 (rows 31, 32, 65): the Logs page indexes a local Codex session's
// conversation (from its own account folder); a Codex session's name is kept
// next to a conversation the app knows for certain, with the rename
// workaround in Known issues; the GitHub Session Context reads its own
// conversation. Nothing still says Codex conversations are not indexed.
describe('app knowledge after P3.12', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  it('says the Logs page indexes Codex conversations, each from its own account folder, with the per-config switch', () => {
    expect(body('codex')).toMatch(/The Logs page indexes a local Codex session's conversation as it does a Claude session's/)
    expect(body('codex')).toMatch(/read from that session's own Codex account folder, never another account's/)
    expect(body('codex')).toMatch(/the Index conversation logs switch in a Codex config turns it off for that config/)
    expect(body('codex')).toMatch(/A Codex session's GitHub Session Context reads its own conversation too/)
    expect(body('pages')).toMatch(/Logs is a full chat-transcript viewer over your Claude and Codex sessions/)
    expect(body('privacy')).toMatch(/reads Claude's and Codex's own transcript files locally/)
  })
  it('says a Codex session\'s name is kept with a conversation the app knows for certain, and the rename workaround', () => {
    expect(body('codex')).toMatch(/is kept next to that conversation, so the list still shows it after the tab is closed/)
    expect(body('known-issues')).toMatch(/A Codex conversation's name can drop out of Restart and pick a conversation after its tab is closed/)
    expect(body('known-issues')).toMatch(/Rename the session again once it has settled on its conversation/)
  })
  it('no longer says Codex conversations are not indexed', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, s.id).not.toMatch(/does not index Codex|Codex conversations are not indexed/)
    }
  })
})

// P3.14 (row 17): a Codex account on paid credits shows its balance on its
// Usage card, in Codex credits (a count, not money). The known issue that said
// the row was missing is gone.
describe('app knowledge after P3.14', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  it('no longer says a Codex account on paid credits has no credits row', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.body, s.id).not.toMatch(/no credits row yet/i)
      expect(s.body, s.id).not.toMatch(/Codex accounts on paid credits show their allowance/)
    }
    // Claude's own credits-row known issue is a different thing and stays.
    expect(body('known-issues')).toMatch(/The credits row can be missing for an account on extra usage while one of its sessions is open/)
  })
  it('says the Usage page shows a Codex balance in Codex credits, under the bars, from the same reading', () => {
    expect(body('accounts')).toMatch(/A Codex account on paid credits shows its balance under its bars, in Codex credits \(a count, not money\)/)
    expect(body('accounts')).toMatch(/from the same reading/)
    expect(body('accounts')).toMatch(/Unlimited/)
  })
})

// P3.15 (rows 70, 71): what the VM run showed. Alt+V with the terminal focused
// goes to the assistant, which pastes the image itself; with focus elsewhere
// the app saves the image and types its path (the tip said it always pasted a
// path into Claude's prompt). Codex's Windows sandbox: only the administrator
// setup lets Codex edit on its own; the non-admin one, or none, asks before
// every edit on Standard and fails on Auto; an elevated app stalls it. Codex's
// own behaviour, given as a known issue with its workaround, and a tip.
describe('app knowledge and tips after P3.15', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((x) => x.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  it('the Alt+V tip says what happens with the session focused and with focus elsewhere, for both assistants', () => {
    const t = tip('tip.paste-image')
    expect(t.body).not.toMatch(/Claude.s prompt/)
    expect(t.body).toMatch(/Click into the session and press \*\*Alt\+V\*\*: the key goes to the assistant, which pastes the image itself/)
    expect(t.body).toMatch(/With focus elsewhere in the app, \*\*Alt\+V\*\* saves the image and types a line with its path into the session/)
    expect(t.body).toMatch(/On a Codex session the app types it only into an empty Codex prompt, and says why when it cannot/)
    const guide = trainingSteps.flatMap((s) => s.highlights ?? []).find((l) => l.startsWith('Alt+V'))!
    expect(guide).not.toMatch(/Claude.s prompt/)
    expect(guide).toMatch(/the assistant pastes it itself; with focus elsewhere, the app saves it and types its path/)
  })
  it('the known issue gives the Windows sandbox workaround: the administrator setup once, what the other choice does, and never an elevated app', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On Windows, Codex edits files on its own only once its sandbox has been set up with administrator permission/)
    expect(k).toMatch(/Choose 1\. Set up default sandbox: Windows asks for administrator permission once/)
    expect(k).toMatch(/2\. Use non-admin sandbox/)
    expect(k).toMatch(/on Standard Codex asks before every edit/)
    expect(k).toMatch(/on Auto every edit fails/)
    expect(k).toMatch(/the same in a terminal outside the app/)
    expect(k).toMatch(/Do not run the app as administrator/)
  })
  it('a tip for Codex users says the same in short', () => {
    const t = TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Codex Edits on Windows')!
    // Shown to the users the other Codex tips are shown to.
    expect(t.requires).toEqual(TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Restart a Codex Session')!.requires)
    expect(t.requires?.length).toBe(1)
    const p = t.variants.primary
    expect(p.shortText.length).toBeLessThan(60)
    expect(p.body).toMatch(/On Windows, when Codex asks to set up its sandbox, choose \*\*1\. Set up default sandbox\*\*/)
    expect(p.body).toMatch(/on \*\*Standard\*\* it asks before every edit, and on \*\*Auto\*\* edits fail/)
    expect(p.body).toMatch(/Do not run the app as administrator/)
    expect(`${p.title} ${p.body}`).not.toMatch(/\u2014/)
  })
})
