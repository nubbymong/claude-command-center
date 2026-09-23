// WP2 provider core: the provider-neutral account registry (design 5, 6, 9.3,
// 11). One versioned document holds identities, groups, provider accounts,
// auth realms, setup journals and the links to legacy account stores.
//
// Everything here is PURE: a transition takes a document and returns the next
// one (or a refusal), never mutating its input and never touching a file, a
// process or the clock. The main process owns persistence, locking and the
// consumer count; this module owns the rules, so they can be tested as a
// transition table without a filesystem.
//
// The document never holds a credential, a token, a login URL or a filesystem
// path the renderer could act on. A realm's `pathRef` is an application-
// controlled reference ("managed:<realmId>", "external-default", a legacy id)
// that only the owning provider package resolves, in the main process.
import type { ProviderId } from '../types'
import { isOpaqueId, isProviderId } from './ids'
import type { OpaqueIdKind } from './ids'
import { IDENTITY_COLOR_KEYS } from '../identity-colors'
import { stripSpoofableText } from '../safe-text'
import { isValidProfileId } from '../profile-id'
import type {
  ConductorIdentity, AccountGroup, ProviderAccount, AuthRealm, AccountLifecycle, AuthMethod, KnownAuthState,
  OperationalState, IdentityAssurance, RealmKind, RealmOwnership, RealmLifecycle, CredentialStoreMode, SessionBinding,
} from './model'

/** Bump on ANY new field, record or list. The parser drops what it does not
 *  know and the next write persists that loss, so an older build must see a
 *  newer document as `newer-schema` (recovery), never as its own. */
export const REGISTRY_SCHEMA_VERSION = 2 as const
/** Schema 1 (the first WP2 builds, never released) had no `migrations`: it
 *  reads as schema 2 with none recorded yet, and is written back as 2. */
const UPGRADABLE_SCHEMA_VERSION = 1

/** The last values Conductor and a legacy store agreed on, per field. A
 *  reconcile compares the legacy store and the registry against it to tell
 *  "legacy was edited" (an older build, a downgrade) from "the registry was
 *  edited" (write-through pending) from "both were" (a conflict). */
export interface LegacyShadow {
  friendlyName: string
  colourKey: string
  lifecycle: 'active' | 'inactive'
}

/** A provider account that mirrors a record in a provider's legacy store
 *  (Claude's profiles.json during 2.1.1). Deterministic ids make a rerun
 *  reattach rather than duplicate. */
export interface LegacyLink {
  providerId: ProviderId
  legacyId: string
  accountId: string
  shadow: LegacyShadow
}

export type SetupJournalState = 'pending' | 'credentials-written'

/** A durable, non-secret record of an account being set up (design 9.3). The
 *  account and realm ids are allocated before authentication starts, so a crash
 *  after the provider wrote credentials is recoverable at the next start. */
export interface SetupJournal {
  accountId: string
  realmId: string
  providerId: ProviderId
  method: AuthMethod
  state: SetupJournalState
  createdAt: number
  updatedAt: number
}

/** A legacy edit and a registry edit to the same field that disagree. The
 *  registry value is kept; the user resolves it explicitly. */
export interface IdentityConflict {
  identityId: string
  field: 'friendlyName' | 'colourKey'
  providerId: ProviderId
  legacyId: string
  legacyValue: string
  registryValue: string
  detectedAt: number
}

/** A one-time provider migration that ran to an answer (design 6.3, 6.4: an
 *  append-only completion marker). Present means it never runs again on its
 *  own. Only a failed registry write, an undecided preference or a setup of
 *  the same home in progress leaves none, and the next start runs again. */
export type ProviderMigrationStep = 'external-default'
/** Why a migration was not checked, so the Accounts surface can say so and
 *  offer the explicit action: switched off; no CLI; a CLI this app cannot
 *  use; the home is missing, or overlaps the app's own; the CLI answered
 *  but not recognisably; or it could not answer then (timed out, did not
 *  start, busy, or the CLI was being checked again or had just changed) --
 *  worth checking again. */
export type ProviderMigrationSkipReason = 'off' | 'no-cli' | 'cli-unsupported' | 'home-missing' | 'overlap' | 'no-answer' | 'unavailable'
export interface ProviderMigrationMarker {
  providerId: ProviderId
  step: ProviderMigrationStep
  /** An account was registered; there was nothing to register (signed
   *  out); or it was not checked and is left to the user's explicit choice. */
  outcome: 'registered' | 'none' | 'skipped'
  /** Present exactly when the outcome is `skipped`. */
  reason?: ProviderMigrationSkipReason
  at: number
}

export interface ProviderRegistryDoc {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION
  identities: ConductorIdentity[]
  groups: AccountGroup[]
  accounts: ProviderAccount[]
  realms: AuthRealm[]
  journals: SetupJournal[]
  legacyLinks: LegacyLink[]
  conflicts: IdentityConflict[]
  migrations: ProviderMigrationMarker[]
}

export type RegistryErrorCode =
  | 'invalid-id' | 'invalid-value' | 'not-found' | 'duplicate' | 'lifecycle' | 'default-required'
  | 'blocked-by-consumers' | 'realm-conflict' | 'subject-conflict' | 'not-linkable' | 'legacy-owned'

export type RegistryResult =
  | { ok: true; doc: ProviderRegistryDoc }
  | { ok: false; code: RegistryErrorCode; message: string }

const fail = (code: RegistryErrorCode, message: string): RegistryResult => ({ ok: false, code, message })
const done = (doc: ProviderRegistryDoc): RegistryResult => ({ ok: true, doc })

export function emptyRegistry(): ProviderRegistryDoc {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, identities: [], groups: [], accounts: [], realms: [], journals: [], legacyLinks: [], conflicts: [], migrations: [] }
}

// ---------------------------------------------------------------------------
// Value rules
// ---------------------------------------------------------------------------

/** Matches the Claude profile name cap (account-profiles rename), so a
 *  migrated name is never truncated and write-through never shortens one. */
export const FRIENDLY_NAME_MAX = 120
export const GROUP_NAME_MAX = 40
const LABEL_MAX = 120
const PLAN_MAX = 60
const SUBJECT_MAX = 256
const PATH_REF_MAX = 512
const GROUP_ORDER_MAX = 1_000_000
/** Date.now() in milliseconds; the largest value a Date can hold. */
const TIME_MAX = 8.64e15

/** A legacy record id. The only legacy store is Claude's profiles.json, whose
 *  ids are also directory names, so this is exactly the main process's
 *  profile-id rule -- one definition, never a second hand-copied regex. */
export const isLegacyId = isValidProfileId

/** Invisible characters stripSpoofableText leaves in: every other format
 *  character, lone surrogates, variation selectors (the payload channel of
 *  variation-selector smuggling) and the fillers that render as blank. */
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u{1d159}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\ufffc\u{e0100}-\u{e01ef}]/gu
/** At most four combining marks on one base: enough for every script's
 *  stacking, not enough for a mark flood over neighbouring rows. */
const MARK_FLOOD = /(\p{M}{4})\p{M}+/gu

/** A display label as it may be stored: every control, spoofing and invisible
 *  character out, whitespace collapsed, mark runs bounded, trimmed, and at
 *  most `max` UTF-16 units (the unit the Claude rename handler caps in) without
 *  splitting a surrogate pair. Empty means "no label", never an empty string.
 *  Idempotent, so a parsed document re-normalises to itself. */
export function normaliseLabel(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = stripSpoofableText(raw, max * 4).replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(MARK_FLOOD, '$1').trim()
  let out = ''
  for (const ch of clean) {
    if (out.length + ch.length > max) break
    out += ch
  }
  out = out.trim()
  return out.length ? out : undefined
}

/** An opaque provider-supplied token (subject, authority): kept verbatim, but
 *  only when it carries nothing a label could not. */
function safeToken(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || !raw.length || raw.length > max) return undefined
  return stripSpoofableText(raw, max) === raw && raw.trim() === raw ? raw : undefined
}

export function isIdentityColourKey(v: unknown): v is string {
  return typeof v === 'string' && (IDENTITY_COLOR_KEYS as readonly string[]).includes(v)
}

const AUTH_METHODS: readonly AuthMethod[] = ['browser', 'device', 'apiKey', 'external', 'unknown']
const LIFECYCLES: readonly AccountLifecycle[] = ['active', 'inactive', 'archived']
const AUTH_STATES: readonly KnownAuthState[] = ['unknown', 'signed-out', 'signed-in', 'expired', 'error', 'unsupported']
const OP_STATES: readonly OperationalState[] = ['ready', 'attention', 'blocked']
const ASSURANCES: readonly IdentityAssurance[] = ['verified-subject', 'realm-only', 'user-asserted']
const REALM_KINDS: readonly RealmKind[] = ['claude-config-home', 'codex-home']
const OWNERSHIPS: readonly RealmOwnership[] = ['conductor-managed', 'external-default']
const REALM_LIFECYCLES: readonly RealmLifecycle[] = ['pending', 'active', 'retiring', 'retired', 'recovery']
const STORE_MODES: readonly CredentialStoreMode[] = ['file', 'keyring', 'unknown']
const JOURNAL_STATES: readonly SetupJournalState[] = ['pending', 'credentials-written']
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= TIME_MAX

/** A pathRef is an app-controlled reference, never shown as an identity. It
 *  must be a plain, bounded token: no control characters, no surrounding space. */
function isPathRef(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= PATH_REF_MAX && stripSpoofableText(v, PATH_REF_MAX) === v && v.trim() === v
}

/** Which provider may own a realm of each kind. */
const REALM_KIND_PROVIDER: Readonly<Record<RealmKind, ProviderId>> = { 'claude-config-home': 'claude', 'codex-home': 'codex' }

/** A realm kind, and one that provider owns. */
export function isRealmKindOf(kind: unknown, providerId: ProviderId): kind is RealmKind {
  return oneOf(REALM_KINDS, kind) && REALM_KIND_PROVIDER[kind as RealmKind] === providerId
}

export const EXTERNAL_DEFAULT_PATH_REF = 'external-default'
export const MANAGED_PATH_REF_PREFIX = 'managed:'
export const CLAUDE_PROFILE_PATH_REF_PREFIX = 'claude-profile:'

/** The closed grammar of realm references (design 5.4). A reference is never
 *  a path, a URL or anything a resolver could join or delete by: it names the
 *  realm's own record, the one external default home, or a Claude profile by
 *  its validated id. Tying a managed reference to the realm's own id makes two
 *  live realms over one managed directory impossible by construction. */
export function realmShapeProblem(r: { id: string; providerId: ProviderId; kind: RealmKind; ownership: RealmOwnership; pathRef: string }): string | null {
  if (REALM_KIND_PROVIDER[r.kind] !== r.providerId) return `a ${r.kind} realm cannot belong to ${r.providerId}`
  if (r.ownership === 'external-default') {
    return r.pathRef === EXTERNAL_DEFAULT_PATH_REF ? null : 'an external default realm must reference the external default home'
  }
  if (r.kind === 'codex-home') {
    return r.pathRef === `${MANAGED_PATH_REF_PREFIX}${r.id}` ? null : 'a managed realm must reference its own id'
  }
  const profileId = r.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX) ? r.pathRef.slice(CLAUDE_PROFILE_PATH_REF_PREFIX.length) : ''
  return isLegacyId(profileId) ? null : 'a Claude realm must reference a valid profile id'
}

/** Drop keys whose value is undefined, so documents compare and serialise
 *  identically however they were built. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

/** The operational state an auth check implies, before subject drift. */
function operationalFor(state: KnownAuthState): OperationalState {
  return state === 'signed-in' ? 'ready' : 'attention'
}

/** Realms that still hold their pathRef: everything but a retired one. */
const holdsPath = (r: AuthRealm) => r.lifecycle !== 'retired'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function findAccount(doc: ProviderRegistryDoc, id: string): ProviderAccount | undefined {
  return doc.accounts.find((a) => a.id === id)
}

export function findRealm(doc: ProviderRegistryDoc, id: string): AuthRealm | undefined {
  return doc.realms.find((r) => r.id === id)
}

export function findIdentity(doc: ProviderRegistryDoc, id: string): ConductorIdentity | undefined {
  return doc.identities.find((i) => i.id === id)
}

/** The provider's default account, when it has one (only among active accounts). */
export function providerDefaultAccount(doc: ProviderRegistryDoc, providerId: ProviderId): ProviderAccount | null {
  return doc.accounts.find((a) => a.providerId === providerId && a.lifecycle === 'active' && a.isProviderDefault) ?? null
}

/** Accounts a user may choose for NEW work: active and not blocked. Inactive
 *  and archived accounts stay resolvable for history; they are simply not offered. */
export function selectableAccounts(doc: ProviderRegistryDoc, providerId: ProviderId): ProviderAccount[] {
  return doc.accounts.filter((a) => a.providerId === providerId && a.lifecycle === 'active' && a.operationalState !== 'blocked')
}

/** An account mirrored from a provider's legacy store. That store stays the
 *  source of its existence and of the provider default during 2.1.1, so the
 *  registry refuses the changes the store cannot express. */
export function isLegacyLinked(doc: ProviderRegistryDoc, accountId: string): boolean {
  return doc.legacyLinks.some((l) => l.accountId === accountId)
}

/** A legacy record live or archived: linked now, or on a home only a legacy
 *  record can own (an archived one keeps its realm and may be restored). */
function isLegacyRecord(doc: ProviderRegistryDoc, account: ProviderAccount): boolean {
  return isLegacyLinked(doc, account.id) || (findRealm(doc, account.authRealmId)?.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX) ?? false)
}

/** An account whose realm is the external default home, or that nobody has
 *  vouched for: its attribution is a guess, so it is never linked and every
 *  launch needs a per-launch acknowledgement. Derived from the realm, not only
 *  from a free field a caller set. */
function isRealmOnly(account: ProviderAccount, realm: AuthRealm | undefined): boolean {
  return account.identityAssurance === 'realm-only' || realm?.ownership === 'external-default'
}

// ---------------------------------------------------------------------------
// Identities and groups (design 5.1, 5.2)
// ---------------------------------------------------------------------------

export interface IdentityInput {
  id: string
  friendlyName?: string
  colourKey: string
  groupId?: string
}

export function createIdentity(doc: ProviderRegistryDoc, input: IdentityInput, now: number): RegistryResult {
  if (!isOpaqueId(input.id, 'identity')) return fail('invalid-id', 'identity id is not an opaque identity id')
  if (findIdentity(doc, input.id)) return fail('duplicate', `identity ${input.id} already exists`)
  if (!isIdentityColourKey(input.colourKey)) return fail('invalid-value', 'colour is not in the identity palette')
  if (input.groupId !== undefined && !doc.groups.some((g) => g.id === input.groupId)) return fail('not-found', `group ${String(input.groupId)} does not exist`)
  const identity: ConductorIdentity = compact({
    id: input.id,
    friendlyName: normaliseLabel(input.friendlyName, FRIENDLY_NAME_MAX),
    colourKey: input.colourKey,
    groupId: input.groupId,
    createdAt: now,
    updatedAt: now,
  })
  return done({ ...doc, identities: [...doc.identities, identity] })
}

export interface IdentityPatch {
  /** A string renames; null or an empty name clears. */
  friendlyName?: string | null
  colourKey?: string
  /** A group id assigns; null removes. */
  groupId?: string | null
}

export function updateIdentity(doc: ProviderRegistryDoc, id: string, patch: IdentityPatch, now: number): RegistryResult {
  const current = findIdentity(doc, id)
  if (!current) return fail('not-found', `identity ${id} does not exist`)
  const next: ConductorIdentity = { ...current, updatedAt: now }
  if (patch.friendlyName !== undefined) next.friendlyName = patch.friendlyName === null ? undefined : normaliseLabel(patch.friendlyName, FRIENDLY_NAME_MAX)
  if (patch.friendlyName !== undefined && next.friendlyName === undefined && doc.accounts.some((a) => a.identityId === id && isLegacyLinked(doc, a.id))) {
    // The legacy store has no "no name"; a cleared name would be re-imported.
    return fail('legacy-owned', 'this account keeps a name in its provider; rename it instead')
  }
  if (patch.colourKey !== undefined) {
    if (!isIdentityColourKey(patch.colourKey)) return fail('invalid-value', 'colour is not in the identity palette')
    next.colourKey = patch.colourKey
  }
  if (patch.groupId !== undefined) {
    if (patch.groupId !== null && !doc.groups.some((g) => g.id === patch.groupId)) return fail('not-found', `group ${String(patch.groupId)} does not exist`)
    next.groupId = patch.groupId ?? undefined
  }
  return done({ ...doc, identities: doc.identities.map((i) => (i.id === id ? compact(next) : i)) })
}

export function createGroup(doc: ProviderRegistryDoc, input: { id: string; name: string }, now: number): RegistryResult {
  if (!isOpaqueId(input.id, 'group')) return fail('invalid-id', 'group id is not an opaque group id')
  if (doc.groups.some((g) => g.id === input.id)) return fail('duplicate', `group ${input.id} already exists`)
  const name = normaliseLabel(input.name, GROUP_NAME_MAX)
  if (!name) return fail('invalid-value', 'a group needs a name')
  const order = doc.groups.reduce((m, g) => Math.max(m, g.order + 1), 0)
  if (order > GROUP_ORDER_MAX) return fail('invalid-value', 'too many groups')
  return done({ ...doc, groups: [...doc.groups, { id: input.id, name, order, createdAt: now, updatedAt: now }] })
}

export function renameGroup(doc: ProviderRegistryDoc, id: string, name: string, now: number): RegistryResult {
  if (!doc.groups.some((g) => g.id === id)) return fail('not-found', `group ${id} does not exist`)
  const clean = normaliseLabel(name, GROUP_NAME_MAX)
  if (!clean) return fail('invalid-value', 'a group needs a name')
  return done({ ...doc, groups: doc.groups.map((g) => (g.id === id ? { ...g, name: clean, updatedAt: now } : g)) })
}

/** Deleting a group removes the organisation only: identities that were in it
 *  lose the reference, and nothing about any account changes. */
export function deleteGroup(doc: ProviderRegistryDoc, id: string, now: number): RegistryResult {
  if (!doc.groups.some((g) => g.id === id)) return fail('not-found', `group ${id} does not exist`)
  return done({
    ...doc,
    groups: doc.groups.filter((g) => g.id !== id),
    identities: doc.identities.map((i) => (i.groupId === id ? compact({ ...i, groupId: undefined, updatedAt: now }) : i)),
  })
}

/** Point an account at another identity -- always an explicit user action.
 *  Shares name, colour and group only; auth, realm and lifecycle stay the
 *  account's own. An account whose identity cannot be verified (a realm-only
 *  external home) is never linked: its attribution would be a guess. */
export function linkAccountIdentity(doc: ProviderRegistryDoc, accountId: string, identityId: string, now: number): RegistryResult {
  const account = findAccount(doc, accountId)
  if (!account) return fail('not-found', `account ${accountId} does not exist`)
  if (!findIdentity(doc, identityId)) return fail('not-found', `identity ${identityId} does not exist`)
  if (isRealmOnly(account, findRealm(doc, account.authRealmId))) return fail('not-linkable', 'an unverified external sign-in cannot be linked to an identity')
  if (isLegacyRecord(doc, account) && doc.accounts.some((a) => a.id !== accountId && a.identityId === identityId && a.providerId === account.providerId && isLegacyRecord(doc, a))) {
    // Two records of one legacy store on one identity would write each
    // other's name and colour: an edit to one profile would rewrite the other.
    // An archived record counts too: its profile may come back.
    return fail('legacy-owned', 'two accounts from the same provider list cannot share one identity')
  }
  return done({ ...doc, accounts: doc.accounts.map((a) => (a.id === accountId ? { ...a, identityId, updatedAt: now } : a)) })
}

/** Give an account a new private identity, copied from its current one. The
 *  old identity is retained: history may still name it. */
export function unlinkAccountIdentity(doc: ProviderRegistryDoc, accountId: string, newIdentityId: string, now: number): RegistryResult {
  const account = findAccount(doc, accountId)
  if (!account) return fail('not-found', `account ${accountId} does not exist`)
  if (isRealmOnly(account, findRealm(doc, account.authRealmId))) return fail('not-linkable', 'an unverified external sign-in keeps its own identity')
  const from = findIdentity(doc, account.identityId)
  if (!from) return fail('not-found', `identity ${account.identityId} does not exist`)
  const created = createIdentity(doc, { id: newIdentityId, friendlyName: from.friendlyName, colourKey: from.colourKey, groupId: from.groupId }, now)
  if (!created.ok) return created
  return done({ ...created.doc, accounts: created.doc.accounts.map((a) => (a.id === accountId ? { ...a, identityId: newIdentityId, updatedAt: now } : a)) })
}

// ---------------------------------------------------------------------------
// Account setup (design 9.3)
// ---------------------------------------------------------------------------

export interface BeginSetupInput {
  accountId: string
  realmId: string
  providerId: ProviderId
  method: AuthMethod
  realmKind: RealmKind
  ownership: RealmOwnership
  pathRef: string
  credentialStoreMode?: CredentialStoreMode
}

/** Reserve the account and realm ids and the realm's pathRef before any
 *  provider process runs. No selectable account exists until commit. */
export function beginAccountSetup(doc: ProviderRegistryDoc, input: BeginSetupInput, now: number): RegistryResult {
  if (!isOpaqueId(input.accountId, 'account')) return fail('invalid-id', 'account id is not an opaque account id')
  if (!isOpaqueId(input.realmId, 'realm')) return fail('invalid-id', 'realm id is not an opaque realm id')
  if (!isProviderId(input.providerId)) return fail('invalid-value', 'unknown provider')
  if (!oneOf(AUTH_METHODS, input.method)) return fail('invalid-value', 'unknown sign-in method')
  if (!oneOf(REALM_KINDS, input.realmKind)) return fail('invalid-value', 'unknown realm kind')
  if (!oneOf(OWNERSHIPS, input.ownership)) return fail('invalid-value', 'unknown realm ownership')
  if (!isPathRef(input.pathRef)) return fail('invalid-value', 'realm reference is not a plain bounded token')
  const shape = realmShapeProblem({ id: input.realmId, providerId: input.providerId, kind: input.realmKind, ownership: input.ownership, pathRef: input.pathRef })
  if (shape) return fail('invalid-value', shape)
  if (input.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX)) return fail('legacy-owned', 'a Claude profile home is registered from its profile, never set up here')
  if (input.credentialStoreMode !== undefined && !oneOf(STORE_MODES, input.credentialStoreMode)) return fail('invalid-value', 'unknown credential store mode')
  if (findAccount(doc, input.accountId) || doc.journals.some((j) => j.accountId === input.accountId)) return fail('duplicate', `account ${input.accountId} already exists`)
  if (findRealm(doc, input.realmId)) return fail('duplicate', `realm ${input.realmId} already exists`)
  if (doc.realms.some((r) => r.providerId === input.providerId && r.pathRef === input.pathRef && holdsPath(r))) {
    return fail('realm-conflict', 'another live account already uses this sign-in location')
  }
  const realm: AuthRealm = compact({
    id: input.realmId,
    providerId: input.providerId,
    ownerProviderAccountId: input.accountId,
    kind: input.realmKind,
    ownership: input.ownership,
    pathRef: input.pathRef,
    credentialStoreMode: input.credentialStoreMode,
    lifecycle: 'pending' as const,
    createdAt: now,
  })
  const journal: SetupJournal = { accountId: input.accountId, realmId: input.realmId, providerId: input.providerId, method: input.method, state: 'pending', createdAt: now, updatedAt: now }
  return done({ ...doc, realms: [...doc.realms, realm], journals: [...doc.journals, journal] })
}

export function markSetupCredentialsWritten(doc: ProviderRegistryDoc, accountId: string, now: number): RegistryResult {
  if (!doc.journals.some((j) => j.accountId === accountId)) return fail('not-found', `no setup in progress for ${accountId}`)
  return done({ ...doc, journals: doc.journals.map((j) => (j.accountId === accountId ? { ...j, state: 'credentials-written' as const, updatedAt: now } : j)) })
}

export interface CommitSetupInput {
  identityId: string
  authMethod: AuthMethod
  lastKnownAuthState: KnownAuthState
  identityAssurance: IdentityAssurance
  providerLabel?: string
  planLabel?: string
  providerSubject?: string
  providerAuthorityId?: string
}

/** Turn a verified setup into a selectable account: the realm goes active, the
 *  journal is cleared, and the first active account of a provider becomes its
 *  default. */
export function commitAccountSetup(doc: ProviderRegistryDoc, accountId: string, input: CommitSetupInput, now: number): RegistryResult {
  const journal = doc.journals.find((j) => j.accountId === accountId)
  if (!journal) return fail('not-found', `no setup in progress for ${accountId}`)
  if (!findIdentity(doc, input.identityId)) return fail('not-found', `identity ${input.identityId} does not exist`)
  if (!oneOf(AUTH_METHODS, input.authMethod)) return fail('invalid-value', 'unknown sign-in method')
  if (!oneOf(AUTH_STATES, input.lastKnownAuthState)) return fail('invalid-value', 'unknown auth state')
  if (!oneOf(ASSURANCES, input.identityAssurance)) return fail('invalid-value', 'unknown identity assurance')
  const subject = safeToken(input.providerSubject, SUBJECT_MAX)
  const authority = safeToken(input.providerAuthorityId, SUBJECT_MAX)
  const reliable = subject !== undefined && authority !== undefined
  if (input.identityAssurance === 'verified-subject' && !reliable) return fail('invalid-value', 'a verified account needs the provider subject and authority')
  if (findRealm(doc, journal.realmId)?.ownership === 'external-default' && input.identityAssurance !== 'realm-only') {
    return fail('invalid-value', 'the external default sign-in cannot be vouched for; it is realm-only')
  }
  if (reliable && subjectTaken(doc, journal.providerId, authority, subject, accountId)) return fail('subject-conflict', 'another live account is already signed in as this user')
  const account: ProviderAccount = compact({
    id: accountId,
    providerId: journal.providerId,
    providerAuthorityId: reliable ? authority : undefined,
    identityId: input.identityId,
    authRealmId: journal.realmId,
    providerSubject: reliable ? subject : undefined,
    providerLabel: normaliseLabel(input.providerLabel, LABEL_MAX),
    authMethod: input.authMethod,
    planLabel: normaliseLabel(input.planLabel, PLAN_MAX),
    lifecycle: 'active' as const,
    isProviderDefault: !providerDefaultAccount(doc, journal.providerId),
    createdAt: now,
    updatedAt: now,
    lastAuthenticatedAt: input.lastKnownAuthState === 'signed-in' ? now : undefined,
    lastValidatedAt: now,
    lastKnownAuthState: input.lastKnownAuthState,
    operationalState: operationalFor(input.lastKnownAuthState),
    identityAssurance: input.identityAssurance,
  })
  return done({
    ...doc,
    accounts: [...doc.accounts, account],
    realms: doc.realms.map((r) => (r.id === journal.realmId ? { ...r, lifecycle: 'active' as const, lastValidatedAt: now } : r)),
    journals: doc.journals.filter((j) => j.accountId !== accountId),
  })
}

/** Drop a setup that did not complete: the journal and its pending realm go.
 *  The caller removes the app-managed directory, and only when it is empty or
 *  proven to hold nothing but what the failed attempt wrote. */
export function abandonAccountSetup(doc: ProviderRegistryDoc, accountId: string): RegistryResult {
  const journal = doc.journals.find((j) => j.accountId === accountId)
  if (!journal) return fail('not-found', `no setup in progress for ${accountId}`)
  return done({
    ...doc,
    realms: doc.realms.filter((r) => !(r.id === journal.realmId && r.lifecycle === 'pending')),
    journals: doc.journals.filter((j) => j.accountId !== accountId),
  })
}

// ---------------------------------------------------------------------------
// One-time provider migrations (design 6.3, 6.4)
// ---------------------------------------------------------------------------

const MIGRATION_STEPS: readonly ProviderMigrationStep[] = ['external-default']
const MIGRATION_OUTCOMES: readonly ProviderMigrationMarker['outcome'][] = ['registered', 'none', 'skipped']
const MIGRATION_SKIP_REASONS: readonly ProviderMigrationSkipReason[] = ['off', 'no-cli', 'cli-unsupported', 'home-missing', 'overlap', 'no-answer', 'unavailable']

/** A reason exactly when skipped, and a known one. */
function migrationReasonFits(outcome: ProviderMigrationMarker['outcome'], reason: unknown): boolean {
  return outcome === 'skipped' ? oneOf(MIGRATION_SKIP_REASONS, reason) : reason === undefined
}

export function hasProviderMigration(doc: ProviderRegistryDoc, providerId: ProviderId, step: ProviderMigrationStep): boolean {
  return doc.migrations.some((m) => m.providerId === providerId && m.step === step)
}

/** Record that a migration ran to an answer. Append-only: a marker already
 *  there is kept as it is, never rewritten. */
export function recordProviderMigration(
  doc: ProviderRegistryDoc,
  input: { providerId: ProviderId; step: ProviderMigrationStep; outcome: ProviderMigrationMarker['outcome']; reason?: ProviderMigrationSkipReason },
  now: number,
): RegistryResult {
  if (!isProviderId(input.providerId)) return fail('invalid-value', 'unknown provider')
  if (!oneOf(MIGRATION_STEPS, input.step)) return fail('invalid-value', 'unknown migration step')
  if (!oneOf(MIGRATION_OUTCOMES, input.outcome)) return fail('invalid-value', 'unknown migration outcome')
  if (!migrationReasonFits(input.outcome, input.reason)) return fail('invalid-value', 'a skipped migration needs a known reason, and only a skipped one')
  if (hasProviderMigration(doc, input.providerId, input.step)) return done(doc)
  const marker: ProviderMigrationMarker = { providerId: input.providerId, step: input.step, outcome: input.outcome, at: now }
  if (input.reason !== undefined) marker.reason = input.reason
  return done({ ...doc, migrations: [...doc.migrations, marker] })
}

// ---------------------------------------------------------------------------
// Lifecycle and defaults (design 5.3, 11)
// ---------------------------------------------------------------------------

/** Change an account's lifecycle. `consumers` is the number of running
 *  sessions and background operations holding a lease on the account, read by
 *  the caller under the same lock that applies this result.
 *
 *  Allowed: active -> inactive, inactive -> active, inactive -> archived.
 *  Restoring an archived account needs provider verification and is a separate
 *  operation (not offered in WP2). */
export function setAccountLifecycle(
  doc: ProviderRegistryDoc,
  accountId: string,
  next: AccountLifecycle,
  ctx: { consumers: number },
  now: number,
): RegistryResult {
  const account = findAccount(doc, accountId)
  if (!account) return fail('not-found', `account ${accountId} does not exist`)
  if (!oneOf(LIFECYCLES, next)) return fail('invalid-value', 'unknown lifecycle')
  if (account.lifecycle === next) return done(doc)
  const from = account.lifecycle
  const allowed = (from === 'active' && next === 'inactive') || (from === 'inactive' && next === 'active') || (from === 'inactive' && next === 'archived')
  if (!allowed) return fail('lifecycle', `an ${from} account cannot become ${next}`)
  if (next !== 'active' && ctx.consumers > 0) return fail('blocked-by-consumers', `${ctx.consumers} running session(s) or operation(s) use this account`)
  if (next === 'active' && account.operationalState === 'blocked') return fail('lifecycle', 'this account is blocked until its sign-in is reconciled')
  if (isLegacyLinked(doc, accountId)) {
    // The legacy store cannot express either: it has no "archived" (removal is
    // done where the account was created) and its default is always active.
    if (next === 'archived') return fail('legacy-owned', 'remove this account where it was created')
    if (next === 'inactive' && account.isProviderDefault) return fail('legacy-owned', "the provider's primary account is always active")
    // The legacy store keeps one account active; a write it would refuse is
    // refused here rather than left pending.
    if (next === 'inactive' && !doc.accounts.some((a) => a.id !== accountId && a.providerId === account.providerId && a.lifecycle === 'active' && isLegacyLinked(doc, a.id))) {
      return fail('legacy-owned', 'at least one of these accounts must stay active')
    }
  }

  let accounts = doc.accounts
  if (from === 'active' && next === 'inactive' && account.isProviderDefault) {
    const others = accounts.some((a) => a.id !== accountId && a.providerId === account.providerId && a.lifecycle === 'active')
    if (others) return fail('default-required', 'choose another default account first')
  }
  const becomesDefault = next === 'active' && !providerDefaultAccount(doc, account.providerId)
  accounts = accounts.map((a) => (a.id === accountId
    ? { ...a, lifecycle: next, isProviderDefault: next === 'active' ? becomesDefault : false, updatedAt: now }
    : a))
  const realms = next === 'archived'
    ? doc.realms.map((r) => (r.id === account.authRealmId ? { ...r, lifecycle: 'retired' as const } : r))
    : doc.realms
  return done({ ...doc, accounts, realms })
}

export function setProviderDefault(doc: ProviderRegistryDoc, accountId: string, now: number): RegistryResult {
  const account = findAccount(doc, accountId)
  if (!account) return fail('not-found', `account ${accountId} does not exist`)
  if (account.lifecycle !== 'active') return fail('lifecycle', 'only an active account can be the default')
  if (account.isProviderDefault) return done(doc)
  if (account.operationalState === 'blocked') return fail('lifecycle', 'a blocked account cannot be the default')
  const current = providerDefaultAccount(doc, account.providerId)
  if (isLegacyLinked(doc, accountId) || (current && isLegacyLinked(doc, current.id))) {
    return fail('legacy-owned', "this provider's default is its primary account, chosen in its own settings")
  }
  return done({
    ...doc,
    accounts: doc.accounts.map((a) => {
      if (a.providerId !== account.providerId) return a
      const want = a.id === accountId
      return a.isProviderDefault === want ? a : { ...a, isProviderDefault: want, updatedAt: now }
    }),
  })
}

// ---------------------------------------------------------------------------
// Auth checks (design 5.3, 5.5)
// ---------------------------------------------------------------------------

function subjectTaken(doc: ProviderRegistryDoc, providerId: ProviderId, authority: string, subject: string, exceptAccountId: string): boolean {
  return doc.accounts.some((a) => a.id !== exceptAccountId && a.providerId === providerId && a.lifecycle !== 'archived'
    && a.providerAuthorityId === authority && a.providerSubject === subject)
}

export interface AuthCheckInput {
  state: KnownAuthState
  authMethod?: AuthMethod
  providerLabel?: string
  planLabel?: string
  /** Only reliable -- and only acted on -- together with an authority. */
  providerSubject?: string
  providerAuthorityId?: string
}

/** Record the result of a provider status check on an account's own realm.
 *
 *  Once a subject is on record, a check that reports ANY subject or authority
 *  other than the byte-identical pair -- a different one, a malformed one, or
 *  one without its authority -- BLOCKS the account and rewrites nothing:
 *  history is never silently re-attributed, and a check that cannot be read is
 *  not evidence of the same user. A check that reports no subject at all says
 *  nothing about who is signed in and changes only the auth state.
 *
 *  With no subject on record, a reliable pair (subject AND authority) is
 *  adopted, unless another live account already holds it: then this account is
 *  BLOCKED rather than the check refused, so a realm signed in as someone else
 *  can never launch. Blocked is sticky; clearing it is an explicit user action
 *  in the accounts flow, never a side effect of a later check. */
export function recordAuthCheck(doc: ProviderRegistryDoc, accountId: string, input: AuthCheckInput, now: number): RegistryResult {
  const account = findAccount(doc, accountId)
  if (!account) return fail('not-found', `account ${accountId} does not exist`)
  if (!oneOf(AUTH_STATES, input.state)) return fail('invalid-value', 'unknown auth state')
  if (input.authMethod !== undefined && !oneOf(AUTH_METHODS, input.authMethod)) return fail('invalid-value', 'unknown sign-in method')
  const next: ProviderAccount = { ...account, lastKnownAuthState: input.state, lastValidatedAt: now, updatedAt: now }
  if (input.state === 'signed-in') next.lastAuthenticatedAt = now
  if (input.authMethod !== undefined) next.authMethod = input.authMethod
  const label = normaliseLabel(input.providerLabel, LABEL_MAX)
  if (label !== undefined) next.providerLabel = label
  const plan = normaliseLabel(input.planLabel, PLAN_MAX)
  if (plan !== undefined) next.planLabel = plan

  let drift = account.operationalState === 'blocked'
  const reported = input.providerSubject !== undefined || input.providerAuthorityId !== undefined
  const subject = safeToken(input.providerSubject, SUBJECT_MAX)
  const authority = safeToken(input.providerAuthorityId, SUBJECT_MAX)
  if (account.providerSubject !== undefined && account.providerAuthorityId !== undefined) {
    if (reported && (subject !== account.providerSubject || authority !== account.providerAuthorityId)) drift = true
  } else if (subject !== undefined && authority !== undefined) {
    if (subjectTaken(doc, account.providerId, authority, subject, accountId)) drift = true
    else {
      next.providerSubject = subject
      next.providerAuthorityId = authority
    }
  }
  next.operationalState = drift ? 'blocked' : operationalFor(input.state)
  return done({ ...doc, accounts: doc.accounts.map((a) => (a.id === accountId ? compact(next) : a)) })
}

// ---------------------------------------------------------------------------
// Launch binding (design 5.7)
// ---------------------------------------------------------------------------

export type LaunchBindingError = 'invalid-id' | 'not-found' | 'provider-mismatch' | 'not-active' | 'blocked' | 'realm-unavailable'

export type LaunchBindingResult =
  | { ok: true; binding: SessionBinding; realmOnly: boolean }
  | { ok: false; code: LaunchBindingError; message: string }

/** Resolve the exact account a launch runs under. The provider account is the
 *  canonical input; realm and identity are derived from it, never taken from
 *  the caller. `realmOnly` means the caller must hold a per-launch
 *  acknowledgement before spawning (an unverifiable external home). */
export function resolveLaunchBinding(doc: ProviderRegistryDoc, input: { providerId: ProviderId; providerAccountId: string }): LaunchBindingResult {
  const no = (code: LaunchBindingError, message: string): LaunchBindingResult => ({ ok: false, code, message })
  if (!isOpaqueId(input.providerAccountId, 'account')) return no('invalid-id', 'the session names no valid account')
  const account = findAccount(doc, input.providerAccountId)
  if (!account) return no('not-found', 'the account this session was bound to no longer exists')
  if (account.providerId !== input.providerId) return no('provider-mismatch', 'the account belongs to another provider')
  if (account.lifecycle !== 'active') return no('not-active', `the account is ${account.lifecycle}; activate it or choose another`)
  if (account.operationalState === 'blocked') return no('blocked', 'the account is blocked until its sign-in is reconciled in Accounts')
  const realm = findRealm(doc, account.authRealmId)
  if (!realm || realm.lifecycle !== 'active' || realm.ownerProviderAccountId !== account.id || realm.providerId !== account.providerId) {
    return no('realm-unavailable', "the account's sign-in location is not available")
  }
  if (!findIdentity(doc, account.identityId)) return no('not-found', 'the account has no identity')
  return {
    ok: true,
    binding: { providerId: account.providerId, providerAccountId: account.id, authRealmId: realm.id, identityId: account.identityId },
    realmOnly: isRealmOnly(account, realm),
  }
}

// ---------------------------------------------------------------------------
// Invariants and parsing (design 6.4, 14)
// ---------------------------------------------------------------------------

/** Every cross-record rule the transitions maintain. Empty means consistent.
 *  A document read from disk that fails any of these is not used. */
export function checkRegistryInvariants(doc: ProviderRegistryDoc): string[] {
  const problems: string[] = []
  const dupes = (kind: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id ${id}`)
      seen.add(id)
    }
  }
  dupes('identity', doc.identities.map((i) => i.id))
  dupes('group', doc.groups.map((g) => g.id))
  dupes('account', [...doc.accounts.map((a) => a.id), ...doc.journals.map((j) => j.accountId)])
  dupes('realm', doc.realms.map((r) => r.id))
  dupes('migration marker', doc.migrations.map((m) => `${m.providerId}:${m.step}`))

  const groups = new Set(doc.groups.map((g) => g.id))
  for (const i of doc.identities) if (i.groupId !== undefined && !groups.has(i.groupId)) problems.push(`identity ${i.id} names missing group ${i.groupId}`)

  const identities = new Set(doc.identities.map((i) => i.id))
  const accounts = new Map(doc.accounts.map((a) => [a.id, a]))
  const journals = new Map(doc.journals.map((j) => [j.accountId, j]))
  const realmsById = new Map(doc.realms.map((r) => [r.id, r]))
  for (const a of doc.accounts) {
    if (!identities.has(a.identityId)) problems.push(`account ${a.id} names missing identity ${a.identityId}`)
    if (a.identityAssurance === 'verified-subject' && (a.providerSubject === undefined || a.providerAuthorityId === undefined)) problems.push(`account ${a.id} is verified without a subject and authority`)
    const r = realmsById.get(a.authRealmId)
    if (!r) { problems.push(`account ${a.id} names missing realm ${a.authRealmId}`); continue }
    if (r.ownerProviderAccountId !== a.id) problems.push(`realm ${r.id} owner is ${r.ownerProviderAccountId}, not ${a.id}`)
    if (r.providerId !== a.providerId) problems.push(`realm ${r.id} provider ${r.providerId} differs from account ${a.id}`)
    if (r.lifecycle === 'pending') problems.push(`account ${a.id} is committed but its realm ${r.id} is still pending`)
    if (r.ownership === 'external-default' && a.identityAssurance !== 'realm-only') problems.push(`account ${a.id} on the external default home is not realm-only`)
  }
  const linkedProfiles = new Set(doc.legacyLinks.map((l) => `${l.accountId}|${l.legacyId}`))
  for (const r of doc.realms) {
    const shape = realmShapeProblem(r)
    if (shape) problems.push(`realm ${r.id}: ${shape}`)
    const owner = accounts.get(r.ownerProviderAccountId)
    const journal = journals.get(r.ownerProviderAccountId)
    if (owner) {
      // One realm per account: an owned realm that is not the owner's own is
      // an orphan still holding a reference.
      if (owner.authRealmId !== r.id) problems.push(`realm ${r.id} is owned by ${owner.id} but is not its realm`)
    } else if (!(journal && journal.realmId === r.id && r.lifecycle === 'pending' && journal.providerId === r.providerId)) {
      problems.push(`realm ${r.id} owner ${r.ownerProviderAccountId} is neither an account nor a setup in progress`)
    }
    // A live Claude profile home belongs to exactly the account linked to that
    // profile: never a swapped or borrowed one.
    if (holdsPath(r) && r.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX)) {
      const profileId = r.pathRef.slice(CLAUDE_PROFILE_PATH_REF_PREFIX.length)
      if (!linkedProfiles.has(`${r.ownerProviderAccountId}|${profileId}`)) problems.push(`realm ${r.id} names profile ${profileId} but its account is not linked to it`)
    }
  }
  for (const j of doc.journals) {
    const r = realmsById.get(j.realmId)
    if (!r || r.lifecycle !== 'pending' || r.ownerProviderAccountId !== j.accountId) problems.push(`setup ${j.accountId} has no pending realm ${j.realmId}`)
  }

  const livePaths = new Map<string, string>()
  for (const r of doc.realms) {
    if (!holdsPath(r)) continue
    const key = `${r.providerId}\u0000${r.pathRef}`
    const other = livePaths.get(key)
    if (other) problems.push(`realms ${other} and ${r.id} share pathRef ${r.pathRef}`)
    livePaths.set(key, r.id)
  }

  const providers = new Set(doc.accounts.map((a) => a.providerId))
  for (const p of providers) {
    const mine = doc.accounts.filter((a) => a.providerId === p)
    const defaults = mine.filter((a) => a.isProviderDefault)
    for (const d of defaults) if (d.lifecycle !== 'active') problems.push(`default account ${d.id} is ${d.lifecycle}`)
    if (defaults.length > 1) problems.push(`${p} has ${defaults.length} default accounts`)
    if (mine.some((a) => a.lifecycle === 'active') && defaults.filter((d) => d.lifecycle === 'active').length === 0) problems.push(`${p} has active accounts but no default`)
  }

  const subjects = new Map<string, string>()
  for (const a of doc.accounts) {
    if (a.lifecycle === 'archived' || a.providerSubject === undefined || a.providerAuthorityId === undefined) continue
    const key = `${a.providerId}\u0000${a.providerAuthorityId}\u0000${a.providerSubject}`
    const other = subjects.get(key)
    if (other) problems.push(`accounts ${other} and ${a.id} claim one upstream subject`)
    subjects.set(key, a.id)
  }

  const legacy = new Set<string>()
  const linked = new Set<string>()
  for (const l of doc.legacyLinks) {
    const key = `${l.providerId}\u0000${l.legacyId}`
    if (legacy.has(key)) problems.push(`duplicate legacy link ${l.providerId}:${l.legacyId}`)
    legacy.add(key)
    if (linked.has(l.accountId)) problems.push(`account ${l.accountId} has two legacy links`)
    linked.add(l.accountId)
    const a = accounts.get(l.accountId)
    if (!a) problems.push(`legacy link ${l.providerId}:${l.legacyId} names missing account ${l.accountId}`)
    else if (a.providerId !== l.providerId) problems.push(`legacy link ${l.legacyId} provider differs from account ${a.id}`)
    else if (a.lifecycle === 'archived') problems.push(`legacy link ${l.legacyId} names archived account ${a.id}`)
  }
  const conflictKeys = new Set<string>()
  for (const c of doc.conflicts) {
    if (!identities.has(c.identityId)) problems.push(`conflict names missing identity ${c.identityId}`)
    if (!legacy.has(`${c.providerId}\u0000${c.legacyId}`)) problems.push(`conflict names unlinked legacy record ${c.providerId}:${c.legacyId}`)
    const key = `${c.identityId}\u0000${c.field}\u0000${c.providerId}\u0000${c.legacyId}`
    if (conflictKeys.has(key)) problems.push(`two open conflicts on ${c.field} of ${c.identityId} from ${c.legacyId}`)
    conflictKeys.add(key)
  }
  const legacyIdentities = new Map<string, string>()
  for (const l of doc.legacyLinks) {
    const a = accounts.get(l.accountId)
    if (!a) continue
    const key = `${l.providerId}|${a.identityId}`
    const other = legacyIdentities.get(key)
    if (other) problems.push(`legacy records ${other} and ${l.legacyId} share identity ${a.identityId}`)
    legacyIdentities.set(key, l.legacyId)
  }
  return problems
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string }
const P = <T>(value: T): Parsed<T> => ({ ok: true, value })
const X = <T>(problem: string): Parsed<T> => ({ ok: false, problem })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function optLabel(raw: unknown, max: number): Parsed<string | undefined> {
  if (raw === undefined) return P(undefined)
  if (typeof raw !== 'string') return X('label is not text')
  return P(normaliseLabel(raw, max))
}

function optToken(raw: unknown, max: number, what: string): Parsed<string | undefined> {
  if (raw === undefined) return P(undefined)
  const t = safeToken(raw, max)
  return t === undefined ? X(`${what} is not a plain bounded token`) : P(t)
}

function optTime(raw: unknown, what: string): Parsed<number | undefined> {
  if (raw === undefined) return P(undefined)
  return isTime(raw) ? P(raw) : X(`${what} is not a timestamp`)
}

function parseIdentity(o: unknown): Parsed<ConductorIdentity> {
  if (!isObj(o)) return X('identity is not an object')
  if (!isOpaqueId(o.id, 'identity')) return X('identity id is invalid')
  const name = optLabel(o.friendlyName, FRIENDLY_NAME_MAX)
  if (!name.ok) return X(`identity ${String(o.id)}: ${name.problem}`)
  if (!isIdentityColourKey(o.colourKey)) return X(`identity ${String(o.id)}: colour is not in the palette`)
  if (o.groupId !== undefined && !isOpaqueId(o.groupId, 'group')) return X(`identity ${String(o.id)}: group id is invalid`)
  if (!isTime(o.createdAt) || !isTime(o.updatedAt)) return X(`identity ${String(o.id)}: timestamps are invalid`)
  return P(compact({ id: o.id as string, friendlyName: name.value, colourKey: o.colourKey, groupId: o.groupId as string | undefined, createdAt: o.createdAt, updatedAt: o.updatedAt }))
}

function parseGroup(o: unknown): Parsed<AccountGroup> {
  if (!isObj(o)) return X('group is not an object')
  if (!isOpaqueId(o.id, 'group')) return X('group id is invalid')
  const name = typeof o.name === 'string' ? normaliseLabel(o.name, GROUP_NAME_MAX) : undefined
  if (!name) return X(`group ${String(o.id)}: name is missing`)
  if (typeof o.order !== 'number' || !Number.isInteger(o.order) || o.order < 0 || o.order > GROUP_ORDER_MAX) return X(`group ${String(o.id)}: order is invalid`)
  if (!isTime(o.createdAt) || !isTime(o.updatedAt)) return X(`group ${String(o.id)}: timestamps are invalid`)
  return P({ id: o.id as string, name, order: o.order, createdAt: o.createdAt, updatedAt: o.updatedAt })
}

function parseAccount(o: unknown): Parsed<ProviderAccount> {
  if (!isObj(o)) return X('account is not an object')
  const id = o.id
  if (!isOpaqueId(id, 'account')) return X('account id is invalid')
  const where = `account ${String(id)}`
  if (!isProviderId(o.providerId)) return X(`${where}: unknown provider`)
  if (!isOpaqueId(o.identityId, 'identity')) return X(`${where}: identity id is invalid`)
  if (!isOpaqueId(o.authRealmId, 'realm')) return X(`${where}: realm id is invalid`)
  const authority = optToken(o.providerAuthorityId, SUBJECT_MAX, 'authority')
  const subject = optToken(o.providerSubject, SUBJECT_MAX, 'subject')
  const label = optLabel(o.providerLabel, LABEL_MAX)
  const plan = optLabel(o.planLabel, PLAN_MAX)
  const lastAuth = optTime(o.lastAuthenticatedAt, 'lastAuthenticatedAt')
  const lastVal = optTime(o.lastValidatedAt, 'lastValidatedAt')
  for (const r of [authority, subject, label, plan, lastAuth, lastVal]) if (!r.ok) return X(`${where}: ${r.problem}`)
  if (!oneOf(AUTH_METHODS, o.authMethod)) return X(`${where}: unknown sign-in method`)
  if (!oneOf(LIFECYCLES, o.lifecycle)) return X(`${where}: unknown lifecycle`)
  if (typeof o.isProviderDefault !== 'boolean') return X(`${where}: isProviderDefault is not a boolean`)
  if (!isTime(o.createdAt) || !isTime(o.updatedAt)) return X(`${where}: timestamps are invalid`)
  if (!oneOf(AUTH_STATES, o.lastKnownAuthState)) return X(`${where}: unknown auth state`)
  if (!oneOf(OP_STATES, o.operationalState)) return X(`${where}: unknown operational state`)
  if (!oneOf(ASSURANCES, o.identityAssurance)) return X(`${where}: unknown identity assurance`)
  const reliable = authority.ok && subject.ok && authority.value !== undefined && subject.value !== undefined
  return P(compact({
    id: id as string,
    providerId: o.providerId,
    providerAuthorityId: reliable && authority.ok ? authority.value : undefined,
    identityId: o.identityId as string,
    authRealmId: o.authRealmId as string,
    providerSubject: reliable && subject.ok ? subject.value : undefined,
    providerLabel: label.ok ? label.value : undefined,
    authMethod: o.authMethod,
    planLabel: plan.ok ? plan.value : undefined,
    lifecycle: o.lifecycle,
    isProviderDefault: o.isProviderDefault,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lastAuthenticatedAt: lastAuth.ok ? lastAuth.value : undefined,
    lastValidatedAt: lastVal.ok ? lastVal.value : undefined,
    lastKnownAuthState: o.lastKnownAuthState,
    operationalState: o.operationalState,
    identityAssurance: o.identityAssurance,
  }))
}

function parseRealm(o: unknown): Parsed<AuthRealm> {
  if (!isObj(o)) return X('realm is not an object')
  if (!isOpaqueId(o.id, 'realm')) return X('realm id is invalid')
  const where = `realm ${String(o.id)}`
  if (!isProviderId(o.providerId)) return X(`${where}: unknown provider`)
  if (!isOpaqueId(o.ownerProviderAccountId, 'account')) return X(`${where}: owner id is invalid`)
  if (!oneOf(REALM_KINDS, o.kind)) return X(`${where}: unknown kind`)
  if (!oneOf(OWNERSHIPS, o.ownership)) return X(`${where}: unknown ownership`)
  if (!isPathRef(o.pathRef)) return X(`${where}: pathRef is not a plain bounded token`)
  if (o.credentialStoreMode !== undefined && !oneOf(STORE_MODES, o.credentialStoreMode)) return X(`${where}: unknown credential store mode`)
  if (!oneOf(REALM_LIFECYCLES, o.lifecycle)) return X(`${where}: unknown lifecycle`)
  if (!isTime(o.createdAt)) return X(`${where}: createdAt is invalid`)
  const lastVal = optTime(o.lastValidatedAt, 'lastValidatedAt')
  if (!lastVal.ok) return X(`${where}: ${lastVal.problem}`)
  return P(compact({
    id: o.id as string, providerId: o.providerId, ownerProviderAccountId: o.ownerProviderAccountId as string, kind: o.kind,
    ownership: o.ownership, pathRef: o.pathRef, credentialStoreMode: o.credentialStoreMode as CredentialStoreMode | undefined,
    lifecycle: o.lifecycle, createdAt: o.createdAt, lastValidatedAt: lastVal.value,
  }))
}

function parseJournal(o: unknown): Parsed<SetupJournal> {
  if (!isObj(o)) return X('setup journal is not an object')
  if (!isOpaqueId(o.accountId, 'account') || !isOpaqueId(o.realmId, 'realm')) return X('setup journal ids are invalid')
  if (!isProviderId(o.providerId)) return X('setup journal names an unknown provider')
  if (!oneOf(AUTH_METHODS, o.method)) return X('setup journal names an unknown method')
  if (!oneOf(JOURNAL_STATES, o.state)) return X('setup journal state is invalid')
  if (!isTime(o.createdAt) || !isTime(o.updatedAt)) return X('setup journal timestamps are invalid')
  return P({ accountId: o.accountId as string, realmId: o.realmId as string, providerId: o.providerId, method: o.method, state: o.state, createdAt: o.createdAt, updatedAt: o.updatedAt })
}

function parseLegacyLink(o: unknown): Parsed<LegacyLink> {
  if (!isObj(o)) return X('legacy link is not an object')
  if (!isProviderId(o.providerId)) return X('legacy link names an unknown provider')
  if (!isLegacyId(o.legacyId)) return X('legacy link id is invalid')
  if (!isOpaqueId(o.accountId, 'account')) return X('legacy link account id is invalid')
  const s = o.shadow
  if (!isObj(s) || typeof s.friendlyName !== 'string' || !isIdentityColourKey(s.colourKey) || (s.lifecycle !== 'active' && s.lifecycle !== 'inactive')) {
    return X(`legacy link ${o.legacyId}: shadow is invalid`)
  }
  return P({
    providerId: o.providerId, legacyId: o.legacyId, accountId: o.accountId as string,
    shadow: { friendlyName: normaliseLabel(s.friendlyName, FRIENDLY_NAME_MAX) ?? '', colourKey: s.colourKey, lifecycle: s.lifecycle },
  })
}

function parseMigration(o: unknown): Parsed<ProviderMigrationMarker> {
  if (!isObj(o)) return X('migration marker is not an object')
  if (!isProviderId(o.providerId)) return X('migration marker names an unknown provider')
  if (!oneOf(MIGRATION_STEPS, o.step) || !oneOf(MIGRATION_OUTCOMES, o.outcome)) return X('migration marker is invalid')
  if (!migrationReasonFits(o.outcome, o.reason)) return X('migration marker reason is invalid')
  if (!isTime(o.at)) return X('migration marker timestamp is invalid')
  const marker: ProviderMigrationMarker = { providerId: o.providerId, step: o.step, outcome: o.outcome, at: o.at }
  if (o.reason !== undefined) marker.reason = o.reason as ProviderMigrationSkipReason
  return P(marker)
}

function parseConflict(o: unknown): Parsed<IdentityConflict> {
  if (!isObj(o)) return X('conflict is not an object')
  if (!isOpaqueId(o.identityId, 'identity')) return X('conflict identity id is invalid')
  if (o.field !== 'friendlyName' && o.field !== 'colourKey') return X('conflict field is invalid')
  if (!isProviderId(o.providerId)) return X('conflict names an unknown provider')
  if (!isLegacyId(o.legacyId)) return X('conflict legacy id is invalid')
  if (typeof o.legacyValue !== 'string' || typeof o.registryValue !== 'string') return X('conflict values are invalid')
  if (o.field === 'colourKey' && (!isIdentityColourKey(o.legacyValue) || !isIdentityColourKey(o.registryValue))) return X('conflict colours are not in the palette')
  if (!isTime(o.detectedAt)) return X('conflict timestamp is invalid')
  return P({
    identityId: o.identityId as string, field: o.field, providerId: o.providerId, legacyId: o.legacyId,
    legacyValue: normaliseLabel(o.legacyValue, FRIENDLY_NAME_MAX) ?? '', registryValue: normaliseLabel(o.registryValue, FRIENDLY_NAME_MAX) ?? '',
    detectedAt: o.detectedAt,
  })
}

export type RegistryParseResult =
  | { ok: true; doc: ProviderRegistryDoc }
  | { ok: false; reason: 'invalid' | 'newer-schema'; problems: string[] }

/** Read a registry document from untrusted JSON. Fails closed: one invalid
 *  record or one broken cross-reference rejects the whole document, and the
 *  caller enters recovery rather than guessing. Unknown fields are dropped and
 *  every label is re-sanitised, so nothing unvalidated reaches a renderer. */
export function parseRegistryDoc(raw: unknown): RegistryParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'invalid', problems: ['the registry is not an object'] }
  const v = raw.schemaVersion
  if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, reason: 'invalid', problems: ['schemaVersion is missing'] }
  if (v > REGISTRY_SCHEMA_VERSION) return { ok: false, reason: 'newer-schema', problems: [`schema ${v} is newer than ${REGISTRY_SCHEMA_VERSION}`] }
  if (v !== REGISTRY_SCHEMA_VERSION && v !== UPGRADABLE_SCHEMA_VERSION) return { ok: false, reason: 'invalid', problems: [`unknown schema ${v}`] }
  const problems: string[] = []
  const src: Record<string, unknown> = raw
  function list<T>(key: string, parse: (o: unknown) => Parsed<T>): T[] {
    // Every list is required: a missing or misspelled key would otherwise read
    // as "no records", and the next write would persist that loss.
    const arr = src[key]
    if (!Array.isArray(arr)) { problems.push(`${key} is not a list`); return [] }
    const out: T[] = []
    for (const item of arr) {
      const p = parse(item)
      if (p.ok) out.push(p.value)
      else problems.push(p.problem)
    }
    return out
  }
  const doc: ProviderRegistryDoc = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    identities: list('identities', parseIdentity),
    groups: list('groups', parseGroup),
    accounts: list('accounts', parseAccount),
    realms: list('realms', parseRealm),
    journals: list('journals', parseJournal),
    legacyLinks: list('legacyLinks', parseLegacyLink),
    conflicts: list('conflicts', parseConflict),
    // Required from schema 2, like every other list; schema 1 predates it.
    migrations: v === UPGRADABLE_SCHEMA_VERSION ? [] : list('migrations', parseMigration),
  }
  if (problems.length) return { ok: false, reason: 'invalid', problems }
  const broken = checkRegistryInvariants(doc)
  if (broken.length) return { ok: false, reason: 'invalid', problems: broken }
  return { ok: true, doc }
}

// ---------------------------------------------------------------------------
// Legacy reconciliation (design 6.1, 6.2, 6.4)
// ---------------------------------------------------------------------------

/** One record of a provider's legacy account store, as the provider package
 *  reads it -- values only, already resolved the way that provider's existing
 *  surfaces show them (Claude: the email colour override wins over the
 *  profile's own key). */
export interface LegacyAccountSnapshot {
  legacyId: string
  friendlyName: string
  colourKey: string
  lifecycle: 'active' | 'inactive'
  isDefault: boolean
  providerLabel?: string
  /** Absent or invalid: the account is stamped with the reconcile time. */
  createdAt?: number
  realm: { kind: RealmKind; ownership: RealmOwnership; pathRef: string }
  authMethod: AuthMethod
  identityAssurance: IdentityAssurance
}

/** A change the registry made that the legacy store has not caught up with.
 *  The provider package applies it; the next reconcile sees legacy agree and
 *  moves the shadow. A write is never marked done optimistically. */
export interface LegacyWrite {
  providerId: ProviderId
  legacyId: string
  field: 'friendlyName' | 'colourKey' | 'lifecycle'
  value: string
}

export interface ReconcileContext {
  now: number
  /** Deterministic opaque id from a seed (a hash in the main process), so the
   *  same legacy record always maps to the same account, realm and identity. */
  deterministicId: (kind: OpaqueIdKind, seed: string) => string
  /** Running sessions and operations holding each account, read under the
   *  lock that applies the result. A legacy change that would take a held
   *  account out of use (inactive, or removed) is deferred, not applied, and
   *  retried by the next reconcile. Absent: nothing holds any account. */
  consumers?: (accountId: string) => number
}

export type ReconcileResult =
  | { ok: true; doc: ProviderRegistryDoc; writes: LegacyWrite[]; created: number; imported: number; archived: number; restored: number; warnings: string[] }
  | { ok: false; problems: string[] }

type ShadowField = 'friendlyName' | 'colourKey'
type CleanSnapshot = LegacyAccountSnapshot & { friendlyName: string; colourKey: string; providerLabel: string | undefined }

/** Bring the registry and one provider's legacy store into agreement, field by
 *  field, against the last values they agreed on (the shadow):
 *
 *  - legacy unchanged, registry changed  -> a pending write-through (LegacyWrite);
 *  - legacy changed, registry unchanged  -> import the legacy value;
 *  - both changed to the same value      -> converged, move the shadow;
 *  - both changed, differently           -> keep the registry value and hold ONE
 *                                           open conflict for that field, write
 *                                           nothing until the user resolves it.
 *
 *  Conflicts are rebuilt on every reconcile, so one that has converged is gone
 *  and one whose values moved is replaced, never appended to.
 *
 *  Existence follows the legacy store: a record new to the registry is migrated
 *  with deterministic ids; a linked record missing from the snapshot is
 *  archived (its history stays resolvable); an archived account whose record
 *  comes back is restored. A snapshot with NO usable record while accounts are
 *  linked is treated as an unreadable store and changes nothing -- one failed
 *  read must never archive every account. The provider default follows the
 *  legacy store's own default, which is always active. Other providers'
 *  records are never touched. Fails closed on an inconsistent result. */
export function reconcileLegacyAccounts(
  doc: ProviderRegistryDoc,
  providerId: ProviderId,
  snapshot: readonly LegacyAccountSnapshot[],
  ctx: ReconcileContext,
): ReconcileResult {
  if (!isProviderId(providerId)) return { ok: false, problems: ['unknown provider'] }
  const now = ctx.now
  const held = (accountId: string) => (ctx.consumers ? ctx.consumers(accountId) : 0) > 0
  const warnings: string[] = []

  // Validate the snapshot first: a record the registry could not store is
  // skipped with a warning, never half-applied.
  const records: CleanSnapshot[] = []
  const seen = new Set<string>()
  for (const raw of snapshot) {
    const id = raw?.legacyId
    if (!isLegacyId(id)) { warnings.push(`skipped a legacy record with an invalid id`); continue }
    if (seen.has(id)) { warnings.push(`skipped duplicate legacy record ${id}`); continue }
    if ((raw.lifecycle !== 'active' && raw.lifecycle !== 'inactive') || !oneOf(AUTH_METHODS, raw.authMethod) || !oneOf(ASSURANCES, raw.identityAssurance)
      || !raw.realm || !oneOf(REALM_KINDS, raw.realm.kind) || !oneOf(OWNERSHIPS, raw.realm.ownership) || !isPathRef(raw.realm.pathRef)) {
      warnings.push(`skipped legacy record ${id}: unknown field value`)
      continue
    }
    // A legacy store carries no provider subject, and its own records are the
    // only ones that may name its homes.
    if (raw.identityAssurance === 'verified-subject' || (raw.realm.ownership === 'external-default') !== (raw.identityAssurance === 'realm-only')) {
      warnings.push(`skipped legacy record ${id}: its identity assurance does not fit its realm`)
      continue
    }
    if (raw.realm.pathRef.startsWith(CLAUDE_PROFILE_PATH_REF_PREFIX) && raw.realm.pathRef !== `${CLAUDE_PROFILE_PATH_REF_PREFIX}${id}`) {
      warnings.push(`skipped legacy record ${id}: it names another profile's home`)
      continue
    }
    seen.add(id)
    records.push({
      ...raw,
      friendlyName: normaliseLabel(raw.friendlyName, FRIENDLY_NAME_MAX) ?? '',
      colourKey: isIdentityColourKey(raw.colourKey) ? raw.colourKey : 'mauve',
      providerLabel: normaliseLabel(raw.providerLabel, LABEL_MAX),
      // The legacy default is always active, whatever the record says.
      lifecycle: raw.isDefault === true ? 'active' : raw.lifecycle,
    })
  }
  const linkedHere = doc.legacyLinks.filter((l) => l.providerId === providerId)
  if (records.length === 0 && linkedHere.length > 0) {
    warnings.push('the legacy account store listed no usable accounts; treated as unreadable, nothing changed')
    return { ok: true, doc, writes: [], created: 0, imported: 0, archived: 0, restored: 0, warnings }
  }

  let identities = [...doc.identities]
  let accounts = [...doc.accounts]
  let realms = [...doc.realms]
  const links = doc.legacyLinks.filter((l) => l.providerId !== providerId)
  const conflicts = doc.conflicts.filter((c) => c.providerId !== providerId)
  const priorConflicts = doc.conflicts.filter((c) => c.providerId === providerId)
  const writes: LegacyWrite[] = []
  let created = 0
  let imported = 0
  let archived = 0
  let restored = 0

  const setIdentity = (id: string, field: ShadowField, value: string) => {
    identities = identities.map((i) => (i.id === id ? compact({ ...i, [field]: field === 'friendlyName' ? (value || undefined) : value, updatedAt: now }) : i))
  }
  const holdConflict = (identityId: string, field: ShadowField, legacyId: string, legacyValue: string, registryValue: string) => {
    const prior = priorConflicts.find((c) => c.identityId === identityId && c.field === field && c.legacyId === legacyId)
    conflicts.push(prior && prior.legacyValue === legacyValue && prior.registryValue === registryValue
      ? prior
      : { identityId, field, providerId, legacyId, legacyValue, registryValue, detectedAt: now })
  }
  const liveElsewhere = (pathRef: string, exceptRealmId: string) => realms.some((r) => r.id !== exceptRealmId && r.providerId === providerId && r.pathRef === pathRef && holdsPath(r))

  for (const s of records) {
    const link = linkedHere.find((l) => l.legacyId === s.legacyId)
    const accountId = link?.accountId ?? ctx.deterministicId('account', `${providerId}:${s.legacyId}`)
    let existing = accounts.find((a) => a.id === accountId)
    if (existing && existing.providerId !== providerId) return { ok: false, problems: [`legacy record ${s.legacyId} maps to another provider's account`] }

    if (!existing) {
      const identityId = ctx.deterministicId('identity', `${providerId}:${s.legacyId}`)
      const realmId = ctx.deterministicId('realm', `${providerId}:${s.legacyId}`)
      if (!isOpaqueId(identityId, 'identity') || !isOpaqueId(realmId, 'realm') || !isOpaqueId(accountId, 'account')) return { ok: false, problems: ['deterministicId produced an invalid id'] }
      const shape = realmShapeProblem({ id: realmId, providerId, kind: s.realm.kind, ownership: s.realm.ownership, pathRef: s.realm.pathRef })
      if (shape) { warnings.push(`skipped legacy record ${s.legacyId}: ${shape}`); continue }
      if (liveElsewhere(s.realm.pathRef, realmId)) { warnings.push(`skipped legacy record ${s.legacyId}: its sign-in location is already registered`); continue }
      if (!identities.some((i) => i.id === identityId)) {
        identities.push(compact({ id: identityId, friendlyName: s.friendlyName || undefined, colourKey: s.colourKey, createdAt: now, updatedAt: now }))
      }
      realms.push({ id: realmId, providerId, ownerProviderAccountId: accountId, kind: s.realm.kind, ownership: s.realm.ownership, pathRef: s.realm.pathRef, lifecycle: 'active', createdAt: now })
      accounts.push(compact({
        id: accountId, providerId, identityId, authRealmId: realmId, providerLabel: s.providerLabel, authMethod: s.authMethod,
        lifecycle: s.lifecycle, isProviderDefault: false, createdAt: isTime(s.createdAt) ? s.createdAt : now, updatedAt: now,
        lastKnownAuthState: 'unknown' as const, operationalState: 'ready' as const, identityAssurance: s.identityAssurance,
      }))
      links.push({ providerId, legacyId: s.legacyId, accountId, shadow: { friendlyName: s.friendlyName, colourKey: s.colourKey, lifecycle: s.lifecycle } })
      created++
      continue
    }

    const identity = identities.find((i) => i.id === existing!.identityId)
    const current = { friendlyName: identity?.friendlyName ?? '', colourKey: identity?.colourKey ?? s.colourKey }
    let shadow: LegacyShadow
    if (existing.lifecycle === 'archived') {
      // The record came back (a restore, a downgrade and re-upgrade, a read
      // that briefly missed it): bring the account back rather than leave a
      // live profile permanently unusable. The legacy values win -- nothing in
      // the registry has been agreed with this record since it went away.
      const realm = realms.find((r) => r.id === existing!.authRealmId)
      if (!realm || realm.providerId !== providerId || realm.pathRef !== s.realm.pathRef || liveElsewhere(realm.pathRef, realm.id)) {
        warnings.push(`legacy record ${s.legacyId} came back but its sign-in location is not its own or is in use; left archived`)
        continue
      }
      // Nothing about who is signed in there is known any more: the subject is
      // dropped (another account may hold it by now) and the account needs a
      // fresh check, exactly as a restore through the accounts flow would.
      realms = realms.map((r) => (r.id === realm.id ? { ...r, lifecycle: 'active' as const } : r))
      accounts = accounts.map((a) => (a.id === existing!.id
        ? compact({
          ...a, lifecycle: s.lifecycle, isProviderDefault: false, updatedAt: now,
          providerSubject: undefined, providerAuthorityId: undefined, lastKnownAuthState: 'unknown' as const,
          operationalState: a.operationalState === 'blocked' ? 'blocked' as const : 'attention' as const,
          identityAssurance: a.identityAssurance === 'verified-subject' ? 'user-asserted' as const : a.identityAssurance,
        })
        : a))
      existing = accounts.find((a) => a.id === accountId)!
      restored++
      shadow = { ...current, lifecycle: s.lifecycle }
    } else {
      // A link lost to a hand edit reattaches by deterministic id; with no
      // agreed base the legacy values win, as for a restore.
      shadow = link ? { ...link.shadow } : { ...current, lifecycle: existing.lifecycle as 'active' | 'inactive' }
    }

    if (identity) {
      for (const field of ['friendlyName', 'colourKey'] as const) {
        const legacyV = s[field]
        const shadowV = shadow[field]
        const regV = current[field]
        if (legacyV === shadowV) {
          // A cleared registry name is never pushed as an empty legacy name.
          if (regV !== shadowV && regV !== '') writes.push({ providerId, legacyId: s.legacyId, field, value: regV })
          else if (regV === '' && legacyV !== '') { setIdentity(identity.id, field, legacyV); imported++ }
        } else if (regV === shadowV || regV === '') {
          setIdentity(identity.id, field, legacyV)
          shadow[field] = legacyV
          imported++
        } else if (regV === legacyV) {
          shadow[field] = legacyV
        } else {
          holdConflict(identity.id, field, s.legacyId, legacyV, regV)
        }
      }
    }

    let lifecycle = existing.lifecycle as 'active' | 'inactive'
    const legacyL = s.lifecycle
    if (legacyL === shadow.lifecycle) {
      if (lifecycle !== shadow.lifecycle) {
        // The legacy default cannot be inactive there, and neither can its
        // last active record, so neither is here: import rather than leave a
        // write pending that would land at some unrelated later start.
        const lastActive = lifecycle === 'inactive' && !records.some((o) => o.legacyId !== s.legacyId && o.lifecycle === 'active')
        if (s.isDefault || lastActive) { lifecycle = 'active'; imported++ } else writes.push({ providerId, legacyId: s.legacyId, field: 'lifecycle', value: lifecycle })
      }
    } else if (legacyL === 'inactive' && lifecycle === 'active' && held(existing.id)) {
      warnings.push(`legacy record ${s.legacyId} was made inactive while in use; deferred`)
    } else {
      if (lifecycle !== legacyL) imported++
      lifecycle = legacyL
      shadow.lifecycle = legacyL
    }
    accounts = accounts.map((a) => (a.id === existing!.id
      ? compact({ ...a, lifecycle, providerLabel: s.providerLabel ?? a.providerLabel, updatedAt: lifecycle !== a.lifecycle ? now : a.updatedAt })
      : a))
    links.push({ providerId, legacyId: s.legacyId, accountId: existing.id, shadow })
  }

  // Linked records gone from the legacy store: archive and retire, unless a
  // running session still holds the account -- then keep everything as it is
  // and retry next time.
  for (const l of linkedHere) {
    if (seen.has(l.legacyId)) continue
    const a = accounts.find((x) => x.id === l.accountId)
    if (!a || a.lifecycle === 'archived') continue
    if (held(a.id)) {
      links.push(l)
      conflicts.push(...priorConflicts.filter((c) => c.legacyId === l.legacyId))
      warnings.push(`legacy record ${l.legacyId} was removed while in use; deferred`)
      continue
    }
    accounts = accounts.map((x) => (x.id === a.id ? { ...x, lifecycle: 'archived' as const, isProviderDefault: false, updatedAt: now } : x))
    realms = realms.map((r) => (r.id === a.authRealmId ? { ...r, lifecycle: 'retired' as const } : r))
    archived++
  }

  // The default follows the legacy store's own default among this provider's
  // linked, active accounts; failing that the current default, then an
  // unblocked active account, keeps "active accounts imply one default".
  const defaultLegacy = records.find((s) => s.isDefault === true)?.legacyId
  const defaultAccount = links.find((l) => l.providerId === providerId && l.legacyId === defaultLegacy)?.accountId
  const actives = accounts.filter((a) => a.providerId === providerId && a.lifecycle === 'active')
  const chosen = actives.find((a) => a.id === defaultAccount)?.id
    ?? actives.find((a) => a.isProviderDefault)?.id
    ?? actives.find((a) => a.operationalState !== 'blocked')?.id
    ?? actives[0]?.id
  accounts = accounts.map((a) => {
    if (a.providerId !== providerId) return a
    const want = a.id === chosen
    return a.isProviderDefault === want ? a : { ...a, isProviderDefault: want, updatedAt: now }
  })

  const next: ProviderRegistryDoc = { ...doc, identities, accounts, realms, legacyLinks: links, conflicts }
  const broken = checkRegistryInvariants(next)
  if (broken.length) return { ok: false, problems: [...warnings, ...broken] }
  return { ok: true, doc: next, writes, created, imported, archived, restored, warnings }
}

/** Settle one open conflict by an explicit user choice. Either way the shadow
 *  records that the legacy value has been seen: keeping the legacy value
 *  converges at once; keeping the registry value makes the next reconcile
 *  write it through to the legacy store. */
export function resolveIdentityConflict(
  doc: ProviderRegistryDoc,
  ref: { identityId: string; field: ShadowField; providerId: ProviderId; legacyId: string },
  keep: 'registry' | 'legacy',
  now: number,
): RegistryResult {
  const c = doc.conflicts.find((x) => x.identityId === ref.identityId && x.field === ref.field && x.providerId === ref.providerId && x.legacyId === ref.legacyId)
  if (!c) return fail('not-found', 'no such open conflict')
  const link = doc.legacyLinks.find((l) => l.providerId === c.providerId && l.legacyId === c.legacyId)
  if (!link) return fail('not-found', `legacy record ${c.legacyId} is no longer linked`)
  // After a relink the conflict names an identity the record no longer shows.
  if (findAccount(doc, link.accountId)?.identityId !== c.identityId) return fail('not-found', 'this conflict is for an identity the account no longer uses')
  if (keep !== 'registry' && keep !== 'legacy') return fail('invalid-value', 'choose the registry or the legacy value')
  const identities = keep === 'legacy'
    ? doc.identities.map((i) => (i.id === c.identityId ? compact({ ...i, [c.field]: c.field === 'friendlyName' ? (c.legacyValue || undefined) : c.legacyValue, updatedAt: now }) : i))
    : doc.identities
  return done({
    ...doc,
    identities,
    legacyLinks: doc.legacyLinks.map((l) => (l === link ? { ...l, shadow: { ...l.shadow, [c.field]: c.legacyValue } } : l)),
    conflicts: doc.conflicts.filter((x) => x !== c),
  })
}
