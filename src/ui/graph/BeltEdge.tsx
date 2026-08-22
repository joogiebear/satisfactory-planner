import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { FlowEdgeData } from './model'
import { capacityFor, fmt, linesLabel } from '../format'
import type { PlannerSettings } from '../../core/types'
import { Icon } from './FactoryNode'

export type BeltEdgeType = Edge<FlowEdgeData, 'belt'>

/**
 * Settings live outside React Flow's edge props, so the graph publishes them
 * here for edges to read when working out belt capacity.
 */
let currentSettings: PlannerSettings | null = null
export function setEdgeSettings(s: PlannerSettings) { currentSettings = s }

export function BeltEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected,
}: EdgeProps<BeltEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
    curvature: 0.35,
  })

  if (!data) return <BaseEdge id={id} path={path} />

  const { item, ratePerMin } = data
  const cap = currentSettings ? capacityFor(item, ratePerMin, currentSettings) : null
  const over = cap?.over ?? false
  const fluid = item.isFluid

  // Heavier flows draw a heavier belt, compressed so a 1200/min line doesn't
  // dwarf a 5/min one.
  const width = Math.min(6, 1.4 + Math.log10(1 + ratePerMin) * 1.5)
  const colour = over ? 'var(--hazard)' : fluid ? 'var(--coolant)' : 'var(--ficsit)'

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: colour,
          strokeWidth: selected ? width + 1.5 : width,
          opacity: selected ? 1 : 0.75,
          strokeDasharray: over ? '9 5' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="belt-label"
          data-fluid={fluid}
          data-over={over}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={
            over && cap
              ? `${fmt(ratePerMin)} ${fluid ? 'm³/min' : '/min'} needs ${cap.lines} × ${cap.name}`
              : `${fmt(ratePerMin)} ${fluid ? 'm³/min' : '/min'} of ${item.name}`
          }
        >
          <Icon item={item} size={16} />
          <span className="belt-rate">{fmt(ratePerMin)}</span>
          {over && cap && <span className="belt-warn">{linesLabel(cap)}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
