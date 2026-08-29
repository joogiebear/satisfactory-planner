import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { billOfMaterials, layOut, FOUNDATION, ROW_GAP, type Placed, type Run } from '../../core/layout'
import type { Plan, PlannerSettings } from '../../core/types'
import { fmt } from '../format'
import { iconFor } from '../icons'
import { initials } from '../format'

/**
 * The plan seen from above, as a thing you could pace out and build.
 *
 * Every other view answers "what does this need"; this one answers "where does
 * it go". Machines are drawn at their real footprint on the game's own 8 m
 * foundation grid, with the splitter in front of each and the merger behind, so
 * the belts on the page are the belts you would run.
 *
 * It is deliberately a diagram rather than a picture. A render of the models
 * would be prettier and much worse to copy from: you cannot count foundations
 * off a perspective view, and the thing worth reading here is the spacing.
 */

interface Props {
  plan: Plan
  settings: PlannerSettings
}

/** Roomy enough to read a label, tight enough that a big build still fits. */
const PAD = 600

/** How far a block's box reaches past its machines, to take in its buses. */
const BUS_GAP = 500

export function LayoutView({ plan, settings }: Props) {
  const layout = useMemo(() => layOut(plan, settings), [plan, settings])
  const bom = useMemo(() => billOfMaterials(layout), [layout])
  const [hover, setHover] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const svgRef = useRef<SVGSVGElement>(null)
  const drawnRef = useRef<SVGGElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  if (!layout.rows.length) {
    return <p className="muted layout-empty">Nothing to lay out yet — add an output first.</p>
  }

  const minX = layout.minX
  const vbW = layout.width + PAD * 2

  // Belt widths scale off the whole drawing so they stay visible however far
  // out you are. Text cannot: sizing words off the longest side gives, on a
  // tall build, a label taller than the gap it sits in and written across the
  // block above. Type is measured against a column's width and the gap it has
  // to sit in, whichever is tighter.
  const perColumn = layout.columns > 1 ? vbW / layout.columns : vbW
  const label = Math.min(perColumn / 22, ROW_GAP * 0.52)
  const small = Math.min(perColumn / 44, ROW_GAP * 0.3)

  const vbH = layout.height + PAD * 2 + label
  const u = Math.max(vbW, vbH) / 100

  // The box the layout reports covers its belts and machines. It does not cover
  // the block labels, which run past the machines they name, and keeping a
  // second set of bounds in step with the first is how the trunks came to be
  // drawn above the top of the canvas. Measuring what was actually rendered
  // needs no bookkeeping and cannot drift: getBBox reports content in user
  // space, so it does not depend on the box it is measured against.
  const [fitted, setFitted] = useState<string | null>(null)
  const provisional = [minX - PAD, layout.minY - PAD - label, vbW, vbH].join(' ')
  const viewBox = fitted ?? provisional

  const vb = viewBox.split(' ').map(Number)

  // Letterboxing a tall build into a wide box leaves a sliver down the middle,
  // so the box grows with the build rather than the build shrinking into it.
  const tall = vb[3] / vb[2]

  useLayoutEffect(() => {
    // The drawing only — the background grid is sized from the box it is being
    // measured against, so including it would make each fit creep outwards by
    // its own padding.
    const drawn = drawnRef.current
    if (!drawn) return
    const box = drawn.getBBox()
    if (!(box.width > 0) || !(box.height > 0)) return
    const pad = PAD
    const next = [
      Math.floor(box.x - pad), Math.floor(box.y - pad),
      Math.ceil(box.width + pad * 2), Math.ceil(box.height + pad * 2),
    ].join(' ')
    setFitted((prev) => (prev === next ? prev : next))
  }, [layout, label])

  /**
   * Wheel zooms about the pointer rather than the middle.
   *
   * Zooming about the centre means every step away from it has to be chased
   * with the scrollbars, which on a build three hundred metres long is most of
   * the work. Keeping whatever is under the cursor under the cursor is what
   * everything else that draws a big picture does.
   */
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = box.getBoundingClientRect()
      const dx = e.clientX - rect.left
      const dy = e.clientY - rect.top
      // Where the pointer sits in the drawing, as a fraction of it.
      const fx = (box.scrollLeft + dx) / Math.max(1, box.scrollWidth)
      const fy = (box.scrollTop + dy) / Math.max(1, box.scrollHeight)

      setZoom((z) => {
        const next = Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        if (Math.abs(next - z) < 1e-6) return z
        // The drawing has to be laid out at the new size before the offset that
        // puts that fraction back under the pointer can be read off it.
        requestAnimationFrame(() => {
          box.scrollLeft = fx * box.scrollWidth - dx
          box.scrollTop = fy * box.scrollHeight - dy
        })
        return Math.round(next * 100) / 100
      })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  /** Drag anywhere on the drawing to pan it, which beats hunting for a bar. */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current
    if (!box || e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const left = box.scrollLeft
    const topAt = box.scrollTop
    let moved = false

    const move = (ev: PointerEvent) => {
      moved = true
      box.scrollLeft = left - (ev.clientX - startX)
      box.scrollTop = topAt - (ev.clientY - startY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) box.classList.remove('is-panning')
    }
    box.classList.add('is-panning')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  const savePng = () => {
    const svg = svgRef.current
    if (!svg) return
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'layout.svg'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="panel layout-panel">
      <div className="panel-head">
        Top-down layout
        <span className="count">
          {layout.rows.length} block{layout.rows.length === 1 ? '' : 's'}
          {layout.columns > 1 && <> in {layout.columns} columns</>} ·{' '}
          {Math.round(layout.width / 100)}×{Math.round(layout.height / 100)} m
        </span>
      </div>

      <div className="layout-bar">
        <Stat label="Machines" value={String(plan.totals.machines)} />
        <Stat label="Splitters" value={String(layout.splitters)} />
        <Stat label="Mergers" value={String(layout.mergers)} />
        <Stat label="Belt" value={`${layout.beltMetres} m`} />
        <Stat label="Foundations" value={String(layout.foundations)} unit="8 m" />
        <button className="btn" onClick={savePng}>Save SVG</button>
      </div>

      <p className="muted layout-blurb">
        A manifold, which is what most people build: one belt along the front of each row
        with a splitter per machine, one along the back collecting through mergers. The
        machines nearest the head fill first and the row evens out once it is saturated.
        Everything is drawn at its real size on the game's 8 m foundation grid.
      </p>

      {layout.warnings.length > 0 && (
        <div className="notice">
          <ul>{layout.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      <div className="layout-zoom">
        <span className="field-label">Zoom</span>
        <input
          type="range" min={1} max={6} step={0.25} value={zoom}
          aria-label="Zoom the layout"
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <span className="muted">{zoom === 1 ? 'whole build' : `${zoom}×`}</span>
        {zoom !== 1 && (
          <button className="btn" onClick={() => setZoom(1)}>Fit</button>
        )}
        <span className="muted">wheel to zoom · drag to pan</span>
        <span className="muted layout-scale">
          1 square = 8 m foundation · build is {Math.round(layout.width / 100)}×{Math.round(layout.height / 100)} m
        </span>
      </div>

      <div
        ref={boxRef}
        className="layout-canvas"
        style={{ height: `${Math.min(82, Math.max(52, 52 + tall * 12))}vh` }}
        onPointerDown={onPointerDown}
      >
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="layout-svg"
          preserveAspectRatio="xMidYMid meet"
          style={{ width: `${zoom * 100}%`, height: `calc(${zoom * 100}% - 2px)` }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern id="foundations" width={FOUNDATION} height={FOUNDATION} patternUnits="userSpaceOnUse">
              <path d={`M ${FOUNDATION} 0 L 0 0 0 ${FOUNDATION}`} fill="none" stroke="#232a31" strokeWidth={u * 0.35} />
            </pattern>
            <marker id="flow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="#f89a3c" />
            </marker>
          </defs>

          <rect
            x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]}
            fill="url(#foundations)"
          />

          <g ref={drawnRef}>
          {layout.rows.map((row) => (
            <g key={row.index} opacity={hover === null || hover === row.index ? 1 : 0.25}>
              <rect
                x={row.x - BUS_GAP} y={row.y - label * 0.2}
                width={row.width + BUS_GAP + label * 0.2}
                height={row.height + label * 0.4}
                className="layout-rowbox"
                strokeWidth={u * 0.25}
                onMouseEnter={() => setHover(row.index)}
                onMouseLeave={() => setHover(null)}
              />
              <text
                x={row.x - BUS_GAP} y={row.y - label * 0.45}
                className="layout-rowlabel" style={{ fontSize: label }}
              >
                {row.label}
              </text>
            </g>
          ))}

          {layout.runs.map((run) => (
            <Belt
              key={run.id} run={run} u={u} small={small}
              dim={hover !== null && hover !== run.row}
            />
          ))}

          {layout.buildings.map((b) => (
            <Building key={b.id} b={b} u={u} dim={hover !== null && hover !== b.row} />
          ))}
          </g>
        </svg>
      </div>

      <div className="layout-bom">
        <h4>What to build</h4>
        <ul>
          {bom.map((b) => (
            <li key={b.key}>
              <strong>{b.count}×</strong> {b.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Building({ b, u, dim }: { b: Placed; u: number; dim: boolean }) {
  const src = iconFor(b.key) ?? (b.item ? iconFor(b.item.key) : undefined)
  const pad = Math.min(b.w, b.h) * 0.2
  const size = Math.min(b.w, b.h) - pad * 2

  return (
    <g opacity={dim ? 0.25 : 1}>
      <title>{b.name}{b.item ? ` — ${b.item.name}` : ''}</title>
      <rect
        x={b.x} y={b.y} width={b.w} height={b.h} rx={u * 0.5}
        className="layout-b" data-kind={b.kind} strokeWidth={u * 0.22}
      />
      {b.kind === 'machine' && src && (
        <image href={src} x={b.x + (b.w - size) / 2} y={b.y + (b.h - size) / 2} width={size} height={size} />
      )}
      {b.kind === 'machine' && !src && (
        <text
          x={b.x + b.w / 2} y={b.y + b.h / 2}
          className="layout-btext" style={{ fontSize: Math.min(b.w, b.h) * 0.4 }}
        >
          {initials(b.name)}
        </text>
      )}
    </g>
  )
}

function Belt({ run, u, small, dim }: { run: Run; u: number; small: number; dim: boolean }) {
  const d = run.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const mid = run.points[Math.floor(run.points.length / 2)]
  const bus = run.id.startsWith('bus') || run.id.startsWith('link')

  return (
    <g opacity={dim ? 0.2 : 1}>
      <title>{run.item.name} — {fmt(run.ratePerMin)}/min{run.lanes > 1 ? ` on ${run.lanes} lines` : ''}</title>
      <path
        d={d}
        className="layout-belt"
        data-bus={bus || undefined}
        data-over={run.lanes > 1 || undefined}
        strokeWidth={bus ? u * 0.5 : u * 0.3}
        strokeDasharray={run.lanes > 1 ? `${u} ${u * 0.7}` : undefined}
        markerEnd={bus ? 'url(#flow)' : undefined}
      />
      {bus && (
        <text x={mid.x} y={mid.y - small * 0.6} className="layout-rate" style={{ fontSize: small }}>
          {fmt(run.ratePerMin)}/min{run.lanes > 1 ? ` ×${run.lanes}` : ''}
        </text>
      )}
    </g>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <span className="layout-stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {unit && <span className="muted">{unit}</span>}
    </span>
  )
}
