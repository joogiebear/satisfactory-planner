import { useMemo, useState } from 'react'
import { fuelTargets, planPower, type PowerOption } from '../../core/power'
import type { Plan, PlanTarget, PlannerSettings } from '../../core/types'
import { fmt, fmtPower } from '../format'
import { ItemChip } from './ItemPicker'

const BLOCKER_LABEL: Record<string, string> = {
  gathered: 'Gathered by hand',
  locked: 'Locked by your settings',
  runaway: 'Costs more than it makes',
}

const BLOCKER_WHY: Record<string, string> = {
  gathered: 'The chain bottoms out in something the game gives no recipe for — you pick it up rather than automate it.',
  locked: 'Recipes for this exist, but none are available right now: check the tier limit, banned recipes and unlocked alternates.',
  runaway: 'Making the fuel draws more power than burning it yields, so no number of generators covers the load.',
}

interface Props {
  plan: Plan
  settings: PlannerSettings
  setTargets: (t: PlanTarget[]) => void
  /** Jump to the production views once a fuel supply has been turned into a plan. */
  onPlanned: () => void
}

export function PowerPanel({ plan, settings, setTargets, onPlanned }: Props) {
  const draw = plan.totals.totalPowerMW
  const [demand, setDemand] = useState(() => Math.round(draw * 10) / 10)
  const [open, setOpen] = useState<string | null>(null)

  const options = useMemo(() => planPower(demand, settings), [demand, settings])
  const buildable = options.filter((o) => o.blocker === null).length

  return (
    <div className="panel">
      <div className="panel-head">
        Power
        <span className="count">
          {buildable} of {options.length} option{options.length === 1 ? '' : 's'} you could build
        </span>
      </div>

      <div className="power-bar">
        <span className="field-label">Cover</span>
        <div className="power-demand">
          <input
            className="prog-minutes"
            type="number"
            min={0}
            step={1}
            value={demand}
            aria-label="Power to cover, in megawatts"
            onChange={(e) => setDemand(Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="muted prog-minutes-unit">MW</span>
          {Math.abs(demand - draw) > 0.05 && draw > 0 && (
            <button className="btn" onClick={() => setDemand(Math.round(draw * 10) / 10)}>
              Match plan ({fmtPower(draw)})
            </button>
          )}
        </div>
        <p className="muted power-blurb">
          Each option's generators cover this <em>and</em> the draw of the factory
          making its fuel — the overhead column. Divide the demand by a
          generator's rating instead and the plant browns out under its own
          mining and refining.
        </p>
      </div>

      {demand <= 0 ? (
        <p className="muted power-empty">Nothing to power yet. Add an output, or type a figure above.</p>
      ) : (
        <table className="power-table">
          <thead>
            <tr>
              <th>Generator</th>
              <th>Fuel</th>
              <th className="num">Build</th>
              <th className="num">Fuel rate</th>
              <th className="num">Overhead</th>
              <th className="num">Output</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {options.map((o) => (
              <OptionRow
                key={o.key}
                option={o}
                open={open === o.key}
                onToggle={() => setOpen(open === o.key ? null : o.key)}
                onPlan={() => { setTargets(fuelTargets(o)); onPlanned() }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function OptionRow({
  option, open, onToggle, onPlan,
}: {
  option: PowerOption
  open: boolean
  onToggle: () => void
  onPlan: () => void
}) {
  const units = Math.ceil(option.units - 1e-9)

  return (
    <>
      <tr className="power-row" data-blocked={option.blocker !== null}>
        <td>
          <button className="power-name" onClick={onToggle} aria-expanded={open}>
            {option.generator.name}
          </button>
        </td>
        <td>
          <span className="cell-item">
            <ItemChip item={option.fuelItem} />
            {option.fuelItem.name}
          </span>
        </td>
        <td className="num">
          {units}
          {option.units % 1 > 1e-6 && <span className="muted"> ({fmt(option.units, 2)})</span>}
        </td>
        <td className="num">{fmt(option.fuelPerMin, 2)}<span className="muted">/min</span></td>
        <td className="num muted">{option.overheadMW > 0.05 ? fmtPower(option.overheadMW) : '—'}</td>
        <td className="num muted">{fmtPower(option.outputMW)}</td>
        <td>
          {option.blocker ? (
            <span className="power-blocked" title={BLOCKER_WHY[option.blocker]}>
              {BLOCKER_LABEL[option.blocker]}
            </span>
          ) : (
            <button className="btn" onClick={onPlan}>Plan the fuel</button>
          )}
        </td>
      </tr>

      {open && (
        <tr className="power-detail">
          <td colSpan={7}>
            <Detail option={option} />
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ option }: { option: PowerOption }) {
  const fuelPlan = option.fuelPlan

  return (
    <div className="power-detail-body">
      {option.blocker && (
        <p className="power-why">{BLOCKER_WHY[option.blocker]}</p>
      )}

      <ul className="power-facts">
        <li>
          <span className="muted">Each generator</span>
          {fmtPower(option.generator.powerMW)} from {fmt(option.fuel.ratePerMin, 3)} {option.fuelItem.name}/min
        </li>
        {option.supplementalItem && option.supplementalPerMin > 0 && (
          <li>
            <span className="muted">Also needs</span>
            {fmt(option.supplementalPerMin, 2)} {option.supplementalItem.name}/min
          </li>
        )}
        {option.byproductItem && option.byproductPerMin > 0 && (
          <li>
            <span className="muted">Produces waste</span>
            {fmt(option.byproductPerMin, 2)} {option.byproductItem.name}/min
          </li>
        )}
        {option.imported.length > 0 && (
          <li>
            <span className="muted">You supply</span>
            {option.imported.map((i) => i.name).join(', ')}
          </li>
        )}
      </ul>

      {fuelPlan && fuelPlan.steps.length > 0 && (
        <div className="power-supply">
          <h4>Making the fuel</h4>
          <p className="muted">
            {Math.ceil(fuelPlan.totals.machines - 1e-9)} machines drawing{' '}
            {fmtPower(fuelPlan.totals.totalPowerMW)}, from{' '}
            {fuelPlan.raw.map((r) => `${fmt(r.ratePerMin, 1)} ${r.item.name}`).join(', ') || 'nothing'}.
          </p>
        </div>
      )}
    </div>
  )
}
