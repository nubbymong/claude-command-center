import { describe, it, expect, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  readPeSubsystem,
  readPeSubsystemAt,
  classifySubsystem,
  classifyPeBuffer,
  sniffExecutableSubsystem,
  sniffExecutableSubsystemSync,
  clearSubsystemCache,
  PE_SUBSYSTEM_GUI,
  PE_SUBSYSTEM_CONSOLE,
} from '../../src/main/pe-subsystem'

// #379. The whole detection rests on one u16 at `e_lfanew + 0x5C`: 2 = a GUI
// program that will AttachConsole to our console and paint its log over the
// pane, 3 = an honest console program. There is no GUI-subsystem binary we can
// rely on existing in CI -- and shipping one to test against would be worse --
// so every fixture here is a PE header built byte by byte.

interface PeOptions {
  subsystem?: number
  peOffset?: number
  magic?: number
  signature?: string
  mz?: boolean
  sizeOfOptionalHeader?: number
  /** Stop the buffer this many bytes short of a complete header. */
  truncateTo?: number
}

/** A minimal but structurally honest PE image prefix. */
function buildPe(opts: PeOptions = {}): Buffer {
  const peOffset = opts.peOffset ?? 0x80
  const subsystem = opts.subsystem ?? PE_SUBSYSTEM_CONSOLE
  const magic = opts.magic ?? 0x10b // PE32
  const sizeOfOptionalHeader = opts.sizeOfOptionalHeader ?? 0xe0

  const buf = Buffer.alloc(peOffset + 0x100)

  // DOS header.
  if (opts.mz !== false) { buf[0] = 0x4d; buf[1] = 0x5a } // 'MZ'
  buf.writeUInt32LE(peOffset, 0x3c)

  // PE signature.
  const sig = opts.signature ?? 'PE\0\0'
  buf.write(sig, peOffset, 'binary')

  // COFF file header: Machine, NumberOfSections, ... SizeOfOptionalHeader at +0x14.
  buf.writeUInt16LE(0x8664, peOffset + 0x04) // Machine = AMD64
  buf.writeUInt16LE(sizeOfOptionalHeader, peOffset + 0x14)

  // Optional header.
  buf.writeUInt16LE(magic, peOffset + 0x18)
  buf.writeUInt16LE(subsystem, peOffset + 0x5c)

  return opts.truncateTo !== undefined ? buf.subarray(0, opts.truncateTo) : buf
}

describe('readPeSubsystem', () => {
  it('reads Subsystem = 2 (GUI) -- the value that means "this will bleed"', () => {
    expect(readPeSubsystem(buildPe({ subsystem: PE_SUBSYSTEM_GUI }))).toBe(2)
  })

  it('reads Subsystem = 3 (console) -- the safe case', () => {
    expect(readPeSubsystem(buildPe({ subsystem: PE_SUBSYSTEM_CONSOLE }))).toBe(3)
  })

  it('finds Subsystem at the SAME offset for PE32+ as for PE32', () => {
    // PE32+ drops BaseOfData (-4) and widens ImageBase (+4); the two cancel, so
    // e_lfanew + 0x5C serves both. If that ever stopped being true, a 64-bit GUI
    // tool -- which is most of them now -- would read as garbage.
    const pe32 = buildPe({ magic: 0x10b, subsystem: PE_SUBSYSTEM_GUI })
    const pe32plus = buildPe({ magic: 0x20b, subsystem: PE_SUBSYSTEM_GUI })
    expect(readPeSubsystem(pe32)).toBe(2)
    expect(readPeSubsystem(pe32plus)).toBe(2)
  })

  it('follows e_lfanew rather than assuming a fixed header offset', () => {
    for (const peOffset of [0x40, 0x80, 0xf8, 0x200, 0x400]) {
      const buf = buildPe({ peOffset, subsystem: PE_SUBSYSTEM_GUI })
      expect(readPeSubsystem(buf)).toBe(2)
    }
  })

  it('rejects a ROM image magic (0x107), whose layout puts nothing useful there', () => {
    expect(readPeSubsystem(buildPe({ magic: 0x107 }))).toBeNull()
  })

  it('rejects a file with no MZ signature', () => {
    expect(readPeSubsystem(buildPe({ mz: false }))).toBeNull()
  })

  it('rejects a file whose PE signature is not "PE\\0\\0"', () => {
    expect(readPeSubsystem(buildPe({ signature: 'NE\0\0' }))).toBeNull()
  })

  it('rejects a header that claims an optional header too small to hold Subsystem', () => {
    // 0x45 is one byte short of the 0x46 needed to reach and read the field.
    expect(readPeSubsystem(buildPe({ sizeOfOptionalHeader: 0x45 }))).toBeNull()
    expect(readPeSubsystem(buildPe({ sizeOfOptionalHeader: 0x46 }))).toBe(3)
    expect(readPeSubsystem(buildPe({ sizeOfOptionalHeader: 0 }))).toBeNull()
  })

  it('rejects an e_lfanew pointing past the end of the buffer instead of throwing', () => {
    const buf = buildPe()
    buf.writeUInt32LE(0xfffff, 0x3c)
    expect(() => readPeSubsystem(buf)).not.toThrow()
    expect(readPeSubsystem(buf)).toBeNull()
  })

  it('rejects an absurd e_lfanew (a 4 GB offset) before attempting any read', () => {
    const buf = buildPe()
    buf.writeUInt32LE(0xfffffff0, 0x3c)
    expect(readPeSubsystem(buf)).toBeNull()
  })

  it('rejects an e_lfanew that points back into the DOS header', () => {
    const buf = buildPe()
    buf.writeUInt32LE(0x10, 0x3c)
    expect(readPeSubsystem(buf)).toBeNull()
  })

  it('rejects a file truncated part-way through the header', () => {
    expect(readPeSubsystem(buildPe({ truncateTo: 0x80 + 0x30 }))).toBeNull()
    expect(readPeSubsystem(buildPe({ truncateTo: 4 }))).toBeNull()
    expect(readPeSubsystem(Buffer.alloc(0))).toBeNull()
  })

  it('rejects plain text and a shell script without throwing', () => {
    expect(readPeSubsystem(Buffer.from('#!/bin/sh\necho hi\n', 'utf8'))).toBeNull()
    expect(readPeSubsystem(Buffer.from('@echo off\r\nbambu-studio.exe %*\r\n', 'utf8'))).toBeNull()
  })

  it('rejects an ELF binary (a POSIX build sitting on a shared volume)', () => {
    const elf = Buffer.alloc(0x200)
    elf.write('\x7fELF', 0, 'binary')
    expect(readPeSubsystem(elf)).toBeNull()
  })
})

describe('readPeSubsystemAt', () => {
  it('reads a header window that does not start at file offset 0', () => {
    // The second-read path: a buffer holding only the PE header itself.
    const full = buildPe({ peOffset: 0x100, subsystem: PE_SUBSYSTEM_GUI })
    const window = full.subarray(0x100, 0x100 + 0x5e)
    expect(readPeSubsystemAt(window, 0)).toBe(2)
  })

  it('refuses a negative or non-integer offset', () => {
    const buf = buildPe()
    expect(readPeSubsystemAt(buf, -1)).toBeNull()
    expect(readPeSubsystemAt(buf, 1.5)).toBeNull()
  })
})

describe('classifySubsystem', () => {
  it('names the two values that matter and lumps the rest together', () => {
    expect(classifySubsystem(2)).toBe('gui')
    expect(classifySubsystem(3)).toBe('console')
    expect(classifySubsystem(null)).toBe('not-pe')
    // Native driver, EFI application, POSIX subsystem: not our problem, and
    // explicitly not to be treated as a GUI program.
    expect(classifySubsystem(1)).toBe('other')
    expect(classifySubsystem(10)).toBe('other')
    expect(classifySubsystem(0)).toBe('other')
  })
})

describe('classifyPeBuffer', () => {
  it('goes straight from bytes to a verdict', () => {
    expect(classifyPeBuffer(buildPe({ subsystem: PE_SUBSYSTEM_GUI }))).toBe('gui')
    expect(classifyPeBuffer(buildPe({ subsystem: PE_SUBSYSTEM_CONSOLE }))).toBe('console')
    expect(classifyPeBuffer(Buffer.from('not an exe'))).toBe('not-pe')
  })
})

describe('sniffExecutableSubsystem (real files, crafted contents)', () => {
  let dir: string

  beforeEach(() => {
    clearSubsystemCache()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pe-'))
  })

  const write = (name: string, buf: Buffer): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, buf)
    return p
  }

  it('classifies a GUI-subsystem file on disk', async () => {
    const p = write('gui.exe', buildPe({ subsystem: PE_SUBSYSTEM_GUI }))
    await expect(sniffExecutableSubsystem(p)).resolves.toBe('gui')
  })

  it('classifies a console-subsystem file on disk', async () => {
    const p = write('cli.exe', buildPe({ subsystem: PE_SUBSYSTEM_CONSOLE }))
    await expect(sniffExecutableSubsystem(p)).resolves.toBe('console')
  })

  it('reads a PE header that sits BEYOND the first read window', async () => {
    // A long DOS stub (or a packer) can push the PE header past 4 KiB. The
    // sniffer must do a second, targeted read rather than declaring not-pe.
    const p = write('far.exe', buildPe({ peOffset: 0x2000, subsystem: PE_SUBSYSTEM_GUI }))
    await expect(sniffExecutableSubsystem(p)).resolves.toBe('gui')
  })

  it('answers not-pe for a script, a directory and a missing file', async () => {
    const script = write('tool.cmd', Buffer.from('@echo off\r\n'))
    await expect(sniffExecutableSubsystem(script)).resolves.toBe('not-pe')
    await expect(sniffExecutableSubsystem(dir)).resolves.toBe('not-pe')
    await expect(sniffExecutableSubsystem(path.join(dir, 'nope.exe'))).resolves.toBe('not-pe')
    await expect(sniffExecutableSubsystem(write('empty.exe', Buffer.alloc(0)))).resolves.toBe('not-pe')
  })

  it('re-sniffs after the file changes rather than trusting a stale cache', async () => {
    const p = write('swap.exe', buildPe({ subsystem: PE_SUBSYSTEM_CONSOLE }))
    await expect(sniffExecutableSubsystem(p)).resolves.toBe('console')
    // Same path, different contents AND a different size, which is what the
    // cache key is built from -- an upgraded tool must not read as its old self.
    fs.writeFileSync(p, Buffer.concat([buildPe({ subsystem: PE_SUBSYSTEM_GUI }), Buffer.alloc(16)]))
    await expect(sniffExecutableSubsystem(p)).resolves.toBe('gui')
  })

  it('the sync variant agrees with the async one', () => {
    const gui = write('g.exe', buildPe({ subsystem: PE_SUBSYSTEM_GUI }))
    const cli = write('c.exe', buildPe({ subsystem: PE_SUBSYSTEM_CONSOLE }))
    expect(sniffExecutableSubsystemSync(gui)).toBe('gui')
    expect(sniffExecutableSubsystemSync(cli)).toBe('console')
    expect(sniffExecutableSubsystemSync(path.join(dir, 'gone.exe'))).toBe('not-pe')
  })
})
