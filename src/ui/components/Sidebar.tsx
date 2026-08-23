import { useMemo, useState } from 'react'
import {
  alternateRecipes, baseRatePerMin, belts, items, maxGameTier, pipes,
  producibleItems,
} from '../../core/gameData'
import type { Plan, PlanTarget, PlannerSettings } from '../../core/types'
import { oneMachineRate } from '../../core/solver'
import { fmt, unit } from '../format'
import { ItemChip, ItemPicker } from './ItemPicker'

interface Props {
  settings: PlannerSettings
  setSettings: (next: PlannerSettings) => void
  targets: PlanTarget[]
  setTargets: (next: PlanTarget[]) => void
  /** Kept so callers need not change; the panel no longer reads it. */
  plan?: Plan
}


export function Sidebar({ settings, setSettings, targets, setTargets }: Props) {
  const patch = (p: Partial<PlannerSettings>) => setSettings({ ...settings, ...p })

  return (
    <aside className="sidebar">
      <Section title="Output" defaultOpen count={`${targets.length}`}>
        <ItemPicker
          items={producibleItems}
          placeholder="Add an item to produce…"
          onPick={(item) => {
            if (targets.some((t) => t.item === item.key)) return
            const rate = oneMachineRate(item.key, settings) ?? baseRatePerMin(item.key)
            setTargets([...targets, { item: item.key, ratePerMin: rate, build: 1 }])
          }}
        />
        {targets.map((t, i) => {
          const item = items[t.item]
          if (!item) return null
          return (
            <div className="target" key={t.item}>
              <div className="target-top">
                <ItemChip item={item} />
                <span className="target-name">{item.name}</span>
                <button
                  type="button"
                  className="remove"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => setTargets(targets.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
              {/* What the factory makes, not what you asked it for. You pick the
                  item and how many machines; the rate is the answer. */}
              <div className="target-rate">
                <span className="target-out">{fmt(t.ratePerMin)}</span>
                <span className="unit">{unit(item)}</span>
              </div>
              {oneMachineRate(t.item, settings) === null ? (
                <p className="hint build-blocked">
                  Nothing available makes this — check the tier and the unlocked
                  alternates above.
                </p>
              ) : (
              <div className="build-scale">
                <span className="muted">Build</span>
                {[1, 2, 5, 10].map((n) => {
                  const one = oneMachineRate(t.item, settings)
                  if (!one) return null
                  const at = Math.round(one * n * 10000) / 10000
                  return (
                    <button
                      key={n}
                      className="btn btn-icon"
                      aria-pressed={(t.build ?? 1) === n}
                      title={`${n} machine${n === 1 ? '' : 's'} of ${item.name} — ${fmt(at)}/min`}
                      onClick={() => {
                        const next = targets.slice()
                        next[i] = { ...t, ratePerMin: at, build: n }
                        setTargets(next)
                      }}
                    >
                      ×{n}
                    </button>
                  )
                })}
                </div>
              )}
            </div>
          )
        })}
        {targets.length === 0 && <p className="hint">Pick an item above to start planning.</p>}
      </Section>

      <Section title="Recipe choice" count={settings.maxTier === null ? settings.objective : `T${settings.maxTier}`}>
        <div className="field">
          <span className="field-label">Optimise for</span>
          <div className="segmented">
            {(['raw', 'buildings', 'power'] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={settings.objective === o}
                onClick={() => patch({ objective: o })}
              >
                {o === 'raw' ? 'Resources' : o === 'buildings' ? 'Machines' : 'Power'}
              </button>
            ))}
          </div>
          <p className="hint">
            {settings.objective === 'raw'
              ? 'Spends the least on resources, counting scarce ones for more — bauxite costs seven times what iron does.'
              : settings.objective === 'buildings'
                ? 'Fewest machines to build, even where that spends scarcer resources.'
                : 'Lowest running power, even where that costs machines or ore.'}
          </p>
        </div>
        <div className="field">
          <span className="field-label">Unlocked up to</span>
          <div className="segmented tier-pick">
            <button
              type="button"
              aria-pressed={settings.maxTier === null}
              onClick={() => patch({ maxTier: null, allowResearch: true })}
              title="Plan with everything the game has"
            >
              All
            </button>
            {Array.from({ length: maxGameTier + 1 }, (_, tier) => (
              <button
                key={tier}
                type="button"
                aria-pressed={settings.maxTier === tier}
                onClick={() => patch({ maxTier: tier })}
                title={`Only machines and recipes you have by Tier ${tier}`}
              >
                {tier}
              </button>
            ))}
          </div>
          <p className="hint">
            {settings.maxTier === null
              ? 'Every machine in the game is fair game, whether or not you can build it yet.'
              : `Only what the HUB has given you by Tier ${settings.maxTier}. A Blender arrives at Tier 7, a Refinery at 5.`}
          </p>
        </div>

        {settings.maxTier !== null && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.allowResearch}
              onChange={(e) => patch({ allowResearch: e.target.checked })}
            />
            <span>Assume MAM research and hard drives</span>
          </label>
        )}
      </Section>

      <Section title="Logistics" count={belts.find((b) => b.key === settings.beltKey)?.name.replace('Conveyor Belt ', '') ?? ''}>
        <div className="field">
          <label htmlFor="belt">Conveyor belt</label>
          <select id="belt" value={settings.beltKey} onChange={(e) => patch({ beltKey: e.target.value })}>
            {belts.map((b) => (
              <option key={b.key} value={b.key}>{b.name} — {fmt(b.itemsPerMin)}/min</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pipe">Pipeline</label>
          <select id="pipe" value={settings.pipeKey} onChange={(e) => patch({ pipeKey: e.target.value })}>
            {pipes.map((p) => (
              <option key={p.key} value={p.key}>{p.name} — {fmt(p.cubicMetersPerMin)} m³/min</option>
            ))}
          </select>
        </div>
        <p className="hint">Any link above one line turns striped in the tree.</p>
      </Section>

      <Section title="Machines" count={`${Math.round(settings.defaultClock * 100)}%`}>
        <div className="field">
          <label htmlFor="clock">Default clock speed %</label>
          <input
            id="clock"
            type="number"
            min={1}
            max={250}
            step={1}
            value={Math.round(settings.defaultClock * 1000) / 10}
            onChange={(e) => patch({ defaultClock: Number(e.target.value) / 100 })}
          />
          <p className="hint">
            Power scales by clock<sup>1.322</sup>. Over 100% needs Power Shards. Tune individual
            recipes in the Steps tab.
          </p>
        </div>
        {Object.keys(settings.tuning).length > 0 && (
          <button type="button" className="btn" onClick={() => patch({ tuning: {} })}>
            Reset {Object.keys(settings.tuning).length} per-recipe override(s)
          </button>
        )}
      </Section>

      <AlternatesSection settings={settings} patch={patch} />
    </aside>
  )
}

function AlternatesSection({
  settings, patch,
}: { settings: PlannerSettings; patch: (p: Partial<PlannerSettings>) => void }) {
  const [query, setQuery] = useState('')
  const unlocked = useMemo(() => new Set(settings.unlockedAlternates), [settings.unlockedAlternates])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return alternateRecipes
    return alternateRecipes.filter((r) => r.name.toLowerCase().includes(q))
  }, [query])

  const toggle = (key: string) => {
    const next = new Set(unlocked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    patch({ unlockedAlternates: [...next] })
  }

  return (
    <Section title="Alternate recipes" count={`${unlocked.size}/${alternateRecipes.length}`}>
      <p className="hint">Tick the alternates you've unlocked. Only these are considered.</p>
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => patch({ unlockedAlternates: alternateRecipes.map((r) => r.key) })}
        >
          Unlock all
        </button>
        <button type="button" className="btn" onClick={() => patch({ unlockedAlternates: [] })}>
          Clear
        </button>
      </div>
      <input
        type="search"
        value={query}
        placeholder="Filter alternates…"
        aria-label="Filter alternate recipes"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="alt-list">
        {shown.map((r) => (
          <label className="alt" key={r.key}>
            <input type="checkbox" checked={unlocked.has(r.key)} onChange={() => toggle(r.key)} />
            <span>
              <span className="alt-name">{r.name}</span>
              <br />
              <span className="alt-recipe">
                {r.ingredients.map((i) => items[i.item]?.name ?? i.item).join(' + ')}
                {' → '}
                {r.products.map((p) => items[p.item]?.name ?? p.item).join(' + ')}
              </span>
            </span>
          </label>
        ))}
        {shown.length === 0 && <div className="picker-empty">No alternates match “{query}”.</div>}
      </div>
    </Section>
  )
}

function Section({
  title, children, count, defaultOpen = false,
}: {
  title: string
  children: React.ReactNode
  count?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section">
      <button type="button" className="section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▼' : '▶'}</span>
        {title}
        {count && <span className="count">{count}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}
