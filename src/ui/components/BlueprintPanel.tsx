import { useRef, useState } from 'react'
import { parseBlueprint, type BlueprintInfo } from '../../core/blueprint'
import type { Plan } from '../../core/types'
import { fmt } from '../format'
import { ItemChip } from './ItemPicker'

export function BlueprintPanel({ plan }: { plan: Plan }) {
  const [blueprint, setBlueprint] = useState<BlueprintInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const open = async (file: File) => {
    setError(null)
    if (!file.name.toLowerCase().endsWith('.sbp')) {
      setError(`${file.name} isn't a .sbp file. Blueprints live in AppData\\Local\\FactoryGame\\Saved\\SaveGames\\blueprints.`)
      return
    }
    try {
      setBlueprint(await parseBlueprint(await file.arrayBuffer(), file.name.replace(/\.sbp$/i, '')))
    } catch (e) {
      setBlueprint(null)
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    }
  }

  return (
    <>
      <div
        className="dropzone"
        data-dragging={dragging}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) void open(file)
        }}
      >
        <p className="dropzone-title">Drop a blueprint here</p>
        <p className="hint">
          Reads .sbp files from <code>AppData\Local\FactoryGame\Saved\SaveGames\blueprints</code> —
          its build cost, dimensions and every building inside it.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
          Choose a file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".sbp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void open(file)
            e.target.value = ''
          }}
        />
      </div>

      {error && <div className="notice" data-kind="error">{error}</div>}

      {blueprint && <Details blueprint={blueprint} plan={plan} />}
    </>
  )
}

function Details({ blueprint, plan }: { blueprint: BlueprintInfo; plan: Plan }) {
  // How many of each production building the current plan calls for, so a
  // blueprint can be checked against it.
  const planned = new Map<string, number>()
  for (const s of plan.steps) {
    planned.set(s.recipe.machine, (planned.get(s.recipe.machine) ?? 0) + Math.ceil(s.machines - 1e-9))
  }

  return (
    <>
      {blueprint.warnings.map((w) => (
        <div className="notice" key={w}>{w}</div>
      ))}

      <div className="rail">
        <Stat label="Blueprint" value={blueprint.name} small />
        <Stat label="Footprint" value={`${blueprint.dimensions.x}×${blueprint.dimensions.y}×${blueprint.dimensions.z}`} />
        <Stat label="Buildings" value={String(blueprint.totalBuildings)} accent />
        <Stat label="Machines" value={String(blueprint.productionBuildings.reduce((n, b) => n + b.count, 0))} />
        <Stat label="Saved by build" value={String(blueprint.buildVersion)} small />
      </div>

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
              {blueprint.productionBuildings.map((b) => {
                const need = planned.get(b.key) ?? 0
                return (
                  <tr key={b.key}>
                    <td>{b.name}</td>
                    <td className="num">{b.count}</td>
                    <td className="num">{need || <span className="muted">—</span>}</td>
                    <td className="num">
                      {need ? `${fmt(need / b.count, 2)}×` : <span className="muted">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          Build cost
          <span className="count">{blueprint.cost.length} item types</span>
        </div>
        <table>
          <thead>
            <tr><th>Item</th><th className="num">Amount</th></tr>
          </thead>
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
          <span className="count">{blueprint.buildings.length} building types · {blueprint.objectCount} objects</span>
        </div>
        <table>
          <thead>
            <tr><th>Building</th><th className="num">Count</th></tr>
          </thead>
          <tbody>
            {blueprint.buildings.map((b) => (
              <tr key={b.key}>
                <td className={b.isProduction ? '' : 'muted'}>{b.name}</td>
                <td className="num">{b.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Stat({ label, value, accent, small }: { label: string; value: string; accent?: boolean; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value"
        data-accent={accent ? 'amber' : undefined}
        style={small ? { fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' } : undefined}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}
