import { describe, expect, it } from 'vitest'
import { defaultSettings, items } from './gameData'
import { solvePlan } from './solver'
import { billOfMaterials, footprint, layOut, FOUNDATION } from './layout'

const plan = (item: string, rate: number, extra: Partial<ReturnType<typeof defaultSettings>> = {}) => {
  const settings = { ...defaultSettings(), ...extra }
  return { plan: solvePlan([{ item, ratePerMin: rate }], settings), settings }
}

describe('laying a plan out to build', () => {
  it('reads footprints from the game rather than guessing', () => {
    // A Constructor really is 8 m by 10 m, and an Assembler 9 by 16.
    expect(footprint('Build_ConstructorMk1_C')).toEqual({ w: 800, h: 1000 })
    expect(footprint('Build_AssemblerMk1_C')).toEqual({ w: 900, h: 1600 })
    expect(footprint('Build_ConveyorAttachmentSplitter_C')).toEqual({ w: 400, h: 400 })
  })

  it('falls back to a foundation for anything it hasn\u2019t got', () => {
    expect(footprint('Build_NotAThing_C')).toEqual({ w: FOUNDATION, h: FOUNDATION })
  })

  /** A manifold is one splitter and one merger per machine, and that is the count. */
  it('gives every machine its splitter and merger', () => {
    const { plan: p, settings } = plan('Desc_IronPlateReinforced_C', 20)
    const l = layOut(p, settings)
    const machines = l.buildings.filter((b) => b.kind === 'machine').length

    expect(machines).toBe(p.totals.machines)
    expect(l.mergers).toBe(machines)
    // Only rows that eat something need feeding.
    const fed = l.rows.filter((r) => r.step.inputs.length > 0)
      .reduce((n, r) => n + r.machines, 0)
    expect(l.splitters).toBe(fed)
  })

  /** Belts that run backwards are worse than no diagram at all. */
  it('puts a row below everything that feeds it', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)
    const rowOf = new Map(l.rows.map((r) => [r.step.recipe.key, r]))

    for (const row of l.rows) {
      for (const input of row.step.inputs) {
        const feeder = l.rows.find((r) => r.step.outputs.some((o) => o.item.key === input.item.key))
        if (!feeder || feeder === row) continue
        expect(feeder.index).toBeLessThan(row.index)
        expect(rowOf.get(feeder.step.recipe.key)!.y).toBeLessThan(row.y)
      }
    }
  })

  it('never overlaps two machines in a row', () => {
    const { plan: p, settings } = plan('Desc_Rotor_C', 40)
    const l = layOut(p, settings)
    for (const row of l.rows) {
      const inRow = l.buildings
        .filter((b) => b.row === row.index && b.kind === 'machine')
        .sort((a, b) => a.x - b.x)
      for (let i = 1; i < inRow.length; i++) {
        expect(inRow[i].x).toBeGreaterThanOrEqual(inRow[i - 1].x + inRow[i - 1].w)
      }
    }
  })

  /** Belts are drawn orthogonally, because that is how they are built. */
  it('routes every belt in right angles', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    for (const run of layOut(p, settings).runs) {
      for (let i = 1; i < run.points.length; i++) {
        const a = run.points[i - 1]
        const b = run.points[i]
        expect(a.x === b.x || a.y === b.y).toBe(true)
      }
    }
  })

  /** A bus carries the whole row, so it is the bus that outgrows a belt. */
  it('says when a row needs more than one line to feed it', () => {
    const slow = { ...defaultSettings(), beltKey: 'Build_ConveyorBeltMk1_C' }
    const p = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 600 }], slow)
    const l = layOut(p, slow)
    expect(l.warnings.length).toBeGreaterThan(0)
    expect(l.runs.some((r) => r.lanes > 1)).toBe(true)
  })

  it('adds up what you would have to place', () => {
    const { plan: p, settings } = plan('Desc_IronPlateReinforced_C', 20)
    const l = layOut(p, settings)
    const bom = billOfMaterials(l)
    const total = bom.reduce((n, b) => n + b.count, 0)
    expect(total).toBe(l.buildings.length)
    expect(bom.every((b) => items[b.key] === undefined)).toBe(true)
  })

  it('has nothing to lay out when there is no plan', () => {
    const l = layOut(solvePlan([], defaultSettings()), defaultSettings())
    expect(l.rows).toEqual([])
    expect(l.foundations).toBe(0)
  })
})
