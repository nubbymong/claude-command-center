// #209 desktop-chat import — IPC-boundary schemas.
//
// The handler seam (desktop-import-handlers.ts) was the one boundary the
// adversarial review found had ZERO tests, and it is where untrusted renderer
// input reaches fs / net / a subprocess. These pin the two size/shape bounds
// added in response: buildBrief's cumulative transcript ceiling (a shape-valid
// but gigantic transcript is a main-process OOM) and writeBrief's absolute-path
// requirement (a relative workingDirectory resolves against the main-process cwd,
// not the session's). Both schemas are exported for exactly this.
import { describe, it, expect } from 'vitest'

// The schemas live in their own electron-free module (desktop-import-schemas.ts)
// exactly so this boundary is testable without the handler's subprocess/electron
// import graph (#209 adversarial review).
import { transcriptSchema, writeBriefArgsSchema } from '../../src/main/ipc/desktop-import-schemas'
import { MAX_TRANSCRIPT_CHARS } from '../../src/shared/desktop-import'

function msg(text: string) {
  return { role: 'human' as const, text, codeBlocks: [] }
}
const baseTranscript = {
  source: 'paste' as const,
  messages: [msg('hello')],
  messageCount: 1,
  codeBlockCount: 0,
  charCount: 5,
  roleMarkersDetected: true,
  truncated: false,
}

describe('transcriptSchema cumulative size bound (#209 OOM guard)', () => {
  it('accepts a normal transcript', () => {
    expect(transcriptSchema.safeParse(baseTranscript).success).toBe(true)
  })

  it('rejects a shape-valid transcript whose cumulative text exceeds the ceiling', () => {
    // Two messages that are individually under the per-field cap but together
    // blow the cumulative ceiling. Mutation: drop the superRefine and this passes.
    const big = {
      ...baseTranscript,
      messages: [
        msg('a'.repeat(MAX_TRANSCRIPT_CHARS - 10)),
        msg('b'.repeat(1000)),
      ],
      messageCount: 2,
      charCount: 1, // lied — the schema must not trust this field
    }
    expect(transcriptSchema.safeParse(big).success).toBe(false)
  })

  it('rejects a single message text over the per-field cap', () => {
    const big = { ...baseTranscript, messages: [msg('a'.repeat(MAX_TRANSCRIPT_CHARS + 1))] }
    expect(transcriptSchema.safeParse(big).success).toBe(false)
  })

  it('rejects code-block content over the cumulative ceiling', () => {
    const big = {
      ...baseTranscript,
      messages: [{
        role: 'assistant' as const,
        text: 'x',
        codeBlocks: [{ lang: 'ts', code: 'z'.repeat(MAX_TRANSCRIPT_CHARS + 5) }],
      }],
    }
    expect(transcriptSchema.safeParse(big).success).toBe(false)
  })
})

describe('writeBriefArgsSchema absolute-path requirement (#209 wrong-root guard)', () => {
  const md = '# brief\n'

  it('accepts an absolute path', () => {
    const p = process.platform === 'win32' ? 'C:\\Users\\me\\proj' : '/home/me/proj'
    expect(writeBriefArgsSchema.safeParse({ workingDirectory: p, markdown: md }).success).toBe(true)
  })

  it('accepts a ~-anchored path (resolveCwd expands it to home)', () => {
    expect(writeBriefArgsSchema.safeParse({ workingDirectory: '~', markdown: md }).success).toBe(true)
    expect(writeBriefArgsSchema.safeParse({ workingDirectory: '~/proj', markdown: md }).success).toBe(true)
  })

  it('rejects a relative workingDirectory that would resolve against the main-process cwd', () => {
    // Mutation: drop the .refine and these pass. `..`/`src` are exactly the cases
    // the adversarial review flagged as writing into an unintended directory.
    for (const bad of ['..', 'src', 'foo/bar', '.', '']) {
      expect(writeBriefArgsSchema.safeParse({ workingDirectory: bad, markdown: md }).success).toBe(false)
    }
  })

  it('rejects markdown over the 4MB cap', () => {
    const p = process.platform === 'win32' ? 'C:\\x' : '/x'
    expect(writeBriefArgsSchema.safeParse({ workingDirectory: p, markdown: 'a'.repeat(4_000_001) }).success).toBe(false)
  })
})
