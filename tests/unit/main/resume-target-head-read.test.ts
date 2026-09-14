import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveResumeTargetFromTranscript } from '../../../src/main/logging/transcript-discovery'

// #397 N2: the DEFAULT reader now reads only a bounded head, because enrichment
// runs on the main process on every debounced autosave and a full multi-MB sync
// read would stall all IPC. The cwd sits in the first entries, so a head read must
// still resolve it — even when a large tail follows.

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let dir = ''

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'rt-head-')) })
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('resolveResumeTargetFromTranscript — bounded head read (#397 N2)', () => {
  it('resolves cwd from the head with the DEFAULT reader, past a 5 MB tail', () => {
    const f = join(dir, `${uuid}.jsonl`)
    const head = JSON.stringify({ type: 'user', cwd: 'C:/proj/app' }) + '\n'
    writeFileSync(f, head + 'x'.repeat(5 * 1024 * 1024)) // huge non-JSON tail after the cwd line
    expect(resolveResumeTargetFromTranscript(f)).toEqual({ uuid, cwd: 'C:/proj/app' })
  })

  it('returns null (fail-safe) when the head carries no cwd line', () => {
    const f = join(dir, `${uuid}.jsonl`)
    writeFileSync(f, JSON.stringify({ type: 'summary' }) + '\n')
    expect(resolveResumeTargetFromTranscript(f)).toBeNull()
  })
})
