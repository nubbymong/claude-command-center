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
import * as fs from 'fs'
import * as path from 'path'
import { APP_KNOWLEDGE_SECTIONS } from '../../../src/shared/app-knowledge'
import { TIPS_LIBRARY } from '../../../src/renderer/tips-library'
import { trainingSteps } from '../../../src/renderer/training-steps'
import { changelog } from '../../../src/renderer/changelog'
import { CODEX_CONDUCTOR_TOOLS } from '../../../src/main/providers/codex/conductor-tools'

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
  it('says the Usage page shows a Codex balance in Codex credits, under the bars, from the newest main report that states them', () => {
    expect(body('accounts')).toMatch(/A Codex account on paid credits shows its balance under its bars, in Codex credits \(a count, not money\)/)
    expect(body('accounts')).toMatch(/taken from the newest main report that states them, so a newer report that says the account has no credits takes the row away and one that says nothing about credits leaves the older figure/)
    expect(body('accounts')).not.toMatch(/taken from the same report as its main bars/)
    expect(body('accounts')).toMatch(/Unlimited/)
    // Round 1: no claim about the balance's age beyond that.
    expect(body('accounts')).not.toMatch(/carries the same age/)
  })
  it('says a conversation moved with Switch Account shows none of the earlier account\'s limits, plan or credits on the new account\'s card until it reports', () => {
    expect(body('accounts')).toMatch(/A conversation you move to another Codex account with Switch Account brings the earlier account's history with it, so the new account's card counts only what that account reports after the move/)
    expect(body('accounts')).toMatch(/until its session reports, the card shows none of the earlier account's limits, plan or credits/)
    // Round 3: while that note cannot be read or written, the move and Sign in again still go on.
    // The VM saw the earlier account's figures for the whole run with the note unreadable
    // from the start, so the sentence says how long, not that it is brief.
    expect(body('accounts')).toMatch(/If the app cannot read or write its note of which conversations were moved, the move and Sign in again still go on, with the note kept in memory until it can be written; a conversation moved in an earlier run may then show the earlier account's figures on the new account's card until that account's session reports or the note can be read, which may be the whole run\./)
    expect(body('accounts')).not.toMatch(/it will not carry a conversation then/)
    expect(body('accounts')).not.toMatch(/it shows no last-seen Codex figures until it can/)
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
    // Round 1 (spec 4): the focused key is evidenced for sessions on this computer;
    // over SSH the app's own path (focus outside the terminal) is the one named.
    expect(t.body).toMatch(/Click into a session on this computer and press \*\*Alt\+V\*\*: the key goes to the assistant, which pastes the image itself/)
    expect(t.body).toMatch(/On an SSH session, press \*\*Alt\+V\*\* with focus outside the terminal: the app saves the image on this computer and asks Claude to fetch it over the connection/)
    expect(t.body).toMatch(/With focus elsewhere in the app, \*\*Alt\+V\*\* saves the image and types a line with its path into the session/)
    expect(t.body).toMatch(/On a Codex session the app types it only into an empty Codex prompt, and says why when it cannot/)
    const guide = trainingSteps.flatMap((s) => s.highlights ?? []).find((l) => l.startsWith('Alt+V'))!
    expect(guide).not.toMatch(/Claude.s prompt/)
    expect(guide).toMatch(/in a local session, the assistant pastes it itself; with focus elsewhere, the app saves it and types its path \(over SSH, it asks Claude to fetch it\)/)
  })
  it('the known issue gives the Windows sandbox workaround: the administrator setup once, what the other choice does, and never an elevated app', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On Windows, Codex edits files on its own only once its sandbox has been set up with administrator permission/)
    // Round 1 (spec 2): what Codex itself says; the UAC prompt was never seen on the VM.
    expect(k).toMatch(/Choose 1\. Set up default sandbox, which Codex says needs administrator permission/)
    expect(k).not.toMatch(/Windows asks for administrator permission once/)
    // Round 1 (spec 3): no question once a folder is trusted or 2 was chosen; the way back is not confirmed, and what to do meanwhile.
    expect(k).toMatch(/asks only when you trust a new folder, so a folder you trusted before, or an earlier choice of 2, brings no question/)
    // Round 2 (J6): the command Codex lists for it (the CLI fixtures' slash popup), not yet confirmed.
    // Round 4 (P6): only after a choice of 2; the administrator prompt blocks Codex's input (the VM at 98455d52).
    // Round 5 (R2): what the VM saw (the prompt left unanswered); a No was never tried, so nothing is said of it.
    expect(k).toMatch(/After a choice of 2, Codex also lists a \/setup-default-sandbox command \(set up elevated agent sandbox\): it asks Windows for administrator permission, and Codex takes no input until that is answered; left unanswered, the session stays stuck, so unless you answer yes, close its tab\./)
    expect(k).not.toMatch(/without a yes the session stays stuck/)
    expect(k).toMatch(/Whether it then lets Codex edit on its own is not yet confirmed; until it is, approve each edit when Codex asks, and use Standard rather than Auto/)
    expect(k).not.toMatch(/has not been confirmed yet/)
    expect(k).toMatch(/2\. Use non-admin sandbox/)
    expect(k).toMatch(/on Standard Codex asks before every edit/)
    expect(k).toMatch(/on Auto every edit fails/)
    expect(k).toMatch(/the same in a terminal outside the app/)
    expect(k).toMatch(/Do not run the app as administrator/)
  })
  it('round 3: the known issue for a tab that stays open after Codex quits, with its workaround (the VM at 98455d52)', () => {
    const k = body('known-issues')
    expect(k).toMatch(/On Windows, a Codex session's tab can stay open after Codex has quit/)
    expect(k).toMatch(/a command Codex started in the background is still running/)
    expect(k).toMatch(/Close the tab: that ends the command too/)
  })
  it('round 2 (J6): the command named is the one both supported CLIs list in their slash popup', () => {
    for (const v of ['0.153.4', '0.155.1']) {
      const popup = fs.readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'codex', 'cli', v, 'tui-slash-popup.txt'), 'utf8')
      expect(popup, v).toMatch(/^ +\/setup-default-sandbox +set up elevated agent sandbox\s*$/m)
    }
  })
  it('a tip for Codex users says the same in short', () => {
    const t = TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Codex Edits on Windows')!
    // Shown to the users the other Codex tips are shown to.
    expect(t.requires).toEqual(TIPS_LIBRARY.find((x) => x.variants.primary.title === 'Restart a Codex Session')!.requires)
    expect(t.requires?.length).toBe(1)
    // Round 1 (a nit): offered on Windows only.
    expect(t.platforms).toEqual(['win32'])
    const p = t.variants.primary
    expect(p.shortText.length).toBeLessThan(60)
    expect(p.body).toMatch(/On Windows, when Codex asks to set up its sandbox, choose \*\*1\. Set up default sandbox\*\*/)
    expect(p.body).toMatch(/on \*\*Standard\*\* it asks before every edit, and on \*\*Auto\*\* edits fail/)
    expect(p.body).toMatch(/Do not run the app as administrator/)
    expect(p.body).toMatch(/\(Codex says it needs administrator permission\)/)
    expect(p.body).toMatch(/After choosing 2, Codex also lists \*\*\/setup-default-sandbox\*\*: it asks for administrator permission, and Codex takes no input until you answer \(without a yes, close the tab\); whether it then lets Codex edit on its own is not yet confirmed/)
    expect(p.body).toMatch(/asks only when you trust a new folder\. After choosing 2, Codex also lists \*\*\/setup-default-sandbox\*\*[^.]*\. If it never asks you, approve each edit when Codex asks about it, and use \*\*Standard\*\* rather than \*\*Auto\*\*/)
    expect(`${p.title} ${p.body}`).not.toMatch(/\u2014/)
  })
})

// P3.16 (the PR 3 user-facing sweep): what PR 3 made true is said where a user
// looks (the Feature Guide, Ask Conductor, the tips, the guide cards and What's
// New), the known issues it ships with have their workarounds, and nothing still
// says what PR 3 made untrue (a Codex Restart starts a new conversation, the
// Logs page does not index Codex, the gpt-5 list, the assistant-only Alt+V).
describe('the PR 3 user-facing sweep (P3.16)', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!
  // The Codex tips by title, as the P3.15 block finds them: their ids, and the
  // feature id they wait on, would name a dotted codex path in this file.
  const titled = (title: string) => TIPS_LIBRARY.find((t) => t.variants.primary.title === title)!
  const codexTipGate = titled('Restart a Codex Session').requires
  const stepText = (id: string) => JSON.stringify(trainingSteps.find((s) => s.id === id)!)
  // The 2.1.1-beta.2 entry, found by its highlight so that a later release's
  // entry above it moves nothing here.
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'README.md'), 'utf8')
  // The pins match the facts by key phrases, so a copy edit that keeps the fact
  // keeps them green.

  // Gate 3 (spec item 3, F2): the count includes the first analysis, so an
  // update is analysed at most three times in all, not three times again.
  it('Sentinel (P3.9 round 4): an update whose findings cannot be matched is analysed at most three times in all', () => {
    const s = body('sentinel')
    expect(s).toMatch(/analysed again at the next start, at most three analyses in all, after which it is recorded as checked with a note saying so/)
    expect(s).not.toMatch(/up to three times/)
  })

  // Fixer 11 (ADR-009 lens D round 2 finding 5, gate 3 F11): the start-up
  // check no longer analyses a downgrade, for either assistant; a Re-run does.
  // Fixer 12 (gate 3 F14 and F15, ADR-009 lens D round 3 NIT 1, R3-1): the rule
  // goes by the newest version checked, and a Re-run makes the installed
  // version the newest one checked; the changelog says it of Claude Code, the
  // assistant that had Sentinel before this release.
  it('Sentinel (fixers 11 and 12): at start only a version newer than the newest checked is analysed; a downgrade runs no analysis; Re-run resets the newest checked', () => {
    const s = body('sentinel')
    // Fixer 13 (gate 3 F16, fixer 12 quality NIT 1): the Re-run moves the
    // newest checked once its analysis is done, and an unmatched one of a
    // version no start analyses asks for another Re-run.
    expect(s).toMatch(/At start it analyses only a version newer than the newest one it has checked, so going back to an older version runs no analysis and the panel names the version installed\. Re-run analyses the installed version and, once that analysis is done, makes it the newest one checked, so a newer version you go back to afterwards is an update again, with the same limit of three analyses\. When a version no start analyses has a finding that cannot be matched, the panel asks you to use Re-run again\./)
    expect(s).not.toMatch(/the last one it checked/)
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).toMatch(/Sentinel no longer runs an analysis at start when you go back to an older Claude Code version \(Codex works the same way\): it analyses only a version newer than the newest one it has checked/)
    expect(all).toMatch(/Re-run in the Sentinel panel analyses the installed version and, once that analysis is done, makes it the newest one checked\./)
    expect(all).not.toMatch(/the last one it checked|older Claude Code or Codex version/)
  })

  it('accounts (P3.2, P3.3): the chip opens the identity editor; Sign in again works while signed in, and what it leaves', () => {
    const a = body('accounts')
    expect(a).toMatch(/round chip to open its editor/)
    // Any two accounts on different identities can be linked, two Codex ones too.
    expect(a).toMatch(/Link another account to tie it to another of your accounts, Claude or Codex/)
    expect(a).not.toMatch(/your account of the other assistant/)
    expect(a).toMatch(/names each of them with Go to/)
    const c = body('codex')
    expect(c).toMatch(/listed under Archived, each with Restore/)
    expect(c).toMatch(/still signed in signs in again inside a new folder/)
    expect(c).toMatch(/moves there only once the new sign-in is verified/)
    // The kept old sign-in shows after a move that worked, and the account can
    // still be used; only one signed in a different way is held back.
    expect(c).toMatch(/Once the account has moved, its row reads Needs attention: the old sign-in is kept/)
    expect(c).toMatch(/can still be picked for sessions/)
    expect(c).toMatch(/one signed in a different way than before cannot be picked until you confirm it/)
    expect(c).toMatch(/An inactive account, or one signed in a different way than before, is greyed/)
    expect(c).not.toMatch(/one that needs attention/)
    expect(c).toMatch(/archiving the account removes it/)
    expect(c).toMatch(/signs it in again in place after a warning/)
    expect(c).not.toMatch(/When a Codex account is signed out or expired, Sign in again/)
    expect(c).not.toMatch(/The app never signs in to it for you/)
    const recovery = titled('Check Sign-in and Sign In Again').variants.primary.body
    expect(recovery).toMatch(/signs in inside a new folder and moves there only once that sign-in works/)
    expect(recovery).not.toMatch(/signs a signed-out or expired account back in/)
  })

  it('Codex sessions (P3.5 to P3.8, P3.13): models, Plan mode, Compact, the model pill, the status line and Multi Spawn', () => {
    const c = body('codex')
    expect(c).toMatch(/The model list is the one the supported Codex versions offer/)
    expect(c).toMatch(/only the effort levels it runs/)
    expect(c).toMatch(/Read-only, Standard, Plan mode, Auto and Unrestricted/)
    expect(c).toMatch(/Compact on the status line types Codex's own \/compact/)
    expect(c).toMatch(/the model pill opens Codex's own model and effort picker/)
    expect(c).toMatch(/Restart carries on with the same conversation/)
    expect(body('statusline')).toMatch(/lines changed \(counted from the edits Codex makes\)/)
    expect(body('statusline')).toMatch(/carried on across restarts/)
    expect(body('sessions')).toMatch(/works the same for a Codex config/)
    expect(body('session-watchdog')).toMatch(/errors in the current turn only/)
  })

  it('Alt+V (P3.15, P3.16a U6 and N9): the plain-terminal and partner-shell routes, in the Feature Guide, the tip and the guide card', () => {
    const k = body('shortcuts')
    expect(k).toMatch(/Alt\+V types only the image's path into a plain terminal, or into a session's partner shell/)
    expect(k).toMatch(/quoted for the shell, with no Enter/)
    // PR-level ADR-009 round 1 (A1): off Windows, a path is typed only into a shell of the sh family.
    expect(k).toMatch(/On macOS and Linux the path is typed only into an sh, bash, zsh, dash or ksh shell/)
    expect(k).toMatch(/Any other shell there, a plain terminal over SSH, or a terminal that is not running gets nothing/)
    expect(k).toMatch(/the hint says where the image was saved/)
    // The copied-file route reads File Explorer's and Finder's clipboard only.
    expect(k).toMatch(/an image file you copied in File Explorer or Finder/)
    expect(k).not.toMatch(/file manager/)
    const t = tip('tip.paste-image').variants.primary.body
    expect(t).toMatch(/\*\*Alt\+V\*\* types only the image's path into a plain terminal, or into the partner shell/)
    expect(t).toMatch(/quoted for the shell, with no Enter/)
    expect(t).toMatch(/On macOS and Linux the path is typed only into an sh, bash, zsh, dash or ksh shell/)
    expect(t).toMatch(/Any other shell there, or a plain terminal over SSH, gets nothing/)
    expect(t).toMatch(/an image file you copied in File Explorer or Finder/)
    expect(t).not.toMatch(/file manager/)
    const guide = trainingSteps.flatMap((s) => s.highlights ?? []).find((l) => l.startsWith('Alt+V'))!
    expect(guide).toMatch(/a plain terminal, or the partner shell in a partner view, gets only the quoted path/)
    expect(guide).toMatch(/with no Enter/)
    // Fixer 7b (N5): off Windows, only a shell of the sh family gets the path.
    expect(guide).toMatch(/on macOS and Linux, only an sh, bash, zsh, dash or ksh shell/)
  })

  it('known issues (P3.10, P3.16a): the Codex lock screen, the Windows folder spelling and vision in one copy, each with its workaround', () => {
    const k = body('known-issues')
    expect(k).toMatch(/one tab at a time write to a conversation/)
    expect(k).toMatch(/with Codex 0\.155\.1, Codex shows its own lock screen/)
    expect(k).toMatch(/close the tab that shows the lock screen/)
    expect(k).toMatch(/give a Claude config its working folder as Windows spells it/)
    expect(k).toMatch(/with the folder picker, or type it exactly as File Explorer shows it/)
    expect(k).toMatch(/drive letter in upper case/)
    // Vision: only copies run from source can share a vision browser (the
    // installed app runs one copy, and a copy run from source has a browser of
    // its own beside it).
    expect(k).toMatch(/one copy of the app at a time when you run the app from source/)
    expect(k).toMatch(/Two copies run from source at once/)
    expect(k).toMatch(/starting vision in one copy can close the browser the other copy opened/)
    expect(k).toMatch(/The installed app is not affected/)
    expect(k).toMatch(/press Start browser on the Conductor MCP page/)
    expect(k).not.toMatch(/another build beside the installed one/)
  })

  it('privacy: what is written while indexing is off is never indexed, for both; the Codex name file', () => {
    const p = body('privacy')
    expect(p).toMatch(/while indexing was off is never indexed later, for Claude and Codex alike/)
    expect(p).toMatch(/kept in a small file beside its conversation/)
  })

  it('the tips a user would not find alone (P3.2, P3.6, P3.8), and the corrected ones', () => {
    const editor = tip('tip.account-identity-editor').variants.primary.body
    expect(editor).toMatch(/click the round chip at the left of an account row, Claude or Codex/)
    expect(editor).toMatch(/ties it to another of your accounts, Claude or Codex/)
    expect(editor).not.toMatch(/your account of the other assistant/)
    // Shown to the users the other Codex tips are shown to.
    expect(codexTipGate?.length).toBe(1)
    const switching = titled('Switch a Codex Session\'s Account')
    expect(switching.requires).toEqual(codexTipGate)
    expect(switching.variants.primary.body).toMatch(/click the \*\*account pill\*\* at the far left of its status line/)
    expect(switching.variants.primary.body).toMatch(/inactive, or signed in a different way than before, is greyed/)
    expect(titled('Codex\'s Own Commands, From the App').requires).toEqual(codexTipGate)
    expect(titled('Codex\'s Own Commands, From the App').variants.primary.body).toMatch(/start in \*\*Plan mode\*\*/)
    // The overload backoff as the Watchdog has it since P3.10 round 3.
    expect(tip('tip.session-watchdog').variants.primary.body).toMatch(/from 30 seconds up to 5 minutes/)
    expect(tip('tip.session-watchdog').variants.primary.body).toMatch(/gives up after two hours of waiting in all/)
    expect(tip('tip.session-watchdog').variants.primary.body).not.toMatch(/with capped attempts/)
    const net = tip('tip.transparency.network-activity').variants.primary.body
    expect(net).toMatch(/current Claude and Codex model pricing/)
    expect(net).toMatch(/`status\.openai\.com` while Codex is on/)
    // Sentinel's reads (Codex's release notes among them) and Codex's own usage
    // check are on the list too.
    expect(net).toMatch(/\*\*Sentinel\*\* \(off by default\)/)
    expect(net).toMatch(/Codex's public release notes \(`api\.github\.com`\)/)
    expect(net).toMatch(/\*\*Codex usage check\*\* \(`chatgpt\.com`/)
    expect(tip('tip.multi-account').variants.primary.body).toMatch(/moves between your Codex accounts the same way/)
  })

  it('the guide cards: the Codex card, the Logs card and the cards that name both assistants', () => {
    const codex = stepText('codex-provider')
    expect(codex).not.toMatch(/gpt-5\.4|gpt-5 series|Six gpt-5 models/)
    expect(codex).not.toMatch(/does not index Codex conversations yet/)
    expect(codex).toMatch(/the Logs page indexes Codex conversations as it does Claude/)
    expect(codex).toMatch(/Switch Account/)
    expect(codex).toMatch(/Plan mode/)
    // The model list is built into the app (the supported versions' list), not
    // read from the Codex that is installed.
    expect(codex).toMatch(/the models the supported Codex versions offer, permission presets/)
    expect(codex).toMatch(/The supported Codex versions' \*\*model list\*\*/)
    expect(codex).not.toMatch(/installed Codex offers|Codex's own \*\*model list\*\*/)
    expect(readme).toMatch(/the models the supported Codex versions offer in the model dropdown/)
    expect(readme).not.toMatch(/installed Codex offers/)
    expect(stepText('logs')).toMatch(/a local Codex session's conversation \(from its Codex account's sessions folder\)/)
    expect(stepText('logs')).not.toMatch(/tool calls, and thinking/)
    expect(stepText('multi-account')).toMatch(/every account of each assistant that is on, in a section per assistant when both are/)
    expect(stepText('multi-account')).not.toMatch(/shows every Claude and Codex account/)
    expect(stepText('multi-account')).toMatch(/Settings, Accounts \(click an account's chip/)
    expect(stepText('multi-account')).not.toMatch(/->/)
    const accounts = stepText('provider-accounts')
    expect(accounts).toMatch(/An assistant that is off keeps its accounts listed/)
    expect(accounts).toMatch(/link it to another of your accounts, Claude or Codex/)
    expect(accounts).toMatch(/Needs attention: signed in a different way than before/)
    expect(stepText('ai-usage-meter')).toMatch(/rate-limit windows of this run's sessions/)
    // The popover shows only the assistants that are on (row 14, OD27 M1 D5).
    expect(stepText('ai-usage-meter').match(/side by side when both are on/g) ?? []).toHaveLength(3)
    expect(tip('tip.github.ai-usage-meter').variants.primary.body).toMatch(/5h \/ 7d rate-limit windows, side by side when both are on/)
  })

  it('What\'s New (2.1.1-beta.2): a Codex Restart keeps its conversation, and PR 3\'s changes are listed', () => {
    expect(top, 'the entry whose highlight starts "Codex becomes a full second assistant"').toBeDefined()
    expect(top.highlights).toMatch(/Sentinel watches Codex too/)
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).not.toMatch(/Restart starts a new conversation/)
    expect(all).toMatch(/Restart carries on with the same conversation/)
    for (const said of [
      /a Codex session moves to another one as a Claude session does/,
      /A Codex session's status line shows Lines changed/,
      /Codex models and efforts match Codex's own/,
      /A Codex config can start in Plan mode/,
      /Sentinel covers Codex/,
      /Allow Multi Spawn and Quick Start work for Codex configs/,
      /shows its credits under its bars on the Usage page/,
      /Click an account's round chip to edit its name, colour and group/,
      /link it to another of your accounts, Claude or Codex/,
      /an account signed in a different way than before cannot be picked until you confirm it/,
      /Sign in again works on a Codex account that is still signed in/,
      /a Codex pill, read from OpenAI's public status page/,
      /a local Codex session keeps its scrollback/,
      /Alt\+V with focus outside the terminal types only the image's path into a plain terminal/,
      /On macOS and Linux it types it only into an sh, bash, zsh, dash or ksh shell; with any other shell there, or over SSH, it types nothing/,
      /the app now finds its conversation for Logs/,
      // P3.16 final-head VM findings D1 to D3.
      /A new Claude conversation now appears in Logs and in search from its first message/,
      /The AI usage popover now opens above its chip in the session status strip/,
      /The Services panel no longer lists an ended session again/,
    ]) expect(all).toMatch(said)
    expect(all).not.toMatch(/come from Codex itself|your account of the other assistant|retries a Claude session again/)
    for (const text of [top.highlights ?? '', ...top.changes.map((c) => c.description)]) expect(text, text.slice(0, 40)).not.toMatch(/\u2014/)
  })
})

// [host] PR 4 ADR-009 round 2: a log_dir folder is shown selected in the
// folder that holds it, never opened, so the Feature Guide says so.
describe('app knowledge after PR 4 (ADR-009 round 2)', () => {
  it('says the log_dir folder is shown in the folder that holds it, not opened', () => {
    const body = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'troubleshooting')!.body
    expect(body).toMatch(/the log_dir folder when one is set, which the app shows selected in the folder that holds it rather than opening it/)
    expect(body).toMatch(/the app says so when it will not open or show it/)
    expect(body).not.toMatch(/The app opens only a plain folder/)
  })

  it('[host] says where the canvas skills go for this computer\'s own Codex sign-in, when they leave, and what a same-named skill of the user\'s own gets (question 5, answered C)', () => {
    const all = APP_KNOWLEDGE_SECTIONS.map((x) => x.body).join('\n')
    expect(all).toMatch(/The sign-in already on this computer gets them in your own Codex skills folder \(~\/\.codex\/skills, or the skills folder inside the folder CODEX_HOME names\), where Codex lists them for every session that uses that folder, however it is started\./)
    expect(all).toMatch(/they are removed when you turn Codex or the built-in tools off, and kept up to date while both are on\./)
    expect(all).toMatch(/A skill of your own with the same name \(agent-canvas, canvas-plan or conductor-vision\) is never touched/)
    // Option A's words are gone: no developer instructions, no picker clause.
    expect(all).not.toMatch(/developer_instructions|Through the resume picker, the guidance/)
  })
})

// [host] PR 4 VM checkpoint (F1): under the Auto preset Codex runs with
// `--ask-for-approval never`, so it cannot ask before a conductor tool that
// needs approval and refuses the call. Claude's Auto mode gets no per-tool
// approval for these tools from the app either, so Auto gets no keys (fail
// closed, OR4 decides) and the Feature Guide says so, with the workaround.
describe('app knowledge after the PR 4 VM checkpoint (F1)', () => {
  it('says Codex on Auto cannot ask before the canvas render, the Vision tools or the in-app browser, and names Standard or Unrestricted', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'known-issues')!.body
    expect(k).toMatch(/On the Auto preset, Codex cannot use the app's built-in tools other than the canvas snapshot and review: the Agent Canvas render, [^.]*the Vision tools, the push to the in-app browser/)
    expect(k).toMatch(/Auto starts Codex with no prompts at all, so it cannot ask before these tools and refuses each call instead/)
    expect(k).toMatch(/The canvas snapshot and review tools still run on Auto/)
    expect(k).toMatch(/The workaround: use the Standard preset, where Codex asks before each of these tools, or Unrestricted, where they run without asking/)
  })

  // [host] PR 4 review (RVMFIX-1): every tool a Codex connection may be
  // offered is refused on Auto but the two the app lets run on every preset
  // (canvas_snapshot and canvas_review: CODEX_PREALLOWED_TOOLS, pinned in
  // spawn-canvas.test.ts), so the line names each of the others. A tool added
  // to the Codex list without a phrase here fails.
  it('the Auto line names every tool offered to Codex that Auto refuses: all but the canvas snapshot and review', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((x) => x.id === 'known-issues')!.body
    const line = /On the Auto preset, Codex cannot use [^.]*\./.exec(k)?.[0] ?? ''
    const named: Record<string, RegExp> = {
      canvas_render: /the Agent Canvas render/, canvas_resolve: /resolving notes/, canvas_verdict: /verdicts/,
      canvas_version_verdict: /verdicts/, canvas_pick: /recording which option you chose/, canvas_complete: /marking a plan complete/,
      open_in_app_browser: /the push to the in-app browser/, fetch_host_screenshot: /the host screenshot fetch/,
      claude_review: /the Claude review/,
    }
    const refused = CODEX_CONDUCTOR_TOOLS.map((t) => t.name).filter((n) => n !== 'canvas_snapshot' && n !== 'canvas_review')
    expect(refused.length).toBeGreaterThan(20)
    for (const tool of refused) expect(line, tool).toMatch(named[tool] ?? (tool.startsWith('vision_') ? /the Vision tools/ : /a phrase for this tool/))
    expect(line).toMatch(/other than the canvas snapshot and review/)
  })
})

// [host] P4.11 (row 54, the PR 4 user-facing sweep): the Codex "Beta" labels
// come off in the release where parity lands (recorded 2026-09-26), in the
// Feature Guide, Ask Conductor's documentation, the README and the user guide.
describe('the PR 4 user-facing sweep (P4.11)', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const guide = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8')

  it('no surface labels Codex Beta', () => {
    for (const s of APP_KNOWLEDGE_SECTIONS) {
      expect(s.title, s.id).not.toMatch(/beta/i)
      expect(s.body, s.id).not.toMatch(/Codex \(Beta\)|Codex support is Beta|\(Codex support is Beta\)/)
    }
    expect(APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'codex')!.title).toBe('Codex: sessions and accounts')
    for (const s of APP_KNOWLEDGE_SECTIONS) expect(s.body, s.id).not.toMatch(/see Codex \(Beta\)/)
    expect(readme).not.toMatch(/Still marked Beta/)
    expect(guide).not.toMatch(/\*\*Codex\*\* \(Beta\)/)
  })

  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tip = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!.variants.primary
  // The policy wraps its lines, so phrases are matched with the wrapping undone.
  const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8').replace(/\s+/g, ' ')

  it('the Feature Guide filter is said where Ask Conductor reads it (review P411C-10, P411-2)', () => {
    expect(body('providers')).toMatch(/The Feature Guide and its tour show the cards for the assistants you use: with Codex alone, the cards for features that need Claude Code \(Dynamic Workflows and Multiple Accounts\) and Code review are not shown, and with Claude Code alone, Code review is not shown, since it needs both\./)
  })

  it('Artifacts: shown for an SSH Claude session signed in as a local account too, not only a local one', () => {
    expect(body('draw')).toMatch(/it appears for a Claude session signed into one of your accounts here, a local session or an SSH session signed in as an account you also use on this computer, and uses that account/)
    expect(body('draw')).not.toMatch(/appears for a local Claude session signed into an account/)
  })

  it('the tips for features that now work for both say so (P4.1, P4.2, P4.4, P4.5)', () => {
    expect(tip('tip.vision-system').shortText).toBe('Give your agent a browser to drive')
    expect(tip('tip.vision-system').body).toMatch(/gives your Claude and Codex sessions a real browser they can control/)
    expect(tip('tip.vision-system').body).not.toMatch(/gives Claude a real browser|that Claude can drive|showing Claude/)
    expect(tip('tip.memory-visualiser').shortText).toBe('Browse what your assistants remember about your projects')
    expect(tip('tip.cloud-agents').shortText).toBe('Dispatch an agent to work in the background')
    expect(TIPS_LIBRARY.find((t) => t.variants.primary.title === 'Codex Sessions')!.variants.primary.body).toMatch(/The Agent Canvas, Vision and the push to the Browser pane work in Codex sessions too./)
    expect(tip('tip.cloud-agents').body).toMatch(/runs headless agents on Claude Code or Codex in the background/)
    expect(tip('tip.transparency.vision-mcp').body).toMatch(/is offered the same vision, browser push, host screenshot and canvas tools, with `claude_review` in place of `codex_review`/)
  })

  it('the README says what PR 3 and PR 4 made true', () => {
    expect(readme).not.toMatch(/Ask Conductor, Cloud Agents and Insights are unavailable/)
    expect(readme).toMatch(/With Claude Code off, Insights runs for Codex accounts only, Ask Conductor runs on Codex, Cloud Agents runs Codex agents only/)
    expect(readme).not.toMatch(/Insights is unavailable/)
    expect(readme).toMatch(/Ask Conductor opens a real session, on Claude Code or Codex,/)
    expect(readme).not.toMatch(/review what Claude built|giving Claude eighteen|dispatch headless Claude|notices when Claude Code updates|straight into Claude|sends a prompt to Claude|driven by Claude's own hooks/)
    expect(readme).toMatch(/notices when Claude Code or Codex updates/)
    expect(readme).toMatch(/each Codex account's own memories/)
    expect(readme).toMatch(/Your agent, Claude or Codex, renders a design mockup/)
  })

  it('the user guide: what runs with Claude Code off, and the Codex known issues PR 4 ships with', () => {
    expect(guide).not.toMatch(/Ask Conductor, Cloud Agents and Insights are\s+unavailable/)
    expect(guide).toMatch(/With Claude Code off, Insights runs for Codex accounts only, Ask Conductor runs on\s+Codex, and Cloud Agents runs Codex agents only/)
    expect(guide).not.toMatch(/for Claude Code also Insights|Insights is unavailable/)
    expect(guide).not.toMatch(/for Claude Code also cloud agents and Insights/)
    // The guide wraps its lines, so a phrase is matched across a line break.
    const known = guide.slice(guide.indexOf('## Known issues with Codex'), guide.indexOf('## Logs & transcript viewer')).replace(/\s+/g, ' ')
    for (const said of [/On the Auto preset, Codex refuses the app's own tools/, /CCC copies its three canvas skills into your own Codex skills folder/, /cannot pass on emoji/, /documentation folder cannot be rebuilt/, /A Codex cloud agent run with Auto/]) expect(known).toMatch(said)
  })

  it('privacy: the staged skills, the copies in your own Codex folder and the record of it, the Memory page and log folders, and cloud agents', () => {
    expect(privacy).toMatch(/under `skills\/`/)
    const said = privacy.replace(/\s+/g, ' ')
    expect(said).toMatch(/it writes the same three into your own Codex folder, under `skills\/`/)
    expect(said).toMatch(/removes them when you turn Codex or the built-in tools off/)
    expect(said).toMatch(/notes that folder's path, and nothing else, in a small file in its own data folder/)
    expect(said).not.toMatch(/developer instructions|the app writes nothing there/)
    expect(privacy).toMatch(/\*\*The Memory page and Debug Logging read each Codex account's own folders\.\*\*/)
    expect(privacy).toMatch(/A cloud agent works the same way/)
  })
})

// [host] P4.11: the 2.1.1 entry lists what PR 4 and its sweep shipped, found
// by its highlight as the P3.16 block finds it.
describe('What\'s New after PR 4 (P4.11)', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  it('the 2.1.1 entry lists PR 4\'s features and the sweep\'s fixes, in plain ASCII', () => {
    expect(top.highlights).toMatch(/The Agent Canvas, Vision and the in-app browser, Ask Conductor, Cloud Agents and the Memory page work for Codex too, and Codex is no longer marked Beta\./)
    const all = top.changes.map((c) => c.description).join('\n')
    for (const said of [
      /The Agent Canvas works in Codex sessions as in Claude ones/,
      /Vision and the push to the in-app browser work in Codex sessions too/,
      /Cloud Agents run on Codex too/,
      /The Memory page lists each Codex account's own memories/,
      /Codex is no longer marked Beta/,
      /The Feature Guide and its tour show the cards for the assistants you use/,
      /with Claude Code alone, Code review is not shown, since it needs both/,
      /Claude Opus 5\.5, Claude Sonnet 5\.5 and Claude Haiku 5\.5 are in the model picker/,
      /The Usage page's Updated line now ages while the page stays open/,
      /now says 1 note, not 1 notes/,
    ]) expect(all).toMatch(said)
    for (const text of [top.highlights ?? '', ...top.changes.map((c) => c.description)]) expect(text, text.slice(0, 40)).toMatch(/^[\x20-\x7e]*$/)
  })

  // [host] The P4.11 copy review (P411C-2, -3, -5, -7, -8, -9): every line
  // says only what is true of what ships.
  it('the 2.1.1 lines claim no parity beyond the label, carry the Auto caveat, and list no fix for what never shipped', () => {
    const all = top.changes.map((c) => c.description).join('\n')
    expect(all).not.toMatch(/it now does what Claude Code does across the app/)
    expect(all).toMatch(/Codex is no longer marked Beta: the label is gone from setup, Settings, Accounts and the Feature Guide\./)
    const canvas = top.changes.find((c) => c.description.startsWith('The Agent Canvas works in Codex sessions'))!.description
    expect(canvas).toMatch(/On the Auto preset Codex refuses the canvas render and the canvas's other tools apart from the snapshot and review, because Auto cannot ask before them; use Standard or Unrestricted \(see Known issues\)\./)
    expect(all).not.toMatch(/Retry agent|Start session/)
    expect(all).toMatch(/Debug Logging opens each Codex account's log folder too, and shows a log_dir folder its settings name selected in the folder that holds it/)
    expect(all).toMatch(/A Codex session's right-click menu no longer offers Claude's account items \(Open artifacts, Authenticate claude\.ai and Sign in to Claude Code\), which acted on your primary Claude account, and its browser pane's start page no longer offers that account's claude\.ai\./)
    expect(all).not.toMatch(/A Codex tab's right-click menu/)
    const root = path.resolve(__dirname, '..', '..', '..')
    const surfaces = [
      all,
      fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
      ...APP_KNOWLEDGE_SECTIONS.map((s) => s.body),
      ...TIPS_LIBRARY.map((t) => t.variants.primary.body),
      ...trainingSteps.map((s) => JSON.stringify(s)),
    ]
    for (const s of surfaces) expect(s).not.toMatch(/read-only for now/)
  })
})

// [host] The P4.11 copy review (P411C-1, -4, -6).
describe('the P4.11 review: images, privacy and the first-launch session', () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8')
  it('the README shows no superseded Memory page, and the release record names the README images WP2 changed', () => {
    expect(read('README.md')).not.toMatch(/shot-memory\.png/)
    const rq = read('docs', 'wp1', 'evidence', 'release-qualification.md').replace(/\s+/g, ' ')
    expect(rq).not.toMatch(/shows a surface WP2 changed, so all references stay/)
    // The record says what was done: the images recaptured on the 2.1.1-beta.2 candidate and
    // approved by the owner, the Memory image not recaptured, and the macOS variants recaptured
    // on a macOS build of that candidate and approved too, with no line left calling them owed.
    for (const img of ['shot-tokenomics.png', 'shot-sessions.png', 'shot-canvas.png']) expect(rq).toMatch(new RegExp('`docs/screenshots/' + img.replace('.', '\\.') + '` \\| [^|]+ \\| Recaptured on the 2\\.1\\.1-beta\\.2 candidate and approved by the owner on 2026-10-07'))
    expect(rq).toMatch(/`docs\/screenshots\/shot-memory\.png` \| [^|]+ \| Not recaptured: the README shows no Memory image/)
    expect(rq).not.toMatch(/\| Recaptured at the final head|being recaptured with the README|await the owner's approval/)
    expect(rq).toMatch(/The six README images and the four Feature Guide images \(`v2-shell-hero\.jpg`, `step-session-options\.jpg`, `step-tokenomics\.jpg`, `step-vision\.jpg`\) were then recaptured on the 2\.1\.1-beta\.2 candidate and approved by the owner on 2026-10-07\./)
    expect(rq).toMatch(/Their macOS variants `step-session-options-mac\.jpg`, `step-tokenomics-mac\.jpg` and `step-vision-mac\.jpg` were then recaptured on a macOS build of the 2\.1\.1-beta\.2 candidate, made on a Mac from a later head of this branch, and approved by the owner on 2026-10-07\./)
    expect(rq).toMatch(/`src\/renderer\/assets\/training\/step-vision\.jpg` \| [^|]+ \| [^|]*Its macOS variant `step-vision-mac\.jpg` was recaptured on a macOS build of the same candidate and approved by the owner on 2026-10-07 too\. \|/)
    expect(rq).not.toMatch(/-mac\.jpg`?[^.|]*(?:not yet recaptured|remain owed)|owed, on a Mac/)
  })

  it('privacy: when the staged skills are written and removed, in a managed account\'s folder and in your own (question 5, answered C)', () => {
    const p = read('PRIVACY.md').replace(/\s+/g, ' ')
    expect(p).toMatch(/Last updated: 4 October 2026/)
    expect(p).toMatch(/while the built-in tools are on, whichever of them are on, and removes them at that account's next launch with the built-in tools off/)
    expect(p).not.toMatch(/while the matching built-in tool is on/)
    expect(p).toMatch(/In either folder it rewrites or removes only the skill folders it marked as its own, never through a link, and never a skill of yours with the same name\./)
    // Option A's settings scan is gone, and PRIVACY no longer lists it.
    expect(p).not.toMatch(/cloud-config-bundle-cache\.json|without reading them|ProgramData\\OpenAI\\Codex/)
  })

  it('the first session on a new Codex account or folder: a neutral known issue with its workaround, in both places', () => {
    const k = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'known-issues')!.body
    expect(k).toMatch(/The first Codex session in a new folder may not stay read-only\. In the session in which Codex asks its first-launch questions \(whether you trust the folder, and on Windows how to set up its sandbox\), Codex runs as on the Standard preset even when the session was started on Read-only: it can edit files in the folder, and commands you approve can run outside its sandbox\. This is Codex's own behaviour, and later sessions keep the preset you chose\. The workaround: once you have answered those questions, Restart the session before relying on Read-only\./)
    const guide = read('docs', 'USER_GUIDE.md').replace(/\s+/g, ' ')
    expect(guide).toMatch(/\*\*The first Codex session in a new folder may not stay read-only\.\*\*/)
  })
})

// [host] WP2 PR 4, P4.7 (row 68): what the app says about Insights for Codex,
// and row 58's signed artifacts record (decision A, item 4).
describe('Insights for Codex, said where Ask Conductor reads it (P4.7)', () => {
  const privacy = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'PRIVACY.md'), 'utf8').replace(/\s+/g, ' ')
  const sec = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  const tipOf = (id: string) => TIPS_LIBRARY.find((t) => t.id === id)!
  it('the pages section says how a Codex report is made, and what Run all covers', () => {
    expect(sec('pages')).toMatch(/Insights builds a qualitative digest of how your Claude Code and Codex sessions have been going/)
    expect(sec('pages')).toMatch(/for a Codex account the app makes the report itself: it counts that account's own Codex sessions, then asks Codex to write the cards, read-only and with no tools, on that account's own allowance/)
    expect(sec('pages')).toMatch(/every account of both assistants in one roll-up/)
    expect(sec('pages')).not.toMatch(/how your Claude sessions have been going/)
  })
  it('an Insights report keeps either assistant in use, and runs for Codex with Claude Code off', () => {
    expect(sec('providers')).toMatch(/a sign-in, a Sentinel check or analysis, or an Insights report\./)
    expect(sec('providers')).toMatch(/With Claude Code off, Insights runs for Codex accounts only/)
    expect(sec('providers')).not.toMatch(/for Claude Code also Insights|Insights is unavailable/)
  })
  it("the Insights tip is no longer Claude Code's alone", () => {
    expect(tipOf('tip.insights').provider).toBeUndefined()
    expect(tipOf('tip.insights').variants.primary.body).toMatch(/Claude Code's or Codex's/)
    expect(tipOf('tip.insights').variants.primary.body).not.toMatch(/Claude-powered|Claude usage/)
  })
  it("row 58's signed record: the Feature Guide and the artifacts tip name Codex's /export", () => {
    expect(sec('draw')).toMatch(/Codex has no artifacts of its own: in a Codex session, Codex's \/export saves the conversation as Markdown/)
    expect(tipOf('tip.artifacts-button').variants.primary.body).toMatch(/in a Codex session, Codex's `\/export` saves the conversation as Markdown/)
  })
  it('the privacy policy says what a Codex report reads and sends', () => {
    expect(privacy).toMatch(/A report on a Codex account reads that account's own conversation files \(its sessions folder\) on this computer/)
    expect(privacy).toMatch(/to Codex's model, as one read-only run of the Codex command-line tool with no tools, on that account's own sign-in and allowance/)
    expect(privacy).toMatch(/the previous report's figures as numbers only/)
  })
  it("the privacy policy says what Run all's written analysis is sent, in both directions, and where that run is kept", () => {
    expect(privacy).toMatch(/It is sent the comparison the app computed, and nothing else: each account's name as the roll-up shows it \(which can be its email\), its reporting period, its figures, and the first three items of each of its top lists\./)
    expect(privacy).toMatch(/its most-used tool and MCP server names \(a name that is not a plain identifier is sent as "other"\), its languages, and the short goal summaries Codex wrote for its report\./)
    expect(privacy).toMatch(/when the analysis runs on Claude Code, all of it, the Codex accounts' part included, goes to Anthropic under that Claude Code account/)
    expect(privacy).toMatch(/when it runs on a Codex account, all of it, the other accounts' goal summaries and MCP server names included, goes to OpenAI under that Codex account/)
    expect(privacy).toMatch(/On Claude Code it runs with no tools, keeps no transcript and loads none of your own settings or instruction files/)
    expect(privacy).toMatch(/Codex keeps it in that account's sessions folder, as it keeps a report's run\./)
    expect(privacy).not.toMatch(/and no conversation text, the same way/)
  })
})

// [host] Usage track MP10: which account Claude usage counts under, said
// exactly, a resumed session included.
describe('Claude usage by account, said where Ask Conductor reads it (MP10)', () => {
  const pages = () => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'pages')!.body
  const guide = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\s+/g, ' ')
  it('a resumed session moves on to its new profile, and a Not recorded one resumed under a profile takes that account for its earlier usage', () => {
    expect(pages()).toMatch(/a session resumed under another account profile counts toward that one from then on, and what it used before keeps its account\./)
    expect(pages()).toMatch(/with one exception: when a local session listed as Not recorded is later resumed in the app under an account profile, its earlier usage moves to that profile's account too\./)
    expect(guide).toMatch(/A session resumed under another account profile counts toward that one from then on; what it used before keeps its account\./)
    expect(guide).toMatch(/with one exception: when a local session that reads \*Not recorded\* is later resumed in the app under an account profile, its earlier usage moves to that profile's account too\./)
  })
})

// [host] The 2.1.1-beta.2 entry states the hardening this release ships, one
// line per guarantee, found by its highlight as the blocks above find it. The
// pins match key phrases, so a copy edit that keeps the guarantee keeps them.
describe('What\'s New (2.1.1-beta.2): the hardening it ships, as guarantees', () => {
  const top = changelog.find((e) => e.highlights?.startsWith('Codex becomes a full second assistant'))!
  const all = () => top.changes.map((c) => c.description).join('\n')
  it('lists each guarantee, in plain ASCII', () => {
    for (const said of [
      /When the app's settings cannot be read, the built-in tools stay off until they can\./,
      /refused once their session ends; an SSH Persistent session that stays running on its host keeps its own across a restart of the app\./,
      /A Codex review now runs without the Codex settings file or the rules files of the account it runs on\./,
      /Failure text from a review, a Codex Insights run, a Codex cloud agent or a Sentinel analysis that runs on Codex hides credentials written inside URLs and session values\./,
      /cloud agent that runs on Codex, keeps its Codex account in use until anything it left running has been ended\./,
      /On Windows a Codex session's PATH keeps only absolute folders/,
      /On Windows a Claude session's PATH keeps only absolute folders too, and so does the PATH of the terminals in which the app sets up Claude Code and runs its \/insights command, and of a cloud agent, a Sentinel or Insights run, a Claude review or the check of whether one can run, the sign-in check, the Claude Code version check during onboarding, the list of versions to pin and a pinned version's install\./,
      /only in the folders PATH names or in the Windows system folder, never in the current folder\./,
      /A Claude Code or Codex session in a network folder that its npm launcher cannot start from is refused, with the reason/,
      /Ask Conductor's conversation list stays inside its help folder/,
      /Names and paths shown from outside the app drop more invisible characters\./,
      /Sentinel's proposed model entries follow the same name rule as the model picker\./,
      /A Claude Code config's extra CLI arguments are now held to a rule of the same shape as a Codex config's/,
      /and so is a word Claude Code would read as a command or as a server to run the session on, or that starts or ends with a comma\./,
      /extra CLI arguments now come after the app's own options on its start line\. On Windows each word reaches a local Claude Code session as one argument, exactly as typed\./,
      /the resume list hands agent templates and other options to Claude Code exactly as written, or starts nothing and says why/,
      /starts under your login shell when it is sh, bash, zsh, dash or ksh/,
      /finds Claude Code where that shell finds it when asked to run a command, so a PATH change made only in interactive shells, such as nvm\.fish's default node, is not seen \(see Known issues in the Feature Guide\)\./,
      /On macOS and Linux, a terminal tab whose shell is outside the sh family, such as fish or PowerShell, opens in its folder, and the app types no folder line into it\./,
      /A session's status bar shows only its own status updates\./,
      /the log says why, and a status line of your own still shows/,
      /starts nothing and says so; it never runs on another account in its place\./,
      /Closing or ending an SSH session removes the files the app last wrote for it from the host it wrote them to, when the app can reach that host with a key or a saved password/,
      /answer only the app's own window\./,
      /an account's sign-in is written only into folders the app has made readable by you alone and checked/,
      /A web sign-in you cancel or leave unfinished never stays signed in after a restart/,
      /only right after your own click, tap, Enter or Space in the view\./,
      /Insights keeps its reports only in its own folder/,
      /Insights shows no report, rather than waiting, when a report cannot be read\./,
      /The cross-account roll-up's written analysis is shown as plain text\./,
      /The app starts normally even when the Insights catalogue cannot be updated or has been edited into another shape\./,
    ]) expect(all()).toMatch(said)
    for (const c of top.changes) expect(c.description, c.description.slice(0, 40)).toMatch(/^[\x20-\x7e]*$/)
  })

  it('the review line names only what the review leaves out by its own flags, and no handler line claims more than its own channels', () => {
    expect(all()).not.toMatch(/review[^.]*without[^.]*hooks/i)
    expect(all()).not.toMatch(/as the others do/)
  })
})

// [host] What the 2.1.1-beta.2 hardening adds where Ask Conductor and the
// Feature Guide read it: the extra CLI arguments rule for Claude Code, a
// session whose account is gone, and each known issue it ships with, with
// its workaround.
describe('app knowledge for the 2.1.1-beta.2 hardening', () => {
  const body = (id: string) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)!.body
  it('says what a Claude Code config\'s extra CLI arguments refuse, and how to give a folder or a value', () => {
    const s = body('sessions')
    expect(s).toMatch(/For Claude Code, the extra CLI arguments come after the app's own options, and what the app sets, or what changes the conversation, where or how the session runs, its permission mode or the settings it reads, is refused, whether Claude Code's help lists it or not/)
    expect(s).toMatch(/--cloud, --bare and --safe-mode among them\./)
    expect(s).toMatch(/a word that starts with an address, a name and a colon as a web address does, which Claude Code can read as a server to run the session on: give a folder as --add-dir=docs, and an option's value after an = sign\./)
    expect(s).toMatch(/an option's value after an = sign\. So is a word that starts or ends with a comma: give a comma only inside a word, such as --allowedTools=Bash,Edit\./)
  })

  it('says a Claude session whose account is gone starts nothing, in the words the app shows', () => {
    expect(body('accounts')).toMatch(/starts nothing and says so: This session's Claude account is no longer set up here\. Choose an account for it and start it again\. It never runs on another account in its place\./)
  })

  it('each known issue it ships with carries its workaround', () => {
    const k = body('known-issues')
    for (const said of [
      /cannot start through the npm launcher, claude\.cmd or codex\.cmd, so the app refuses it and says why\. Workaround: open the folder from a mapped drive letter, or install the native Claude Code or the standalone Codex\./,
      /Ask Conductor cannot start, on either assistant, when the resources folder's path holds a ; on Windows \(a : on macOS and Linux\) or a control character; it says so and starts nothing\. Workaround: choose a resources folder whose path has none\./,
      /holds a % sign or a control character: it starts nothing, and names the template or option where it can\. Workaround: remove the % sign, or install the native Claude Code\./,
      /other variables set only in that shell's own configuration are not passed on\. Workaround: set them in \.zshenv \(macOS\) or \.bashrc \(Linux\) in your home folder as well\./,
      /a folder added to PATH only in interactive fish shells, such as nvm\.fish's default node version, is not seen, and a Claude Code installed with npm under that node reads as not found\./,
      /Workaround: add the line nvm use --silent \$nvm_default_version to your config\.fish outside any is-interactive block\./,
      /also add Claude Code's folder to PATH in \.zprofile \(macOS\) or \.profile \(Linux; \.bash_profile if you have one\) in your home folder; until then the app may report Claude Code as not found/,
      /add the folder that holds it \(for Claude Code, the folder with claude\.exe or claude\.cmd\) to your PATH as a full path, then restart the app\./,
      /only when you name it with \.\\ in front \(\.\\build\.cmd rather than build\.cmd\)\. Terminal tabs are unchanged\./,
      /a status line of your own still shows\. Workaround: choose a resources folder whose path has none of these\./,
      /give an option's value after an = sign when the value starts with letters and a colon/,
      /and write a list with no space after its commas \(--allowedTools=Bash,Edit rather than --allowedTools=Bash, Edit\)\./,
      /that account cannot be used and nothing is written there\. Workaround: make your Windows user the owner of AI Code Conductor's resources folder/,
      /make sure Windows PowerShell, whoami and icacls are allowed to run for your user/,
      /Insights runs only when the insights folder in your resources folder is a real folder, not a link or junction/,
      /and on macOS and Linux one you own whose permissions let only you write to it\./,
      /On macOS the app keeps your accounts' sign-in folders in your resources folder to you alone, and the Insights and Sentinel folders there writable only by you, through their owner and permissions\. That holds when the resources folder is on a volume that honours ownership/,
      /Workaround: keep the resources folder on your Mac's own disk, or on a drive whose Get Info has Ignore ownership on this volume turned off/,
    ]) expect(k).toMatch(said)
    // Sessions start through node (the resume picker), so the native installer
    // alone does not help a user whose only node is an interactive-only one.
    expect(k).not.toMatch(/native Claude Code installer, which needs no node/)
  })

  it('says on macOS that the sign-in folders stay yours only while only you can write to the resources folder, and how to keep it so', () => {
    const k = body('known-issues')
    expect(k).toMatch(/That holds when the resources folder is on a volume that honours ownership, only you can write to the resources folder, and no access entry on it, or passed down to it from a folder above, lets another user in\./)
    expect(k).toMatch(/Ignore ownership on this volume turned off, as a folder only you can write to, and not inside a folder you have opened to other users with access entries/)
  })

  it('names each Windows program the sign-in folder check starts, so a check that gets no answer points at the right one', () => {
    const k = body('known-issues')
    expect(k).toMatch(/If the app cannot check those folders \(Windows PowerShell, or whoami or icacls, which the app starts when Windows PowerShell gives it no answer, did not answer in time or is not allowed to run\), it writes nothing there and says so/)
    expect(k).toMatch(/make sure Windows PowerShell, whoami and icacls are allowed to run for your user, since the app uses them to check those folders' rights\./)
  })
})
