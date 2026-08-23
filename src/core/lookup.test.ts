import { describe, expect, it } from 'vitest'
import { buildableNames } from './gameData'

/**
 * The game disagrees with itself about capitalisation: its docs name the Mk.2
 * pipeline pump Build_PipelinePumpMk2_C while the asset behind it is MK2. The
 * viewer folds case when looking a building up, so this pins the disagreement
 * rather than letting it quietly come back as a grey box.
 */
describe('buildable names', () => {
  it('still spells the Mk.2 pump the way the docs do', () => {
    expect(buildableNames['Build_PipelinePumpMk2_C']).toBe('Pipeline Pump Mk.2')
  })

  it('has no two buildings differing only by case', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const key of Object.keys(buildableNames)) {
      const folded = key.toLowerCase()
      const first = seen.get(folded)
      if (first) clashes.push(`${first} / ${key}`)
      else seen.set(folded, key)
    }
    expect(clashes).toEqual([])
  })
})
