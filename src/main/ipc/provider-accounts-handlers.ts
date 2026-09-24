// WP2 commit 3: the provider-neutral Accounts IPC (design 12; plan A6).
//
// The boundary rules:
// - Only the app's own window, and only its main frame, is served: a webview,
//   an embedded or fenced frame or any other window gets `untrusted-sender`.
// - Every payload is validated with a STRICT schema before the service sees
//   it: unknown keys are refused, every id must be an opaque id of the right
//   kind, every provider a known provider. A refusal never echoes the input.
// - Replies are the service's views and results: no path, token, key,
//   environment value or argv crosses here. Sign-in output is the CLI's own
//   display text, redacted of secrets, sent only to the renderer that started
//   the sign-in.
// - The API key never travels in a request or a reply: it arrives once on a
//   one-way channel, bound to a main-issued handle, and this module never
//   logs, echoes or keeps it.
// - A renderer that goes away (destroyed, or its process gone: crash or
//   reload) stops the sign-ins it started; each releases its lease once its
//   process has ended. Session and review leases belong to their processes,
//   never to a window.
import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { isOpaqueId, isProviderId, isLegacyId, SECRET_HANDLE_RE, FRIENDLY_NAME_MAX, GROUP_NAME_MAX } from '../../shared/providers'
import type { AccountsFailure, OpaqueIdKind, ProviderId } from '../../shared/providers'
import type { AccountsService } from '../providers/core'
import { logError } from '../debug-logger'

const opaque = (kind: OpaqueIdKind) => z.string().max(80).refine((v) => isOpaqueId(v, kind))
const accountId = opaque('account')
const identityId = opaque('identity')
const groupId = opaque('group')
const providerId = z.string().max(40).refine((v): v is ProviderId => isProviderId(v)).transform((v) => v as ProviderId)
const signInMethod = z.enum(['browser', 'device', 'apiKey'])
// Names are normalised and capped by the registry; this only bounds the raw size.
const friendlyName = z.string().max(FRIENDLY_NAME_MAX * 4)
const groupName = z.string().max(GROUP_NAME_MAX * 4)
const colour = z.string().max(40)

export const PROVIDER_ACCOUNTS_SCHEMAS = {
  provider: z.object({ providerId }).strict(),
  setEnabled: z.object({ providerId, enabled: z.boolean() }).strict(),
  beginSetup: z.object({ providerId, method: signInMethod }).strict(),
  account: z.object({ accountId }).strict(),
  signIn: z.object({ accountId, method: signInMethod, secretHandle: z.string().regex(SECRET_HANDLE_RE).optional() }).strict(),
  completeSetup: z.object({
    accountId,
    identity: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('new'), friendlyName: friendlyName.optional(), colourKey: colour, groupId: groupId.optional() }).strict(),
      z.object({ mode: z.literal('link'), identityId }).strict(),
    ]),
  }).strict(),
  logout: z.object({ accountId, acknowledgeExternal: z.boolean().optional() }).strict(),
  setLifecycle: z.object({ accountId, lifecycle: z.enum(['active', 'inactive', 'archived']), acknowledgeExternal: z.boolean().optional() }).strict(),
  updateIdentity: z.object({ identityId, friendlyName: friendlyName.nullable().optional(), colourKey: colour.optional(), groupId: groupId.nullable().optional() }).strict(),
  createGroup: z.object({ name: groupName }).strict(),
  renameGroup: z.object({ groupId, name: groupName }).strict(),
  group: z.object({ groupId }).strict(),
  link: z.object({ accountId, identityId }).strict(),
  resolveConflict: z.object({
    identityId,
    field: z.enum(['friendlyName', 'colourKey']),
    providerId,
    // A legacy record id (a Claude profile id): the registry's own rule.
    legacyId: z.string().max(80).refine((v) => isLegacyId(v)),
    keep: z.enum(['registry', 'legacy']),
  }).strict(),
  setReviewerDefault: z.object({ providerId, accountId: accountId.nullable() }).strict(),
} as const

const refusal = (code: AccountsFailure['code'], message: string): AccountsFailure => ({ ok: false, code, message })
const UNTRUSTED = refusal('untrusted-sender', 'That request was not accepted.')
const INVALID = refusal('invalid-request', 'That request was not valid.')
const UNAVAILABLE = refusal('registry-unavailable', 'The account list is not available right now.')
const INTERNAL = refusal('internal', 'That did not work; the app log has the detail.')

export function registerProviderAccountsHandlers(getWindow: () => BrowserWindow | null, getService: () => AccountsService | null): void {
  /** The app's own window, top frame only. */
  const trusted = (e: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    try {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      if (e.sender !== win.webContents) return false
      // The window's own main frame, by identity (not "a frame without a
      // parent", which a fenced frame's root also is).
      const frame = e.senderFrame
      return !!frame && frame === win.webContents.mainFrame
    } catch {
      return false
    }
  }

  // A renderer that goes away (closed, crashed) stops what it started.
  const watched = new Set<number>()
  const watch = (wc: WebContents, service: AccountsService) => {
    if (watched.has(wc.id)) return
    const id = wc.id
    watched.add(id)
    wc.once('destroyed', () => { watched.delete(id); service.releaseRenderer(id) })
    wc.on('render-process-gone', () => service.releaseRenderer(id))
  }

  // Changes go to the window as one coalesced snapshot.
  let subscribedTo: AccountsService | null = null
  let pending = false
  const push = () => {
    if (pending) return
    pending = true
    setImmediate(() => {
      pending = false
      const svc = getService()
      const win = getWindow()
      if (!svc || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
      try { win.webContents.send(IPC.PROVIDER_ACCOUNTS_CHANGED, svc.snapshot()) } catch (err) { logError('[provider-accounts] change push failed:', err) }
    })
  }
  const serviceFor = (e: IpcMainInvokeEvent | IpcMainEvent): AccountsService | null => {
    const svc = getService()
    if (!svc) return null
    if (subscribedTo !== svc) { subscribedTo = svc; svc.subscribe(push) }
    watch(e.sender, svc)
    return svc
  }

  /** One request/response channel: trusted sender, strict schema, service. */
  function handle<S extends z.ZodTypeAny>(channel: string, schema: S, fn: (input: z.infer<S>, svc: AccountsService, e: IpcMainInvokeEvent) => unknown): void {
    ipcMain.handle(channel, async (e, payload: unknown) => {
      if (!trusted(e)) return UNTRUSTED
      const parsed = schema.safeParse(payload)
      if (!parsed.success) return INVALID
      const svc = serviceFor(e)
      if (!svc) return UNAVAILABLE
      try {
        return await fn(parsed.data, svc, e)
      } catch (err) {
        // The error only: never the payload.
        logError(`[provider-accounts] ${channel} failed:`, err instanceof Error ? err.message : String(err))
        return INTERNAL
      }
    })
  }

  ipcMain.handle(IPC.PROVIDER_ACCOUNTS_SNAPSHOT, (e, payload: unknown) => {
    if (!trusted(e) || payload !== undefined) return null
    const svc = serviceFor(e)
    return svc ? svc.snapshot() : null
  })

  const S = PROVIDER_ACCOUNTS_SCHEMAS
  handle(IPC.PROVIDER_ACCOUNTS_DISCOVER, S.provider, (i, svc) => svc.discover(i.providerId))
  handle(IPC.PROVIDER_ACCOUNTS_INSTALL_RECIPES, S.provider, (i, svc) => svc.installRecipes(i.providerId))
  handle(IPC.PROVIDER_ACCOUNTS_SET_ENABLED, S.setEnabled, (i, svc) => svc.setProviderEnabled(i.providerId, i.enabled))
  handle(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, S.beginSetup, (i, svc) => svc.beginSetup(i))
  handle(IPC.PROVIDER_ACCOUNTS_ISSUE_SECRET_HANDLE, S.account, (i, svc, e) => svc.issueSecretHandle(i, e.sender.id))
  handle(IPC.PROVIDER_ACCOUNTS_SIGN_IN, S.signIn, (i, svc, e) => {
    const sender = e.sender
    return svc.signIn(i, sender.id, (text) => {
      if (!sender.isDestroyed()) sender.send(IPC.PROVIDER_ACCOUNTS_SIGN_IN_OUTPUT, { accountId: i.accountId, text })
    })
  })
  handle(IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, S.signIn, (i, svc, e) => {
    const sender = e.sender
    return svc.signInAgain(i, sender.id, (text) => {
      if (!sender.isDestroyed()) sender.send(IPC.PROVIDER_ACCOUNTS_SIGN_IN_OUTPUT, { accountId: i.accountId, text })
    })
  })
  handle(IPC.PROVIDER_ACCOUNTS_CANCEL_SIGN_IN, S.account, (i, svc, e) => svc.cancelSignIn(i, e.sender.id))
  handle(IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, S.completeSetup, (i, svc) => svc.completeSetup(i))
  handle(IPC.PROVIDER_ACCOUNTS_ABANDON_SETUP, S.account, (i, svc) => svc.abandonSetup(i))
  handle(IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, S.account, (i, svc) => svc.refreshStatus(i))
  handle(IPC.PROVIDER_ACCOUNTS_LOGOUT, S.logout, (i, svc) => svc.logout(i))
  handle(IPC.PROVIDER_ACCOUNTS_SET_LIFECYCLE, S.setLifecycle, (i, svc) => svc.setLifecycle(i))
  handle(IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, S.account, (i, svc) => svc.setDefault(i))
  handle(IPC.PROVIDER_ACCOUNTS_UPDATE_IDENTITY, S.updateIdentity, (i, svc) => svc.updateIdentity(i))
  handle(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, S.createGroup, (i, svc) => svc.createGroup(i))
  handle(IPC.PROVIDER_ACCOUNTS_RENAME_GROUP, S.renameGroup, (i, svc) => svc.renameGroup(i))
  handle(IPC.PROVIDER_ACCOUNTS_DELETE_GROUP, S.group, (i, svc) => svc.deleteGroup(i))
  handle(IPC.PROVIDER_ACCOUNTS_LINK_IDENTITY, S.link, (i, svc) => svc.linkIdentity(i))
  handle(IPC.PROVIDER_ACCOUNTS_UNLINK_IDENTITY, S.account, (i, svc) => svc.unlinkIdentity(i))
  handle(IPC.PROVIDER_ACCOUNTS_ADOPT_EXTERNAL, S.provider, (i, svc) => svc.adoptExternalDefault(i))
  handle(IPC.PROVIDER_ACCOUNTS_RUN_MIGRATION, S.provider, (i, svc) => svc.migrateExternalDefault(i.providerId))
  handle(IPC.PROVIDER_ACCOUNTS_RECONCILE_SIGN_IN, S.account, (i, svc) => svc.reconcileSignIn(i))
  handle(IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, S.resolveConflict, (i, svc) => svc.resolveIdentityConflict(i))
  handle(IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, S.setReviewerDefault, (i, svc) => svc.setReviewerDefault(i))

  // One-way: no reply, no log, nothing kept here. A malformed deposit is
  // simply not accepted; the sign-in then reports the key as not received.
  ipcMain.on(IPC.PROVIDER_ACCOUNTS_SECRET, (e, payload: unknown) => {
    if (!trusted(e)) return
    if (!payload || typeof payload !== 'object') return
    const svc = serviceFor(e)
    if (!svc) return
    const { handle, secret } = payload as { handle?: unknown; secret?: unknown }
    svc.depositSecret(handle, e.sender.id, secret)
  })
}
