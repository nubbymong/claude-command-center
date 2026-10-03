// The Claude-only footer scenario the usage track MP5 regression case renders:
// three profiles (one primary) with aliases and a colour override, two sessions
// on one account, one on another reported on the legacy fields, and an SSH
// session attributed by its remote account (#571). No reset times, so the
// recorded HTML does not depend on the machine's time zone or locale.
// tests/fixtures/footer/pre-mp5-claude-only.json holds the footer's HTML for it
// as rendered by the footer before MP5 (895ee237), in both display modes.
export const SCENARIO = {
  profiles: [
    { id: 'p1', accountEmail: 'a@x.com', name: '', isPrimary: true, createdAt: 0 },
    { id: 'p2', accountEmail: 'b@x.com', name: '', createdAt: 0 },
    { id: 'p3', accountEmail: 'c@x.com', name: '', createdAt: 0 },
  ],
  settings: {
    accountAliases: { 'a@x.com': 'Alpha', 'b@x.com': 'Bravo', 'c@x.com': 'Charlie' },
    accountColourOverrides: { 'b@x.com': 'rose' },
    claudeEnabled: true,
  },
  sessions: [
    { id: 's1', label: 'x', status: 'working', provider: 'claude', accountEmail: 'b@x.com', rateLimitCurrent: 10, rateLimitWeekly: 20 },
    {
      id: 's2', label: 'x', status: 'working', provider: 'claude', accountEmail: 'a@x.com',
      usageBuckets: [
        { key: '5h', label: '5h', group: 'session', percent: 30, resetsAt: '', severity: 'normal' },
        { key: 'weekly', label: 'Weekly', group: 'weekly', percent: 40, resetsAt: '', severity: 'normal' },
        { key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 92, resetsAt: '', severity: 'normal' },
      ],
    },
    {
      id: 's3', label: 'x', status: 'idle', provider: 'claude', accountEmail: 'a@x.com',
      usageBuckets: [{ key: '5h', label: '5h', group: 'session', percent: 55, resetsAt: '', severity: 'normal' }],
    },
    { id: 's4', label: 'x', status: 'working', provider: 'claude', sessionType: 'ssh', sshRemoteAccount: 'C@X.com', rateLimitCurrent: 75 },
  ],
}
