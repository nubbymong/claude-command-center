import React, { useEffect, useState } from 'react'
import { useSessionStore, Session } from '../stores/sessionStore'
import { markSessionForResumePicker } from '../App'
import { COLOR_SWATCHES } from './SessionDialog'

interface DiscoveredProject {
  path: string
  name: string
  sessionCount: number
  lastActive: number
}

interface DiscoveredSession {
  id: string
  filePath: string
  firstMessage: string
  timestamp: number
  lastActive: number
  messageCount: number
  model?: string
}

export default function ProjectBrowser() {
  const [projects, setProjects] = useState<DiscoveredProject[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [sessions, setSessions] = useState<DiscoveredSession[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const addSession = useSessionStore(s => s.addSession)
  const existingSessions = useSessionStore(s => s.sessions)

  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.discovery.getProjects() as DiscoveredProject[]
      setProjects(result)
    } catch { /* ignore */ }
    setLoading(false)
  }

  const loadSessions = async (projectPath: string) => {
    setSelectedProject(projectPath)
    try {
      const result = await window.electronAPI.discovery.getSessionHistory(projectPath) as DiscoveredSession[]
      setSessions(result)
    } catch { /* ignore */ }
  }

  const resumeSession = (ds: DiscoveredSession, projectPath: string) => {
    const session: Session = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      label: ds.firstMessage.slice(0, 40) || 'Resumed session',
      workingDirectory: projectPath,
      model: ds.model || '',
      color: COLOR_SWATCHES[existingSessions.length % COLOR_SWATCHES.length],
      status: 'idle',
      createdAt: Date.now(),
      sessionType: 'local'
    }
    markSessionForResumePicker(session.id)
    addSession(session)
  }

  const filteredProjects = projects.filter(p =>
    !search || p.path.toLowerCase().includes(search.toLowerCase()) || p.name.toLowerCase().includes(search.toLowerCase())
  )

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-lg font-semibold text-text mb-4">Session Browser</h2>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="w-full bg-base border border-surface1 rounded-lg px-4 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue mb-4"
        />

        {loading ? (
          <div className="text-center text-overlay0 py-8">Scanning projects...</div>
        ) : (
          <div className="space-y-2">
            {filteredProjects.map(project => (
              <div key={project.path}>
                <button
                  onClick={() => loadSessions(project.path)}
                  className={`w-full text-left rounded-lg px-4 py-3 transition-colors ${
                    selectedProject === project.path ? 'bg-surface0' : 'hover:bg-surface0/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-text">{project.name}</div>
                      <div className="text-xs text-overlay0">{project.path}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-overlay1">{project.sessionCount} sessions</div>
                      <div className="text-xs text-overlay0">{formatDate(project.lastActive)}</div>
                    </div>
                  </div>
                </button>

                {selectedProject === project.path && sessions.length > 0 && (
                  <div className="ml-4 mt-1 space-y-1 mb-2">
                    {sessions.map(session => (
                      <div
                        key={session.id}
                        className="flex items-center justify-between bg-crust rounded px-3 py-2 group"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-text truncate">{session.firstMessage}</div>
                          <div className="text-xs text-overlay0">
                            {session.messageCount} messages · {session.model || 'unknown'} · {formatDate(session.lastActive)}
                          </div>
                        </div>
                        <button
                          onClick={() => resumeSession(session, project.path)}
                          className="ml-3 px-3 py-1 rounded text-xs bg-blue/20 text-blue hover:bg-blue/30 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          Resume
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {filteredProjects.length === 0 && (
              <div className="text-center text-overlay0 py-8">No projects found</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
