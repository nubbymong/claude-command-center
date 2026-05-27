// src/main/channel-attachments.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { channelsDir } from './channel-storage'

// Persists a data URL (or raw base64) to conductor-channels/attachments/<id>.<ext>
// and returns the absolute path. CC reads files reliably; we never embed base64.
export function persistAttachment(dataUrl: string, ext: 'png' | 'txt'): string {
  const dir = join(channelsDir(), 'attachments')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const path = join(dir, `${Date.now().toString(36)}.${ext}`)
  writeFileSync(path, Buffer.from(base64, 'base64'))
  return path
}
