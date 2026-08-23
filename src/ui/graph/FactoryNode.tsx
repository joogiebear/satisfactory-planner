import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { FlowNodeData, Port } from './model'
import { fmt, fmtPower } from '../format'
import { iconFor } from '../icons'
import { initials } from '../format'
import type { GameItem } from '../../core/types'

export type FactoryNodeType = Node<FlowNodeData, 'factory'>

/** Item icon, falling back to a tinted letter tile when art isn't downloaded. */
export function Icon({ item, size = 20 }: { item: GameItem; size?: number }) {
  const src = iconFor(item.key)
  if (src) {
    return <img className="gi" src={src} alt="" width={size} height={size} title={item.name} />
  }
  return (
    <span className="gi gi-letter" data-fluid={item.isFluid} style={{ width: size, height: size }} title={item.name}>
      {initials(item.name)}
    </span>
  )
}

/** Building icon for the card header. */
function BuildingIcon({ nodeKey, label, size = 34 }: { nodeKey: string | null; label: string; size?: number }) {
  const src = nodeKey ? iconFor(nodeKey) : undefined
  if (src) return <img className="gi" src={src} alt="" width={size} height={size} title={label} />
  return <span className="gi gi-letter" style={{ width: size, height: size }}>{initials(label)}</span>
}

function PortRow({ port, side }: { port: Port; side: 'in' | 'out' }) {
  return (
    <div className="port" data-side={side}>
      <Handle
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        id={`${side}:${port.item.key}`}
        className="port-dot"
        data-fluid={port.item.isFluid}
      />
      <Icon item={port.item} size={18} />
      <span className="port-name">{port.item.name}</span>
      <span className="port-rate">
        {fmt(port.ratePerMin)}
        <span className="port-unit">{port.item.isFluid ? ' m³' : ''}</span>
      </span>
    </div>
  )
}

export function FactoryNode({ data, selected }: NodeProps<FactoryNodeType>) {
  const { kind, step, raw, power } = data

  const headerKey =
    kind === 'machine' ? step?.recipe.machine ?? null
      : kind === 'power' ? power?.generator.key ?? null
        : kind === 'source' ? null
          : data.item?.key ?? null

  return (
    <div
      className="fnode"
      data-kind={kind}
      data-selected={selected}
      style={{ width: data.width, minHeight: data.height }}
    >
      <div className="fnode-head">
        {kind === 'source' && data.item
          ? <Icon item={data.item} size={30} />
          : <BuildingIcon nodeKey={headerKey} label={data.title} size={30} />}

        <div className="fnode-titles">
          <div className="fnode-title">{data.title}</div>
          <div className="fnode-sub">{data.subtitle}</div>
        </div>

        {kind === 'power' && power
          ? <div className="fnode-power fnode-power-out">+{fmtPower(power.outputMW)}</div>
          : data.powerMW > 0 && <div className="fnode-power">{fmtPower(data.powerMW)}</div>}
      </div>

      {(step?.clock !== 1 || (step?.sloops ?? 0) > 0) && step && (
        <div className="fnode-badges">
          {step.clock !== 1 && <span className="badge">{fmt(step.clock * 100, 1)}%</span>}
          {step.sloops > 0 && (
            <span className="badge badge-sloop">
              {step.sloops} sloop{step.sloops > 1 ? 's' : ''} · ×{fmt(step.sloopMultiplier, 2)}
            </span>
          )}
        </div>
      )}

      {kind === 'power' && power && (
        <div className="fnode-badges">
          <span className="badge">{fmt(power.generator.powerMW)} MW each</span>
          {power.overheadMW > 0.05 && (
            <span className="badge" title="What the factory making this fuel draws, which these generators also cover">
              +{fmt(power.overheadMW, 0)} MW to feed itself
            </span>
          )}
        </div>
      )}

      {raw && raw.extractor && (
        <div className="fnode-badges">
          <span className="badge">{fmt(raw.ratePerExtractor)}/min each</span>
        </div>
      )}

      <div className="fnode-ports">
        {data.inputs.length > 0 && (
          <div className="port-group">
            {data.inputs.map((p) => <PortRow key={`in-${p.item.key}`} port={p} side="in" />)}
          </div>
        )}
        {data.outputs.length > 0 && (
          <div className="port-group port-group-out">
            {data.outputs.map((p) => <PortRow key={`out-${p.item.key}`} port={p} side="out" />)}
          </div>
        )}
      </div>
    </div>
  )
}
