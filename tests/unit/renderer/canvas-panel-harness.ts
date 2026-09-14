// The pane-owned props every CanvasNotesPanel mount needs (M2 shared contract).
//
// The panel asks the PANE about the glass — which strokes nobody has claimed,
// how to serialise the scene for the persisted draft, how to put one back — and
// those props are required, because a panel that silently could not see the
// glass would drop the drawing the user made without saying so.
//
// `sketchRevision` is the counter the pane bumps from the glass's own onChange:
// it is the ONLY way the panel learns a drawing happened, so a test about
// drawing bumps it and a test about anything else leaves it alone.
//
// A test that is not about the glass still has to answer, so it answers "no
// strokes, nothing to persist" here rather than repeating four no-ops in a dozen
// files. Anything a test IS about, it overrides.

import type { CanvasSketchScene } from '../../../src/shared/canvas'

export interface PaneSketchProps {
  getUnattachedSketchElementIds: () => string[]
  markSketchElementsAttached: (ids: string[]) => void
  getSketchSceneForPersist: () => CanvasSketchScene | null
  /** True iff it CHANGED the glass — the panel suppresses exactly one
   *  revision bump after a restore, and only a restore that moved the glass
   *  produces one. */
  restoreSketchScene: (scene: CanvasSketchScene) => boolean
  getAllSketchElements: () => never[]
  sketchRevision: number
}

export function paneSketchProps(overrides: Partial<PaneSketchProps> = {}): PaneSketchProps {
  return {
    getUnattachedSketchElementIds: () => [],
    markSketchElementsAttached: () => {},
    getSketchSceneForPersist: () => null,
    restoreSketchScene: () => false,
    getAllSketchElements: () => [],
    sketchRevision: 0,
    ...overrides,
  }
}
