// #209 desktop-chat import — share-page extraction.
//
// claude.ai's share payload is not a published API, so the extractor is
// deliberately shape-tolerant: it hunts for a message-shaped array anywhere in
// any embedded JSON blob. These tests pin that tolerance AND the refusal — a page
// with no recognisable messages must throw and point at the paste path, never
// return a half-read conversation.
import { describe, it, expect, vi } from 'vitest'

const netRequest = vi.fn()
vi.mock('electron', () => ({ net: { request: netRequest } }))

const {
  extractJsonCandidates,
  fetchText,
  findMessageList,
  findTitle,
  isShareUrl,
  looksSignedOut,
  parseSharePage,
  shareUuid,
  textOf,
} = await import('../../src/main/desktop-import/share-link')
const { CLAUDE_WEB_PARTITION } = await import('../../src/shared/desktop-import')

const UUID = '11111111-2222-3333-4444-555555555555'

describe('share URL validation', () => {
  it('accepts only the canonical share form', () => {
    expect(isShareUrl(`https://claude.ai/share/${UUID}`)).toBe(true)
    expect(shareUuid(` https://claude.ai/share/${UUID} `)).toBe(UUID)
  })

  it('rejects other hosts, paths, and schemes', () => {
    for (const bad of [
      `http://claude.ai/share/${UUID}`,
      `https://evil.example/share/${UUID}`,
      `https://claude.ai/chat/${UUID}`,
      `https://claude.ai/share/${UUID}?x=1`,
      'https://claude.ai/share/not-a-uuid',
    ]) {
      expect(isShareUrl(bad)).toBe(false)
      expect(shareUuid(bad)).toBeNull()
    }
  })
})

describe('textOf', () => {
  it('reads a plain string field', () => {
    expect(textOf({ text: 'hello' })).toBe('hello')
  })

  it('joins text blocks and ignores non-text ones', () => {
    expect(
      textOf({
        content: [
          { type: 'text', text: 'one' },
          { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\n\ntwo')
  })

  it('returns empty when there is nothing readable', () => {
    expect(textOf({ content: [{ type: 'thinking' }] })).toBe('')
  })
})

describe('findMessageList', () => {
  it('finds a message array nested anywhere and maps sender to role', () => {
    const found = findMessageList({
      a: { b: [{ props: {} }] },
      deep: { conv: { chat_messages: [
        { sender: 'human', text: 'q' },
        { sender: 'assistant', content: [{ type: 'text', text: 'a' }] },
      ] } },
    })
    expect(found).toEqual([
      { role: 'human', text: 'q' },
      { role: 'assistant', text: 'a' },
    ])
  })

  it('prefers the longest message-shaped array', () => {
    const found = findMessageList({
      short: [{ role: 'human', text: 'x' }],
      long: [
        { role: 'human', text: 'x' },
        { role: 'assistant', text: 'y' },
        { role: 'human', text: 'z' },
      ],
    })
    expect(found).toHaveLength(3)
  })

  it('ignores arrays that are not message-shaped', () => {
    expect(findMessageList({ items: [{ id: 1 }, { id: 2 }] })).toBeNull()
    expect(findMessageList({ items: [{ sender: 'human' }] })).toBeNull()
  })
})

describe('findTitle', () => {
  it('takes the name off the object that owns the messages', () => {
    expect(findTitle({ wrapper: { name: 'Parser work', chat_messages: [{ sender: 'human', text: 'x' }] } }))
      .toBe('Parser work')
  })
})

describe('parseSharePage', () => {
  const messages = [
    { sender: 'human', text: 'why is the fence scan line-based?' },
    { sender: 'assistant', text: 'because markers hide inside fences' },
  ]

  it('reads an application/json script block', () => {
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { conv: { name: 'Fences', chat_messages: messages } },
    })}</script></html>`
    const t = parseSharePage(html)
    expect(t.source).toBe('share')
    expect(t.title).toBe('Fences')
    expect(t.messages.map((m) => m.role)).toEqual(['human', 'assistant'])
  })

  it('reads a streamed self.__next_f.push chunk', () => {
    const payload = JSON.stringify({ chat_messages: messages })
    const html = `<script>self.__next_f.push([1,${JSON.stringify(`3:${payload}`)}])</script>`
    const t = parseSharePage(html)
    expect(t.messageCount).toBe(2)
  })

  it('throws and points at the paste path when nothing is recognisable', () => {
    expect(() => parseSharePage('<html><body>nothing useful here</body></html>')).toThrow(/Paste tab/)
  })
})

describe('the share fetch runs on the claude.ai partition, not the default session', () => {
  // A bare net.request runs on the DEFAULT session, which holds no claude.ai
  // cookies, so it can only ever fetch a world-readable link. Naming the
  // partition is half of it -- Electron does not attach that partition's cookies
  // without useSessionCookies -- so both are asserted.
  //
  // Nothing populates this partition today: the embedded sign-in window was
  // removed because it cannot complete SSO in a managed environment. #216 fills
  // it from a system-browser handoff, and when it does, org-scoped shares start
  // working through this same code path with no change here.
  it('names the claude.ai import partition and sends its cookies', () => {
    netRequest.mockReturnValue({ on: vi.fn(), end: vi.fn(), abort: vi.fn() })
    void fetchText('https://claude.ai/share/' + UUID)

    expect(netRequest).toHaveBeenCalledTimes(1)
    const opts = netRequest.mock.calls[0][0]
    expect(opts.partition).toBe(CLAUDE_WEB_PARTITION)
    expect(opts.useSessionCookies).toBe(true)
  })

  it('pins the partition name #216 will populate', () => {
    expect(CLAUDE_WEB_PARTITION).toBe('persist:claude-web-import')
  })
})


describe('looksSignedOut', () => {
  it('recognises a login shell', () => {
    expect(looksSignedOut('<a href="/login">Sign in to Claude</a>')).toBe(true)
    expect(looksSignedOut('window.location = "/sign-in"')).toBe(true)
  })

  it('does not fire on ordinary conversation prose', () => {
    expect(looksSignedOut('we discussed how to sign in users with magic links')).toBe(false)
    expect(looksSignedOut('<html><body>nothing useful here</body></html>')).toBe(false)
  })
})
