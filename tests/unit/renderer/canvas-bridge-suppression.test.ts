// @vitest-environment jsdom
// The ways a page could delete its own findings from ordinary markup.
//
// Every rule that says "do not report this" is a suppression primitive: what it
// covers produces nothing, and nothing downstream can tell an honest exemption
// from a forged one. Each needs a CONTROL — the same fixture without the
// suppressing attribute must produce the finding — or the test passes for the
// wrong reason.
//
// They are also, every one of them, accidental FALSE-NEGATIVE sources on markup
// nobody wrote adversarially: component libraries put `aria-disabled` on
// wrappers, `<a>` is `display: inline` by default, and card grids give their
// headings an ellipsis.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

const GREY = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'

async function nodeFor(markup: string, uxId = 'grey'): Promise<SnapshotNode | undefined> {
  document.body.innerHTML = markup
  const result = await captureSnapshot({ analysis: false })
  return flatten(result.root).find((n) => n.uxId === uxId)
}

async function rulesFor(markup: string, uxId = 'grey'): Promise<string[]> {
  return ((await nodeFor(markup, uxId))?.issues ?? []).map((i) => i.rule)
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('aria-disabled does not reach descendants; real disabled does', () => {
  // The distinction the whole rule now turns on. `disabled` is styled by the
  // user agent, so it really does grey a subtree. `aria-disabled` is a semantic
  // state with NO visual effect at all — the page decides what it looks like,
  // and usually that is nothing.

  it('reviews the contents of an <a aria-disabled>, which greys nothing', async () => {
    // Natural markup: a card wrapped in a link the app has marked unavailable.
    const rules = await rulesFor(
      `<a href="#x" aria-disabled="true" data-test-box="0,0,300,200">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p>
       </a>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('still exempts the aria-disabled element’s OWN text', async () => {
    // Narrowed, not deleted: a widget claiming to be disabled is claiming its
    // own text is inactive, and reporting that tells a reviewer to fix the
    // thing that works.
    const rules = await rulesFor(
      `<a href="#x" data-ux-id="grey" aria-disabled="true" data-test-box="0,0,120,32" style="${GREY}">Save</a>`,
    )
    expect(rules).not.toContain('color-contrast')
  })

  it.each(['fieldset', 'select', 'button'])('exempts a subtree under a really-disabled <%s>', async (tag) => {
    const inner =
      tag === 'select'
        ? `<option data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</option>`
        : `<span data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</span>`
    expect(await rulesFor(`<${tag} disabled data-test-box="0,0,300,200">${inner}</${tag}>`)).not.toContain('color-contrast')
  })

  it('ignores a `disabled` ATTRIBUTE on an element that cannot be disabled', async () => {
    // `disabled` on a `<div>` is not an IDL property and styles nothing — the
    // browser ignores it completely. Read with `hasAttribute` instead of the
    // property it would be a one-attribute, subtree-wide suppression primitive
    // on the commonest tag there is.
    const rules = await rulesFor(
      `<div disabled data-test-box="0,0,300,200"><p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p></div>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('reviews the same subtree when the ancestor is NOT disabled (the control)', async () => {
    const rules = await rulesFor(
      `<fieldset data-test-box="0,0,300,200"><span data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</span></fieldset>`,
    )
    expect(rules).toContain('color-contrast')
  })
})

describe('an <optgroup> only means anything inside a list', () => {
  it('reviews a subtree wrapped in a stray <optgroup>', async () => {
    // Two tags, no script: an `<optgroup>` outside a `<select>` renders its
    // contents perfectly normally, and it used to delete contrast review for
    // all of them at any depth of the ancestor chain.
    const rules = await rulesFor(
      `<optgroup data-test-box="0,0,300,200"><p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p></optgroup>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('reviews a stray <optgroup>’s OWN text', async () => {
    // The ancestor case above and this one take different branches: an
    // `<optgroup>` further up the chain is judged as an ancestor, but one that
    // owns the text is judged as the element itself. Both were unconditional.
    const rules = await rulesFor(
      `<optgroup data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</optgroup>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('reviews an <option> whose chain to a <select> is broken', async () => {
    // Built with the DOM rather than innerHTML on purpose: the parser reparents
    // anything invalid out of a `<select>`, so this shape only exists if it is
    // constructed — which page script does. Valid nesting is
    // option -> optgroup -> select and nothing else, so the climb stops at the
    // first thing that is not an optgroup; without that stop, a `<select>`
    // anywhere above exempts an `<option>` buried in unrelated markup.
    document.body.innerHTML = ''
    const select = document.createElement('select')
    select.setAttribute('data-test-box', '0,0,300,32')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-test-box', '0,0,300,32')
    const option = document.createElement('option')
    option.setAttribute('data-ux-id', 'grey')
    option.setAttribute('data-test-box', '0,0,300,20')
    option.setAttribute('style', GREY)
    option.textContent = 'Low contrast'
    wrapper.appendChild(option)
    select.appendChild(wrapper)
    document.body.appendChild(select)

    const result = await captureSnapshot({ analysis: false })
    const node = flatten(result.root).find((n) => n.uxId === 'grey')
    expect((node?.issues ?? []).map((i) => i.rule)).toContain('color-contrast')
  })

  it('still exempts a real <option> in a real <select>', async () => {
    // The UA paints these, not the page.
    const rules = await rulesFor(
      `<select data-test-box="0,0,300,32">
         <optgroup label="Group"><option data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</option></optgroup>
       </select>`,
    )
    expect(rules).not.toContain('color-contrast')
  })
})

describe('a <label> is exempt only when its control is actually greyed', () => {
  it('reviews a label whose disabled control is not rendered', async () => {
    // The exemption's justification is that the label is painted to match a
    // control the user can SEE. A `display: none` disabled input greys nothing,
    // and one of those plus a `<label for>` deleted review for a whole subtree.
    const rules = await rulesFor(
      `<input id="ctl" disabled style="display:none">
       <label for="ctl" data-test-box="0,0,300,200">
         <span data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</span>
       </label>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('still exempts a label whose disabled control IS rendered', async () => {
    const rules = await rulesFor(
      `<input id="ctl" disabled data-test-box="0,0,20,20">
       <label for="ctl" data-test-box="0,0,300,200">
         <span data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</span>
       </label>`,
    )
    expect(rules).not.toContain('color-contrast')
  })
})

describe('inert suppresses, and says that it did', () => {
  it('marks every node it covers', async () => {
    // It really does remove a subtree from the accessibility tree, so
    // withholding the finding is right. Withholding it SILENTLY is what made it
    // the last traceless suppression in the pass — the `aria-disabled` variants
    // at least emit `[disabled]`.
    const node = await nodeFor(
      `<div inert data-test-box="0,0,300,200">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p>
       </div>`,
    )
    expect((node?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
    expect(node?.state?.inert).toBe(true)
  })

  it('does not mark a node that is not inert (the control)', async () => {
    const node = await nodeFor(
      `<div data-test-box="0,0,300,200"><p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p></div>`,
    )
    expect(node?.state?.inert).toBeUndefined()
  })
})

describe('the overlap budget cannot be starved by descendants', () => {
  it('finds a genuine overlap behind sixty-four decoys', async () => {
    // An ancestor and its descendant overlap by definition and can never be a
    // finding, so charging the comparison budget for one meant a page could
    // spend it on boxes the rule was never going to report — and the rule then
    // went quiet for that node with nothing said anywhere. An icon grid inside
    // a card does this by accident.
    const decoys = Array.from(
      { length: 64 },
      (_, i) => `<span data-test-box="0,0,1,1" style="position:static">d${i}</span>`,
    ).join('')
    document.body.innerHTML = `
      <div data-ux-id="host" data-test-box="0,0,200,100" style="position:static">Host text${decoys}</div>
      <div data-ux-id="partner" data-test-box="50,10,200,100" style="position:static">Partner text</div>`
    const result = await captureSnapshot({ analysis: false })
    const host = flatten(result.root).find((n) => n.uxId === 'host')
    expect((host?.issues ?? []).map((i) => i.rule)).toContain('overlap')
  })

  it('still finds the overlap with no decoys at all (the control)', async () => {
    document.body.innerHTML = `
      <div data-ux-id="host" data-test-box="0,0,200,100" style="position:static">Host text</div>
      <div data-ux-id="partner" data-test-box="50,10,200,100" style="position:static">Partner text</div>`
    const result = await captureSnapshot({ analysis: false })
    const host = flatten(result.root).find((n) => n.uxId === 'host')
    expect((host?.issues ?? []).map((i) => i.rule)).toContain('overlap')
  })
})

describe('text-overflow: ellipsis excuses width, never height', () => {
  const CLIPPED_VERTICALLY = 'data-test-scroll="200,200,400,100"'
  const CLIPPED_HORIZONTALLY = 'data-test-scroll="400,200,100,100"'

  it('still reports vertical clipping on an element with an ellipsis', async () => {
    // `text-overflow` is a single-line property. It cannot put an ellipsis on
    // vertically clipped text and does nothing at all without `nowrap` — but it
    // was honoured for both axes, so on a card grid the heading truncated as
    // designed AND the body text disappearing under the fold went unreported.
    const rules = await rulesFor(
      `<div data-ux-id="grey" ${CLIPPED_VERTICALLY} data-test-box="0,0,200,100"
            style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">Body</div>`,
    )
    expect(rules).toContain('clipped-content')
  })

  it('still excuses width when the ellipsis can actually appear', async () => {
    const rules = await rulesFor(
      `<div data-ux-id="grey" ${CLIPPED_HORIZONTALLY} data-test-box="0,0,200,100"
            style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">Heading</div>`,
    )
    expect(rules).not.toContain('clipped-content')
  })

  it('reports width clipping when the ellipsis cannot appear (no nowrap)', async () => {
    const rules = await rulesFor(
      `<div data-ux-id="grey" ${CLIPPED_HORIZONTALLY} data-test-box="0,0,200,100"
            style="overflow:hidden; text-overflow:ellipsis">Heading</div>`,
    )
    expect(rules).toContain('clipped-content')
  })
})

describe('the inline target exemption is for targets in a sentence', () => {
  it('reports an icon-only link, whose display:inline is a default nobody chose', async () => {
    // `inline` is `<a>`'s default, so every icon-only link on every page was
    // exempt without the author doing anything — and every fixture in the
    // neighbouring suite hand-writes `display:inline-block`, so the suite opted
    // into the rule and never tested the default.
    const rules = await rulesFor(
      `<p data-test-box="0,0,300,20">
         <a href="#x" data-ux-id="grey" data-test-box="0,0,16,16"><svg data-test-box="0,0,16,16"></svg></a>
       </p>`,
    )
    expect(rules).toContain('target-size')
  })

  it('still exempts a text link in a run of text', async () => {
    const rules = await rulesFor(
      `<p data-test-box="0,0,300,20">Read the <a href="#x" data-ux-id="grey" data-test-box="0,0,60,16">terms</a> first</p>`,
    )
    expect(rules).not.toContain('target-size')
  })

  it('still exempts a text link whose text is in a child element', async () => {
    const rules = await rulesFor(
      `<p data-test-box="0,0,300,20">
         <a href="#x" data-ux-id="grey" data-test-box="0,0,60,16"><span data-test-box="0,0,60,16">terms</span></a>
       </p>`,
    )
    expect(rules).not.toContain('target-size')
  })
})
