/**
 * The training screenshot tool's provider seed (WP2 PR 4, P4.11 recapture;
 * review item P411-3): what the capture's throwaway data root needs so the
 * shots the P4.11 inventory lists show both assistants as a user who runs
 * them sees them:
 *  - Claude Code and Codex both on, and Codex's on/off an answer
 *    (codexAnswered), with the one-time pages that would cover the window
 *    already seen (Hello Codex, the multi-spawn intro, logging consent, the
 *    What's New of this version);
 *  - two fictional Claude accounts (legacy profiles, which main mirrors into
 *    the account registry at start), each answering `claude auth status`
 *    through the stand-in CLI as signed in;
 *  - two fictional Codex accounts in the registry, written with the app's
 *    own registry transitions (src/shared/providers, as the e2e seed does):
 *    the first the default, the second the reviewer; the first keeps a few
 *    Codex memories, the second has memories off;
 *  - stand-in `claude` and `codex` CLIs (no network, no real account) that
 *    the app finds, at versions it supports, so the Providers card reads
 *    both as found.
 *
 * Everything is written inside the capture's data root; seedCaptureProviders
 * refuses a path outside it. Nothing reads or writes the real ~/.claude or
 * ~/.codex: the launch environment (capture-env.ts) points the app's home,
 * app data and temp folders inside the root and takes every real Claude and
 * Codex off its PATH.
 *
 * No Playwright import, so the unit suite reads this directly
 * (tests/unit/scripts/capture-seed.test.ts).
 */
import fs from 'fs'
import path from 'path'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, setReviewerDefault,
  checkRegistryInvariants, parseRegistryDoc,
} from '../src/shared/providers'
import type { ProviderRegistryDoc, RegistryResult } from '../src/shared/providers'
import { LOGGING_CONSENT_VERSION } from '../src/shared/logging-consent-version'
import { CLAUDE_MIN_MANAGED_CLI_VERSION } from '../src/main/providers/claude/managed-launch'
import { installFakeCodex, signInFakeRealm } from '../tests/e2e/helpers/fake-codex'

const IS_WIN = process.platform === 'win32'

/** The settings keys the recapture needs, merged into the seeded settings. */
export const CAPTURE_PROVIDER_SETTINGS = Object.freeze({
  claudeEnabled: true,
  codexEnabled: true,
  // A saved on/off counts only with the answer (codex/enablement.ts).
  codexAnswered: true,
  loggingConsentSeen: true,
  loggingConsentVersion: LOGGING_CONSENT_VERSION,
  conductorToolsEnabled: true,
  sentinelEnabled: false,
})

/** The app-meta keys that keep this version's one-time pages from covering
 *  the window: What's New compares lastSeenVersion and lastRunVersion with
 *  the running version exactly (onboarding/upgrade-flow.ts), Hello Codex and
 *  the multi-spawn intro record that they were seen. */
export function captureAppMetaKeys(appVersion: string): Record<string, string> {
  return {
    lastSeenVersion: appVersion,
    lastRunVersion: appVersion,
    helloCodexSeenVersion: appVersion,
    multiSpawnIntroVersion: appVersion,
  }
}

/** The fictional Claude accounts (legacy profiles; ids as account-profiles
 *  makes them). Example domains only. */
export const CAPTURE_CLAUDE_ACCOUNTS = Object.freeze([
  { id: 'profile-demo-work', name: 'Work', email: 'dev@example.com', org: 'Example Co', primary: true },
  { id: 'profile-demo-oss', name: 'Open source', email: 'dev.oss@example.org', org: 'Example OSS', primary: false },
])

/** The fictional Codex accounts: opaque ids (prefix + lowercase hex, as the
 *  app makes them). The first is the provider default (the first committed
 *  account becomes it), the second the reviewer. */
export const CAPTURE_CODEX_ACCOUNTS = Object.freeze([
  {
    identityId: 'idn-c0de5eed00000000000000a1', accountId: 'acct-c0de5eed00000000000000a1', realmId: 'realm-c0de5eed00000000000000a1',
    name: 'Codex work', colourKey: 'indigo', label: 'dev@example.com', plan: 'Plus', reviewer: false, memories: true,
  },
  {
    identityId: 'idn-c0de5eed00000000000000b2', accountId: 'acct-c0de5eed00000000000000b2', realmId: 'realm-c0de5eed00000000000000b2',
    name: 'Codex reviews', colourKey: 'rose', label: 'reviews@example.org', plan: 'Pro', reviewer: true, memories: false,
  },
])

/** Codex's own memory files for the first account: Codex writes a heading,
 *  not frontmatter (account-memories.ts). Fictional. */
export const CAPTURE_CODEX_MEMORIES: Readonly<Record<string, string>> = Object.freeze({
  'MEMORY.md': '# Memory\n\nThe api-server handlers stay thin: validation in the route, logic in the service layer.\nRun the integration suite against the local test database before a migration.\n',
  'raw_memories.md': '# Raw memories\n\nPrefers small pull requests with one migration each.\nThe staging deploy waits for the smoke checks.\n',
  [path.join('rollout_summaries', '2026-09-28-retry-backoff.md')]: '# Retry backoff for the payments client\n\nAdded jittered backoff (3 tries) to the payments client and a test for the third failure.\n',
})

function ok(r: RegistryResult, step: string): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`[capture] seeding the Codex accounts failed at ${step}: ${r.code}: ${r.message}`)
  return r.doc
}

/** The registry the capture starts with: the two Codex accounts, signed in,
 *  the first the default and the second the reviewer. Claude's accounts are
 *  mirrored in by main at start from the legacy profiles. */
export function buildCaptureRegistry(now: number): ProviderRegistryDoc {
  let doc = emptyRegistry()
  let t = now
  for (const a of CAPTURE_CODEX_ACCOUNTS) {
    doc = ok(createIdentity(doc, { id: a.identityId, friendlyName: a.name, colourKey: a.colourKey }, t++), 'createIdentity')
    doc = ok(beginAccountSetup(doc, {
      accountId: a.accountId, realmId: a.realmId, providerId: 'codex', method: 'browser',
      realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${a.realmId}`,
    }, t++), 'beginAccountSetup')
    doc = ok(commitAccountSetup(doc, a.accountId, {
      identityId: a.identityId, authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted',
      providerLabel: a.label, planLabel: a.plan,
    }, t++), 'commitAccountSetup')
  }
  const reviewer = CAPTURE_CODEX_ACCOUNTS.find((a) => a.reviewer)
  if (reviewer) doc = ok(setReviewerDefault(doc, 'codex', reviewer.accountId, t++), 'setReviewerDefault')
  const problems = checkRegistryInvariants(doc)
  if (problems.length) throw new Error(`[capture] the seeded registry breaks its invariants: ${problems.join('; ')}`)
  const parsed = parseRegistryDoc(JSON.parse(JSON.stringify(doc)))
  if (!parsed.ok) throw new Error(`[capture] the seeded registry does not parse back: ${JSON.stringify(parsed)}`)
  return doc
}

/** The stand-in Claude CLI (node), answering what the app asks a Claude it
 *  found: `--version` (at the managed launch's minimum, so it reads as
 *  supported), `auth status` for the profile home the app runs it in
 *  (USERPROFILE/HOME: signed in as that profile's `.claude.json` account),
 *  and a headless `-p` run (an empty answer). Anything else stands in for a
 *  session: one line, then up until Ctrl+C or the end of its input. It
 *  reads only that `.claude.json` and talks to no network. */
function fakeClaudeScript(version: string): string {
  return [
    "const fs = require('fs'), path = require('path')",
    'const NL = String.fromCharCode(10)',
    'const argv = process.argv.slice(2)',
    `if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write('${version} (Claude Code)' + NL); process.exit(0) }`,
    "if (argv[0] === 'auth' && argv[1] === 'status') {",
    "  const home = process.env.USERPROFILE || process.env.HOME || ''",
    '  let acct = null',
    "  try { acct = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).oauthAccount } catch (e) { acct = null }",
    "  if (!acct || typeof acct.emailAddress !== 'string') { process.stdout.write(JSON.stringify({ loggedIn: false }) + NL); process.exit(1) }",
    "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: acct.emailAddress, orgName: acct.organizationName, subscriptionType: 'max' }) + NL)",
    '  process.exit(0)',
    '}',
    "if (argv.includes('-p') || argv.includes('--print')) { process.stdout.write('{}' + NL); process.exit(0) }",
    'const CRLF = String.fromCharCode(13, 10)',
    `process.stdout.write('Claude Code ${version} (capture stand-in): ready' + CRLF)`,
    "const quit = () => { process.stdout.write('bye' + CRLF); process.exit(0) }",
    'if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)',
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (c) => { if (c.includes(String.fromCharCode(3))) quit() })",
    "process.stdin.on('end', quit)",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n')
}

/** The stand-in Claude CLI's version: the managed launch's minimum. */
export const CAPTURE_CLAUDE_VERSION = CLAUDE_MIN_MANAGED_CLI_VERSION

/** Write the stand-in Claude into `dir` (created), beside the stand-in Codex
 *  (installFakeCodex, which also writes the POSIX login-shell stand-in). */
export function installFakeClaude(dir: string, version: string = CAPTURE_CLAUDE_VERSION): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'fake-claude.js'), fakeClaudeScript(version))
  if (IS_WIN) {
    // npm's cmd-shim template, node pinned to this one (as installFakeCodex).
    fs.writeFileSync(path.join(dir, 'claude.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      `SET "_prog=${process.execPath}"`,
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%fake-claude.js" %*', '',
    ].join('\r\n'))
  } else {
    fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'fake-claude.js'))})\n`, { mode: 0o755 })
  }
}

/** a === b or a inside b (resolved, case-blind on Windows). */
function inside(child: string, parent: string): boolean {
  const norm = (p: string) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(norm(parent), norm(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface CaptureProviderSeed {
  /** The capture's throwaway data root: every path below must be in it. */
  dataRoot: string
  /** <dataRoot>/resources */
  resourcesDir: string
  /** The capture's home (capture-env.ts captureHomeDir). */
  homeDir: string
  /** Where the stand-in CLIs go (capture-env.ts captureFakeBinDir). */
  fakeBinDir: string
  now: number
}

/** Seed the accounts and the stand-in CLIs. Returns every file written. */
export function seedCaptureProviders(o: CaptureProviderSeed): string[] {
  for (const p of [o.resourcesDir, o.homeDir, o.fakeBinDir]) {
    if (!inside(p, o.dataRoot) || path.resolve(p) === path.resolve(o.dataRoot)) {
      throw new Error(`[capture] refusing to seed ${p}: it is not inside the capture's data root ${o.dataRoot}`)
    }
  }
  const written: string[] = []
  const write = (file: string, text: string): void => {
    if (!inside(file, o.dataRoot)) throw new Error(`[capture] refusing to write ${file} outside ${o.dataRoot}`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
    written.push(file)
  }

  // Claude: the legacy profiles main mirrors into the registry at start, and
  // each profile home's account (what the stand-in's `auth status` answers).
  const profilesRoot = path.join(o.resourcesDir, 'account-profiles')
  write(path.join(profilesRoot, 'profiles.json'), JSON.stringify({
    profiles: CAPTURE_CLAUDE_ACCOUNTS.map((a) => ({
      id: a.id, name: a.name, accountEmail: a.email, isPrimary: a.primary, createdAt: o.now - 30 * 86_400_000,
    })),
  }, null, 2))
  for (const a of CAPTURE_CLAUDE_ACCOUNTS) {
    write(path.join(profilesRoot, a.id, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: a.email, organizationName: a.org },
    }, null, 2))
  }

  // Codex: the registry, each account's folder (signed in as far as the
  // stand-in can tell), and the first account's memories.
  write(path.join(o.resourcesDir, 'providers', 'registry.json'), JSON.stringify(buildCaptureRegistry(o.now), null, 2))
  for (const a of CAPTURE_CODEX_ACCOUNTS) {
    const realm = path.join(o.resourcesDir, 'codex-realms', a.realmId)
    if (!inside(realm, o.dataRoot)) throw new Error(`[capture] refusing the realm folder ${realm}`)
    signInFakeRealm(realm, `Logged in using ChatGPT (${a.label})`)
    written.push(path.join(realm, 'auth.fake'))
    if (a.memories) {
      for (const [name, text] of Object.entries(CAPTURE_CODEX_MEMORIES)) write(path.join(realm, 'memories', name), text)
    }
  }

  // The stand-in CLIs.
  installFakeCodex(o.fakeBinDir)
  installFakeClaude(o.fakeBinDir)
  for (const name of fs.readdirSync(o.fakeBinDir)) written.push(path.join(o.fakeBinDir, name))
  return written
}
