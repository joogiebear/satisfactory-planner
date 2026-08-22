import { useMemo, useState } from 'react'
import {
  hardDrives, items, mamResearch, milestones, recipes, spaceElevatorPhases,
} from '../../core/gameData'
import type {
  PlanTarget, PlannerSettings, ProgressionGoal, ProgressionTrack,
} from '../../core/types'
import { fmt } from '../format'
import { ItemChip } from './ItemPicker'

/**
 * A goal costs a *total* — 50 Modular Frames — while the planner works in items
 * per minute, so the two only meet once you say how long you'll wait for the
 * delivery. These are the round numbers a player actually thinks in.
 */
const DELIVERY_OPTIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
]

/**
 * Tier names are hand-kept: the game shows them in the HUB but they appear
 * nowhere in its exported data, so nothing else can supply them. A missing one
 * costs a subtitle, not the feature.
 */
const TIER_NAMES: Record<number, string> = {
  0: 'Onboarding',
  1: 'Field Research',
  2: 'Part Assembly',
  3: 'Obstacle Clearing',
  4: 'Logistics Mk.2',
  5: 'Jump Start',
  6: 'Expanded Power Infrastructure',
  7: 'Bauxite Refinement',
  8: 'Advanced Aluminium Production',
  9: 'Nuclear Age',
}

const TRACKS: { id: ProgressionTrack; label: string; blurb: string }[] = [
  {
    id: 'milestone',
    label: 'Milestones',
    blurb: 'HUB deliveries. Each one opens machines, recipes and the next tier.',
  },
  {
    id: 'spaceelevator',
    label: 'Space Elevator',
    blurb: 'Project Assembly phases. These are what actually unlock the tiers above.',
  },
  {
    id: 'mam',
    label: 'MAM research',
    blurb: 'Research you feed samples to. Not tier-gated — you can do it whenever you find the resource.',
  },
  {
    id: 'harddrive',
    label: 'Hard drives',
    blurb: 'Alternate recipes. Nothing to build: switch one on once a drive has given it to you.',
  },
]

interface Props {
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
  setTargets: (t: PlanTarget[]) => void
  /** Jump to the production views once a goal has been turned into a plan. */
  onPlanned: () => void
}

export function ProgressionPanel({ settings, setSettings, setTargets, onPlanned }: Props) {
  const [track, setTrack] = useState<ProgressionTrack>('milestone')
  const [minutes, setMinutes] = useState(60)

  const active = TRACKS.find((t) => t.id === track)!

  return (
    <div className="panel">
      <div className="panel-head">
        Progression
        <span className="count">
          {milestones.length} milestones · {spaceElevatorPhases.length} phases ·{' '}
          {mamResearch.length} research · {hardDrives.length} drives
        </span>
      </div>

      <div className="prog-tracks" role="tablist">
        {TRACKS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="prog-track"
            aria-selected={track === t.id}
            onClick={() => setTrack(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="prog-bar">
        <p className="muted prog-blurb">{active.blurb}</p>
        {track !== 'harddrive' && (
          <>
            <span className="field-label">Deliver in</span>
            <div className="prog-times">
              {DELIVERY_OPTIONS.map((o) => (
                <button
                  key={o.minutes}
                  className="btn"
                  aria-pressed={minutes === o.minutes}
                  onClick={() => setMinutes(o.minutes)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {track === 'milestone' && (
        <TieredGoals
          goals={milestones}
          minutes={minutes}
          settings={settings}
          setSettings={setSettings}
          setTargets={setTargets}
          onPlanned={onPlanned}
        />
      )}

      {track === 'spaceelevator' && (
        <div className="prog-list">
          {spaceElevatorPhases.map((g) => (
            <GoalCard
              key={g.key}
              goal={g}
              minutes={minutes}
              subtitle={`Built with Tier ${g.tier} tech`}
              settings={settings}
              setSettings={setSettings}
              setTargets={setTargets}
              onPlanned={onPlanned}
            />
          ))}
        </div>
      )}

      {track === 'mam' && (
        <GroupedGoals
          goals={mamResearch}
          minutes={minutes}
          settings={settings}
          setSettings={setSettings}
          setTargets={setTargets}
          onPlanned={onPlanned}
        />
      )}

      {track === 'harddrive' && <HardDrives settings={settings} setSettings={setSettings} />}
    </div>
  )
}

interface ListProps {
  goals: ProgressionGoal[]
  minutes: number
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
  setTargets: (t: PlanTarget[]) => void
  onPlanned: () => void
}

/** Milestones, which the game presents as ten numbered tiers. */
function TieredGoals({ goals, ...rest }: ListProps) {
  const [open, setOpen] = useState<number | null>(0)

  const tiers = useMemo(() => {
    const groups = new Map<number, ProgressionGoal[]>()
    for (const g of goals) {
      const list = groups.get(g.tier)
      if (list) list.push(g)
      else groups.set(g.tier, [g])
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
  }, [goals])

  return (
    <>
      {tiers.map(([tier, list]) => (
        <Section
          key={tier}
          eyebrow={`Tier ${tier}`}
          title={TIER_NAMES[tier] ?? ''}
          count={list.length}
          open={open === tier}
          onToggle={() => setOpen(open === tier ? null : tier)}
        >
          {list.map((g) => <GoalCard key={g.key} goal={g} {...rest} />)}
        </Section>
      ))}
    </>
  )
}

/** MAM research, which the game presents as one tree per resource. */
function GroupedGoals({ goals, ...rest }: ListProps) {
  const [open, setOpen] = useState<string | null>(null)

  const trees = useMemo(() => {
    const groups = new Map<string, ProgressionGoal[]>()
    for (const g of goals) {
      const list = groups.get(g.group)
      if (list) list.push(g)
      else groups.set(g.group, [g])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [goals])

  return (
    <>
      {trees.map(([name, list]) => (
        <Section
          key={name}
          eyebrow={name}
          title=""
          count={list.length}
          open={open === name}
          onToggle={() => setOpen(open === name ? null : name)}
        >
          {list.map((g) => <GoalCard key={g.key} goal={g} {...rest} />)}
        </Section>
      ))}
    </>
  )
}

function Section({
  eyebrow, title, count, open, onToggle, children,
}: {
  eyebrow: string
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="prog-section">
      <button className="prog-section-head" aria-expanded={open} onClick={onToggle}>
        <span className="prog-eyebrow">{eyebrow}</span>
        <span className="prog-section-name">{title}</span>
        <span className="count">{count}</span>
      </button>
      {open && <div className="prog-list">{children}</div>}
    </section>
  )
}

function GoalCard({
  goal, minutes, subtitle, settings, setSettings, setTargets, onPlanned,
}: {
  goal: ProgressionGoal
  minutes: number
  subtitle?: string
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
  setTargets: (t: PlanTarget[]) => void
  onPlanned: () => void
}) {
  const unlocked = goal.unlocksRecipes
    .map((k) => recipes[k]?.name)
    .filter(Boolean) as string[]

  const plan = () => {
    setTargets(goal.cost.map((c) => ({
      item: c.item,
      // Four decimals is what the game itself shows; the exact quotient puts
      // 16.666666666666668 in an input box nobody wants to edit.
      ratePerMin: Math.round((c.amount / minutes) * 10000) / 10000,
    })))
    // Cap the recipes to what this point in the game actually gives you. A plan
    // for Basic Steel Production that routes through a machine you unlock two
    // tiers later is worse than useless: you'd build it and find you can't.
    // MAM research isn't tier-gated, so it plans against everything.
    setSettings({ ...settings, maxTier: goal.track === 'mam' ? null : goal.tier })
    onPlanned()
  }

  return (
    <article className="prog-goal">
      <header className="prog-goal-head">
        <h3>{goal.name}</h3>
        <button className="btn btn-primary" onClick={plan} disabled={!goal.cost.length}>
          Plan this
        </button>
      </header>

      {subtitle && <p className="muted prog-subtitle">{subtitle}</p>}

      {goal.cost.length > 0 ? (
        <ul className="prog-cost">
          {goal.cost.map((c) => {
            const item = items[c.item]
            if (!item) return null
            return (
              <li key={c.item}>
                <ItemChip item={item} />
                <span className="prog-cost-name">{item.name}</span>
                <span className="prog-cost-total">{fmt(c.amount)}</span>
                <span className="muted prog-cost-rate">{fmt(c.amount / minutes, 2)}/min</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted">Free — nothing to deliver.</p>
      )}

      <footer className="prog-unlocks muted">
        {goal.note ? goal.note : unlocked.length > 0 ? <>Unlocks {unlocked.join(', ')}</> : <>No new recipes</>}
        {goal.otherUnlocks > 0 && (
          <> · {goal.otherUnlocks} other unlock{goal.otherUnlocks === 1 ? '' : 's'}</>
        )}
      </footer>
    </article>
  )
}

/**
 * Hard drives have no cost — you find the drive — so there is nothing to plan.
 * The useful action is switching the recipe on once you have it, which is the
 * same list the sidebar keeps.
 */
function HardDrives({
  settings, setSettings,
}: {
  settings: PlannerSettings
  setSettings: (s: PlannerSettings) => void
}) {
  const [query, setQuery] = useState('')
  const unlocked = new Set(settings.unlockedAlternates)

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return hardDrives
      .flatMap((d) => d.unlocksRecipes.map((key) => ({ drive: d, recipe: recipes[key] })))
      .filter((r) => r.recipe)
      .filter((r) => !needle || r.recipe.name.toLowerCase().includes(needle))
  }, [query])

  const toggle = (key: string) => {
    const next = new Set(settings.unlockedAlternates)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSettings({ ...settings, unlockedAlternates: [...next] })
  }

  const setAll = (on: boolean) =>
    setSettings({
      ...settings,
      unlockedAlternates: on ? rows.map((r) => r.recipe.key) : [],
    })

  return (
    <>
      <div className="prog-bar prog-bar-tight">
        <input
          className="prog-search"
          type="search"
          placeholder="Filter recipes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="prog-times">
          <button className="btn" onClick={() => setAll(true)}>All on</button>
          <button className="btn" onClick={() => setAll(false)}>All off</button>
        </div>
      </div>

      <ul className="prog-drives">
        {rows.map(({ recipe }) => (
          <li key={recipe.key}>
            <label>
              <input
                type="checkbox"
                checked={unlocked.has(recipe.key)}
                onChange={() => toggle(recipe.key)}
              />
              <span className="prog-drive-name">{recipe.name}</span>
              <span className="muted prog-drive-out">
                {recipe.products.map((p) => items[p.item]?.name).filter(Boolean).join(', ')}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}
