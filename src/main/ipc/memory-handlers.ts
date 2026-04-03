import { ipcMain } from 'electron'
import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../memory-scanner'

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:scan', async () => {
    return scanLocalMemory()
  })

  ipcMain.handle('memory:read', async (_event, filePath: string) => {
    return readMemoryContent(filePath)
  })

  ipcMain.handle('memory:delete', async (_event, filePath: string) => {
    await deleteMemoryFile(filePath)
  })

  ipcMain.handle('memory:writeFrontmatter', async (_event, filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => {
    await writeMemoryFrontmatter(filePath, frontmatter)
  })
}
