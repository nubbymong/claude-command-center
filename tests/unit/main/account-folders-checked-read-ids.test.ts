// readCheckedFile reads a file only when what it opened is the file the check
// saw, by device and file id, and only on a volume whose ids can tell two
// files apart. A volume that gives every file the same id -- no device number
// (0), no file number (0), or a file number of all ones (which Node's bigint
// stats read as -1) -- cannot, so a read there is refused rather than taken
// as the checked file. That matters most on Windows, where the open cannot
// refuse a link (no O_NOFOLLOW), so the id is the only test of the file.
//
// Host-safe: the file system is a fake; the open follows to another file, as
// it would after the checked name was replaced.
import { describe, it, expect } from 'vitest'
import { readCheckedFile, CheckedReadRefused } from '../../../src/main/account-folders'

const OTHER_FILE = 'the other file'

/** A file system whose open always lands on another file than the one checked,
 *  with the ids given; Windows' flags (no O_NOFOLLOW, no O_NONBLOCK). */
function filesOpeningAnother(id: { dev: bigint; ino: bigint }) {
  return {
    constants: { O_RDONLY: 0 },
    open: async () => {
      const body = Buffer.from(OTHER_FILE, 'utf8')
      return {
        stat: async () => ({ ...id, size: BigInt(body.length) }),
        read: async (buf: Buffer, off: number, len: number, pos: number) => ({ bytesRead: body.copy(buf, off, pos, pos + len) }),
        close: async () => {},
      }
    },
  } as never
}

const P = 'C:\\acct\\memory\\note.md'

describe('readCheckedFile: ids that cannot tell files apart are refused', () => {
  const cases: Array<[string, { dev: bigint; ino: bigint }]> = [
    ['no file number (0)', { dev: 7n, ino: 0n }],
    ['a file number of all ones, read signed (-1)', { dev: 7n, ino: -1n }],
    ['a file number of all ones, read unsigned', { dev: 7n, ino: (1n << 64n) - 1n }],
    ['no device number (0)', { dev: 0n, ino: 99n }],
  ]
  for (const [label, id] of cases) {
    it(`refuses a read when the volume gives ${label}, even though the ids match`, async () => {
      await expect(readCheckedFile(P, 4096, filesOpeningAnother(id), { expect: id })).rejects.toThrow(CheckedReadRefused)
    })
  }

  it('refuses when only the id the check saw is one that cannot tell files apart', async () => {
    await expect(readCheckedFile(P, 4096, filesOpeningAnother({ dev: 7n, ino: 99n }), { expect: { dev: 7n, ino: 0n } })).rejects.toThrow(CheckedReadRefused)
  })

  it('reads the file when the ids tell files apart and match', async () => {
    await expect(readCheckedFile(P, 4096, filesOpeningAnother({ dev: 7n, ino: 99n }), { expect: { dev: 7n, ino: 99n } })).resolves.toBe(OTHER_FILE)
  })

  it('refuses another file whose ids tell files apart', async () => {
    await expect(readCheckedFile(P, 4096, filesOpeningAnother({ dev: 7n, ino: 98n }), { expect: { dev: 7n, ino: 99n } })).rejects.toThrow(/changed/)
  })
})
