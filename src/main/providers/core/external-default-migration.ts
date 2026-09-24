// WP2 slice 3e: adopt a provider's own default sign-in once, on upgrade
// (design 6.3, 6.4, 8.2, 9.3; plan "Existing users"). Provider-neutral: a
// package that declares `externalDefaultRealm` (Codex's ~/.codex) gets this;
// one that does not (Claude) never reaches it.
//
// It runs AT MOST ONCE per provider to an answer, recorded as an append-only
// marker. After that, adopting the default home is the user's explicit
// choice in the Accounts surface (design 9.3: "an external default has been
// explicitly selected"), never something a later start does unasked.
//
// The steps, each its own registry transaction so no CLI run holds the lock:
//   1. this migration's own reservation from an interrupted earlier run is
//      dropped first, whatever else happens -- ONLY its own: the ids are
//      deterministic per provider and cannot be a legacy account's, so a
//      setup the user started is never touched, and one left behind never
//      blocks the user's own adoption of the home;
//   2. the marker is there -> nothing;
//   3. the user's preference: undecided -> nothing, not even the CLI (the
//      user is asked first; design 6.3 step 5, 8.2); off -> marker "skipped";
//   4. an external realm already registered (or archived since) is the
//      answer;
//   5. discover the CLI; not usable -> marker "skipped";
//   6. reserve an account and realm for the external default home;
//   7. ask the provider's status in that realm -- never read its files:
//      signed in  -> a private identity, a realm-only account and the marker
//                    in ONE transaction;
//      signed out -> the reservation dropped and marker "none", together;
//      no answer  -> the reservation dropped and marker "skipped", together.
// Every marker write drops the reservation in the same transaction. Only a
// failed registry write, a preference that is no longer a yes or no, or a
// setup of the same home the user has in progress leaves no marker, and the
// next start tries again. The preference is read again before the status
// run and before the commit: off records "skipped"; undecided drops the
// reservation, records nothing and asks.
//
// A skipped marker carries its reason, so the Accounts surface can say why
// and offer its explicit adoption as "check again" ("unavailable": it timed
// out, did not start, was busy, or the CLI was being re-checked). The
// automatic run never repeats one.
//
// Nothing is copied from the home and no credential is stored. A key in the
// process environment never reaches the status run (the allowlisted
// environment strips it); a key the user keeps in the home's own `.env` is
// part of that home, which is exactly what an external realm is.
import {
  beginAccountSetup, abandonAccountSetup, commitAccountSetup, createIdentity, recordProviderMigration, hasProviderMigration,
  findAccount, EXTERNAL_DEFAULT_PATH_REF,
} from '../../../shared/providers'
import type {
  ProviderRegistryDoc, RegistryResult, ProviderId, AuthMethod, ProviderMigrationMarker, ProviderMigrationSkipReason, ProviderPreference,
} from '../../../shared/providers'
import type { ProviderPackage, AuthCredentialKind, AuthFailureCode } from './package'
import type { AccountRegistryStore } from './account-registry-store'
import { deterministicOpaqueId } from './account-registry-store'

export type ExternalDefaultMigrationOutcome =
  | 'unsupported'           // the package has no external default home
  | 'needs-confirmation'    // the user has not said whether they use the provider: ask first
  | 'registry-unavailable'  // recovery mode, or not loaded
  | 'already-done'          // ran to an answer before, or registered otherwise
  | 'registered'            // a realm-only account now stands for the home
  | 'not-signed-in'         // the home is signed out: nothing registered
  | 'skipped'               // not checked (the marker says why), not asked again automatically
  | 'retry-later'           // a registry write failed, or the user is setting up the same home

/** The user's preference for a provider: a durable yes or no, or nothing
 *  durable yet (installation alone is never consent). */
export type { ProviderPreference } from '../../../shared/providers'

export interface ExternalDefaultMigrationDeps {
  store: Pick<AccountRegistryStore, 'current' | 'mutate' | 'status'>
  /** Read afresh at each step. A throw counts as undecided. */
  preference(providerId: ProviderId): ProviderPreference
  log?(message: string): void
}

/** A fixed colour. "Unverified" is carried by the account's identity
 *  assurance (realm-only), which the renderer shows -- never by the name,
 *  which the user may edit, or the colour, which other identities share. */
const EXTERNAL_IDENTITY_COLOUR = 'slate-blue'
const STEP = 'external-default' as const

/** The seed of the migration's own ids. A legacy account's seed is
 *  `<provider>:<legacy id>`; this one never starts with a provider id and a
 *  colon, so no legacy profile can own an id the migration takes for its own. */
function ownSeed(providerId: ProviderId): string {
  return `migration/external-default:${providerId}`
}

/** Chain transitions; the first refusal is the result. */
function chain(doc: ProviderRegistryDoc, steps: ReadonlyArray<(d: ProviderRegistryDoc) => RegistryResult>): RegistryResult {
  let cur = doc
  for (const step of steps) {
    const r = step(cur)
    if (!r.ok) return r
    cur = r.doc
  }
  return { ok: true, doc: cur }
}

function methodFor(credential: AuthCredentialKind | undefined): AuthMethod {
  if (credential === 'api-key') return 'apiKey'
  if (credential === 'account') return 'external'
  return 'unknown'
}

/** Why a status run gave no answer. A CLI this app cannot use was already
 *  skipped at discovery, so `cli-unavailable` here is passing: another
 *  check of the CLI is running, or it changed (an update) since. That holds
 *  while the provider's discovery reports an unusable version as too old,
 *  unsupported or invalid, never as found and `unknown` (Codex's does). */
function statusSkipReason(code: AuthFailureCode | undefined): ProviderMigrationSkipReason {
  if (code === 'realm-unavailable') return 'home-missing'
  if (code === 'external-overlap') return 'overlap'
  if (code === 'timed-out' || code === 'not-started' || code === 'busy' || code === 'cli-unavailable') return 'unavailable'
  return 'no-answer'
}

/** One run at a time per provider. A call with the same store joins the run
 *  in flight; one with another store object (a wrapper, or another registry)
 *  waits for it and then runs against its own, where a marker the first run
 *  wrote makes it `already-done`. Never an answer for a registry it did not
 *  look at. */
const inFlight = new Map<ProviderId, { store: object; run: Promise<ExternalDefaultMigrationOutcome> }>()

export function migrateExternalDefaultRealm(pkg: ProviderPackage, deps: ExternalDefaultMigrationDeps): Promise<ExternalDefaultMigrationOutcome> {
  const running = inFlight.get(pkg.id)
  if (running && running.store === deps.store) return running.run
  const before = running ? running.run.then(() => undefined, () => undefined) : Promise.resolve()
  const run: Promise<ExternalDefaultMigrationOutcome> = before
    .then(() => migrate(pkg, deps))
    .finally(() => { if (inFlight.get(pkg.id)?.run === run) inFlight.delete(pkg.id) })
  inFlight.set(pkg.id, { store: deps.store, run })
  return run
}

async function migrate(pkg: ProviderPackage, deps: ExternalDefaultMigrationDeps): Promise<ExternalDefaultMigrationOutcome> {
  const log = (m: string) => { try { deps.log?.(`[registry] ${pkg.id} external default: ${m}`) } catch { /* never breaks the migration */ } }
  const spec = pkg.externalDefaultRealm
  const setup = pkg.setup
  const auth = pkg.auth
  if (!spec || !setup || !auth) return 'unsupported'
  const store = deps.store
  const preference = (): ProviderPreference => {
    try {
      const p = deps.preference(pkg.id)
      return p === 'on' || p === 'off' ? p : 'undecided'
    } catch {
      return 'undecided'
    }
  }
  if (store.status().mode !== 'ready' || !store.current()) return 'registry-unavailable'

  // The migration's own ids: the same for every run of this provider, so an
  // interrupted run's reservation is recognisably its own.
  const seed = ownSeed(pkg.id)
  const accountId = deterministicOpaqueId('account', seed)
  const realmId = deterministicOpaqueId('realm', seed)
  const identityId = deterministicOpaqueId('identity', seed)
  const hasOwn = (d: ProviderRegistryDoc) => d.journals.some((j) => j.accountId === accountId)
  /** Drop this migration's own reservation, when there is one; nothing else. */
  const dropOwn = (d: ProviderRegistryDoc): RegistryResult => (hasOwn(d) ? abandonAccountSetup(d, accountId) : { ok: true, doc: d })

  if (hasOwn(store.current()!)) {
    const dropped = await store.mutate((d) => dropOwn(d))
    if (!dropped.ok) { log(`an interrupted run's reservation could not be dropped (${dropped.code})`); return 'retry-later' }
  }
  const now = store.current()
  if (!now) return 'registry-unavailable'
  if (hasProviderMigration(now, pkg.id, STEP)) return 'already-done'

  /** Record the answer and drop the reservation together, or neither. */
  function answer(outcome: 'registered', then: 'already-done'): Promise<ExternalDefaultMigrationOutcome>
  function answer(outcome: 'none', then: 'not-signed-in'): Promise<ExternalDefaultMigrationOutcome>
  function answer(outcome: 'skipped', then: 'skipped', reason: ProviderMigrationSkipReason): Promise<ExternalDefaultMigrationOutcome>
  async function answer(outcome: ProviderMigrationMarker['outcome'], then: ExternalDefaultMigrationOutcome, reason?: ProviderMigrationSkipReason): Promise<ExternalDefaultMigrationOutcome> {
    const r = await store.mutate((d, t) => chain(d, [
      dropOwn,
      (x) => recordProviderMigration(x, { providerId: pkg.id, step: STEP, outcome, ...(reason ? { reason } : {}) }, t),
    ]))
    if (r.ok) return then
    log(`the answer was not saved (${r.code}); it runs again next start`)
    // The reservation alone, so the user's own adoption of the home is not
    // blocked until then; failing that, the next start drops it.
    const dropped = await store.mutate((d) => dropOwn(d))
    if (!dropped.ok) log(`the reservation could not be dropped (${dropped.code}); the next start drops it`)
    return 'retry-later'
  }
  /** The preference read again mid-run: a yes carries on (null); a no is
   *  the answer; anything else is no answer yet -- drop the reservation,
   *  record nothing, and ask. */
  const stillOn = async (): Promise<ExternalDefaultMigrationOutcome | null> => {
    const p = preference()
    if (p === 'on') return null
    if (p === 'off') return answer('skipped', 'skipped', 'off')
    const r = await store.mutate((d) => dropOwn(d))
    if (!r.ok) log(`the reservation could not be dropped (${r.code}); the next start drops it`)
    return 'needs-confirmation'
  }

  const first = preference()
  if (first === 'undecided') return 'needs-confirmation'
  if (first === 'off') return answer('skipped', 'skipped', 'off')

  /** A committed (or since archived) external realm of this provider. */
  const adopted = (d: ProviderRegistryDoc | null) => !!d && d.realms.some((r) => r.providerId === pkg.id && r.pathRef === EXTERNAL_DEFAULT_PATH_REF && r.lifecycle !== 'pending')
  if (adopted(store.current())) return answer('registered', 'already-done')

  let found: Awaited<ReturnType<typeof setup.discover>> | null = null
  try { found = await setup.discover() } catch { found = null }
  if (!found || found.state !== 'found') {
    const reason: ProviderMigrationSkipReason = found?.state === 'missing' ? 'no-cli' : found?.state === 'invalid' ? 'cli-unsupported' : 'unavailable'
    return answer('skipped', 'skipped', reason)
  }
  // A version the app knows it cannot use: the status run would refuse it.
  if (found.compatibility === 'too-old' || found.compatibility === 'unsupported') return answer('skipped', 'skipped', 'cli-unsupported')

  const begun = await store.mutate((d, t) => beginAccountSetup(d, {
    accountId, realmId, providerId: pkg.id, method: 'external', realmKind: spec.kind, ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
  }, t))
  if (!begun.ok) {
    // Taken meanwhile: by an account (the answer), or by a setup the user
    // has in progress (no answer yet).
    if (begun.code === 'realm-conflict' && adopted(store.current())) return answer('registered', 'already-done')
    log(`the reservation was not saved (${begun.code})`)
    return 'retry-later'
  }

  const beforeStatus = await stillOn()
  if (beforeStatus) return beforeStatus
  let status: Awaited<ReturnType<typeof auth.status>> | null = null
  try { status = await auth.status({ authRealmId: realmId }) } catch { status = null }

  if (status && status.ok === true && status.state === 'signed-in') {
    const beforeCommit = await stillOn()
    if (beforeCommit) return beforeCommit
    const committed = await store.mutate((d, t) => chain(d, [
      (x) => createIdentity(x, { id: identityId, friendlyName: spec.identityLabel, colourKey: EXTERNAL_IDENTITY_COLOUR }, t),
      (x) => commitAccountSetup(x, accountId, { identityId, authMethod: methodFor(status!.credential), lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, t),
      (x) => recordProviderMigration(x, { providerId: pkg.id, step: STEP, outcome: 'registered' }, t),
    ]))
    if (committed.ok && findAccount(committed.doc, accountId)) { log('registered as a realm-only account'); return 'registered' }
    log(`the account was not saved (${committed.ok ? 'missing after commit' : committed.code})`)
    const r = await store.mutate((d) => dropOwn(d))
    if (!r.ok) log(`the reservation could not be dropped (${r.code}); the next start drops it`)
    return 'retry-later'
  }
  if (status && status.ok === true && status.state === 'signed-out') return answer('none', 'not-signed-in')
  const reason = status ? (status.ok === true ? 'no-answer' : statusSkipReason(status.code)) : 'unavailable'
  log(`no answer (${reason}); not asked again automatically`)
  return answer('skipped', 'skipped', reason)
}
