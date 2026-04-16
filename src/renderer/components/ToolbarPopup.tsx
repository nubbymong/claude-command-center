import React, { useEffect, useRef } from 'react'

interface PopupSection {
  title: string
  shortcut?: string
  items: PopupItem[]
}

interface PopupItem {
  label: string
  value: string
  active?: boolean
  disabled?: boolean
  hint?: string
  key?: string
}

interface Props {
  sections: PopupSection[]
  onSelect: (sectionIndex: number, value: string) => void
  onClose: () => void
  alignRight?: boolean
}

export default function ToolbarPopup({ sections, onSelect, onClose, alignRight }: Props) {
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= 9) {
        for (let si = 0; si < sections.length; si++) {
          const items = sections[si].items.filter((i) => !i.disabled)
          if (num <= items.length) {
            onSelect(si, items[num - 1].value)
            return
          }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sections, onSelect, onClose])

  // Clamp popup so it doesn't overflow the viewport on the right
  useEffect(() => {
    const el = popupRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewW = window.innerWidth
    if (rect.right > viewW - 8) {
      const overflow = rect.right - viewW + 8
      el.style.transform = `translateX(-${overflow}px)`
    }
  }, [])

  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div
        ref={popupRef}
        className={`absolute bottom-full mb-1 z-50 rounded-lg shadow-xl py-1 min-w-[260px] w-max ${alignRight ? 'right-0' : 'left-0'}`}
        style={{
          background: 'var(--color-mantle)',
          border: '1px solid var(--color-surface1)',
          maxWidth: 'calc(100vw - 16px)',
        }}
      >
        {sections.map((section, si) => (
          <div key={section.title}>
            {si > 0 && (
              <div style={{ borderTop: '1px solid var(--color-surface0)', margin: '4px 0' }} />
            )}
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="text-xs text-overlay1 font-medium">{section.title}</span>
              {section.shortcut && (
                <span className="ml-auto flex gap-0.5">
                  {section.shortcut.split('+').map((k, i) => (
                    <kbd
                      key={i}
                      className="text-xs px-1 py-0.5 rounded"
                      style={{
                        background: 'var(--color-surface0)',
                        color: 'var(--color-overlay1)',
                        fontSize: 10,
                      }}
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              )}
            </div>
            {section.items.map((item, ii) => (
              <button
                key={item.value}
                onClick={() => {
                  if (!item.disabled) onSelect(si, item.value)
                }}
                className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-start gap-2"
                style={{
                  color: item.disabled
                    ? 'var(--color-overlay0)'
                    : item.active
                      ? 'var(--color-text)'
                      : 'var(--color-subtext0)',
                  cursor: item.disabled ? 'default' : 'pointer',
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled)
                    e.currentTarget.style.background = 'var(--color-surface0)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <div className="flex flex-col flex-1 min-w-0">
                  <span className={item.active ? 'font-medium' : ''}>
                    {item.label}
                  </span>
                  {item.hint && (
                    <span className="text-overlay0" style={{ fontSize: 10, lineHeight: '14px' }}>
                      {item.hint}
                    </span>
                  )}
                </div>
                <span className="flex items-center gap-1.5 shrink-0 pt-0.5">
                  {item.active && (
                    <span className="text-green">{String.fromCodePoint(0x2713)}</span>
                  )}
                  {!item.disabled && (
                    <span className="text-overlay0" style={{ fontSize: 10 }}>
                      {ii + 1}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
