import { useMemo, useRef, useState } from 'react'
import { parseBlueprint, type BlueprintInfo } from '../../core/blueprint'
import type { Plan } from '../../core/types'
import { fmt } from '../format'
import { ItemChip } from './ItemPicker'
import { Icon } from '../graph/FactoryNode'
import { BlueprintViewer } from '../blueprint/BlueprintViewer'

const CATEGORY_LABELS: Record<string, string> = {
  machine: 'Machines',
  foundation: 'Foundations',
  wall: 'Walls',
  conveyor: 'Belts & lifts',
  pipe: 'Pipes',
  power: 'Power',
  storage: 'Storage',
  other: 'Other',
}

const CATEGORY_SWATCH: Record<string, string> = {
  machine: '#f89a3c',
  foundation: '#39424c',
  wall: '#4d5763',
  conveyor: '#d8853a',
  pipe: '#4fb8c9',
  power: '#8e7cc3',
  storage: '#6fbf73',
  other: '#5a646f',
}

export function BlueprintPanel({ plan }: { plan: Plan }) {
  const [blueprint, setBlueprint] = useState<BlueprintInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  const open = async (file: File) => {
    setError(null)
    if (!file.name.toLowerCase().endsWith('.sbp')) {
      setError(`${file.name} isn't a .sbp file. Blueprints live in AppData\\Local\\FactoryGame\\Saved\\SaveGames\\blueprints.`)
      return
    }
    setBusy(true)
    try {
      const parsed = await parseBlueprint(await file.arrayBuffer(), file.name.replace(/\.sbp$/i, ''))
      setBlueprint(parsed)
      setHidden(new Set())
    } catch (e) {
      setBlueprint(null)
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  const onFile = (file: File | undefined) => { if (file) void open(file) }

  return (
    <>
      {!blueprint && (
        <div
          className="dropzone"
          data-dragging={dragging}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0]) }}
        >
          <p className="dropzone-title">Drop a blueprint here</p>
          <p className="hint">
            Reads .sbp files from <code>AppData\Local\FactoryGame\Saved\SaveGames\blueprints</code> and
            shows what's inside — the layout in 3D, the build cost, and how its machines line up with your plan.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Choose a file'}
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".sbp"
        hidden
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }}
      />

      {error && <div className="notice" data-kind="error">{error}</div>}

      {blueprint && (
        <Details
          blueprint={blueprint}
          plan={plan}
          hidden={hidden}
          setHidden={setHidden}
          onReplace={() => inputRef.current?.click()}
        />
      )}
    </>
  )
}

interface DetailsProps {
  blueprint: BlueprintInfo
  plan: Plan
  hidden: Set<string>
  setHidden: (next: Set<string>) => void
  onReplace: () => void
}

function Details({ blueprint, plan, hidden, setHidden, onReplace }: DetailsProps) {
  // Machines the current plan calls for, so a blueprint can be checked against it.
  const planned = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of plan.steps) {
      map.set(s.recipe.machine, (map.get(s.recipe.machine) ?? 0) + Math.ceil(s.machines - 1e-9))
    }
    return map
  }, [plan])

  const categories = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of blueprint.placements) map.set(p.category, (map.get(p.category) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [blueprint])

  const toggle = (category: string) => {
    const next = new Set(hidden)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    setHidden(next)
  }

  const b = blueprint.bounds
  const metres = b
    ? `${Math.round((b.max[0] - b.min[0]) / 100)} × ${Math.round((b.max[1] - b.min[1]) / 100)} × ${Math.round((b.max[2] - b.min[2]) / 100)} m`
    : '—'

  return (
    <>
      {blueprint.warnings.map((w) => <div className="notice" key={w}>{w}</div>)}

      <div className="bp-head">
        <div>
          <div className="bp-name">{blueprint.name}</div>
          <div className="bp-meta">
            {blueprint.dimensions.x}×{blueprint.dimensions.y}×{blueprint.dimensions.z} designer
            · {metres} used · {blueprint.totalBuildings} buildings · saved by build {blueprint.buildVersion}
          </div>
        </div>
        <button type="button" className="btn" onClick={onReplace}>Open another</button>
      </div>

      {blueprint.placements.length > 0 && (
        <div className="bp-stage">
          <BlueprintViewer blueprint={blueprint} hidden={hidden} />
          <div className="bp-filters">
            {categories.map(([category, count]) => (
              <button
                key={category}
                type="button"
                className="bp-filter"
                aria-pressed={!hidden.has(category)}
                onClick={() => toggle(category)}
                title={hidden.has(category) ? 'Show these' : 'Hide these'}
              >
                <i className="sw" style={{ background: CATEGORY_SWATCH[category] ?? '#5a646f' }} />
                {CATEGORY_LABELS[category] ?? category}
                <span className="bp-filter-count">{count}</span>
              </button>
            ))}
          </div>
          <p className="hint bp-note">
            Drag to orbit, scroll to zoom, hover a building to name it. Belts, lifts, pipes and power
            lines are stored as paths rather than boxes, so they show as small markers along their run.
          </p>
        </div>
      )}

      {blueprint.productionBuildings.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            Production machines
            <span className="count">compared with the current plan</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Machine</th>
                <th className="num">In blueprint</th>
                <th className="num">Plan needs</th>
                <th className="num">Stamps</th>
              </tr>
            </thead>
            <tbody>
              {blueprint.productionBuildings.map((bld) => {
                const need = planned.get(bld.key) ?? 0
                return (
                  <tr key={bld.key}>
                    <td>
                      <span className="cell-item">
                        <BuildingIcon buildingKey={bld.key} label={bld.name} />
                        {bld.name}
                      </span>
                    </td>
                    <td className="num">{bld.count}</td>
                    <td className="num">{need || <span className="muted">—</span>}</td>
                    <td className="num">{need ? `${fmt(need / bld.count, 2)}×` : <span className="muted">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="bp-columns">
        <div className="panel">
          <div className="panel-head">
            Build cost
            <span className="count">{blueprint.cost.length} item types</span>
          </div>
          <table>
            <thead><tr><th>Item</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {blueprint.cost.map((c) => (
                <tr key={c.key}>
                  <td>
                    <span className="cell-item">
                      {c.item ? <ItemChip item={c.item} /> : <span className="chip" aria-hidden="true">?</span>}
                      {c.name}
                    </span>
                  </td>
                  <td className="num">{c.amount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head">
            Everything in it
            <span className="count">{blueprint.buildings.length} types · {blueprint.objectCount} objects</span>
          </div>
          <table>
            <thead><tr><th>Building</th><th className="num">Count</th></tr></thead>
            <tbody>
              {blueprint.buildings.map((bld) => (
                <tr key={bld.key}>
                  <td className={bld.isProduction ? '' : 'muted'}>
                    <span className="cell-item">
                      <BuildingIcon buildingKey={bld.key} label={bld.name} />
                      {bld.name}
                    </span>
                  </td>
                  <td className="num">{bld.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/** Machines have icons; scenery like walls doesn't, so it falls back to a dot. */
function BuildingIcon({ buildingKey, label }: { buildingKey: string; label: string }) {
  const fake = { key: buildingKey, name: label, isFluid: false, isRaw: false } as never
  return <Icon item={fake} size={18} />
}
