import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { spawnPty, writePty, resizePty, killPty, getSshFlow, SSHOptions } from '../pty-manager'
import { logUserInput, isDebugModeEnabled } from '../debug-capture'
import { logInfo } from '../debug-logger'
import { isVersionInstalled, installVersion } from '../legacy-version-manager'
import { loadCredential } from '../credential-store'
import { IPC } from '../../shared/ipc-channels'

/** SSH options as received from the renderer (no passwords — only configId) */
interface RendererSSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
  startClaudeAfter?: boolean
  dockerContainer?: string
  connectionFlow?: 'auto' | 'manual'
}

const sshSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  remotePath: z.string().min(1),
  postCommand: z.string().optional(),
  startClaudeAfter: z.boolean().optional(),
  dockerContainer: z.string().optional(),
  connectionFlow: z.enum(['auto', 'manual']).optional(),
}).optional()

const spawnOptionsSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  ssh: sshSchema,
  shellOnly: z.boolean().optional(),
  configId: z.string().optional(),
  configLabel: z.string().max(100).optional(),
  useResumePicker: z.boolean().optional(),
  legacyVersion: z.object({
    enabled: z.boolean(),
    version: z.string(),
  }).optional(),
  agentsConfig: z.array(z.object({
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })).optional(),
  flickerFree: z.boolean().optional(),
  powershellTool: z.boolean().optional(),
  effortLevel: z.enum(['low', 'medium', 'high']).optional(),
  disableAutoMemory: z.boolean().optional(),
}).optional()

const sessionIdSchema = z.string().min(1).max(200)

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', async (_event, sessionId: string, options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: RendererSSHOptions
    shellOnly?: boolean
    configId?: string
    configLabel?: string
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    flickerFree?: boolean
    powershellTool?: boolean
    effortLevel?: 'low' | 'medium' | 'high'
    disableAutoMemory?: boolean
  }) => {
    try {
      sessionIdSchema.parse(sessionId)
      spawnOptionsSchema.parse(options)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }

    const win = getWindow()
    if (!win) throw new Error('No window available')

    // Auto-install legacy version before spawn if needed
    if (options?.legacyVersion?.enabled && options.legacyVersion.version) {
      if (!isVersionInstalled(options.legacyVersion.version)) {
        logInfo(`[pty] Auto-installing legacy Claude CLI v${options.legacyVersion.version} before spawn`)
        const result = await installVersion(options.legacyVersion.version)
        if (!result.ok) {
          logInfo(`[pty] Legacy install failed, falling back to system claude: ${result.error}`)
        }
      }
    }

    // Resolve SSH credentials in the main process (never transit through renderer)
    let resolvedOptions = options
    if (options?.ssh && options.configId) {
      const password = loadCredential(options.configId) ?? undefined
      const sudoPassword = loadCredential(options.configId + '_sudo') ?? undefined
      const sshWithCreds: SSHOptions = {
        ...options.ssh,
        password,
        sudoPassword,
      }
      resolvedOptions = { ...options, ssh: sshWithCreds }
    }

    spawnPty(win, sessionId, resolvedOptions)
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    if (isDebugModeEnabled()) {
      logUserInput(sessionId, data, 'inputBar')
    }
    writePty(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.on('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId)
  })

  // SSH manual-flow controller — renderer drives stage transitions.
  ipcMain.handle(IPC.SSH_FLOW_RUN_POSTCOMMAND, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.runPostCommand()
  })

  ipcMain.handle(IPC.SSH_FLOW_LAUNCH_CLAUDE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.launchClaude()
  })

  ipcMain.handle(IPC.SSH_FLOW_SKIP, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.skip()
  })

  ipcMain.handle(IPC.SSH_FLOW_GET_STATE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    return getSshFlow(sessionId)?.getState() ?? { state: 'connecting' }
  })
}
