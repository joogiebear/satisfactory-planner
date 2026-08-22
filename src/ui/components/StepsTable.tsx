import type { Plan, PlannerSettings, ProductionStep } from '../../core/types'
import { fmt, fmtPower, unit } from '../format'
import { ItemChip } from './ItemPicker'

interface Props {
  plan: Plan
  settings: PlannerSettings
  onTune: (recipeKey: string, patch: { clock?: number; sloops?: number }) => void
}

export function StepsTable({ plan, settings, onTune }: Props) {
  return (
    <div className="panel">
      <div className="panel-head">
        Production steps
        <span className="count">{plan.steps.length} recipes · clock and sloops are editable</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Output</th>
            <th className="num">Rate</th>
            <th>Recipe</th>
            <th>Building</th>
            <th className="num">Machines</th>
            <th className="num">Clock</th>
            <th className="num">Sloops</th>
            <th className="num">Power</th>
            <th>Inputs</th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.map((step) => (
            <Row key={step.recipe.key} step={step} settings={settings} onTune={onTune} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ step, settings, onTune }: { step: ProductionStep; settings: PlannerSettings; onTune: Props['onTune'] }) {
  const slots = step.building?.sloopSlots ?? 0
  const tuning = settings.tuning[step.recipe.key]

  return (
    <tr>
      <td>
        <span className="cell-item">
          <ItemChip item={step.primaryItem} />
          {step.primaryItem.name}
        </span>
      </td>
      <td className="num">
        {fmt(step.primaryRatePerMin)} <span className="muted">{unit(step.primaryItem)}</span>
      </td>
      <td className={step.recipe.isAlternate ? '' : 'muted'}>
        {step.recipe.isAlternate ? `Alt: ${step.recipe.name}` : step.recipe.name}
      </td>
      <td className="nowrap">{step.building?.name ?? '—'}</td>
      <td className="num">
        {Math.ceil(step.machines - 1e-9)}
        {step.machines % 1 > 1e-6 && <span className="muted"> ({fmt(step.machines, 2)})</span>}
      </td>
      <td className="num">
        <input
          type="number"
          min={1}
          max={250}
          step={1}
          value={Math.round((tuning?.clock ?? settings.defaultClock) * 1000) / 10}
          onChange={(e) => onTune(step.recipe.key, { clock: Number(e.target.value) / 100 })}
          style={{ width: 68 }}
          aria-label={`Clock speed for ${step.recipe.name}`}
        />
      </td>
      <td className="num">
        {slots > 0 ? (
          <input
            type="number"
            min={0}
            max={slots}
            step={1}
            value={tuning?.sloops ?? 0}
            onChange={(e) => onTune(step.recipe.key, { sloops: Number(e.target.value) })}
            style={{ width: 54 }}
            aria-label={`Somersloops for ${step.recipe.name}`}
            title={`${slots} slot${slots > 1 ? 's' : ''} available`}
          />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num">{fmtPower(step.powerMW)}</td>
      <td className="muted" style={{ fontSize: 12 }}>
        {step.inputs.length === 0
          ? '—'
          : step.inputs.map((i) => `${fmt(i.ratePerMin)} ${i.item.name}`).join(' · ')}
      </td>
    </tr>
  )
}
