import { isDesktop } from './meshes'
import { useMeshes } from './MeshContext'

/**
 * The models line on the Blueprints tab.
 *
 * The offer itself and the progress card now live at the top of the app, so
 * this is just the readout and a way to run it again after a game update.
 */
export function MeshSetup({ onReady }: { onReady: () => void }) {
  const { status, busy, gameDir, extract, generation } = useMeshes()
  if (!isDesktop || !status) return null

  if (status.count > 0) {
    return (
      <div className="mesh-status" key={generation}>
        <span className="mesh-status-dot" />
        Real models in use · <strong>{status.count}</strong> buildings
        <button
          type="button"
          className="btn btn-icon"
          disabled={busy || !gameDir || !status.exporterAvailable}
          onClick={() => { if (gameDir) void extract(gameDir).then(onReady) }}
          title="Read the models again, after a game update"
        >
          {busy ? 'Reading…' : 'Re-extract'}
        </button>
      </div>
    )
  }

  return (
    <div className="mesh-status" data-muted="true">
      <span className="mesh-status-dot" data-off="true" />
      Buildings drawn as sized boxes
      <button
        type="button"
        className="btn btn-icon"
        disabled={busy || !gameDir || !status.exporterAvailable}
        onClick={() => { if (gameDir) void extract(gameDir).then(onReady) }}
      >
        {busy ? 'Reading…' : 'Use real models'}
      </button>
    </div>
  )
}
