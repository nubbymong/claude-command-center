import { describe, it, expect } from 'vitest'
import { serializeSnapshot } from '../../../src/shared/canvas-snapshot-serialize'
import type { SemanticSnapshot, SnapshotNode } from '../../../src/shared/canvas'

function node(partial: Partial<SnapshotNode> & Pick<SnapshotNode, 'ref'>): SnapshotNode {
  return {
    role: '',
    name: '',
    box: { x: 0, y: 0, width: 0, height: 0 },
    children: [],
    ...partial,
  }
}

function snap(root: SnapshotNode): SemanticSnapshot {
  return { versionId: 'v3', capturedAt: '2026-08-11T00:00:00Z', viewport: { width: 1440, height: 900, dpr: 2 }, root }
}

describe('serializeSnapshot — compact text (§4.1)', () => {
  it('renders the spec example shape: role, name, ref, ux, box, and an indented issue', () => {
    const s = snap(
      node({
        ref: 'e0',
        role: 'document',
        name: 'Settings',
        box: { x: 0, y: 0, width: 1440, height: 2000 },
        children: [
          node({
            ref: 'e12',
            role: 'button',
            name: 'Save',
            uxId: 'settings-save',
            box: { x: 840, y: 512, width: 64, height: 28 },
            issues: [{ rule: 'target-size', severity: 'serious', measured: '28px', needed: '44px' }],
          }),
        ],
      }),
    )
    expect(serializeSnapshot(s)).toBe(
      [
        'snapshot v3  viewport=1440x900 dpr=2',
        '- document "Settings" [ref=e0] [box=0,0,1440,2000]',
        '  - button "Save" [ref=e12] [ux=settings-save] [box=840,512,64,28]',
        '    - issue: target-size 28px, needs 44px',
      ].join('\n'),
    )
  })

  it('nests children with 2-space indentation per depth', () => {
    const s = snap(
      node({
        ref: 'e0',
        role: 'main',
        children: [node({ ref: 'e1', role: 'list', children: [node({ ref: 'e2', role: 'listitem', name: 'One' })] })],
      }),
    )
    const lines = serializeSnapshot(s).split('\n')
    expect(lines[1]).toBe('- main [ref=e0] [box=0,0,0,0]')
    expect(lines[2]).toBe('  - list [ref=e1] [box=0,0,0,0]')
    expect(lines[3]).toBe('    - listitem "One" [ref=e2] [box=0,0,0,0]')
  })

  it('rounds box coordinates to integers', () => {
    const s = snap(node({ ref: 'e0', role: 'img', box: { x: 12.4, y: 8.9, width: 63.5, height: 27.51 } }))
    expect(serializeSnapshot(s)).toContain('[box=12,9,64,28]')
  })

  it('omits role and name when empty', () => {
    const s = snap(node({ ref: 'e0', box: { x: 1, y: 2, width: 3, height: 4 } }))
    expect(serializeSnapshot(s).split('\n')[1]).toBe('- [ref=e0] [box=1,2,3,4]')
  })
})

describe('form-state semantics (HARD P2 requirement)', () => {
  it('renders type / checked / disabled / value / aria-invalid / opacity tokens', () => {
    const s = snap(
      node({
        ref: 'e5',
        role: 'checkbox',
        name: 'Enable',
        box: { x: 0, y: 0, width: 16, height: 16 },
        state: { type: 'checkbox', checked: true, disabled: true, ariaInvalid: true, opacity: 0.3 },
      }),
    )
    const line = serializeSnapshot(s).split('\n')[1]
    expect(line).toBe('- checkbox "Enable" [ref=e5] [box=0,0,16,16] [type=checkbox] [checked] [disabled] [aria-invalid] [opacity=0.3]')
  })

  it('shows a text input value but omits checked/disabled/aria-invalid when false, and opacity when 1', () => {
    const s = snap(
      node({
        ref: 'e6',
        role: 'textbox',
        box: { x: 0, y: 0, width: 200, height: 32 },
        state: { type: 'text', value: 'hello', checked: false, disabled: false, ariaInvalid: false, opacity: 1 },
      }),
    )
    const line = serializeSnapshot(s).split('\n')[1]
    expect(line).toBe('- textbox [ref=e6] [box=0,0,200,32] [type=text] [value="hello"]')
  })

  it('marks screen-reader-only nodes so a hidden label never reads as broken text', () => {
    const s = snap(
      node({
        ref: 'e7',
        name: 'Skip to content',
        box: { x: 0, y: 0, width: 1, height: 1 },
        state: { srOnly: true },
      }),
    )
    expect(serializeSnapshot(s).split('\n')[1]).toBe('- "Skip to content" [ref=e7] [box=0,0,1,1] [sr-only]')
  })
})

describe('styles (scoped-only, token economy)', () => {
  it('renders curated styles inline in a stable sorted order, only when present', () => {
    const s = snap(
      node({
        ref: 'e0',
        role: 'button',
        name: 'Pro',
        box: { x: 0, y: 0, width: 80, height: 40 },
        styles: { color: '#8a8a8a', background: 'linear-gradient(#111,#333)', 'font-size': '14px' },
      }),
    )
    expect(serializeSnapshot(s).split('\n')[1]).toBe(
      '- button "Pro" [ref=e0] [box=0,0,80,40] [background=linear-gradient(#111,#333)] [color=#8a8a8a] [font-size=14px]',
    )
  })

  it('a scoped (styled) snapshot is larger than the same tree without styles', () => {
    const bare = node({ ref: 'e0', role: 'button', name: 'X', box: { x: 0, y: 0, width: 1, height: 1 } })
    const styled = node({ ...bare, styles: { color: '#fff', background: '#000', padding: '8px' } })
    expect(serializeSnapshot(snap(styled)).length).toBeGreaterThan(serializeSnapshot(snap(bare)).length)
  })

  it('the text form is far smaller than JSON for the same snapshot', () => {
    const root = node({
      ref: 'e0',
      role: 'main',
      children: Array.from({ length: 20 }, (_, i) =>
        node({ ref: `e${i + 1}`, role: 'button', name: `Item ${i}`, box: { x: i, y: i, width: 64, height: 28 } }),
      ),
    })
    const s = snap(root)
    expect(serializeSnapshot(s).length).toBeLessThan(serializeSnapshot(s, { format: 'json' }).length / 2)
  })
})

describe('robustness', () => {
  it('escapes quotes and flattens newlines in names', () => {
    const s = snap(node({ ref: 'e0', role: 'button', name: 'Say "hi"\nnow', box: { x: 0, y: 0, width: 1, height: 1 } }))
    expect(serializeSnapshot(s).split('\n')[1]).toBe('- button "Say \\"hi\\" now" [ref=e0] [box=0,0,1,1]')
  })

  it('coerces non-finite box values to 0', () => {
    const s = snap(node({ ref: 'e0', role: 'x', box: { x: NaN, y: Infinity, width: -Infinity, height: 5 } }))
    expect(serializeSnapshot(s)).toContain('[box=0,0,0,5]')
  })

  it('json format returns the raw snapshot', () => {
    const s = snap(node({ ref: 'e0', role: 'button', name: 'Save', box: { x: 1, y: 2, width: 3, height: 4 } }))
    expect(JSON.parse(serializeSnapshot(s, { format: 'json' }))).toEqual(s)
  })
})
