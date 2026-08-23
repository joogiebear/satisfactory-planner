import { useMemo } from 'react'
import { miners, recipes as allRecipes, items } from '../../core/gameData'
import type { PlannerSettings } from '../../core/types'
import type { FlowNodeData } from './model'
import { fmt, fmtPower, unit } from '../format'
import { Icon } from './FactoryNode'

/** The clock a resource uses when its own miner has not been set. */
function rawClockDefault(ex: { key: string; kind: string }, settings: PlannerSettings): number {
  if (ex.key === 'Build_WaterPump_C') return settings.extraction.waterExtractorClock
  if (ex.key === 'Build_OilPump_C' || ex.kind === 'fracking') return settings.extraction.oilExtractorClock
  return settings.extraction.minerClock
}

interface Props {
  data: FlowNodeData
  settings: PlannerSettings
  setSettings: (next: PlannerSettings) => void
  onClose: () => void
}

/** Panel for the selected machine: swap its recipe, set clock and Somersloops. */
export function NodeInspector({ data, settings, setSettings, onClose }: Props) {
  const { step, raw } = data
  const producedItem = step?.primaryItem ?? null

  // Every recipe that could make this item, alternates included so they can be
  // chosen here even if they haven't been ticked in the sidebar yet.
  const options = useMemo(() => {
    if (!producedItem) return []
    return Object.values(allRecipes)
      .filter((r) => r.products[0]?.item === producedItem.key)
      .sort((a, b) => Number(a.isAlternate) - Number(b.isAlternate) || a.name.localeCompare(b.name))
  }, [producedItem])

  const pinned = producedItem ? settings.pinnedRecipes[producedItem.key] : undefined
  const unlocked = new Set(settings.unlockedAlternates)

  const chooseRecipe = (recipeKey: string) => {
    if (!producedItem) return
    const next = { ...settings }
    const pins = { ...settings.pinnedRecipes }
    if (!recipeKey) {
      delete pins[producedItem.key]
    } else {
      pins[producedItem.key] = recipeKey
      // Picking a locked alternate here implies unlocking it; otherwise the
      // solver would filter out the very recipe just chosen.
      const recipe = allRecipes[recipeKey]
      if (recipe?.isAlternate && !unlocked.has(recipeKey)) {
        next.unlockedAlternates = [...settings.unlockedAlternates, recipeKey]
      }
    }
    next.pinnedRecipes = pins
    setSettings(next)
  }

  const tune = (patch: { clock?: number; sloops?: number }) => {
    if (!step) return
    const current = settings.tuning[step.recipe.key] ?? { clock: settings.defaultClock, sloops: 0 }
    setSettings({
      ...settings,
      tuning: { ...settings.tuning, [step.recipe.key]: { ...current, ...patch } },
    })
  }

  const slots = step?.building?.sloopSlots ?? 0

  return (
    <aside className="inspector">
      <div className="inspector-head">
        {data.item && <Icon item={data.item} size={26} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="inspector-title">{data.title}</div>
          <div className="inspector-sub">{data.subtitle}</div>
        </div>
        <button type="button" className="remove" aria-label="Close inspector" onClick={onClose}>✕</button>
      </div>

      <div className="inspector-body">
        {step && producedItem && options.length > 1 && (
          <div className="field">
            <label htmlFor="insp-recipe">Recipe for {producedItem.name}</label>
            <select
              id="insp-recipe"
              value={pinned ?? step.recipe.key}
              onChange={(e) => chooseRecipe(e.target.value)}
            >
              {options.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.isAlternate ? `Alt: ${r.name}` : r.name}
                  {r.isAlternate && !unlocked.has(r.key) ? ' (locks on)' : ''}
                </option>
              ))}
            </select>
            <p className="hint">
              {step.recipe.ingredients.map((i) => `${i.amount}× ${items[i.item]?.name ?? i.item}`).join(' + ')}
              {' → '}
              {step.recipe.products.map((p) => `${p.amount}× ${items[p.item]?.name ?? p.item}`).join(' + ')}
              {` in ${fmt(step.recipe.timeSeconds)}s`}
            </p>
            {pinned && (
              <button type="button" className="btn" onClick={() => chooseRecipe('')}>
                Unpin — let the solver choose
              </button>
            )}
          </div>
        )}

        {step && (
          <>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="insp-clock">Clock %</label>
                <input
                  id="insp-clock"
                  type="number"
                  min={1}
                  max={250}
                  step={1}
                  value={Math.round((settings.tuning[step.recipe.key]?.clock ?? settings.defaultClock) * 1000) / 10}
                  onChange={(e) => tune({ clock: Number(e.target.value) / 100 })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="insp-sloops">Somersloops</label>
                <input
                  id="insp-sloops"
                  type="number"
                  min={0}
                  max={slots}
                  step={1}
                  disabled={slots === 0}
                  value={settings.tuning[step.recipe.key]?.sloops ?? 0}
                  onChange={(e) => tune({ sloops: Number(e.target.value) })}
                />
                <p className="hint">
                  {slots === 0 ? 'Not supported by this building.' : `${slots} slot${slots > 1 ? 's' : ''} · ×2 output at full`}
                </p>
              </div>
            </div>

            <div className="field">
              <span className="field-label">Exactly</span>
              <p className="hint">
                {fmt(step.machines, 3)} machines running · build {Math.ceil(step.machines - 1e-9)} and
                underclock the last one. {fmtPower(step.powerMW)} total.
              </p>
            </div>
          </>
        )}

        {raw && raw.extractor && (
          <>
            {/* Set on the miner rather than in a global default: a survey turns
                up a pure iron node and an impure copper one, and they are
                separate machines with separate settings. */}
            {raw.extractor.kind === 'solid' && (
              <>
                <div className="field">
                  <label htmlFor="insp-miner">Miner</label>
                  <select
                    id="insp-miner"
                    value={settings.extraction.minerByResource?.[raw.item.key] ?? settings.extraction.minerKey}
                    onChange={(e) => setSettings({
                      ...settings,
                      extraction: {
                        ...settings.extraction,
                        minerByResource: { ...settings.extraction.minerByResource, [raw.item.key]: e.target.value },
                      },
                    })}
                  >
                    {miners.map((m) => (
                      <option key={m.key} value={m.key}>{m.name} — {fmt(m.baseRatePerMin)}/min normal</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <span className="field-label">Node purity</span>
                  <div className="segmented">
                    {(['impure', 'normal', 'pure'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={(settings.extraction.purity[raw.item.key] ?? settings.extraction.defaultPurity) === p}
                        onClick={() => setSettings({
                          ...settings,
                          extraction: {
                            ...settings.extraction,
                            purity: { ...settings.extraction.purity, [raw.item.key]: p },
                          },
                        })}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="field">
              <label htmlFor="insp-exclock">Overclock %</label>
              <input
                id="insp-exclock"
                type="number"
                min={1}
                max={250}
                step={1}
                value={Math.round((settings.extraction.clockByResource?.[raw.item.key]
                  ?? rawClockDefault(raw.extractor, settings)) * 1000) / 10}
                onChange={(e) => setSettings({
                  ...settings,
                  extraction: {
                    ...settings.extraction,
                    clockByResource: {
                      ...settings.extraction.clockByResource,
                      [raw.item.key]: Math.max(0.01, Number(e.target.value) / 100),
                    },
                  },
                })}
              />
            </div>

            {/* Setting each node separately is right, but a base with Mk.3
                miners everywhere should not mean clicking every one of them. */}
            <button
              className="btn"
              onClick={() => setSettings({
                ...settings,
                extraction: {
                  ...settings.extraction,
                  minerKey: settings.extraction.minerByResource?.[raw.item.key] ?? settings.extraction.minerKey,
                  minerClock: settings.extraction.clockByResource?.[raw.item.key] ?? settings.extraction.minerClock,
                  defaultPurity: settings.extraction.purity[raw.item.key] ?? settings.extraction.defaultPurity,
                  minerByResource: {},
                  clockByResource: {},
                  purity: {},
                },
              })}
              title="Give every other miner this mark, purity and overclock"
            >
              Use these for every miner
            </button>

            <div className="field">
              <span className="field-label">Exactly</span>
              <p className="hint">
                {raw.extractor.name}{raw.purity ? ` on a ${raw.purity} node` : ''} delivers {fmt(raw.ratePerExtractor)} {unit(raw.item)}.
                This plan needs {fmt(raw.ratePerMin)}, so {Math.ceil(raw.extractorCount - 1e-9)} node
                {Math.ceil(raw.extractorCount - 1e-9) === 1 ? '' : 's'} ({fmt(raw.extractorCount, 2)} used).
              </p>
            </div>
          </>
        )}

        {(data.inputs.length > 0 || data.outputs.length > 0) && (
          <div className="field">
            <span className="field-label">Throughput</span>
            <table className="mini">
              <tbody>
                {data.inputs.map((p) => (
                  <tr key={`i-${p.item.key}`}>
                    <td className="muted">in</td>
                    <td><span className="cell-item"><Icon item={p.item} size={16} />{p.item.name}</span></td>
                    <td className="num">{fmt(p.ratePerMin)}</td>
                  </tr>
                ))}
                {data.outputs.map((p) => (
                  <tr key={`o-${p.item.key}`}>
                    <td className="muted">out</td>
                    <td><span className="cell-item"><Icon item={p.item} size={16} />{p.item.name}</span></td>
                    <td className="num">{fmt(p.ratePerMin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </aside>
  )
}
