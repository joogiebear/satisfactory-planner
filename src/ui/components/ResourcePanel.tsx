import { useMemo, useState } from 'react'
import { items, miners, rawResources } from '../../core/gameData'
import { bestFrom, supplyOf, type Available, type Candidate } from '../../core/fromResources'
import { generatorOptions, type GeneratorCost } from '../../core/selfPowered'
import { buildRawRequirement } from '../../core/solver'
import type { PlanTarget, PlannerSettings } from '../../core/types'
import { fmt, fmtPower, unit } from '../format'
import { Icon } from '../graph/FactoryNode'
import { ItemPicker } from './ItemPicker'

/**
 * The planner asked backwards: here is what I found, what should I build?
 *
 * Everything else in the app starts from the thing you want. Standing on a
 * fresh patch of map you don't have a thing you want yet — you have three
 * nodes and a question. This ranks what those nodes could actually feed, and
 * hands the winner to the planner as a real factory.
 */

/** Placed on a shoreline rather than mined, so it is never the thing you have. */
const UNLIMITED = new Set(['Desc_Water_C'])

const SORTS = {
  value: { label: 'Most valuable', of: (c: Candidate) => c.sinkPointsPerMin },
  output: { label: 'Most items', of: (c: Candidate) => c.ratePerMin },
  lean: { label: 'Fewest machines', of: (c: Candidate) => -c.machines },
} as const
type SortKey = keyof typeof SORTS

/** Named as the sidebar names them, so it is clear which control is in play. */
const OBJECTIVE_LABEL: Record<PlannerSettings['objective'], string> = {
  raw: 'Resources',
  buildings: 'Machines',
  power: 'Power',
}

const STORAGE_KEY = 'satisfactory-planner/resources'
const POWER_KEY = 'satisfactory-planner/resources-power'

/** The value that means "assume the grid is already there". */
const GRID = ''

interface Held { item: string; nodes: number }

function loadHeld(): Held[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as Held[]).filter((h) => items[h.item] && h.nodes > 0)
  } catch { return [] }
}

interface Props {
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
  setTargets: (t: PlanTarget[]) => void
  /** Jump to the production views once a candidate has been turned into a plan. */
  onPlanned: () => void
}

export function ResourcePanel({ settings, setSettings, setTargets, onPlanned }: Props) {
  const [held, setHeld] = useState<Held[]>(loadHeld)
  const [sort, setSort] = useState<SortKey>('value')
  const [adding, setAdding] = useState(false)
  const [powerKey, setPowerKey] = useState<string>(() => {
    try { return localStorage.getItem(POWER_KEY) ?? GRID } catch { return GRID }
  })

  const save = (next: Held[]) => {
    setHeld(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }

  // Purity lives on the miner, the same setting the factory view edits, so a
  // node declared pure here stays pure when the plan opens.
  const available = useMemo<Available[]>(() => held.map((h) => ({
    item: h.item,
    nodes: h.nodes,
    purity: settings.extraction.purity[h.item] ?? settings.extraction.defaultPurity,
  })), [held, settings.extraction.purity, settings.extraction.defaultPurity])

  const supply = useMemo(() => supplyOf(available, settings), [available, settings])

  // Generators you have the fuel for come first: a nuclear plant is the biggest
  // number on the list and no use at all on an iron and coal patch.
  const plants = useMemo(() => {
    const all = generatorOptions(settings)
    const fuelled = (g: GeneratorCost) => [...g.draws.keys()].every((k) => k === 'Desc_Water_C' || supply.has(k))
    return [...all].sort((a, b) => Number(fuelled(b)) - Number(fuelled(a)) || b.netMW - a.netMW)
  }, [settings, supply])

  const chosenPlant = plants.find((g) => plantKey(g) === powerKey) ?? null

  const ranked = useMemo(
    () => bestFrom(available, settings, chosenPlant),
    [available, settings, chosenPlant],
  )

  const sorted = useMemo(
    () => [...ranked].sort((a, b) => SORTS[sort].of(b) - SORTS[sort].of(a)),
    [ranked, sort],
  )

  const tunedCount = ranked.filter((c) => c.tuned).length

  const choosePower = (key: string) => {
    setPowerKey(key)
    try { localStorage.setItem(POWER_KEY, key) } catch { /* private mode */ }
  }

  const pickable = rawResources.filter(
    (r) => !UNLIMITED.has(r.key) && !held.some((h) => h.item === r.key),
  )

  const plan = (c: Candidate) => {
    setTargets([{ item: c.item.key, ratePerMin: c.ratePerMin }])
    onPlanned()
  }

  return (
    <div className="panel">
      <div className="panel-head">
        What you have
        <span className="count">
          {ranked.length === 0 ? 'nothing to make yet' : `${ranked.length} things you could make`}
        </span>
      </div>

      <div className="res-held">
        {held.map((h) => (
          <HeldRow
            key={h.item}
            held={h}
            settings={settings}
            setSettings={setSettings}
            supply={supply.get(h.item) ?? 0}
            onCount={(nodes) => save(held.map((x) => (x.item === h.item ? { ...x, nodes } : x)))}
            onRemove={() => save(held.filter((x) => x.item !== h.item))}
          />
        ))}

        {adding ? (
          <div className="res-add-open">
            <ItemPicker
              items={pickable}
              placeholder="Which resource did you find?"
              emptyText="Nothing left to add."
              onPick={(item) => { save([...held, { item: item.key, nodes: 1 }]); setAdding(false) }}
            />
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn btn-primary res-add" onClick={() => setAdding(true)}>
            + Add a resource
          </button>
        )}
      </div>

      {held.length === 0 ? (
        <p className="muted res-empty">
          List the nodes you've surveyed — the ore, the oil, the coal — and this works out
          everything they could feed and how big each build would get. Water isn't listed:
          extractors go wherever there's a lake, so it never runs out.
        </p>
      ) : ranked.length === 0 ? (
        <p className="muted res-empty">
          Nothing can be made from that alone. Most chains need at least one more resource —
          add another node and see what opens up.
        </p>
      ) : (
        <>
          <div className="res-sort">
            <span className="field-label">Power</span>
            <select
              className="res-plant-pick"
              value={powerKey}
              aria-label="How the build is powered"
              onChange={(e) => choosePower(e.target.value)}
            >
              <option value={GRID}>From a grid you already have</option>
              {plants.map((g) => (
                <option key={plantKey(g)} value={plantKey(g)}>
                  {g.generator.name} on {items[g.fuel.item]?.name ?? g.fuel.item}
                </option>
              ))}
            </select>

            <span className="field-label">Rank by</span>
            <div className="segmented">
              {(Object.keys(SORTS) as SortKey[]).map((k) => (
                <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>
                  {SORTS[k].label}
                </button>
              ))}
            </div>
            <p className="muted res-blurb">
              Every row is sized until one of your nodes runs dry, so these are whole builds,
              not samples. The bars show how much of each resource it spends — a row leaving
              most of something untouched has room for a second factory beside it.
              {chosenPlant ? (
                <> The generators are part of the build and burn the same pile, so what you
                  see is what these machines run on their own — nothing plugged in from
                  elsewhere. The miners you declared draw their full rating whether or not
                  the factory takes everything they lift.</>
              ) : (
                <> Power is assumed to come from somewhere: pick a generator above to size
                  builds that run on their own resources instead.</>
              )}
              {settings.objective === 'raw' ? (
                <> Routes are picked to get the most out of what you have, counting whatever
                  you have least of as the dear one.</>
              ) : (
                <> Output comes first here: <em>{OBJECTIVE_LABEL[settings.objective]}</em> picks
                  between the routes that reach it rather than settling for less
                  {tunedCount > 0 && <>, which it managed on {tunedCount} of these</>}.</>
              )}
            </p>
          </div>

          <table className="data-table res-table">
            <thead>
              <tr>
                <th>Make</th>
                <th className="num">Output</th>
                <th className="num">Machines</th>
                {chosenPlant && <th className="num">Plant</th>}
                <th className="num">{chosenPlant ? 'Load' : 'Power'}</th>
                <th className="num">Sink points</th>
                <th>Uses</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.item.key}>
                  <td>
                    <span className="cell-item">
                      <Icon item={c.item} size={18} />
                      {c.item.name}
                    </span>
                  </td>
                  <td className="num">{fmt(c.ratePerMin, 2)}<span className="muted">{unit(c.item)}</span></td>
                  <td className="num">{Math.ceil(c.machines - 1e-9)}</td>
                  {chosenPlant && (
                    <td className="num" title="Generators, and the water pumps cooling them">
                      {Math.ceil((c.plant?.generators ?? 0) - 1e-9)}
                      <span className="muted"> gen</span>
                      {(c.plant?.pumps ?? 0) > 0 && (
                        <> · {c.plant!.pumps}<span className="muted"> pump</span></>
                      )}
                    </td>
                  )}
                  <td className="num muted">{fmtPower(c.powerMW)}</td>
                  <td className="num muted">{fmt(c.sinkPointsPerMin, 0)}<span className="muted">/min</span></td>
                  <td>
                    <div className="res-draws">
                      {c.draws.map((d) => (
                        <span
                          key={d.item.key}
                          className="res-draw"
                          data-binding={d.item.key === c.limitedBy?.key}
                          title={`${fmt(d.ratePerMin, 1)} ${d.item.name}/min — ${Math.round(d.fraction * 100)}% of what you have`}
                        >
                          <Icon item={d.item} size={14} />
                          <span className="res-bar">
                            <span style={{ width: `${Math.min(100, d.fraction * 100)}%` }} />
                          </span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button className="btn" onClick={() => plan(c)}>Plan this</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function HeldRow({
  held, settings, setSettings, supply, onCount, onRemove,
}: {
  held: Held
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
  supply: number
  onCount: (nodes: number) => void
  onRemove: () => void
}) {
  const item = items[held.item]
  if (!item) return null

  // Purity is a property of the extractor, not the item: miners read it, water
  // pumps ignore it, and the fracking gear has rules of its own.
  const extractor = buildRawRequirement(item, 0, settings).extractor
  const graded = extractor?.affectedByPurity ?? false
  const purity = settings.extraction.purity[held.item] ?? settings.extraction.defaultPurity
  // A miner mark is a machine you place, so it belongs on the row you placed it
  // on rather than on a global default that every node then has to override.
  const minable = extractor?.kind === 'solid'
  const minerKey = settings.extraction.minerByResource?.[held.item] ?? settings.extraction.minerKey

  return (
    <div className="res-row">
      <span className="cell-item res-row-name">
        <Icon item={item} size={20} />
        {item.name}
      </span>

      {minable && (
        <select
          className="res-miner"
          value={minerKey}
          aria-label={`Miner on the ${item.name} nodes`}
          onChange={(e) => setSettings({
            ...settings,
            extraction: {
              ...settings.extraction,
              minerByResource: { ...settings.extraction.minerByResource, [held.item]: e.target.value },
            },
          })}
        >
          {miners.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      )}

      {graded && (
        <div className="segmented res-purity">
          {(['impure', 'normal', 'pure'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={purity === p}
              onClick={() => setSettings({
                ...settings,
                extraction: {
                  ...settings.extraction,
                  purity: { ...settings.extraction.purity, [held.item]: p },
                },
              })}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <label className="res-count">
        <input
          type="number"
          min={1}
          step={1}
          value={held.nodes}
          aria-label={`How many ${item.name} nodes`}
          onChange={(e) => onCount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
        />
        <span className="muted">{minable ? `miner${held.nodes === 1 ? '' : 's'}` : `node${held.nodes === 1 ? '' : 's'}`}</span>
      </label>

      <span className="muted res-supply">{fmt(supply, 1)}/min</span>

      <button type="button" className="remove" aria-label={`Remove ${item.name}`} onClick={onRemove}>✕</button>
    </div>
  )
}

/** Stable id for a generator-and-fuel pairing. */
function plantKey(g: GeneratorCost): string {
  return `${g.generator.key}:${g.fuel.item}`
}
