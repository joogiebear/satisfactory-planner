import { useState } from 'react'
import type { Plan, PlanNode, PlannerSettings } from '../../core/types'
import { capacityFor, fmt, fmtPower, linesLabel, unit } from '../format'
import { ItemChip } from './ItemPicker'

interface Props {
  plan: Plan
  settings: PlannerSettings
}

/** Branches below this depth start collapsed so a big plan stays readable. */
const AUTO_OPEN_DEPTH = 4

export function TreeView({ plan, settings }: Props) {
  // Only branches the user has actually clicked are recorded; everything else
  // falls back to the depth rule, so a new plan opens sensibly on its own.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())

  const toggle = (id: string, currentlyOpen: boolean) =>
    setOverrides((prev) => new Map(prev).set(id, !currentlyOpen))

  if (!plan.tree.length) return null

  return (
    <div className="panel">
      <div className="panel-head">
        Production tree
        <span className="count">amber rides a belt · teal rides a pipe · striped exceeds your tier</span>
      </div>
      <div className="tree" style={{ padding: '12px 14px' }}>
        {plan.tree.map((node) => (
          <Node key={node.id} node={node} settings={settings} overrides={overrides} toggle={toggle} />
        ))}
      </div>
    </div>
  )
}

interface NodeProps {
  node: PlanNode
  settings: PlannerSettings
  overrides: Map<string, boolean>
  toggle: (id: string, currentlyOpen: boolean) => void
}

function Node({ node, settings, overrides, toggle }: NodeProps) {
  const hasKids = node.children.length > 0
  const open = hasKids && (overrides.get(node.id) ?? node.depth < AUTO_OPEN_DEPTH)

  const cap = capacityFor(node.item, node.ratePerMin, settings)
  const step = node.step

  return (
    <div className="node">
      <div className="link">
        <button
          type="button"
          className="twist"
          data-empty={!hasKids}
          aria-label={open ? `Collapse ${node.item.name}` : `Expand ${node.item.name}`}
          aria-expanded={hasKids ? open : undefined}
          onClick={() => hasKids && toggle(node.id, open)}
        >
          {hasKids ? (open ? '▼' : '▶') : ''}
        </button>

        <span
          className="rate"
          data-fluid={node.item.isFluid}
          data-over={cap.over}
          title={
            cap.over
              ? `${fmt(node.ratePerMin)} ${unit(node.item)} exceeds one ${cap.name} at ${fmt(cap.limit)}. Needs ${cap.lines} lines.`
              : `${fmt(node.ratePerMin)} ${unit(node.item)}`
          }
        >
          {fmt(node.ratePerMin)}
        </span>

        {/* The tier is only worth printing when it isn't just the one you
            already picked: either several lines, or over capacity. */}
        {(cap.lines > 1 || cap.over) && (
          <span className="link-belt" data-over={cap.over}>{linesLabel(cap)}</span>
        )}

        <div className="node-card" data-kind={node.kind}>
          <ItemChip item={node.item} />
          <span className="node-name">{node.item.name}</span>

          {step ? (
            <>
              <span
                className="node-machines"
                title={`${fmt(node.machines, 2)} machines for this branch`}
              >
                {Math.ceil(node.machines - 1e-9)}× {step.building?.name ?? '—'}
              </span>
              <span className="node-meta">
                {/* The recipe name repeats the item name for standard recipes,
                    so only show it when it actually adds something. */}
                {step.recipe.isAlternate && `Alt: ${step.recipe.name}`}
                {!step.recipe.isAlternate && step.recipe.name !== node.item.name && step.recipe.name}
                {step.clock !== 1 && ` · ${fmt(step.clock * 100, 1)}%`}
                {step.sloops > 0 && ` · ${step.sloops} sloop${step.sloops > 1 ? 's' : ''}`}
              </span>
              <span className="node-power">{fmtPower(node.powerMW)}</span>
            </>
          ) : (
            <span className="node-meta">
              {node.kind === 'imported' ? 'supplied externally' : 'extracted'}
            </span>
          )}

          {node.isRepeat && <span className="loop-note">loop — balanced above</span>}
        </div>
      </div>

      {open && (
        <div className="node-kids">
          {node.children.map((child) => (
            <Node key={child.id} node={child} settings={settings} overrides={overrides} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  )
}
