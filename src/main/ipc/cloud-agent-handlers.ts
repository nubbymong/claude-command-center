import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  initCloudAgentManager,
  cleanupStuckAgents,
  dispatchAgent,
  cancelAgent,
  removeAgent,
  retryAgent,
  listAgents,
  getAgentOutput,
  clearCompletedAgents,
} from '../cloud-agent-manager'
import { appWindowSender } from './trusted-sender'
import { isOpaqueId } from '../../shared/providers'
import { isValidProfileId } from '../../shared/profile-id'
import { CODEX_MODEL_MAX, CODEX_MODEL_RE, CODEX_EFFORTS } from '../sanitize-restored-spawn-options'

// WP2 PR 4, P4.5 (row 57): every request is answered only for the app's own
// window (its top frame), and what starts an agent is held to a strict
// schema: the provider, and an account of that provider's class -- a Claude
// Code agent names a profile (never a registry account id), a Codex agent an
// `acct-` registry account (never a profile), and neither carries the other's
// fields. A refused request is answered, never thrown.

/** What main answers a dispatch or retry it does not take. */
const REJECTED_UNTRUSTED = { rejected: 'This request did not come from the app window.' } as const
const REJECTED_INVALID = { rejected: 'That agent request was not valid.' } as const

const NAME_MAX = 500
/** The task is a prompt: a long one is allowed, an unbounded one is not. */
const DESCRIPTION_MAX = 2_000_000
/** The longest Windows path. */
const PATH_MAX = 32_767
const ID_MAX = 128

/** A Claude Code profile id, and never an id of the registry's own classes
 *  (the profile shape alone would also take an `acct-` id). */
const claudeProfileId = z.string().max(ID_MAX).refine((v) => isValidProfileId(v) && !isOpaqueId(v), 'not a Claude Code profile id')
/** A provider account of the registry's account class. */
const registryAccountId = z.string().max(ID_MAX).refine((v) => isOpaqueId(v, 'account'), 'not a registry account id')

export const dispatchSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  description: z.string().min(1).max(DESCRIPTION_MAX),
  projectPath: z.string().min(1).max(PATH_MAX),
  configId: z.string().min(1).max(ID_MAX).optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  // Claude Code only.
  profileId: claudeProfileId.optional(),
  legacyVersion: z.object({ enabled: z.boolean(), version: z.string().max(64) }).optional(),
  // Per run; each provider maps it (cloud-agent-manager.ts).
  skipPermissions: z.boolean().optional(),
  // Codex only.
  providerAccountId: registryAccountId.optional(),
  acknowledgeRealmOnly: z.literal(true).optional(),
  codexOptions: z.object({
    // The launch's own rules (pty-handlers' codexOptions): each becomes an argument.
    model: z.string().max(CODEX_MODEL_MAX).regex(CODEX_MODEL_RE).optional().or(z.literal('')),
    reasoningEffort: z.enum(CODEX_EFFORTS).optional(),
  }).strict().optional(),
}).strict().superRefine((p, ctx) => {
  const codex = p.provider === 'codex'
  const wrong = (field: string, why: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: why, path: [field] })
  if (codex) {
    if (p.profileId !== undefined) wrong('profileId', 'a Codex agent names a Codex account, not a profile')
    if (p.legacyVersion !== undefined) wrong('legacyVersion', 'a pinned CLI version is for Claude Code agents')
  } else {
    if (p.providerAccountId !== undefined) wrong('providerAccountId', 'a Claude Code agent names a profile, not a registry account')
    if (p.acknowledgeRealmOnly !== undefined) wrong('acknowledgeRealmOnly', 'for Codex agents only')
    if (p.codexOptions !== undefined) wrong('codexOptions', 'for Codex agents only')
  }
  // An acknowledgement counts only with the account it names.
  if (p.acknowledgeRealmOnly === true && p.providerAccountId === undefined) wrong('acknowledgeRealmOnly', 'an acknowledgement names its account')
})

const agentId = z.string().min(1).max(ID_MAX)
export const retryOptionsSchema = z.object({ acknowledgeRealmOnly: z.literal(true).optional() }).strict().optional()

export function registerCloudAgentHandlers(getWindow: () => BrowserWindow | null): void {
  initCloudAgentManager(getWindow)
  cleanupStuckAgents()
  /** The app's own window, top frame only (trusted-sender.ts). */
  const trusted = appWindowSender(getWindow)

  ipcMain.handle('cloudAgent:dispatch', async (event, params: unknown) => {
    if (!trusted(event)) return REJECTED_UNTRUSTED
    const parsed = dispatchSchema.safeParse(params)
    if (!parsed.success) return REJECTED_INVALID
    return dispatchAgent(parsed.data)
  })

  ipcMain.handle('cloudAgent:cancel', async (event, id: unknown) => {
    if (!trusted(event) || !agentId.safeParse(id).success) return false
    return cancelAgent(id as string)
  })

  ipcMain.handle('cloudAgent:remove', async (event, id: unknown) => {
    if (!trusted(event)) return { ok: false, removed: false, error: REJECTED_UNTRUSTED.rejected }
    if (!agentId.safeParse(id).success) return { ok: false, removed: false, error: REJECTED_INVALID.rejected }
    return removeAgent(id as string)
  })

  ipcMain.handle('cloudAgent:retry', async (event, id: unknown, opts: unknown) => {
    if (!trusted(event)) return REJECTED_UNTRUSTED
    const parsedOpts = retryOptionsSchema.safeParse(opts)
    if (!agentId.safeParse(id).success || !parsedOpts.success) return REJECTED_INVALID
    return retryAgent(id as string, parsedOpts.data ?? {})
  })

  ipcMain.handle('cloudAgent:list', async (event) => {
    if (!trusted(event)) return []
    return listAgents()
  })

  ipcMain.handle('cloudAgent:getOutput', async (event, id: unknown) => {
    if (!trusted(event) || !agentId.safeParse(id).success) return ''
    return getAgentOutput(id as string)
  })

  ipcMain.handle('cloudAgent:clearCompleted', async (event) => {
    if (!trusted(event)) return { ok: false, removed: 0, error: REJECTED_UNTRUSTED.rejected }
    return clearCompletedAgents()
  })
}
