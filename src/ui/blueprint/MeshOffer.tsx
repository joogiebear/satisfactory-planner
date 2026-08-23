import { shouldOffer, useMeshes } from './MeshContext'

/**
 * The one-time offer to use the game's own models, made wherever you are.
 *
 * It sits above the tabs rather than inside the blueprint panel, because
 * somebody planning a factory has no reason to open that tab and would never
 * be asked. Declining is remembered.
 */
export function MeshOffer() {
  const meshes = useMeshes()
  if (!shouldOffer(meshes)) return null

  return (
    <div className="mesh-offer">
      <div className="mesh-offer-text">
        <strong>Draw the real machines?</strong>
        <span className="muted">
          Blueprints currently draw as sized boxes. The planner can read Satisfactory's own
          models from your installed copy — nothing is downloaded, and you can keep working
          while it runs.
        </span>
      </div>
      <div className="mesh-offer-actions">
        {meshes.gameDir ? (
          <button className="btn btn-primary" onClick={() => void meshes.extract(meshes.gameDir!)}>
            Yes, read them
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void meshes.browse()}>
            Find my Satisfactory folder
          </button>
        )}
        <button className="btn" onClick={meshes.dismiss}>Not now</button>
      </div>
    </div>
  )
}

/**
 * A small card that stays put while the extraction runs.
 *
 * The work happens in the main process, so the planner keeps working
 * throughout — this exists so that is obvious rather than something you have to
 * discover by trying.
 */
export function MeshProgressCard() {
  const { busy, progress, error } = useMeshes()
  if (!busy && !error) return null

  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null

  if (error && !busy) {
    return (
      <div className="mesh-float" data-kind="error" role="status">
        <div className="mesh-float-head">Couldn't read the models</div>
        <p className="hint">{error}</p>
      </div>
    )
  }

  return (
    <div className="mesh-float" role="status" aria-live="polite">
      <div className="mesh-float-head">
        {progress?.phase === 'optimising' ? 'Simplifying models' : 'Reading game files'}
        {pct !== null && <span className="mesh-float-pct">{pct}%</span>}
      </div>
      <div className="mesh-progress-bar">
        <span style={{ width: pct === null ? '35%' : `${pct}%` }} data-indeterminate={pct === null} />
      </div>
      <p className="hint">
        {progress?.message || 'Starting…'}
        <br />
        Carry on planning — this runs in the background.
      </p>
    </div>
  )
}
