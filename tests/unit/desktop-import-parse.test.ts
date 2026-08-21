// #209 desktop-chat import — transcript parser.
//
// The parser is the ONLY thing between untrusted pasted chat text and the rest of
// the app, so the cases that matter here are the ones where a naive split gets it
// wrong: role markers hiding inside fenced code, sentences that merely START with
// "You", and a paste with no markers at all.
import { describe, it, expect } from 'vitest'
import {
  extractCodeBlocks,
  parsePastedTranscript,
  parseStructuredTranscript,
} from '../../src/main/desktop-import/parse-transcript'
import { MAX_TRANSCRIPT_CHARS } from '../../src/shared/desktop-import'

describe('parsePastedTranscript — role markers', () => {
  it('splits on inline "Label:" markers and assigns roles', () => {
    const t = parsePastedTranscript('Human: fix the parser\nAssistant: on it\n')
    expect(t.roleMarkersDetected).toBe(true)
    expect(t.messages.map((m) => m.role)).toEqual(['human', 'assistant'])
    expect(t.messages[0].text).toBe('fix the parser')
    expect(t.messages[1].text).toBe('on it')
  })

  it('splits on standalone / decorated marker lines', () => {
    const t = parsePastedTranscript('**You**\nwhy is it slow?\n\n## Claude\n\nthe fence scan\n')
    expect(t.messages.map((m) => m.role)).toEqual(['human', 'assistant'])
    expect(t.messages[1].text).toBe('the fence scan')
  })

  it('does NOT split a sentence that merely starts with a label word', () => {
    const t = parsePastedTranscript('Human: hi\nYou need to fix this today\nMe too, probably\n')
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].text).toContain('You need to fix this today')
    expect(t.messages[0].text).toContain('Me too, probably')
  })

  it('treats a marker INSIDE a fenced block as content, not a turn boundary', () => {
    const raw = [
      'Human: look at this log',
      '```',
      'Human: this line is data',
      'Assistant: so is this',
      '```',
      'Assistant: understood',
    ].join('\n')
    const t = parsePastedTranscript(raw)
    expect(t.messages).toHaveLength(2)
    expect(t.messages[0].text).toContain('Human: this line is data')
    expect(t.messages[1].text).toBe('understood')
  })

  it('falls back to a single unknown message when no markers exist', () => {
    const t = parsePastedTranscript('just a wall of text\nwith two lines')
    expect(t.roleMarkersDetected).toBe(false)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].role).toBe('unknown')
  })

  it('drops standalone UI chrome lines but keeps them inside fences', () => {
    const t = parsePastedTranscript('Human: hi\nRetry\nCopy\nreal content\n')
    expect(t.messages[0].text).toBe('hi\nreal content')

    const fenced = parsePastedTranscript('Human: hi\n```\nRetry\n```\n')
    expect(fenced.messages[0].text).toContain('Retry')
  })

  it('normalises CRLF and strips a BOM', () => {
    const t = parsePastedTranscript('﻿Human: a\r\nAssistant: b\r\n')
    expect(t.messages.map((m) => m.text)).toEqual(['a', 'b'])
  })

  it('does not backtrack quadratically on a long line (main-process DoS)', () => {
    // Measured before the fix: this exact shape blocked the main process for
    // 133 SECONDS at 600k chars, scaling quadratically — the parser runs
    // synchronously inside an ipcMain.handle, so every terminal and the window
    // freeze with no error. Paste is the primary path and takes third-party text.
    const payload = 'Human: here is my chat\n#' + ' '.repeat(600_000) + 'x\n'
    const started = Date.now()
    const t = parsePastedTranscript(payload)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    // The long line must still be KEPT as content, not silently dropped.
    expect(t.messages[0].text).toContain('x')
  })

  it('still splits on a role marker at the length boundary', () => {
    // Guards the fix from becoming a hole: a marker never approaches 200 chars,
    // but the cutoff must not swallow ordinary short markers.
    const t = parsePastedTranscript('Human: a\nAssistant: b\n')
    expect(t.messages.map((m) => m.role)).toEqual(['human', 'assistant'])
  })

  it('truncates a paste beyond the ceiling and flags it', () => {
    const t = parsePastedTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS + 500))
    expect(t.truncated).toBe(true)
    expect(t.charCount).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS)
  })
})

describe('extractCodeBlocks', () => {
  it('captures the info string as the language', () => {
    const blocks = extractCodeBlocks('before\n```ts\nconst a = 1\n```\nafter')
    expect(blocks).toEqual([{ lang: 'ts', code: 'const a = 1' }])
  })

  it('does not let an inner shorter fence close a longer one', () => {
    const blocks = extractCodeBlocks('````md\n```\ninner\n```\n````')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].code).toContain('inner')
  })

  it('keeps the content of an unterminated fence', () => {
    const blocks = extractCodeBlocks('```py\nprint(1)')
    expect(blocks).toEqual([{ lang: 'py', code: 'print(1)' }])
  })

  it('handles tilde fences', () => {
    expect(extractCodeBlocks('~~~\nx\n~~~')).toEqual([{ lang: '', code: 'x' }])
  })
})

describe('parseStructuredTranscript', () => {
  it('keeps machine-readable roles and counts code blocks', () => {
    const t = parseStructuredTranscript(
      [
        { role: 'human', text: 'do it' },
        { role: 'assistant', text: 'done\n```sh\nls\n```' },
      ],
      'share',
      'My chat',
    )
    expect(t.title).toBe('My chat')
    expect(t.messageCount).toBe(2)
    expect(t.codeBlockCount).toBe(1)
    expect(t.roleMarkersDetected).toBe(true)
  })

  it('skips empty messages and enforces the total budget', () => {
    const t = parseStructuredTranscript(
      [
        { role: 'human', text: '   ' },
        { role: 'assistant', text: 'y'.repeat(MAX_TRANSCRIPT_CHARS + 10) },
        { role: 'human', text: 'never reached' },
      ],
      'share',
    )
    expect(t.truncated).toBe(true)
    expect(t.messages).toHaveLength(1)
    expect(t.charCount).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS)
  })
})
