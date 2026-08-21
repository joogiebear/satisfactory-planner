import { useEffect, useMemo, useRef, useState } from 'react'
import type { GameItem } from '../../core/types'
import { initials } from '../format'

export function ItemChip({ item }: { item: GameItem }) {
  return (
    <span
      className="chip"
      data-fluid={item.isFluid}
      data-raw={item.isRaw}
      title={item.name}
      aria-hidden="true"
    >
      {initials(item.name)}
    </span>
  )
}

interface Props {
  items: GameItem[]
  onPick: (item: GameItem) => void
  placeholder?: string
  /** Rendered inside the list when a search finds nothing. */
  emptyText?: string
}

/** Search-as-you-type item chooser. Arrow keys move, Enter picks, Esc closes. */
export function ItemPicker({ items, onPick, placeholder = 'Search items…', emptyText = 'No matching items.' }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = q
      ? items.filter((i) => i.name.toLowerCase().includes(q))
      : items
    // Prefix matches first: typing "iron" should surface Iron Ore before
    // Reinforced Iron Plate.
    if (!q) return pool.slice(0, 60)
    return pool
      .slice()
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return ap - bp || a.name.length - b.name.length
      })
      .slice(0, 60)
  }, [items, query])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = (item: GameItem) => {
    onPick(item)
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="picker" ref={boxRef}>
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, matches.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); choose(matches[active]) }
          else if (e.key === 'Escape') { setOpen(false) }
        }}
      />
      {open && (
        <div className="picker-list" role="listbox">
          {matches.length === 0 && <div className="picker-empty">{emptyText}</div>}
          {matches.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              className="picker-option"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <ItemChip item={item} />
              <span>{item.name}</span>
              {item.isRaw && <span className="tag">RAW</span>}
              {item.isFluid && !item.isRaw && <span className="tag">FLUID</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
