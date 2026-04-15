import { ipcMain, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getResourcesDirectory } from './setup-handlers'

interface NoteEntry {
  id: string
  label: string
  color: string
  configId?: string  // Links note to a session config (undefined = global)
  createdAt: number
}

function getNotesDir(): string {
  const dir = join(getResourcesDirectory(), 'secret_notes')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getIndexPath(): string {
  return join(getNotesDir(), 'index.json')
}

function loadIndex(): NoteEntry[] {
  try {
    const indexPath = getIndexPath()
    if (existsSync(indexPath)) {
      return JSON.parse(readFileSync(indexPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  return []
}

function saveIndex(entries: NoteEntry[]): void {
  writeFileSync(getIndexPath(), JSON.stringify(entries, null, 2))
}

export function registerNotesHandlers(): void {
  // List all notes (returns metadata only, no content)
  ipcMain.handle('notes:list', async () => {
    return loadIndex()
  })

  // Load and decrypt a single note's content
  ipcMain.handle('notes:load', async (_event, id: string) => {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const filePath = join(getNotesDir(), `${id}.enc`)
      if (!existsSync(filePath)) return null
      const encrypted = readFileSync(filePath)
      return safeStorage.decryptString(encrypted)
    } catch {
      return null
    }
  })

  // Save (create or update) a note — encrypts content
  ipcMain.handle('notes:save', async (_event, id: string, label: string, content: string, color: string, configId?: string) => {
    if (!safeStorage.isEncryptionAvailable()) return false
    try {
      const notesDir = getNotesDir()

      // Encrypt and write content
      const encrypted = safeStorage.encryptString(content)
      writeFileSync(join(notesDir, `${id}.enc`), encrypted)

      // Update index
      const index = loadIndex()
      const existing = index.findIndex(e => e.id === id)
      const entry: NoteEntry = { id, label, color, configId, createdAt: Date.now() }
      if (existing >= 0) {
        entry.createdAt = index[existing].createdAt // preserve original
        index[existing] = entry
      } else {
        index.push(entry)
      }
      saveIndex(index)
      return true
    } catch {
      return false
    }
  })

  // Delete a note
  ipcMain.handle('notes:delete', async (_event, id: string) => {
    try {
      const filePath = join(getNotesDir(), `${id}.enc`)
      if (existsSync(filePath)) unlinkSync(filePath)

      const index = loadIndex().filter(e => e.id !== id)
      saveIndex(index)
      return true
    } catch {
      return false
    }
  })

  // Reorder notes
  ipcMain.handle('notes:reorder', async (_event, ids: string[]) => {
    try {
      const index = loadIndex()
      const ordered: NoteEntry[] = []
      for (const id of ids) {
        const entry = index.find(e => e.id === id)
        if (entry) ordered.push(entry)
      }
      // Append any that weren't in the reorder list (shouldn't happen, but be safe)
      for (const entry of index) {
        if (!ordered.find(e => e.id === entry.id)) {
          ordered.push(entry)
        }
      }
      saveIndex(ordered)
      return true
    } catch {
      return false
    }
  })
}
