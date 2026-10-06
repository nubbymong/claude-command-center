import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod'
import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../memory-scanner'
import { AccountPathRefused, validateMemoryPath } from '../utils/path-validator'
import { getLogSupervisor } from '../logging/logging-service'
import { IPC } from '../../shared/ipc-channels'
import { ACCOUNT_MEMORY_DELETE_SHOWN, MEMORY_PATH_MAX } from '../../shared/account-memories'
import type { MemoryScanWithAccounts } from '../../shared/account-memories'
import { appWindowSender } from './trusted-sender'
import { realAccountFileFs } from '../account-folders'
import type { AccountFileFs, AccountFolderSet, AccountFoldersSource } from '../account-folders'
import { deleteAccountMemory, isUnderAccountMemories, readAccountMemory, scanAccountMemories } from '../account-memories'

const filePathSchema = z.string().min(1).max(MEMORY_PATH_MAX)
const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
})

/** WP2 PR 4, P4.4 (row 55). All optional: without them the channels serve
 *  Claude's store exactly as before.
 *  - `getWindow`: every memory channel then answers only the app's own
 *    window, its main frame (trusted-sender.ts), before any argument is read.
 *  - `accountFolders`: each live account's own folders (the accounts
 *    service), asked afresh per request; memory:scan then lists each
 *    account's memories, and memory:read and memory:delete take a path inside
 *    an account's memories folder through validateAccountMemoryPath (never
 *    `.git`, never through a link; memory:delete refuses it while
 *    ACCOUNT_MEMORY_DELETE_SHOWN is false). memory:writeFrontmatter stays
 *    Claude's.
 *  - `accountFs`, `platform`: test seams. */
export interface MemoryHandlerDeps {
  getWindow?: () => BrowserWindow | null
  accountFolders?: AccountFoldersSource
  accountFs?: AccountFileFs
  platform?: NodeJS.Platform
}

/** Claude's store, by spelling (validateMemoryPath then checks it for real). */
function underClaudeProjects(filePath: string): boolean {
  const root = path.resolve(path.join(os.homedir(), '.claude', 'projects'))
  const resolved = path.resolve(filePath)
  return resolved === root || resolved.startsWith(root + path.sep)
}

export function registerMemoryHandlers(deps: MemoryHandlerDeps = {}): void {
  const trusted = deps.getWindow ? appWindowSender(deps.getWindow) : null
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (trusted && !trusted(e)) throw new Error('That request was not accepted.')
      return fn(e, ...args)
    })
  }
  const accountDeps = () => ({ fs: deps.accountFs ?? realAccountFileFs, platform: deps.platform ?? process.platform })
  const foldersNow = async (): Promise<readonly AccountFolderSet[] | null> => {
    if (!deps.accountFolders) return null
    try { return await deps.accountFolders() } catch { return null }
  }
  /** The account folders when `filePath` is inside one of their memories
   *  folders, else null (Claude's branch). */
  const accountBranch = async (filePath: string): Promise<readonly AccountFolderSet[] | null> => {
    if (!deps.accountFolders || underClaudeProjects(filePath)) return null
    const sets = await foldersNow()
    return sets && isUnderAccountMemories(filePath, sets, accountDeps().platform) ? sets : null
  }

  handle('memory:scan', async () => {
    const result: MemoryScanWithAccounts = await scanLocalMemory()
    if (deps.accountFolders) {
      try {
        result.accountMemories = await scanAccountMemories(await foldersNow(), accountDeps())
      } catch {
        result.accountMemories = []
      }
    }
    return result
  })

  handle('memory:read', async (_event, filePath: string) => {
    try {
      filePathSchema.parse(filePath)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sets = await accountBranch(filePath)
    if (sets) return readAccountMemory(filePath, sets, accountDeps())
    const validPath = validateMemoryPath(filePath)
    return readMemoryContent(validPath)
  })

  handle('memory:delete', async (_event, filePath: string) => {
    try {
      filePathSchema.parse(filePath)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sets = await accountBranch(filePath)
    if (sets) {
      // Not offered until P4.4's VM check, and refused here too, before any
      // file call: no caller deletes in an account's memories folder first.
      if (!ACCOUNT_MEMORY_DELETE_SHOWN) throw new AccountPathRefused('refused', 'deleting an account memory is not offered yet')
      await deleteAccountMemory(filePath, sets, accountDeps())
      return
    }
    const validPath = validateMemoryPath(filePath, { destructive: true })
    await deleteMemoryFile(validPath)
  })

  handle('memory:writeFrontmatter', async (_event, filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => {
    try {
      filePathSchema.parse(filePath)
      frontmatterSchema.parse(frontmatter)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Claude's store only: an account's memory files carry a heading, not
    // frontmatter (P4.4), so validateMemoryPath refuses their paths.
    const validPath = validateMemoryPath(filePath, { destructive: true })
    await writeMemoryFrontmatter(validPath, frontmatter)
  })

  // Recent sessions for a project (Memory page sessions rail). Routed through
  // the log supervisor's forked worker — the transcripts DB is NEVER readable
  // from the main bundle. Fail-open: logging off / supervisor absent / query
  // error -> [] (the rail shows "no indexed sessions", never an error).
  const projectDirSchema = z.string().min(1).max(500)
  handle(IPC.MEMORY_RECENT_SESSIONS, async (_event, projectDir: unknown) => {
    let dir: string
    try { dir = projectDirSchema.parse(projectDir) } catch { return [] }
    try {
      const sup = getLogSupervisor()
      if (!sup) return []
      return await sup.query('recent-sessions', { projectDir: dir, limit: 5 })
    } catch { return [] }
  })
}
