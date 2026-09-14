// Pasted-image intake for canvas review notes (item B, Ctrl+V).
//
// The pipeline downstream is the sketch-PNG one: base64 PNG over IPC, byte cap
// re-checked in main, file under the canvas dir, delivered to the agent as an
// MCP image block. This module's job is only to get from "whatever is on the
// clipboard" to a PNG that fits the cap — re-encoding through a canvas, which
// also strips any non-image payload a clipboard item may carry.

import { MAX_ATTACHMENT_PNG_BYTES } from '../../shared/canvas'

/** The image on a paste, if any — the first image item wins. */
export function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

/** Longest-side targets tried in order until the encoded PNG fits the cap.
 *  1600 keeps UI text readable; the lower rungs trade detail for fitting. */
export const PASTE_SCALE_LADDER: readonly number[] = [1600, 1100, 720]

export type PastedPngResult = { pngBase64: string } | { error: 'decode-failed' | 'too-large' }

/** One rung: render the blob to a PNG whose longest side is at most maxDim.
 *  DOM-dependent (createImageBitmap + canvas); kept thin so the ladder above it
 *  is testable with an injected exporter. */
export async function blobToPngBase64(blob: Blob, maxDim: number): Promise<{ base64: string; bytes: number }> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const cnv = document.createElement('canvas')
    cnv.width = w
    cnv.height = h
    const ctx = cnv.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const png: Blob = await new Promise((resolve, reject) =>
      cnv.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'),
    )
    const bytes = new Uint8Array(await png.arrayBuffer())
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    return { base64: btoa(binary), bytes: bytes.length }
  } finally {
    bitmap.close()
  }
}

/**
 * Convert a pasted image to a capped PNG, stepping down the ladder until it
 * fits. `decode-failed` on anything the browser cannot read as an image;
 * `too-large` only when even the smallest rung overruns the cap.
 */
export async function pastedImageToPng(
  blob: Blob,
  exporter: (blob: Blob, maxDim: number) => Promise<{ base64: string; bytes: number }> = blobToPngBase64,
): Promise<PastedPngResult> {
  for (const maxDim of PASTE_SCALE_LADDER) {
    let out: { base64: string; bytes: number }
    try {
      out = await exporter(blob, maxDim)
    } catch {
      return { error: 'decode-failed' }
    }
    if (out.bytes <= MAX_ATTACHMENT_PNG_BYTES) return { pngBase64: out.base64 }
  }
  return { error: 'too-large' }
}
