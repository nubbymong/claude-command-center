import React from 'react'

export type AccountFilterValue = 'all' | '__mixed__' | '__unknown__' | string  // email

interface Props {
  emails: string[]
  value: AccountFilterValue
  onChange: (next: AccountFilterValue) => void
}

export function AccountFilter({ emails, value, onChange }: Props) {
  return (
    <select
      className="bg-surface0 text-text text-sm rounded px-2 py-1 border border-surface1"
      value={value}
      onChange={(e) => onChange(e.target.value as AccountFilterValue)}
      aria-label="Account filter"
    >
      <option value="all">All accounts</option>
      {emails.map((e) => (
        <option key={e} value={e}>{e}</option>
      ))}
      <option value="__mixed__">(Mixed)</option>
      <option value="__unknown__">(Unknown)</option>
    </select>
  )
}
