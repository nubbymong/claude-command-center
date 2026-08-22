import { describe, it, expect } from 'vitest'
import { readPeSubsystem } from '../../src/main/pe-subsystem'
// @ts-expect-error -- plain ESM helper for the verification script, no types.
import { readPeSubsystem as readPeSubsystemLite } from '../../scripts/lib/pe-subsystem-lite.mjs'

// #379. The issue asks for a 30-second verification against a real
// GUI-subsystem executable. It cannot run here: CI has no such binary, we are
// not shipping one, and half the result ("did text land on the terminal frame?")
// is only observable by a human watching the terminal. So it lives in
// `scripts/verify-console-bleed.mjs`, documented and skipped below, and what IS
// automatable is automated: the two copies of the header read must agree.

function buildPe(subsystem: number, peOffset = 0x80, magic = 0x10b): Buffer {
  const buf = Buffer.alloc(peOffset + 0x100)
  buf[0] = 0x4d; buf[1] = 0x5a
  buf.writeUInt32LE(peOffset, 0x3c)
  buf.write('PE\0\0', peOffset, 'binary')
  buf.writeUInt16LE(0xe0, peOffset + 0x14)
  buf.writeUInt16LE(magic, peOffset + 0x18)
  buf.writeUInt16LE(subsystem, peOffset + 0x5c)
  return buf
}

describe('the verification script’s PE reader matches the app’s', () => {
  // The script runs under bare node with no TypeScript step, so it carries its
  // own copy of the header read. Two copies drift; this is the thing that
  // notices.
  const cases: Array<[string, Buffer]> = [
    ['GUI PE32', buildPe(2)],
    ['GUI PE32+', buildPe(2, 0x80, 0x20b)],
    ['console PE32', buildPe(3)],
    ['console PE32+', buildPe(3, 0x100, 0x20b)],
    ['driver subsystem', buildPe(1)],
    ['far header', buildPe(2, 0x400)],
    ['text file', Buffer.from('@echo off\r\n')],
    ['empty', Buffer.alloc(0)],
    ['MZ but truncated', Buffer.from([0x4d, 0x5a, 0x00, 0x00])],
  ]

  for (const [name, buf] of cases) {
    it(`agrees on ${name}`, () => {
      expect(readPeSubsystemLite(buf)).toBe(readPeSubsystem(buf))
    })
  }
})

describe('MANUAL: the 30-second real-exe verification (#379)', () => {
  // Run it by hand on a machine with a Subsystem=2 tool, from a REAL terminal:
  //
  //   node scripts/verify-console-bleed.mjs "C:\path\to\bambu-studio.exe" \
  //        --debug 2 --zzz-not-a-flag
  //
  // Fixed looks like:
  //   1. DIRECT (parent HAS a console)  -> 0 bytes, banner smeared on the frame
  //   2. CONSOLE-LESS (no console)      -> ~5.6 KB captured, terminal clean
  //
  // Exit 0xFFFFFFFE (4294967294) is expected from that argument error and is a
  // good non-zero-exit case. If step 2 also reports 0 bytes, the fix is NOT
  // working on that machine and nothing below should be trusted.
  it.skip('captures ~5.6 KB from a console-less parent and 0 bytes from a console-owning one', () => {
    // Intentionally not implemented: see scripts/verify-console-bleed.mjs.
  })
})
