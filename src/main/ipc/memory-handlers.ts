import { ipcMain } from 'electron'
import { z } from 'zod'
import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../memory-scanner'
import { validateMemoryPath } from '../utils/path-validator'
import { getLogSupervisor } from '../logging/logging-service'
import { IPC } from '../../shared/ipc-channels'

const filePathSchema = z.string().min(1).max(1000)
const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
})

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:scan', async () => {
    return scanLocalMemory()
  })

  ipcMain.handle('memory:read', async (_event, filePath: string) => {
    try {
      filePathSchema.parse(filePath)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const validPath = validateMemoryPath(filePath)
    return readMemoryContent(validPath)
  })

  ipcMain.handle('memory:delete', async (_event, filePath: string) => {
    try {
      filePathSchema.parse(filePath)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const validPath = validateMemoryPath(filePath, { destructive: true })
    await deleteMemoryFile(validPath)
  })

  ipcMain.handle('memory:writeFrontmatter', async (_event, filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => {
    try {
      filePathSchema.parse(filePath)
      frontmatterSchema.parse(frontmatter)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const validPath = validateMemoryPath(filePath, { destructive: true })
    await writeMemoryFrontmatter(validPath, frontmatter)
  })

  // Recent sessions for a project (Memory page sessions rail). Routed through
  // the log supervisor's forked worker — the transcripts DB is NEVER readable
  // from the main bundle. Fail-open: logging off / supervisor absent / query
  // error -> [] (the rail shows "no indexed sessions", never an error).
  const projectDirSchema = z.string().min(1).max(500)
  ipcMain.handle(IPC.MEMORY_RECENT_SESSIONS, async (_event, projectDir: unknown) => {
    let dir: string
    try { dir = projectDirSchema.parse(projectDir) } catch { return [] }
    try {
      const sup = getLogSupervisor()
      if (!sup) return []
      return await sup.query('recent-sessions', { projectDir: dir, limit: 5 })
    } catch { return [] }
  })
}
