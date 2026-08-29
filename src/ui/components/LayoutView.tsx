import { useMemo, useRef, useState } from 'react'
import { billOfMaterials, layOut, FOUNDATION, type Placed, type Run } from '../../core/layout'
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

export function LayoutView({ plan, settings }: Props) {
  const layout = useMemo(() => layOut(plan, settings), [plan, settings])
  const bom = useMemo(() => billOfMaterials(layout), [layout])
  const [hover, setHover] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const svgRef = useRef<SVGSVGElement>(null)

  if (!layout.rows.length) {
    return <p className="muted layout-empty">Nothing to lay out yet — add an output first.</p>
  }

  // The buses and links run to the left of the machines, so the canvas starts
  // there rather than at the first machine.
  const minX = Math.min(0, ...layout.runs.flatMap((r) => r.points.map((p) => p.x)))
  const maxX = Math.max(...layout.buildings.map((b) => b.x + b.w))
  const vbW = maxX - minX + PAD * 2
  const vbH = layout.height + PAD * 2
  const viewBox = [minX - PAD, -PAD, vbW, vbH].join(' ')

  // Text and belt widths are in world units, so they have to be sized against
  // the build or a small one is unreadable and a large one is a scrawl.
  const u = Math.max(vbW, vbH) / 100

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
          {layout.rows.length} row{layout.rows.length === 1 ? '' : 's'} ·{' '}
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
        <span className="muted layout-scale">
          1 square = 8 m foundation · build is {Math.round(layout.width / 100)}×{Math.round(layout.height / 100)} m
        </span>
      </div>

      <div className="layout-canvas">
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

          <rect x={minX - PAD} y={-PAD} width={maxX - minX + PAD * 2} height={layout.height + PAD * 2}
                fill="url(#foundations)" />

          {layout.rows.map((row) => (
            <g key={row.index} opacity={hover === null || hover === row.index ? 1 : 0.25}>
              <rect
                x={minX - PAD / 2} y={row.y - u}
                width={maxX - minX + PAD} height={row.height + u * 2}
                className="layout-rowbox"
                strokeWidth={u * 0.25}
                onMouseEnter={() => setHover(row.index)}
                onMouseLeave={() => setHover(null)}
              />
              <text
                x={minX - PAD / 2 + u} y={row.y - u * 1.6}
                className="layout-rowlabel" style={{ fontSize: u * 2.6 }}
              >
                {row.machines}× {row.step.building?.name ?? 'Machine'} — {row.step.recipe.name}
              </text>
            </g>
          ))}

          {layout.runs.map((run) => (
            <Belt key={run.id} run={run} u={u} dim={hover !== null && hover !== run.row} />
          ))}

          {layout.buildings.map((b) => (
            <Building key={b.id} b={b} u={u} dim={hover !== null && hover !== b.row} />
          ))}
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

function Belt({ run, u, dim }: { run: Run; u: number; dim: boolean }) {
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
        <text x={mid.x} y={mid.y - u * 0.8} className="layout-rate" style={{ fontSize: u * 1.5 }}>
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
