/**
 * Building meshes exported from an installed copy of the game by
 * tools/mesh-exporter (see docs/MESHES.md).
 *
 * The folder is gitignored and empty unless the export has been run, so this
 * normally resolves to {} and the viewer draws sized boxes instead. Nothing of
 * the game's is redistributed — each machine extracts from its own copy.
 */
const files = import.meta.glob('../../data/meshes/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
})

export const meshUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(files)) {
  const key = path.split('/').pop()?.replace(/\.glb$/, '')
  if (key) meshUrls[key] = url as string
}

export const hasMeshes = Object.keys(meshUrls).length > 0

export function meshFor(buildableKey: string): string | undefined {
  return meshUrls[buildableKey]
}
