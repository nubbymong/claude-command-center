import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import type { AgentTemplate } from '../types/electron'
import AgentTemplateDialog from './AgentTemplateDialog'

const MODEL_COLORS: Record<string, string> = {
  inherit: '#b8c5d6',
  sonnet: '#89B4FA',
  opus: '#CBA6F7',
  haiku: '#A6E3A1',
}

interface ContextMenuState {
  x: number
  y: number
  templateId: string
  isBuiltIn: boolean
}

function TemplateCard({ template, onClick, onContextMenu }: {
  template: AgentTemplate
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const modelColor = MODEL_COLORS[template.model] || MODEL_COLORS.inherit

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="w-full text-left rounded-xl p-3 transition-all duration-150 border bg-mantle/30 border-transparent hover:bg-surface0/30 hover:border-surface0/60 group"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-text font-mono">{template.name}</span>
        {template.isBuiltIn && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface0/60 text-overlay0">built-in</span>
        )}
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: modelColor + '20', color: modelColor }}>
          {template.model}
        </span>
      </div>
      <div className="text-[11px] text-overlay1 truncate mb-1.5">{template.description}</div>
      <div className="flex items-center gap-1.5 text-[10px] text-overlay0">
        <span>{template.tools.length > 0 ? `${template.tools.length} tools` : 'All tools'}</span>
      </div>
    </button>
  )
}

export default function AgentLibrary() {
  const userTemplates = useAgentLibraryStore(s => s.templates)
  const addTemplate = useAgentLibraryStore(s => s.addTemplate)
  const updateTemplate = useAgentLibraryStore(s => s.updateTemplate)
  const removeTemplate = useAgentLibraryStore(s => s.removeTemplate)
  const duplicateTemplate = useAgentLibraryStore(s => s.duplicateTemplate)

  const [showDialog, setShowDialog] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<AgentTemplate | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && contextMenu) setContextMenu(null)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [contextMenu])

  const handleContextMenu = useCallback((e: React.MouseEvent, templateId: string, isBuiltIn: boolean) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, templateId, isBuiltIn })
  }, [])

  const handleCardClick = (template: AgentTemplate) => {
    if (template.isBuiltIn) return // built-in templates are read-only
    setEditingTemplate(template)
    setShowDialog(true)
  }

  const handleSaveNew = (data: Omit<AgentTemplate, 'id'>) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    addTemplate({ ...data, id })
    setShowDialog(false)
  }

  const handleSaveEdit = (data: Omit<AgentTemplate, 'id'>) => {
    if (!editingTemplate) return
    updateTemplate(editingTemplate.id, data)
    setEditingTemplate(null)
    setShowDialog(false)
  }

  return (
    <div className="flex-1 flex flex-col bg-base overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-surface0/80 bg-mantle/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-lavender/10 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-lavender">
              <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-text">Agent Library</h1>
            <p className="text-[11px] text-overlay0 mt-0.5">Reusable agent templates for Claude CLI --agents</p>
          </div>
          <button
            onClick={() => { setEditingTemplate(null); setShowDialog(true) }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-lavender hover:bg-lavender/85 text-crust transition-colors flex items-center gap-1.5 shadow-sm"
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.5"/><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5"/></svg>
            New Agent
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Your Agents */}
        <div>
          <h2 className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2 px-1">Your Agents</h2>
          {userTemplates.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-surface0/30 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay0">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <p className="text-sm text-subtext1 font-medium mb-1">No custom agents yet</p>
              <p className="text-xs text-overlay0 mb-3">Create your first agent template or duplicate a built-in one</p>
              <button
                onClick={() => { setEditingTemplate(null); setShowDialog(true) }}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-lavender hover:bg-lavender/85 text-crust transition-colors"
              >
                + New Agent
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5">
              {userTemplates.map(t => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onClick={() => handleCardClick(t)}
                  onContextMenu={(e) => handleContextMenu(e, t.id, false)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Built-in Agents */}
        <div>
          <h2 className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2 px-1">Built-in Agents</h2>
          <div className="grid grid-cols-1 gap-1.5">
            {BUILTIN_TEMPLATES.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                onClick={() => handleCardClick(t)}
                onContextMenu={(e) => handleContextMenu(e, t.id, true)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface0 border border-surface1 rounded-xl shadow-2xl py-1.5 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {!contextMenu.isBuiltIn && (
            <button
              onClick={() => {
                const t = userTemplates.find(t => t.id === contextMenu.templateId)
                if (t) { setEditingTemplate(t); setShowDialog(true) }
                setContextMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 text-text hover:bg-surface1 transition-colors"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => {
              duplicateTemplate(contextMenu.templateId)
              setContextMenu(null)
            }}
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 text-text hover:bg-surface1 transition-colors"
          >
            Duplicate
          </button>
          {!contextMenu.isBuiltIn && (
            <button
              onClick={() => {
                removeTemplate(contextMenu.templateId)
                setContextMenu(null)
              }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 text-red hover:bg-red/10 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      )}

      {/* Dialog */}
      {showDialog && (
        <AgentTemplateDialog
          initial={editingTemplate || undefined}
          onSave={editingTemplate ? handleSaveEdit : handleSaveNew}
          onCancel={() => { setShowDialog(false); setEditingTemplate(null) }}
        />
      )}
    </div>
  )
}
