import type { Plan, PlannerSettings } from '../../core/types'
import { capacityFor, fmt, fmtPower, unit } from '../format'
import { ItemChip } from './ItemPicker'

export function SummaryPanel({ plan, settings }: { plan: Plan; settings: PlannerSettings }) {
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          Raw inputs
          <span className="count">{plan.raw.length} resource{plan.raw.length === 1 ? '' : 's'}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              <th className="num">Rate</th>
              <th>Extraction</th>
              <th className="num">Per node</th>
              <th className="num">Nodes</th>
              <th className="num">Power</th>
            </tr>
          </thead>
          <tbody>
            {plan.raw.map((r) => (
              <tr key={r.item.key}>
                <td>
                  <span className="cell-item">
                    <ItemChip item={r.item} />
                    {r.item.name}
                  </span>
                </td>
                <td className="num">
                  {fmt(r.ratePerMin)} <span className="muted">{unit(r.item)}</span>
                </td>
                <td className="nowrap">
                  {r.extractor
                    ? <>{r.extractor.name}{r.purity && <span className="muted"> · {r.purity}</span>}</>
                    : <span className="muted">imported</span>}
                </td>
                <td className="num">{r.ratePerExtractor ? fmt(r.ratePerExtractor) : '—'}</td>
                <td className="num">
                  {r.extractor ? Math.ceil(r.extractorCount - 1e-9) : '—'}
                  {r.extractor && r.extractorCount % 1 > 1e-6 && (
                    <span className="muted"> ({fmt(r.extractorCount, 2)})</span>
                  )}
                </td>
                <td className="num muted">{r.powerMW ? fmtPower(r.powerMW) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          Buildings
          <span className="count">{plan.totals.machines} total</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Building</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {plan.totals.buildingCounts.map((b) => (
              <tr key={b.building?.key ?? b.building?.name}>
                <td>{b.building?.name ?? '—'}</td>
                <td className="num">{b.count}</td>
              </tr>
            ))}
            {plan.raw
              .filter((r) => r.extractor)
              .map((r) => (
                <tr key={`ex-${r.item.key}`}>
                  <td className="muted">{r.extractor!.name} <span className="muted">({r.item.name})</span></td>
                  <td className="num muted">{Math.ceil(r.extractorCount - 1e-9)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {plan.byproducts.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            Byproducts
            <span className="count">surplus with nowhere to go</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Rate</th>
                <th>Disposal</th>
                <th className="num">Sink points/min</th>
              </tr>
            </thead>
            <tbody>
              {plan.byproducts.map((b) => {
                const cap = capacityFor(b.item, b.ratePerMin, settings)
                return (
                  <tr key={b.item.key}>
                    <td>
                      <span className="cell-item">
                        <ItemChip item={b.item} />
                        {b.item.name}
                      </span>
                    </td>
                    <td className="num">
                      {fmt(b.ratePerMin)} <span className="muted">{unit(b.item)}</span>
                    </td>
                    <td className="nowrap muted">
                      {b.item.isFluid
                        ? cap.lines > 1
                          ? `${cap.lines} pipes to a sink or packager`
                          : 'pipe it to a sink or packager'
                        : cap.lines > 1
                          ? `${cap.lines} belts to an AWESOME Sink`
                          : 'belt it to an AWESOME Sink'}
                    </td>
                    <td className="num muted">
                      {b.item.sinkPoints ? fmt(b.item.sinkPoints * b.ratePerMin, 0) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
