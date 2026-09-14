// Pasted-image intake (item B, Ctrl+V): clipboard pick + the scale ladder.
// The DOM exporter itself (createImageBitmap/canvas) is not under test — the
// ladder takes an injected exporter precisely so its policy is testable here.

import { describe, expect, it, vi } from 'vitest'
import {
  imageFileFromClipboard,
  pastedImageToPng,
  PASTE_SCALE_LADDER,
} from '../../../src/renderer/utils/canvasPasteImage'
import { MAX_ATTACHMENT_PNG_BYTES } from '../../../src/shared/canvas'

type Item = { kind: string; type: string; getAsFile: () => File | null }

function clipboard(items: Item[]): DataTransfer {
  return { items } as unknown as DataTransfer
}

function fileItem(type: string, file: File | null): Item {
  return { kind: 'file', type, getAsFile: () => file }
}

const png = new File(['x'], 'shot.png', { type: 'image/png' })
const jpeg = new File(['y'], 'shot.jpg', { type: 'image/jpeg' })

describe('imageFileFromClipboard', () => {
  it('returns null for a null DataTransfer and for an empty clipboard', () => {
    expect(imageFileFromClipboard(null)).toBeNull()
    expect(imageFileFromClipboard(clipboard([]))).toBeNull()
    expect(imageFileFromClipboard({} as unknown as DataTransfer)).toBeNull()
  })

  it('picks the first image item and ignores non-image items around it', () => {
    const data = clipboard([
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      fileItem('application/pdf', new File(['p'], 'doc.pdf', { type: 'application/pdf' })),
      fileItem('image/png', png),
      fileItem('image/jpeg', jpeg),
    ])
    expect(imageFileFromClipboard(data)).toBe(png)
  })

  it('skips an image item whose getAsFile returns null and takes the next', () => {
    const data = clipboard([fileItem('image/png', null), fileItem('image/jpeg', jpeg)])
    expect(imageFileFromClipboard(data)).toBe(jpeg)
  })

  it('returns null when only non-image items are present', () => {
    const data = clipboard([
      { kind: 'string', type: 'text/html', getAsFile: () => null },
      fileItem('text/plain', new File(['t'], 'a.txt', { type: 'text/plain' })),
    ])
    expect(imageFileFromClipboard(data)).toBeNull()
  })
})

describe('pastedImageToPng ladder', () => {
  const blob = new Blob(['img'], { type: 'image/png' })

  it('returns the first rung that fits without trying lower rungs', async () => {
    const exporter = vi.fn(async () => ({ base64: 'AAA', bytes: MAX_ATTACHMENT_PNG_BYTES }))
    const out = await pastedImageToPng(blob, exporter)
    expect(out).toEqual({ pngBase64: 'AAA' })
    expect(exporter).toHaveBeenCalledTimes(1)
    expect(exporter).toHaveBeenCalledWith(blob, PASTE_SCALE_LADDER[0])
  })

  it('falls through oversize rungs and returns the rung that fits', async () => {
    const exporter = vi.fn(async (_b: Blob, maxDim: number) =>
      maxDim > 720
        ? { base64: 'BIG', bytes: MAX_ATTACHMENT_PNG_BYTES + 1 }
        : { base64: 'FITS', bytes: 1024 },
    )
    const out = await pastedImageToPng(blob, exporter)
    expect(out).toEqual({ pngBase64: 'FITS' })
    expect(exporter.mock.calls.map((c) => c[1])).toEqual([...PASTE_SCALE_LADDER])
  })

  it('reports too-large only when every rung overruns the cap', async () => {
    const exporter = vi.fn(async () => ({ base64: 'BIG', bytes: MAX_ATTACHMENT_PNG_BYTES + 1 }))
    const out = await pastedImageToPng(blob, exporter)
    expect(out).toEqual({ error: 'too-large' })
    expect(exporter).toHaveBeenCalledTimes(PASTE_SCALE_LADDER.length)
  })

  it('reports decode-failed when the exporter throws (undecodable clipboard bytes)', async () => {
    const exporter = vi.fn(async () => {
      throw new Error('not an image')
    })
    const out = await pastedImageToPng(blob, exporter)
    expect(out).toEqual({ error: 'decode-failed' })
    expect(exporter).toHaveBeenCalledTimes(1)
  })
})
