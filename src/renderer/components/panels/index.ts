import { registerPaneComponent } from './PaneRegistry'
import TerminalPane from './TerminalPane'
import DiffViewerPane from './DiffViewerPane'

// Register all built-in pane components
// Future phases will add: PreviewPane, FileEditorPane
registerPaneComponent('claude-terminal', TerminalPane)
registerPaneComponent('partner-terminal', TerminalPane)
registerPaneComponent('diff-viewer', DiffViewerPane)

export { default as PanelContainer } from './PanelContainer'
export { default as PaneHeader } from './PaneHeader'
