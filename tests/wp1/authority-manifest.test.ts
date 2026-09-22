// WP1.38 (slice 2): the GENERATED Claude authority manifest (D16).
//
// WP1.38 is "ambient poisoning cannot override the bound realm". What counts as
// ambient poisoning is decided by the authority list, and the hand-written one
// was an incomplete denylist -- so the list itself is now derived from the CLI
// and this suite is what holds that derivation honest.
//
// Two tiers, deliberately separated:
//
//   1. Tests that need NO Claude binary -- schema, internal digest, tamper
//      detection, and the invariants the app relies on. These are what CI runs,
//      and they are why a build and the full suite succeed on a machine with
//      Claude Code not installed.
//
//   2. ONE test that re-derives from the pinned development fixture and requires
//      byte-for-byte reproduction. It SKIPS when the binary is absent. The
//      binary is proprietary and is never vendored, excerpted or committed.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  validateAuthorityManifest, authorityManifest, authorityManifestProvenance,
  isClaudeSettingsEnvAuthority, isClaudeAmbientAuthority, authorityEntryFor,
  claudeCliPrefixRules,
  CLAUDE_SETTINGS_ENV_STRIP, CLAUDE_AMBIENT_STRIP,
  AUTHORITY_MANIFEST_ERROR, AUTHORITY_MANIFEST_SCHEMA_VERSION,
} from '../../src/main/providers/claude/authority-manifest'
// The generator is maintainer-only and needs a binary; its presence RULE is a
// pure function and is tested here with none.
import {
  repoAddedOccurrence, requiresExactRuling, classify, composeCensusRulings,
  CLI_OWNED_NAMESPACES, CLI_OWNED_CENSUS_FRAGMENTS, CENSUS_CLASSIFICATION, canonicalManifestDigest,
} from '../../scripts/claude-authority-classification.mjs'
import { CLI_OWNED_CENSUS_RULINGS } from '../../scripts/claude-authority-census-rulings.mjs'

const REPO = path.resolve(__dirname, '..', '..')
const MANIFEST_PATH = path.join(REPO, 'src', 'main', 'providers', 'claude', 'claude-authority-manifest.json')

/** The pinned development fixture. Absent on CI and on a fresh clone. */
function pinnedBinary(): string | null {
  const candidates = [
    process.env.CLAUDE_BINARY,
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  ].filter((c): c is string => Boolean(c))
  return candidates.find((c) => existsSync(c)) ?? null
}

describe('the generated authority manifest', () => {
  it('loads and validates with no Claude binary present', () => {
    expect(AUTHORITY_MANIFEST_ERROR).toBeNull()
    expect(authorityManifest().schemaVersion).toBe(AUTHORITY_MANIFEST_SCHEMA_VERSION)
  })

  it('states its provenance precisely, so no completeness claim outruns its scope', () => {
    const p = authorityManifestProvenance()
    expect(p).not.toBeNull()
    // The claim is about ONE version, ONE platform and ONE binary -- never "the
    // CLI" in general. A different digest means revalidation is required.
    expect(p?.cliVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(p?.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(p?.binarySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(p?.binaryBytes).toBeGreaterThan(0)
    // Every extraction site names WHERE in the CLI the set came from.
    expect(p!.extractedFrom.length).toBeGreaterThanOrEqual(2)
    for (const src of p!.extractedFrom) {
      expect(src.id.length).toBeGreaterThan(0)
      expect(src.what.length).toBeGreaterThan(0)
    }
  })

  it('detects a tampered manifest instead of silently shrinking the strip list', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const tampered = { ...raw, entries: raw.entries.filter((e: { name: string }) => e.name !== 'ANTHROPIC_API_KEY') }
    const result = validateAuthorityManifest(tampered)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/digest/)
  })

  it('rejects a flipped disposition, not just a removed entry', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const flipped = {
      ...raw,
      entries: raw.entries.map((e: { name: string; ambient: string }) =>
        e.name === 'ANTHROPIC_API_KEY' ? { ...e, ambient: 'keep' } : e),
    }
    const result = validateAuthorityManifest(flipped)
    expect(result.ok).toBe(false)
  })

  it('rejects a CLAUDE name settled by a FAMILY RULE instead of by its own ruling', () => {
    // The rail that keeps the census's family rules away from the names that
    // decide which account a session runs as. It was the one validator branch
    // with no synthetic-manifest test, so removing it changed nothing
    // (adversarial re-attack, MAJOR) -- which is how a Claude-namespaced
    // authority variable could have picked up a weaker pattern disposition.
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const familyId = raw.provenance.familyRules[0].id
    const target = raw.entries.find((e: { name: string }) => /^CLAUDE/.test(e.name))
    expect(target, 'no Claude-namespaced entry to test with').toBeDefined()
    const smuggled = {
      ...raw,
      entries: raw.entries.map((e: { name: string }) => (e.name === target.name ? { ...e, reason: familyId } : e)),
    }
    const result = validateAuthorityManifest(smuggled)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/needs a ruling of its own/)
    // ...and the same for ANT_, the CLI's third own namespace. The generator's
    // rule and this validator guard have to agree, or a hand-edited manifest
    // could carry an ANT_ name under a family reason the generator would refuse.
    // ...and for EVERY namespace the manifest itself declares as the CLI's own.
    // The guard was a three-item prefix list twice, and each time a namespace
    // the census treated as Claude's was missing from it. Now the manifest
    // carries the list, the validator reads it, and this loop walks it.
    for (const ns of raw.provenance.cliOwnedNamespaces as string[]) {
      const member = raw.entries.find((e: { name: string }) => new RegExp(`^${ns}`).test(e.name))
      if (!member) continue // a namespace with no member in this binary
      const smuggledNs = validateAuthorityManifest({
        ...raw,
        entries: raw.entries.map((e: { name: string }) => (e.name === member.name ? { ...e, reason: familyId } : e)),
      })
      expect(smuggledNs.ok, `${ns}: ${member.name} was accepted under a family reason`).toBe(false)
    }
    const ant = raw.entries.find((e: { name: string }) => /^ANT_/.test(e.name))
    expect(ant, 'no ANT_-namespaced entry to test with').toBeDefined()
    const smuggledAnt = validateAuthorityManifest({
      ...raw,
      entries: raw.entries.map((e: { name: string }) => (e.name === ant.name ? { ...e, reason: familyId } : e)),
    })
    expect(smuggledAnt.ok).toBe(false)
    expect(smuggledAnt.ok === false && smuggledAnt.error).toMatch(/needs a ruling of its own/)
    // ...and the same reason on a NON-Claude name is fine, which is the whole
    // point of the split.
    const owned = new RegExp(`^(${raw.provenance.cliOwnedNamespaces.join('|')})`)
    const nonClaude = raw.entries.find((e: { name: string }) => !owned.test(e.name))
    expect(validateAuthorityManifest({
      ...raw,
      entries: raw.entries.map((e: { name: string }) => (e.name === nonClaude.name ? { ...e, reason: familyId } : e)),
    }).ok).toBe(true)
  })

  it('rejects an unknown schemaVersion rather than guessing the shape', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const result = validateAuthorityManifest({ ...raw, schemaVersion: 99 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/schemaVersion/)
  })

  it('carries the names the 33-entry hand-written list missed', () => {
    // Each was found by the adversarial pass and was absent from all of src/ and
    // docs/wp1/ -- not considered and excluded, simply missing. Being in the
    // INVENTORY is the claim here; the disposition is a separate decision.
    for (const name of [
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
      'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
      'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION', 'ANTHROPIC_SERVICE_ACCOUNT_ID',
      'ANTHROPIC_SCOPE', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_API_BASE_URL',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_BRIDGE_OAUTH_TOKEN',
      'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS',
    ]) {
      expect(authorityEntryFor(name), name).not.toBeNull()
    }
    // The Claude-specific ones are removed; the shared developer credentials are
    // preserved, because a probe showed they cannot redirect Claude alone.
    for (const name of ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_SCOPE', 'CLAUDE_CODE_API_BASE_URL']) {
      expect(isClaudeSettingsEnvAuthority(name), name).toBe(true)
    }
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(isClaudeSettingsEnvAuthority(name), name).toBe(false)
      expect(isClaudeAmbientAuthority(name), name).toBe(false)
    }
  })

  it('keeps the currently INERT remote/managed variables in the strip', () => {
    // Probed against 2.1.278: these three are never read -- the override reader
    // is a stub in that build. They stay because their inactivity is
    // pinned-version evidence, not a contract. (owner ruling, D16 item 8)
    for (const name of [
      'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
      'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
      'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION',
    ]) {
      expect(authorityEntryFor(name)?.kind, name).toBe('host-hook')
      expect(isClaudeAmbientAuthority(name), name).toBe(true)
      expect(isClaudeSettingsEnvAuthority(name), name).toBe(true)
    }
  })

  it('records the CLI prefix families as provenance WITHOUT stripping them', () => {
    // The CLI's predicate matches these by prefix. D18 item 4: do not classify a
    // shared SDK variable by name -- a probe showed AWS_ENDPOINT_URL* cannot
    // redirect Claude with the provider selectors removed, and stripping it
    // would break `aws` in the Bash tool that inherits this environment.
    expect(claudeCliPrefixRules()).toEqual(['AWS_ENDPOINT_URL', 'VERTEX_REGION_CLAUDE_'])
    for (const name of ['AWS_ENDPOINT_URL_ANYTHING', 'VERTEX_REGION_CLAUDE_3_OPUS']) {
      expect(isClaudeSettingsEnvAuthority(name), name).toBe(false)
      expect(isClaudeAmbientAuthority(name), name).toBe(false)
    }
  })

  it('is case-insensitive on every platform, not only Windows', () => {
    expect(isClaudeSettingsEnvAuthority('anthropic_api_key')).toBe(true)
    expect(isClaudeSettingsEnvAuthority('Anthropic_Api_Key')).toBe(true)
    expect(isClaudeAmbientAuthority('claude_code_oauth_token')).toBe(true)
  })

  it('keeps transport and corporate trust configuration on BOTH axes (D18 item 1)', () => {
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']) {
      expect(CLAUDE_SETTINGS_ENV_STRIP, name).not.toContain(name)
      expect(CLAUDE_AMBIENT_STRIP, name).not.toContain(name)
    }
  })

  it('leaves model selection alone on both axes', () => {
    for (const name of ['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      expect(isClaudeSettingsEnvAuthority(name), name).toBe(false)
      expect(isClaudeAmbientAuthority(name), name).toBe(false)
    }
  })

  it('carries the account IDENTITY names, which two of the three enumerations do not list', () => {
    // WP1.38. These are read straight off `process.env` -- one is the fallback
    // in the CLI's own `getUserId`, one becomes an X-Organization request
    // header -- so an inherited value decides WHO a managed session is. Neither
    // the settings filter nor the host-managed suppression set contains them;
    // they live in a THIRD enumeration, the session/bridge carrier set, which
    // the generator did not extract until an adversarial pass found the gap
    // (BLOCKER). The module's own doc had been citing ACCOUNT_UUID as an
    // example of what the generated manifest recovered, while shipping without
    // it.
    for (const name of ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL']) {
      const entry = authorityEntryFor(name)
      expect(entry, `${name} is not in the manifest`).not.toBeNull()
      expect(entry!.kind, name).toBe('account-pin')
      expect(entry!.sources, name).toContain('session-carrier')
      expect(isClaudeAmbientAuthority(name), `${name} ambient`).toBe(true)
      expect(isClaudeSettingsEnvAuthority(name), `${name} settings`).toBe(true)
    }
    // The parent-session pair asks the same question about the session above.
    for (const name of ['CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID', 'CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID']) {
      expect(isClaudeAmbientAuthority(name), name).toBe(true)
    }
    // ...while the carrier set's ordinary session plumbing is preserved: the
    // set is an inventory, not a strip list, and D17 is explicit that this app
    // does not restrict what Claude Code may otherwise do.
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CONTAINER_ID', 'CLAUDE_CODE_DISABLE_HOOK_FORWARDING']) {
      expect(authorityEntryFor(name), `${name} should be inventoried`).not.toBeNull()
      expect(isClaudeAmbientAuthority(name), `${name} should be preserved`).toBe(false)
    }
  })

  it('strips the background/messaging credential family, which NO CLI enumeration lists', () => {
    // WP1.38. The fourth family, found after the third was closed -- which is
    // why the generator now censuses the binary instead of gaining one more
    // anchor per review round. Two of these are proven primitives, not just
    // authority-shaped names: the CLI reads a PATH from
    // `CLAUDE_BG_AUTH_SNAPSHOT_PATH`, reads that file and JSON-parses it as an
    // auth snapshot; and `CLAUDE_CODE_MESSAGING_TOKEN` is a bearer token in a
    // handshake to a socket that then relays messages typed as 'user' into the
    // session.
    for (const name of [
      'CLAUDE_BG_AUTH_SNAPSHOT_PATH', 'CLAUDE_BG_SOCKET_TOKENS_PATH',
      'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_TRUSTED_DEVICE_TOKEN',
      'CLAUDE_CODE_GATEWAY_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
    ]) {
      const entry = authorityEntryFor(name)
      expect(entry, `${name} is not in the manifest`).not.toBeNull()
      expect(entry!.kind, name).toBe('claude-credential')
      expect(isClaudeAmbientAuthority(name), `${name} ambient`).toBe(true)
      expect(isClaudeSettingsEnvAuthority(name), `${name} settings`).toBe(true)
    }
    // ...and the socket the handshake goes to is an endpoint.
    expect(authorityEntryFor('CLAUDE_CODE_MESSAGING_SOCKET')?.kind).toBe('claude-endpoint')
  })

  it('rules on the MCP client secrets, which no namespace list would have reached', () => {
    // The fifth family, and the reason the census now qualifies a name on its
    // SHAPE as well as its namespace: these are CLI-documented OAuth client
    // secrets read from the environment, and `MCP_` was not a namespace this
    // app had listed, so no census method could see them (adversarial round 3).
    // The ruling is PRESERVE -- they authenticate a third-party MCP server's
    // own OAuth, not Claude, which is D18 item 2 -- but the point is that the
    // ruling exists at all.
    for (const name of ['MCP_CLIENT_SECRET', 'MCP_XAA_IDP_CLIENT_SECRET']) {
      const entry = authorityEntryFor(name)
      expect(entry, `${name} was never ruled on`).not.toBeNull()
      expect(isClaudeAmbientAuthority(name), `${name} should be preserved`).toBe(false)
    }
  })

  it('rules on the three Claude names the shape test added, by NAME', () => {
    // A family rule may not settle a Claude-namespaced name, so each of these
    // carries its own ruling: a capability grant that travels beside
    // credentials, the toggle deciding whether ambient env is filtered before
    // reaching an MCP child, and a companion-browser pairing id.
    expect(authorityEntryFor('CLAUDE_ARTIFACT_HOST_GRANT')?.kind).toBe('account-pin')
    expect(isClaudeAmbientAuthority('CLAUDE_ARTIFACT_HOST_GRANT')).toBe(true)
    expect(authorityEntryFor('CLAUDE_CODE_MCP_ALLOWLIST_ENV')?.kind).toBe('host-hook')
    expect(isClaudeAmbientAuthority('CLAUDE_CODE_MCP_ALLOWLIST_ENV')).toBe(true)
    // Ruled and PRESERVED: it identifies a browser, not the Claude account
    // (an identifier a separate pairing authorises, since round 8's re-ruling).
    expect(authorityEntryFor('CLAUDE_CHROME_PAIRED_DEVICE_ID')?.kind).toBe('non-redirecting-identifier')
    expect(isClaudeAmbientAuthority('CLAUDE_CHROME_PAIRED_DEVICE_ID')).toBe(false)
  })

  it('carries the names the WIDENED census found, which four read forms hid', () => {
    // Round 3's census had three patterns and the CLI uses at least four more:
    // a list containing a spread (which made the whole array stop matching), an
    // alias longer than two characters, a typed env-schema object KEY, and a
    // lone quoted argument to a read helper. Each name below is read from the
    // environment by the pinned CLI and was in the manifest on NEITHER axis
    // (adversarial round 4).
    const strippedBoth = (name: string, kind: string) => {
      const e = authorityEntryFor(name)
      expect(e, name).toBeTruthy()
      expect(e!.kind, name).toBe(kind)
      expect(e!.settingsEnv, name).toBe('strip')
      expect(e!.ambient, name).toBe('strip')
      expect(isClaudeAmbientAuthority(name), name).toBe(true)
    }
    // In the CLI's token list beside CLAUDE_CODE_OAUTH_TOKEN; the list contains
    // `...Bkt`, so the bracket-anchored pattern matched none of it.
    strippedBoth('CLAUDE_CODE_HFI_BEARER_TOKEN', 'claude-credential')
    // `R("ANTHROPIC_ENVIRONMENT_KEY")` -- a lone quoted argument. It becomes the
    // `authToken` on an Anthropic-side request.
    strippedBoth('ANTHROPIC_ENVIRONMENT_KEY', 'claude-credential')
    // A computed key in one of the six typed env-schema maps. Removed because
    // the CLI spreads the ambient environment into the proxy-authorization
    // helper CONDITIONALLY, so an inherited value reaches a credential-minting
    // helper where the CLI has none of its own.
    strippedBoth('CLAUDE_CODE_PROXY_URL', 'child-helper-channel')

    // ...and the other half of the same census, PRESERVED under D3. Finding a
    // name does not decide its disposition: an interactive session inherits the
    // developer's environment, and a strip that redirects nothing is a cost with
    // no benefit (owner requirements 1-3).
    const kept = (name: string, kind: string) => {
      const e = authorityEntryFor(name)
      expect(e, name).toBeTruthy()
      expect(e!.kind, name).toBe(kind)
      expect(e!.ambient, name).toBe('keep')
      expect(isClaudeAmbientAuthority(name), name).toBe(false)
    }
    // Reaches one field of a payload the separate environmentKey authorises,
    // and that key IS stripped, so it can neither override managed identity nor
    // attribute work outside the environment the key already grants.
    kept('ANTHROPIC_SESSION_ID', 'non-redirecting-identifier')
    // A log sink. `this.deps.env.CLAUDE_CODE_DEBUG_LOGS_DIR` -- a THREE-character
    // alias, which `\w{1,2}` could not reach, so the census finding is real; the
    // DISPOSITION is keep, because it selects no account, credential, provider
    // or endpoint.
    kept('CLAUDE_CODE_DEBUG_LOGS_DIR', 'non-redirecting-sink')
    // `& ($env:...)` in a PowerShell helper: command execution, the same
    // accepted class as PATH and CLAUDE_CODE_GIT_BASH_PATH under D17.
    kept('CLAUDE_CODE_POLICY_HELPER_PS1_PATH', 'non-redirecting-exec-path')
    // Assigned unconditionally from verified JWT claims, so an inherited value
    // is overwritten before anything reads it.
    kept('CLAUDE_RUNNER_ACCOUNT_EMAIL', 'cli-set-child-variable')
    // Verifies inbound webhooks; never sent. A secret, but not a redirect.
    kept('ANTHROPIC_WEBHOOK_SIGNING_KEY', 'non-redirecting-secret')
  })

  it('does not let a FAMILY rule settle a name the CLI calls one of its own secrets', () => {
    // ENVIRONMENT_SERVICE_KEY wears no Claude prefix, so `requiresExactRuling`
    // let the third-party-dev-credential family swallow it -- and that family's
    // reason, "it authenticates that tool, not Claude", was false of it: the CLI
    // lists it among its own secrets and the environments worker sends it as an
    // `authToken` (adversarial round 4).
    const e = authorityEntryFor('ENVIRONMENT_SERVICE_KEY')
    expect(e?.kind).toBe('claude-credential')
    expect(e?.settingsEnv).toBe('strip')
    expect(e?.ambient).toBe('strip')
    // The reason is its OWN, not a family rule's id.
    expect(e?.reason).not.toBe('third-party-dev-credential')
    expect(e?.sources).toContain('cli-secret-list')
    // The source that makes this structural rather than a one-name patch.
    const p = authorityManifestProvenance()!
    expect(p.extractedFrom.map((s) => s.id)).toContain('cli-secret-list')
    // Its neighbours in the same list are ruled BY NAME too, even where the
    // ruling is unchanged -- that is what "no family rule may settle these"
    // means in practice.
    for (const n of ['MCP_CLIENT_SECRET', 'SELF_HOSTED_RUNNER_POOL_SECRET', 'NPM_TOKEN']) {
      expect(authorityEntryFor(n)?.reason, n).not.toBe('third-party-dev-credential')
    }
    // ...and two of that list are NOT a third party's at all. The self-hosted
    // runner's registration secrets are Anthropic-side ("Shown beside the runner
    // in the Anthropic console"), so the third-party group's reason -- "it
    // authenticates that tool, not Claude" -- was false of them: the
    // ENVIRONMENT_SERVICE_KEY defect restated by hand, one slot away in the same
    // list (adversarial round 5). KEPT on their own evidence: only the
    // `self-hosted-runner` subcommand reads them, and a managed launch never
    // runs it.
    for (const n of ['SELF_HOSTED_RUNNER_POOL_SECRET', 'SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET']) {
      expect(authorityEntryFor(n)?.kind, n).toBe('non-redirecting-subcommand-credential')
      expect(authorityEntryFor(n)?.ambient, n).toBe('keep')
    }
    expect(authorityEntryFor('NPM_TOKEN')?.kind).toBe('dev-tool-credential')
  })

  it('carries the names an incomplete SHAPE test let through, not just an incomplete census', () => {
    // Round 4 fixed a census that could not SEE four read forms. These were
    // already IN the census -- all 1284 names of it -- and never became entries,
    // because the authority-SHAPE pattern did not match them, so the "unruled
    // authority-shaped name is a hard failure" gate never fired. A different
    // defect in the same machine (adversarial round 5).
    for (const n of ['CLAUDE_CODE_RATE_LIMIT_TIER', 'CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER']) {
      // The TIER twin of a name already stripped as an account pin. The CLI
      // writes the pair together out of authenticated account state and scrubs
      // them together from its own children.
      expect(authorityEntryFor(n)?.kind, n).toBe('account-pin')
      expect(isClaudeAmbientAuthority(n), n).toBe(true)
      expect(isClaudeSettingsEnvAuthority(n), n).toBe(true)
    }
    // Same disposition as its twin, which is the point of calling it one.
    expect(authorityEntryFor('CLAUDE_CODE_SUBSCRIPTION_TYPE')?.kind).toBe('account-pin')
    // Turns off the CLI's OWN credential redaction for every subprocess -- the
    // consequence already recorded for CLAUDE_CODE_MCP_ALLOWLIST_ENV, which is a
    // stripped host hook.
    expect(authorityEntryFor('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')?.kind).toBe('host-hook')
    expect(isClaudeAmbientAuthority('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')).toBe(true)
    expect(authorityEntryFor('CLAUDE_CODE_MCP_ALLOWLIST_ENV')?.kind).toBe('host-hook')
    // The feature-flag override channel and the eval switch that gates it. INERT
    // in the pinned build (the consumer is a stub), and ruled by the owner's
    // existing precedent for exactly that, D16 item 8: inactivity is
    // pinned-version evidence, not a contract. What the channel would override is
    // feature flags, and the credential-store backend is selected by one.
    expect(authorityEntryFor('CLAUDE_INTERNAL_FC_OVERRIDES')?.kind).toBe('host-hook')
    expect(isClaudeAmbientAuthority('CLAUDE_INTERNAL_FC_OVERRIDES')).toBe(true)
    // NOT its neighbour: the eval switch is LIVE in the pinned build, read by
    // the plugin-eval harness, and the CLI's own error text says the value
    // 'must come from the operator's shell'. An operator opt-in that selects no
    // account, credential, provider or endpoint is what D3 preserves.
    expect(authorityEntryFor('CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES')?.kind).toBe('non-redirecting-operator-switch')
    expect(isClaudeAmbientAuthority('CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES')).toBe(false)
    // ...and what the shared namespace list found the moment it existed: a
    // credential SOURCE the CLI reports as its login method, and a session
    // identity, both family-ruled keep while their sibling CCR_SESSION_PROFILE
    // was stripped.
    expect(authorityEntryFor('CCR_OAUTH_TOKEN_FILE')?.kind).toBe('claude-credential')
    expect(isClaudeAmbientAuthority('CCR_OAUTH_TOKEN_FILE')).toBe(true)
    expect(authorityEntryFor('CCR_SESSION_ACCOUNT_EMAIL')?.kind).toBe('account-pin')
    expect(isClaudeAmbientAuthority('CCR_SESSION_ACCOUNT_EMAIL')).toBe(true)
    // The ANT_ telemetry endpoints: ruled BY NAME, kept, and with a reason of
    // their own rather than the family rule's 'not an environment variable'.
    for (const n of ['ANT_CLAUDE_CODE_METRICS_ENDPOINT', 'ANT_OTEL_EXPORTER_OTLP_ENDPOINT']) {
      expect(authorityEntryFor(n)?.kind, n).toBe('non-redirecting-endpoint')
      expect(authorityEntryFor(n)?.reason, n).not.toBe('bundled-constant')
      expect(isClaudeAmbientAuthority(n), n).toBe(false)
    }
  })

  it('records the CENSUS, so "did we find every enumeration?" is the tool\'s question', () => {
    // An anchor list is a denylist of places to look, and three review rounds
    // each found one more place. The census is over the whole binary; its
    // digest moves when a CLI version adds or removes any environment-shaped
    // name in the namespaces this app cares about.
    const p = authorityManifestProvenance()!
    expect(p.census.names, 'the census found implausibly little').toBeGreaterThan(500)
    expect(p.census.authorityShaped).toBeGreaterThan(0)
    expect(p.census.authorityShaped).toBeLessThanOrEqual(p.census.names)
    expect(p.census.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(p.extractedFrom.map((s) => s.id)).toContain('census')
    // Every source is named, including the two later rounds added -- the
    // manifest's self-description undercounting its own sources is the same
    // class of defect as the doc that cited a name it did not carry.
    for (const id of ['settings-env-filter', 'host-managed-suppression', 'session-carrier', 'census', 'repo-added', 'cli-secret-list']) {
      expect(p.extractedFrom.map((s) => s.id), id).toContain(id)
    }
  })

  it('carries the CLI-owned namespace list the generator used, and refuses one without it', () => {
    // ONE list, declared in the classification module, written into the
    // manifest, read by the runtime validator. This is the cross-boundary check
    // (src/ may not import scripts/) that the three copies have not drifted.
    const p = authorityManifestProvenance()!
    expect([...p.cliOwnedNamespaces]).toEqual([...CLI_OWNED_NAMESPACES])
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const { cliOwnedNamespaces, ...withoutList } = raw.provenance
    void cliOwnedNamespaces
    expect(validateAuthorityManifest({ ...raw, provenance: withoutList }).ok).toBe(false)
    // ...and one that DROPS a floor namespace is refused even if the digest is
    // recomputed for it, because the floor is code, not data.
    const narrowed = { ...raw, provenance: { ...raw.provenance, cliOwnedNamespaces: ['ANTHROPIC'] } }
    // The digest is recomputed for the narrowed manifest ON PURPOSE: a plain edit
    // fails the digest first and the floor is never exercised, which is how the
    // mutant that removed the floor survived until this line existed.
    narrowed.digest = canonicalManifestDigest(narrowed)
    const r = validateAuthorityManifest(narrowed)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/omits CLAUDE/)
    // ...and one whose prefix carries a regex quantifier is refused, because
    // the list is interpolated into a RegExp and `CLAUDEX?` would WIDEN the
    // family-rule guard rather than narrow it (code-quality review, MINOR).
    const quantified = { ...raw, provenance: { ...raw.provenance, cliOwnedNamespaces: [...raw.provenance.cliOwnedNamespaces, 'CLAUDEX?'] } }
    quantified.digest = canonicalManifestDigest(quantified)
    const q = validateAuthorityManifest(quantified)
    expect(q.ok).toBe(false)
    expect(q.ok === false && q.error).toMatch(/namespace prefixes/)
  })

  it('refuses a manifest whose generator did not run the census', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const { census, ...withoutCensus } = raw.provenance
    expect(census).toBeDefined()
    const result = validateAuthorityManifest({ ...raw, provenance: withoutCensus })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/census/)
  })

  it('rules on EVERY CLI-owned census name, not only the authority-shaped ones (round 8)', () => {
    // The exact-ruling rule said a CLI-owned name is never settled by a
    // pattern. The generator asked that question only of names a SHAPE pattern
    // also described, so six hundred CLI-owned names were counted and never
    // ruled -- and the pattern had ACCOUNT but not ACCT, so the account half of
    // an identity pair was inherited while its organization half was stripped
    // (adversarial round 8, the fourth shape the pattern lacked).
    const acct = authorityEntryFor('CLAUDE_BRIDGE_REATTACH_OWNER_ACCT')
    const org = authorityEntryFor('CLAUDE_BRIDGE_REATTACH_OWNER_ORG')
    expect(acct, 'the ACCT twin has no entry').not.toBeNull()
    expect(acct?.kind).toBe('account-pin')
    expect([acct?.settingsEnv, acct?.ambient]).toEqual(['strip', 'strip'])
    expect([org?.settingsEnv, org?.ambient]).toEqual(['strip', 'strip'])
    expect(isClaudeAmbientAuthority('CLAUDE_BRIDGE_REATTACH_OWNER_ACCT')).toBe(true)
    // A CLI-owned name with NO authority shape is now an entry too, ruled keep
    // by name with a reason of its own -- the proof the gate widened rather
    // than the pattern gaining one more word.
    const plain = authorityEntryFor('CLAUDE_CODE_DISABLE_MOUSE')
    expect(plain).not.toBeNull()
    expect([plain?.settingsEnv, plain?.ambient]).toEqual(['keep', 'keep'])
    expect(plain?.sources).toContain('census')
    expect(plain?.reason).not.toMatch(/^bundled-constant$/)
    // The invariant in its checkable form: the census says how many CLI-owned
    // names it found, and exactly that many CLI-owned entries cite it.
    const p = authorityManifestProvenance()!
    const owned = new RegExp(`^(${p.cliOwnedNamespaces.join('|')})`)
    const cited = authorityManifest().entries.filter((e) => owned.test(e.name) && e.sources.includes('census')).length
    expect(p.census.cliOwned).toBeGreaterThan(p.census.authorityShaped)
    expect(cited).toBe(p.census.cliOwned)
    // Every ruled name in the table is an entry, and every CLI-owned census
    // entry that no hand ruling covers is in the table.
    for (const name of Object.keys(CLI_OWNED_CENSUS_RULINGS)) expect(authorityEntryFor(name), name).not.toBeNull()
    expect(Object.keys(CENSUS_CLASSIFICATION).length).toBe(Object.keys(CLI_OWNED_CENSUS_RULINGS).length)
  })

  it('refuses a manifest that DROPPED a CLI-owned census entry and re-signed itself', () => {
    // The digest catches the casual edit; this catches the deliberate one.
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const dropped = { ...raw, entries: raw.entries.filter((e: { name: string }) => e.name !== 'CLAUDE_BRIDGE_REATTACH_OWNER_ACCT') }
    dropped.digest = canonicalManifestDigest(dropped)
    const r = validateAuthorityManifest(dropped)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/cliOwned/)
    // The count is IN the digest: decrementing it to match the deletion
    // without re-signing fails the digest, so the invariant cannot be edited
    // to agree with the entries for free (adversarial round 8, the confirm).
    const counted = { ...raw, provenance: { ...raw.provenance, census: { ...raw.provenance.census, cliOwned: raw.provenance.census.cliOwned - 1 } } }
    const r2 = validateAuthorityManifest(counted)
    expect(r2.ok).toBe(false)
    expect(r2.ok === false && r2.error).toMatch(/digest/)
    // Stated, not hidden: delete, decrement AND re-sign is consistent by
    // construction. Only `--check` against the binary catches that one.
    const consistent = { ...dropped, provenance: counted.provenance }
    consistent.digest = canonicalManifestDigest(consistent)
    expect(validateAuthorityManifest(consistent).ok).toBe(true)
  })

  it('records the run-time prefix FRAGMENTS as the residual they are, and never as entries', () => {
    // A name assembled at run time is invisible to a literal scan. The census
    // sees the prefixes such names are built from; those are not variables,
    // are not ruled, and are recorded so the residual names what it hides.
    const p = authorityManifestProvenance()!
    expect([...p.census.fragments]).toEqual([...CLI_OWNED_CENSUS_FRAGMENTS])
    expect(p.census.fragments.length).toBeGreaterThan(0)
    for (const f of p.census.fragments) {
      expect(f.endsWith('_'), f).toBe(true)
      expect(authorityEntryFor(f), f).toBeNull()
    }
    for (const e of authorityManifest().entries) expect(e.name.endsWith('_'), e.name).toBe(false)
    // An entry that IS a fragment is refused, digest or no digest.
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const withFragment = { ...raw, entries: [...raw.entries, { ...raw.entries[0], name: 'CLAUDE_CODE_' }] }
    withFragment.digest = canonicalManifestDigest(withFragment)
    const r = validateAuthorityManifest(withFragment)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/not an environment variable/)
    // ...and a fragment list that names a non-owned or non-fragment prefix.
    const bad = { ...raw, provenance: { ...raw.provenance, census: { ...raw.provenance.census, fragments: ['AWS_'] } } }
    expect(validateAuthorityManifest(bad).ok).toBe(false)
  })

  it('refuses a FAMILY-ruled entry the CLI lists among its own secrets, at load time too', () => {
    // The generator's second exact-ruling trigger (`cliSecret`) had no runtime
    // twin: a manifest edited so that a CLI-designated secret outside the CLI
    // namespaces carried a family id as its reason validated clean
    // (adversarial round 7).
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const target = raw.entries.find((e: { sources: string[]; name: string }) =>
      e.sources.includes('cli-secret-list') && !new RegExp(`^(${raw.provenance.cliOwnedNamespaces.join('|')})`).test(e.name))
    expect(target, 'no CLI-designated secret outside the CLI namespaces to test with').toBeDefined()
    const familyId = raw.provenance.familyRules[0].id
    const edited = {
      ...raw,
      entries: raw.entries.map((e: { name: string }) => (e.name === target.name ? { ...e, reason: familyId } : e)),
    }
    edited.digest = canonicalManifestDigest(edited)
    const r = validateAuthorityManifest(edited)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/own secrets/)
  })

  it('carries the credential-store selector the CLI enumerations do not list', () => {
    // WP1.38. The extraction recovers what the CLI itself singles out, which is
    // not the same as everything deciding which stored identity a launch
    // resolves: a credential-STORE selector is read before either filter is
    // consulted, so neither enumeration contains it and the generated manifest
    // alone would have missed it. It is classified in this repo, recorded as
    // `repo-added`, and the generator asserts it still occurs in the pinned
    // binary rather than carrying it forward on faith.
    const entry = authorityEntryFor('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')
    expect(entry, 'the credential-store selector is not in the manifest').not.toBeNull()
    expect(entry!.kind).toBe('claude-realm-root')
    expect(entry!.sources).toContain('repo-added')
    // Removed on BOTH axes: out of an inherited environment, and out of the
    // `env` block of the settings copy the app writes.
    expect(isClaudeAmbientAuthority('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')).toBe(true)
    expect(isClaudeSettingsEnvAuthority('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')).toBe(true)
    expect(CLAUDE_AMBIENT_STRIP).toContain('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')
    expect(CLAUDE_SETTINGS_ENV_STRIP).toContain('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')
    // ...in any spelling, because Windows resolves env names case-insensitively.
    expect(isClaudeAmbientAuthority('claude_code_force_windows_credman')).toBe(true)
  })

  it('never lists a name twice, so "removed" means removed once', () => {
    expect(new Set(CLAUDE_AMBIENT_STRIP).size).toBe(CLAUDE_AMBIENT_STRIP.length)
    expect(new Set(CLAUDE_SETTINGS_ENV_STRIP).size).toBe(CLAUDE_SETTINGS_ENV_STRIP.length)
  })
})

describe('an unusable manifest fails CLOSED in this module, not by import order (WP1.38)', () => {
  // The derived exports used to be `MANIFEST?.entries ?? []`, so a manifest
  // that failed validation produced an EMPTY strip list and a predicate that
  // answered `false` for every name -- the silent degradation the module header
  // says must never happen. Nothing shipped reached it, but only because the
  // one consumer evaluates a throwing accessor a few lines earlier: a property
  // of the import graph, not of this file (adversarial review, MAJOR).
  //
  // So this imports the module DIRECTLY, with a corrupted manifest, exactly as
  // a future second consumer would.
  it('refuses to load rather than degrading to an empty strip list', async () => {
    vi.resetModules()
    vi.doMock('../../src/main/providers/claude/claude-authority-manifest.json', () => ({
      default: { schemaVersion: 2, provenance: {}, entries: [], digest: 'nope' },
    }))
    try {
      await expect(import('../../src/main/providers/claude/authority-manifest'))
        .rejects.toThrow(/manifest is unusable/)
    } finally {
      vi.doUnmock('../../src/main/providers/claude/claude-authority-manifest.json')
      vi.resetModules()
    }
  })
})

describe('which names may be ruled by FAMILY (WP1.38)', () => {
  // A pure rule, tested with no binary, because the gap it closes was found in
  // the one place a pattern cannot reason about: a Claude credential whose name
  // carries no Claude prefix.
  it('forces an exact ruling for the Claude and Anthropic namespaces', () => {
    expect(requiresExactRuling('CLAUDE_CODE_ANYTHING')).toBe(true)
    expect(requiresExactRuling('ANTHROPIC_ANYTHING')).toBe(true)
    // ANT_ as well. Adding that namespace to the CENSUS made the family visible
    // and nothing more: this rule still tested CLAUDE and ANTHROPIC only, so
    // every ANT_ name fell through to the catch-all family rule and was kept
    // with no hard failure -- the ENVIRONMENT_SERVICE_KEY defect reopened in the
    // namespace the previous fix had just opened (adversarial round 6).
    expect(requiresExactRuling('ANT_CLAUDE_CODE_SESSION_KEY')).toBe(true)
    expect(classify('ANT_SOMETHING_NEW_TOKEN')).toBeNull()
    // Not a prefix match on the letters alone.
    expect(requiresExactRuling('ANTLR_HOME')).toBe(false)
    // ...and the CLI's OTHER own prefixes, which the census already treated as
    // Claude's while this rule did not: AGENT_PROXY_AUTH_TOKEN is stripped as a
    // credential, and a hypothetical AGENT_PROXY_AUTH_TOKEN_V2 was family-ruled
    // keep with no hard failure (adversarial round 6, the third occurrence).
    for (const ns of CLI_OWNED_NAMESPACES) {
      expect(requiresExactRuling(`${ns}NEW_TOKEN`), ns).toBe(true)
      expect(classify(`${ns}NEW_TOKEN`), ns).toBeNull()
    }
    expect(CLI_OWNED_NAMESPACES).toEqual(expect.arrayContaining(['CCR_', 'AGENT_PROXY', 'SESSION_INGRESS', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH']))
    expect(requiresExactRuling('AZURE_PASSWORD')).toBe(false)
  })

  it('...and for ANY name the CLI lists among its own secrets, whatever its prefix', () => {
    // The whole point: the name looks third-party and is not. Without this the
    // `third-party-dev-credential` family ruled ENVIRONMENT_SERVICE_KEY keep on
    // both axes (adversarial round 4).
    // The flag comes from the generator, which knows the name's SOURCES. The
    // rule is deliberately not a second hard-coded list of names -- that is the
    // shape that kept missing them.
    expect(requiresExactRuling('ENVIRONMENT_SERVICE_KEY', { cliSecret: true })).toBe(true)
    expect(requiresExactRuling('SOME_UNKNOWN_TOKEN', { cliSecret: true })).toBe(true)
    expect(requiresExactRuling('SOME_UNKNOWN_TOKEN', { cliSecret: false })).toBe(false)
    expect(requiresExactRuling('SOME_UNKNOWN_TOKEN')).toBe(false)
  })

  it('composes the census table into exact rulings, and refuses a row that would silently lose', () => {
    // Every refusal is a hard failure at import, so a table row that a hand
    // ruling shadows, a third-party name that crept in, or a fragment ruled as
    // if it were a variable cannot pass as "ruled".
    const ok = composeCensusRulings({ CLAUDE_CODE_PROBE_ONLY: ['operational', 'gates a probe'] })
    expect(ok.CLAUDE_CODE_PROBE_ONLY).toMatchObject({ kind: 'operational', settingsEnv: 'keep', ambient: 'keep' })
    expect(ok.CLAUDE_CODE_PROBE_ONLY.reason).toMatch(/^gates a probe -- /)
    const strip = composeCensusRulings({ CLAUDE_CODE_PROBE_PIN: ['account-pin', 'pins the probe account'] })
    expect(strip.CLAUDE_CODE_PROBE_PIN).toMatchObject({ kind: 'account-pin', settingsEnv: 'strip', ambient: 'strip' })
    expect(() => composeCensusRulings({ ANTHROPIC_API_KEY: ['operational', 'x'] })).toThrow(/already ruled by name/)
    expect(() => composeCensusRulings({ AWS_PROBE_ONLY: ['operational', 'x'] })).toThrow(/not in a CLI-owned namespace/)
    expect(() => composeCensusRulings({ CLAUDE_CODE_: ['operational', 'x'] })).toThrow(/prefix fragment/)
    expect(() => composeCensusRulings({ CLAUDE_CODE_X: ['no-such-kind', 'x'] })).toThrow(/unknown kind/)
    expect(() => composeCensusRulings({ CLAUDE_CODE_X: ['operational', ''] })).toThrow(/expected \[kind, what\]/)
    // The shipped table composes, and `classify` consults it after the hand
    // rulings: a table name is ruled, a new CLI-owned name still is not.
    expect(classify('CLAUDE_CODE_DISABLE_MOUSE')).toMatchObject({ settingsEnv: 'keep', ambient: 'keep' })
    expect(classify('CLAUDE_BRIDGE_REATTACH_OWNER_ACCT')).toMatchObject({ kind: 'account-pin' })
    expect(classify('CLAUDE_CODE_SOMETHING_NEW')).toBeNull()
  })

  it('makes an unruled CLI secret a hard failure rather than a family match', () => {
    // `classify` returning null is what the generator turns into exit 4. A name
    // that WOULD match a family rule must still come back unclassified once the
    // CLI has called it a secret.
    // A name with no exact ruling that a family rule WOULD settle. (The CLI's
    // current secret names all carry exact rulings now, which is the fix; this
    // asserts the rule that keeps the NEXT one from being family-ruled.)
    expect(classify('GITHUB_TOKEN')).toBeTruthy()
    expect(classify('GITHUB_TOKEN', { cliSecret: true })).toBeNull()
    // ...and the opts argument is optional, so a caller with no source
    // information still gets the namespace rule.
    expect(classify('CLAUDE_CODE_SOMETHING_NEW')).toBeNull()
  })
})

describe('the repo-added presence assertion (WP1.38)', () => {
  // The generator refuses to ship a `repo-added` name that no longer occurs in
  // the pinned binary. That rule had NO test -- it lives in a maintainer script
  // reachable only through a binary CI does not have, so a regression that
  // weakened it to a warning would have shipped unnoticed (adversarial review,
  // MAJOR). The rule itself is a pure function, so it is testable against
  // synthetic text with no binary at all.
  const NAME = 'CLAUDE_CODE_SOMETHING'

  it('accepts a name that is READ as an environment variable', () => {
    expect(repoAddedOccurrence(`if(process.env.${NAME}==="1"){}`, NAME)).toBeGreaterThanOrEqual(0)
    expect(repoAddedOccurrence(`var q=new Set(["${NAME}"]);q.has(k.toUpperCase())`, NAME)).toBeGreaterThanOrEqual(0)
  })

  it('refuses a name that is absent', () => {
    expect(repoAddedOccurrence('nothing to see here', NAME)).toBe(-1)
  })

  it('refuses a name that only occurs INSIDE a longer identifier', () => {
    // A bare `indexOf` passed here, which is the false confidence the check was
    // supposed to remove: the binary contains `<NAME>_LEGACY` and nothing else.
    expect(repoAddedOccurrence(`if(process.env.${NAME}_LEGACY==="1"){}`, NAME)).toBe(-1)
    expect(repoAddedOccurrence(`process.env.PREFIX_${NAME}`, NAME)).toBe(-1)
  })

  it('refuses a name that is only MENTIONED, never read', () => {
    expect(repoAddedOccurrence(`help("set ${NAME} to disable this")`, NAME)).toBe(-1)
  })

  it('is the assertion the shipped repo-added name actually passes', () => {
    // Ties the rule to the real entry: if the classification grows a name this
    // function would reject, that is a fact worth failing on here rather than
    // only in a maintainer's regeneration run.
    expect(repoAddedOccurrence(`x=process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN==="1"`, 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN'))
      .toBeGreaterThanOrEqual(0)
  })
})

describe('regeneration from the pinned fixture', () => {
  const binary = pinnedBinary()

  it.skipIf(binary === null)(
    'reproduces the checked-in manifest byte-for-byte',
    () => {
      // --check re-derives from the binary and compares; exit 0 means identical.
      // Never run by CI: CI has no Claude binary, and the tests above already
      // validate the manifest's schema and internal digest without one.
      expect(() =>
        execFileSync(
          process.execPath,
          [path.join(REPO, 'scripts', 'gen-claude-authority-manifest.mjs'), '--binary', binary!, '--check'],
          { cwd: REPO, encoding: 'utf8', timeout: 300000, stdio: 'pipe' },
        )).not.toThrow()
    },
    300000,
  )

  it('says clearly when the fixture is absent rather than failing the suite', () => {
    // The whole point of tier 1: this suite is meaningful without the binary.
    if (binary === null) expect(AUTHORITY_MANIFEST_ERROR).toBeNull()
    else expect(existsSync(binary)).toBe(true)
  })
})
