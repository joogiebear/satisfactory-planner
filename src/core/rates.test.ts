import { describe, expect, it } from 'vitest'
import { baseRatePerMin, items } from './gameData'

describe('baseRatePerMin', () => {
  it('matches what one machine makes in game', () => {
    // Constructor: 2 Iron Plate per 6 s = 20/min. Assembler: 5 Reinforced Iron
    // Plate per 12 s... these are the numbers on the machine's own panel.
    expect(baseRatePerMin('Desc_IronPlate_C')).toBe(20)
    expect(baseRatePerMin('Desc_IronRod_C')).toBe(15)
    expect(baseRatePerMin('Desc_IronIngot_C')).toBe(30)
    expect(baseRatePerMin('Desc_IronPlateReinforced_C')).toBe(5)
    expect(baseRatePerMin('Desc_Cable_C')).toBe(30)
  })

  it('never returns zero or a non-finite rate for any producible item', () => {
    const bad = Object.keys(items)
      .map((k) => [k, baseRatePerMin(k)] as const)
      .filter(([, r]) => !isFinite(r) || r <= 0)
    expect(bad).toEqual([])
  })
})
