/**
 * Icons for items and buildings, read from the game on this machine.
 *
 * They used to be downloaded from the wiki into `src/data/icons/` and inlined
 * into the bundle at build time, which meant Coffee Stain's artwork travelled
 * inside the installer — the one thing the planner is careful not to do with
 * models. The game ships the same icons and every descriptor names one, so they
 * come out of the player's own copy on first run, alongside the meshes, and are
 * served from the app's data folder over the `mesh://` scheme.
 *
 * Nothing is bundled and nothing is fetched over the network. Without an
 * extraction every chip falls back to a lettered tile, which is what the web
 * build shows.
 */

/** Class name -> icon file, e.g. Desc_IronPlate_C -> Desc_IronPlate_C.png. */
let available = new Set<string>()

export async function refreshIcons(): Promise<number> {
  const api = typeof window !== 'undefined' ? window.meshApi : undefined
  if (!api) return 0
  try {
    available = new Set(await api.icons())
  } catch {
    available = new Set()
  }
  return available.size
}

export const hasIcons = () => available.size > 0

export function iconFor(key: string): string | undefined {
  if (!available.has(key)) return undefined
  return `mesh://model/${encodeURIComponent(key)}.png`
}
