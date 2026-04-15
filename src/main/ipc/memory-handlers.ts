import { ipcMain } from 'electron'
import { z } from 'zod'
import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../memory-scanner'
import { validateMemoryPath } from '../utils/path-validator'

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
    const validPath = validateMemoryPath(filePath)
    await deleteMemoryFile(validPath)
  })

  ipcMain.handle('memory:writeFrontmatter', async (_event, filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => {
    try {
      filePathSchema.parse(filePath)
      frontmatterSchema.parse(frontmatter)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const validPath = validateMemoryPath(filePath)
    await writeMemoryFrontmatter(validPath, frontmatter)
  })
}
