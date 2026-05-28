// src/main/channel-attachments.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { channelsDir } from './channel-storage'

// 2 MB decoded cap -- allows base64 overhead over the spec's 1 MB post-encode image limit.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

// Persists a data URL (or raw base64) to conductor-channels/attachments/<id>.<ext>
// and returns the absolute path. CC reads files reliably; we never embed base64.
export function persistAttachment(dataUrl: string, ext: 'png' | 'txt'): string {
  const dir = join(channelsDir(), 'attachments')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment exceeds size cap')
  const path = join(dir, `${Date.now().toString(36)}.${ext}`)
  writeFileSync(path, buffer)
  return path
}
