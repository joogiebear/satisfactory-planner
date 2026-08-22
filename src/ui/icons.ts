/**
 * Icons extracted from the game by tools/extract_icons.py.
 *
 * The folder is gitignored and usually empty, so this resolves to {} and every
 * chip falls back to a lettered tile. Vite inlines whatever is present at build
 * time; nothing is fetched at runtime.
 */
const files = import.meta.glob('../data/icons/*.png', { eager: true, query: '?url', import: 'default' })

export const icons: Record<string, string> = {}
for (const [path, url] of Object.entries(files)) {
  const key = path.split('/').pop()?.replace(/\.png$/, '')
  if (key) icons[key] = url as string
}

export const hasIcons = Object.keys(icons).length > 0

export function iconFor(key: string): string | undefined {
  return icons[key]
}
