import { useEffect, useMemo, useState } from 'react'
import { defaultSettings, gameData, items } from '../core/gameData'
import { solvePlan } from '../core/solver'
import type { PlanTarget, PlannerSettings } from '../core/types'
import { Sidebar } from './components/Sidebar'
import { StepsTable } from './components/StepsTable'
import { SummaryPanel } from './components/SummaryPanel'
import { TreeView } from './components/TreeView'
import { BlueprintPanel } from './components/BlueprintPanel'
import { fmt, fmtPower } from './format'

type Tab = 'tree' | 'steps' | 'summary' | 'blueprint'

const STORAGE_KEY = 'satisfactory-planner/v1'

interface Saved {
  settings: PlannerSettings
  targets: PlanTarget[]
}

function load(): Saved {
  const fallback: Saved = {
    settings: defaultSettings(),
    targets: [{ item: 'Desc_IronPlateReinforced_C', ratePerMin: 10 }],
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Saved>
    return {
      // Merge onto defaults so a saved file from an older build still loads
      // once new settings are added.
      settings: { ...fallback.settings, ...parsed.settings, extraction: { ...fallback.settings.extraction, ...parsed.settings?.extraction } },
      targets: (parsed.targets ?? fallback.targets).filter((t) => items[t.item]),
    }
  } catch {
    return fallback
  }
}

export function App() {
  const initial = useMemo(load, [])
  const [settings, setSettings] = useState<PlannerSettings>(initial.settings)
  const [targets, setTargets] = useState<PlanTarget[]>(initial.targets)
  const [tab, setTab] = useState<Tab>('tree')

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, targets }))
      } catch {
        /* storage full or unavailable; the plan still works in memory */
      }
    }, 250)
    return () => clearTimeout(id)
  }, [settings, targets])

  const plan = useMemo(() => solvePlan(targets, settings), [targets, settings])

  const onTune = (recipeKey: string, tweak: { clock?: number; sloops?: number }) => {
    const current = settings.tuning[recipeKey] ?? { clock: settings.defaultClock, sloops: 0 }
    setSettings({
      ...settings,
      tuning: { ...settings.tuning, [recipeKey]: { ...current, ...tweak } },
    })
  }

  const hasPlan = plan.steps.length > 0 || plan.raw.length > 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">FICSIT</span>
          <span className="brand-sub">Production Planner</span>
        </div>
        <nav className="tabs" role="tablist">
          {(['tree', 'steps', 'summary', 'blueprint'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              className="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {t === 'tree' ? 'Tree' : t === 'steps' ? 'Steps' : t === 'summary' ? 'Summary' : 'Blueprints'}
            </button>
          ))}
        </nav>
        <span className="version" title={`Data extracted from ${gameData.source}`}>
          {gameData.gameVersion}
        </span>
      </header>

      <div className="body">
        <Sidebar
          settings={settings}
          setSettings={setSettings}
          targets={targets}
          setTargets={setTargets}
          plan={plan}
        />

        <main className="main">
          {plan.errors.length > 0 && (
            <div className="notice" data-kind="error">
              <strong>Can't build this plan.</strong>
              <ul>{plan.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}

          {plan.warnings.length > 0 && (
            <div className="notice">
              <ul>{[...new Set(plan.warnings)].map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}

          {tab === 'blueprint' && <BlueprintPanel plan={plan} />}

          {tab !== 'blueprint' && !hasPlan && plan.errors.length === 0 && (
            <div className="empty">
              <h2>Nothing to build yet</h2>
              <p>Add an item under Output in the sidebar and set how many you want per minute.</p>
            </div>
          )}

          {tab !== 'blueprint' && hasPlan && (
            <>
              <div className="rail">
                <Stat label="Machines" value={String(plan.totals.machines)} accent="amber" />
                <Stat label="Total power" value={fmtPower(plan.totals.totalPowerMW)} />
                <Stat
                  label="Power: factory / mining"
                  value={`${fmt(plan.totals.machinePowerMW, 0)} / ${fmt(plan.totals.extractorPowerMW, 0)}`}
                  unit="MW"
                />
                <Stat label="Raw inputs" value={String(plan.raw.length)} />
                <Stat label="Byproducts" value={String(plan.byproducts.length)} />
                <Stat label="Sink points" value={fmt(plan.totals.sinkPointsPerMin, 0)} unit="/min" />
              </div>

              {tab === 'tree' && <TreeView plan={plan} settings={settings} />}
              {tab === 'steps' && <StepsTable plan={plan} settings={settings} onTune={onTune} />}
              {tab === 'summary' && <SummaryPanel plan={plan} settings={settings} />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-accent={accent}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  )
}
