// An install or update command as every surface shows it: the first-run
// setup screen, the assistant setup pages, Settings, Accounts and the
// footer's CLI help (ADR-024; owner decisions D1 to D3, 2026-10-10).
//
// Each command has both buttons. Copy copies the command exactly as shown.
// Run it for me asks first: the confirmation shows the exact line main built
// and says where it runs, and, for a vendor's installer script, names the
// host it downloads the script from and says it downloads and runs it. Only
// "Run it" there hands the line to the surface, which runs it in a visible
// terminal. Whether a command may run is main's decision: it sends the line
// (`runLine`) only for one it allows, and the host (`downloadsFrom`) for an
// installer; without them Run it for me is off and says why. An npm command
// main marks `needsNode` (Node.js was not found) is offered to copy only.
//
// Styled by the onboarding sheet's .cx-* rules, which apply inside .ob-root
// and inside any element with the install-recipes class.
import { useEffect, useRef, useState } from 'react'
import type { InstallRecipeView } from '../../shared/providers'
import './onboarding.css'

export type RunnableRecipe = InstallRecipeView & { runLine: string }

export const NEEDS_NODE_TEXT = 'Needs Node.js, which was not found on this computer.'
export const NOT_RUN_NOTE = 'The app does not run this command: copy it and run it in a terminal.'

/** "From Anthropic", or "From OpenAI's README" for a command copied from a README. */
export function recipeSourceLine(r: Pick<InstallRecipeView, 'publisher' | 'sourceUrl'>): string {
  return /readme/i.test(r.sourceUrl) ? `From ${r.publisher}'s README` : `From ${r.publisher}`
}

/** What a check that still does not find `tool` says: after a command the app
 *  ran ended (with its exit code when it is known and not 0), or after the
 *  user's own Retry or Check again. The PATH was brought up to date before
 *  the check, so a restart is the last resort, not the first. */
export function afterInstallMessage(tool: string, how: { ended: boolean; exitCode?: number }): string {
  const restart = 'quit AI Code Conductor and start it again so it sees the new PATH.'
  if (!how.ended) return `${tool} was still not found. If you installed it, ${restart}`
  const code = typeof how.exitCode === 'number' && how.exitCode !== 0 ? ` with exit code ${how.exitCode}` : ''
  return `The command ended${code}, but ${tool} was still not found. The terminal shows what happened. If it installed without an error, ${restart}`
}

/** The confirmation's words: for an installer script, where it downloads the
 *  script from and that it runs it; then where the surface runs the line. */
export function recipeConfirmText(recipe: Pick<InstallRecipeView, 'method' | 'downloadsFrom'>, where: string): string {
  return recipe.method === 'script' && recipe.downloadsFrom ? `This downloads a script from ${recipe.downloadsFrom} and runs it. ${where}` : where
}

/** Why Run it for me is off for `recipe`, or undefined when it may run. */
function runOffReason(recipe: InstallRecipeView, busyReason: string | undefined): string | undefined {
  if (recipe.needsNode) return NEEDS_NODE_TEXT
  if (typeof recipe.runLine !== 'string' || recipe.runLine === '') return NOT_RUN_NOTE
  // An installer script runs only with a confirmation that names its host.
  if (recipe.method === 'script' && !recipe.downloadsFrom) return NOT_RUN_NOTE
  return busyReason
}

export function InstallRecipeRow({ recipe, testIdPrefix: P, confirmWhere, onRun, busyReason }: {
  recipe: InstallRecipeView
  testIdPrefix: string
  /** Where the surface runs the line, said in the confirmation. */
  confirmWhere: string
  onRun: (r: RunnableRecipe) => void
  /** Why Run is unavailable right now (an install this surface opened is still running). */
  busyReason?: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  const id = recipe.id
  const runLine = typeof recipe.runLine === 'string' && recipe.runLine !== '' ? recipe.runLine : undefined
  const off = runOffReason(recipe, busyReason)
  const copy = () => {
    void navigator.clipboard?.writeText(recipe.displayCommand).then(() => {
      if (!live.current) return
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => { timer.current = null; setCopied(false) }, 1500)
    }).catch(() => { /* clipboard blocked: the command is selectable */ })
  }
  return (
    <div className="cx-recipe" data-testid={`${P}-recipe-${id}`}>
      <div className="cx-cmd">
        <code className="select-all" data-testid={`${P}-recipe-command-${id}`}>{recipe.displayCommand}</code>
        <button
          className="cx-btn"
          type="button"
          onClick={() => setConfirming(true)}
          disabled={confirming || !!off}
          title={off}
          data-autofocus=""
          data-testid={`${P}-recipe-run-${id}`}
        >
          Run it for me
        </button>
        <button className="cx-btn" type="button" onClick={copy} data-autofocus="" data-testid={`${P}-recipe-copy-${id}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {recipe.note && <div className="cx-note" data-testid={`${P}-recipe-note-${id}`}>{recipe.note}</div>}
      {recipe.needsNode && <div className="cx-note" data-testid={`${P}-recipe-needs-node-${id}`}>{NEEDS_NODE_TEXT}</div>}
      {!recipe.needsNode && off === NOT_RUN_NOTE && <div className="cx-note" data-testid={`${P}-recipe-not-run-${id}`}>{NOT_RUN_NOTE}</div>}
      {busyReason && off === busyReason && !confirming && (
        <div className="cx-note" data-testid={`${P}-recipe-busy-${id}`}>{busyReason}</div>
      )}
      {runLine && confirming && (
        <div className="cx-confirm" role="group" aria-label="Run this command?" data-testid={`${P}-recipe-confirm-${id}`}>
          <span>
            <span data-testid={`${P}-recipe-confirm-text-${id}`}>{recipeConfirmText(recipe, confirmWhere)}</span>
            <code className="cx-run-line" data-testid={`${P}-recipe-run-line-${id}`}>{runLine}</code>
          </span>
          <span className="cx-confirm-btns">
            <button className="cx-btn" type="button" onClick={() => setConfirming(false)} data-testid={`${P}-recipe-cancel-${id}`}>Cancel</button>
            <button
              className="cx-btn primary"
              type="button"
              disabled={!!off}
              onClick={() => { setConfirming(false); onRun({ ...recipe, runLine }) }}
              data-testid={`${P}-recipe-confirm-run-${id}`}
            >
              Run it
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

/** The install or update commands for one tool, with where they come from.
 *  Nothing while they have not been read; a line saying so when there are
 *  none or they could not be read. */
export function InstallRecipeList({ purpose, recipes, toolName, testIdPrefix: P, confirmWhere, onRun, busyReason }: {
  purpose: 'install' | 'update'
  recipes: InstallRecipeView[] | null | undefined
  toolName: string
  testIdPrefix: string
  confirmWhere: string
  onRun: (r: RunnableRecipe) => void
  busyReason?: string
}) {
  if (recipes === undefined) return null
  const mine = (recipes ?? []).filter((r) => r.purpose === purpose)
  return (
    <div className="cx-recipes" data-testid={`${P}-recipes-${purpose}`}>
      <div className="cx-recipes-h">
        <b>{purpose === 'install' ? `Install ${toolName}` : `Update ${toolName}`}</b>
        {mine[0] && <span className="cx-muted" title={mine[0].sourceUrl}>{recipeSourceLine(mine[0])}</span>}
      </div>
      {mine.length === 0 && (
        <div className="cx-muted" data-testid={`${P}-recipes-none`}>
          {recipes === null
            ? `The ${purpose} commands could not be read.`
            : `No ${purpose} command is known for this computer.`}
        </div>
      )}
      {mine.map((r) => <InstallRecipeRow key={r.id} recipe={r} testIdPrefix={P} confirmWhere={confirmWhere} onRun={onRun} busyReason={busyReason} />)}
    </div>
  )
}
