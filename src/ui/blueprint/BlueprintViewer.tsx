import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BlueprintInfo, Placement } from '../../core/blueprint'
import { iconFor } from '../icons'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { partsFor, urlForFile, type MeshPart } from './meshes'

/** glTF is metres; the game, and every placement in a blueprint, is centimetres. */
const GLTF_TO_CM = 100

/**
 * Tile a conveyor's segment mesh along the path it actually follows.
 *
 * The game builds a belt by repeating one short mesh along a spline, and the
 * blueprint stores that spline per belt. Drawing a single segment at the actor's
 * origin — which is all we could do before the path was decoded — leaves a run
 * as a scatter of disconnected stubs.
 */
function layOutAlongSplines(geometry: THREE.BufferGeometry, placements: Placement[]): THREE.Matrix4[] {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) return []

  const size = new THREE.Vector3()
  box.getSize(size)
  // The segment runs along whichever horizontal axis is longest.
  const alongX = size.x >= size.y
  const segmentLength = Math.max(1, alongX ? size.x : size.y)
  const axis = alongX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)

  const matrices: THREE.Matrix4[] = []
  const actor = new THREE.Matrix4()
  const local = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const tangent = new THREE.Vector3()

  for (const placement of placements) {
    actor.compose(
      new THREE.Vector3(...placement.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, placement.yaw)),
      new THREE.Vector3(...placement.scale)
    )

    if (!placement.spline || placement.spline.length < 2) {
      matrices.push(actor.clone())
      continue
    }

    const curve = new THREE.CatmullRomCurve3(
      placement.spline.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      'catmullrom',
      0.02
    )
    const length = curve.getLength()
    if (!isFinite(length) || length <= 0) { matrices.push(actor.clone()); continue }

    // Stretch each copy a little rather than leave gaps at the ends.
    const count = Math.max(1, Math.round(length / segmentLength))
    const stretch = length / count / segmentLength

    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count
      const point = curve.getPointAt(t)
      curve.getTangentAt(t, tangent)
      quaternion.setFromUnitVectors(axis, tangent.normalize())
      scale.set(alongX ? stretch : 1, alongX ? 1 : stretch, 1)
      local.compose(point, quaternion, scale)
      matrices.push(actor.clone().multiply(local))
    }
  }

  return matrices
}

/**
 * Turn one glTF primitive into geometry that can be instanced.
 *
 * The exported meshes use KHR_mesh_quantization, so positions and normals
 * arrive as normalised integers. Transforming those in place writes floats back
 * into an integer array and destroys the mesh, so they are expanded to Float32
 * first. Reading through getX/getY/getZ de-quantises for us.
 */
function prepareGeometry(
  source: THREE.BufferGeometry,
  worldMatrix: THREE.Matrix4,
  partMatrix: THREE.Matrix4
): THREE.BufferGeometry | null {
  const position = source.getAttribute('position')
  if (!position) return null

  const geo = new THREE.BufferGeometry()
  const expand = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const out = new Float32Array(attr.count * 3)
    for (let i = 0; i < attr.count; i++) {
      out[i * 3] = attr.getX(i)
      out[i * 3 + 1] = attr.getY(i)
      out[i * 3 + 2] = attr.getZ(i)
    }
    return new THREE.BufferAttribute(out, 3)
  }

  geo.setAttribute('position', expand(position))
  const normal = source.getAttribute('normal')
  if (normal) geo.setAttribute('normal', expand(normal))
  if (source.index) geo.setIndex(source.index.clone())

  geo.applyMatrix4(worldMatrix)
  // glTF measures in metres while blueprint placements are in centimetres, so
  // the geometry arrives a hundred times too small to see.
  geo.scale(GLTF_TO_CM, GLTF_TO_CM, GLTF_TO_CM)
  // glTF is Y-up; the root group converts from the game's Z-up axes.
  geo.rotateX(Math.PI / 2)
  // Now in the building's own space, place the piece within it.
  geo.applyMatrix4(partMatrix)
  if (!normal) geo.computeVertexNormals()
  return geo
}

/**
 * Draws a blueprint the way the designer holds it: every building as the box
 * the game reserves for it, at the transform recorded in the file.
 *
 * Belts, lifts, pipes and power lines are splines — the file stores a path we
 * don't decode — so they get a small marker at their own position instead.
 * Segments sit at regular intervals along a run, so the markers still trace
 * where the belts go without inventing geometry.
 */

const COLOURS: Record<string, number> = {
  machine: 0xf89a3c,
  foundation: 0x39424c,
  wall: 0x4d5763,
  conveyor: 0xd8853a,
  pipe: 0x4fb8c9,
  power: 0x8e7cc3,
  storage: 0x6fbf73,
  other: 0x5a646f,
}

/** Splines get a small stand-in so a belt run still reads as a line. */
const MARKER = { min: [-45, -45, -12] as const, max: [45, 45, 12] as const }

/**
 * Shrink each box slightly. Buildings in a real blueprint touch exactly, and
 * without a gap a row of twelve Smelters renders as one undivided slab.
 */
const INSET_CM = 9

export interface ViewerHandle {
  category: string | null
}

interface Props {
  blueprint: BlueprintInfo
  /** Only these categories are drawn; empty means everything. */
  hidden: Set<string>
}

export function BlueprintViewer({ blueprint, hidden }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const hiddenKey = useMemo(() => [...hidden].sort().join(','), [hidden])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0e1013)
    scene.fog = new THREE.Fog(0x0e1013, 6000, 26000)

    const camera = new THREE.PerspectiveCamera(45, 1, 10, 80000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.495 // never go under the floor

    // --- lighting: a cool key from above with warm bounce, so orange machines
    // stay legible against the dark plate palette ---
    scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x0b0d10, 1.5))
    const key = new THREE.DirectionalLight(0xffffff, 1.7)
    key.position.set(1, 1.4, 0.8)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xf89a3c, 0.5)
    rim.position.set(-1, 0.4, -0.9)
    scene.add(rim)

    const root = new THREE.Group()
    scene.add(root)

    // Game axes are Z-up; three.js is Y-up. Rotating the whole group keeps the
    // per-building maths in the game's own coordinates.
    root.rotation.x = -Math.PI / 2

    const visible = blueprint.placements.filter((p) => !hidden.has(p.category))

    // Group by building class rather than category so each type can carry its
    // own icon; a blueprint has a few dozen classes, which is a cheap number of
    // draw calls, and instancing still handles the hundreds of copies.
    const byClass = new Map<string, Placement[]>()
    for (const p of visible) {
      const list = byClass.get(p.key) ?? []
      list.push(p)
      byClass.set(p.key, list)
    }

    const pendingMeshes: { classKey: string; parts: MeshPart[]; list: Placement[]; colour: number }[] = []
    const unit = new THREE.BoxGeometry(1, 1, 1)
    const meshes: THREE.InstancedMesh[] = []
    const lookup: { mesh: THREE.InstancedMesh; items: Placement[] }[] = []
    const textures: THREE.Texture[] = []
    const dummy = new THREE.Object3D()

    for (const [classKey, list] of byClass) {
      const category = list[0].category
      const colour = COLOURS[category] ?? COLOURS.other
      const base = () => new THREE.MeshPhongMaterial({
        color: colour, flatShading: true, shininess: 6, specular: 0x111417,
      })

      // BoxGeometry face order is +x, -x, +y, -y, +z, -z. The group is rotated
      // so the box's local +z points up, which is the face worth labelling.
      const faces = [base(), base(), base(), base(), base(), base()]
      const iconUrl = iconFor(classKey)
      if (iconUrl) {
        const img = new Image()
        img.onload = () => {
          // Composite onto the body colour: the icons are transparent PNGs, and
          // an alpha-blended map would show straight through the box.
          const size = 128
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
          ctx.fillRect(0, 0, size, size)
          const pad = size * 0.14
          ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2)
          const tex = new THREE.CanvasTexture(canvas)
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 4
          textures.push(tex)
          faces[4].map = tex
          faces[4].color.set(0xffffff)
          faces[4].needsUpdate = true
        }
        img.src = iconUrl
      }

      const mesh = new THREE.InstancedMesh(unit, faces, list.length)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

      // Swap in the real geometry once it arrives. Buildings with no exported
      // mesh — belts, lifts, pipes and power lines, which are splines — keep
      // their sized box.
      const parts = partsFor(classKey)
      if (parts.length) pendingMeshes.push({ classKey, parts, list, colour })

      list.forEach((p, i) => {
        const box = p.box ?? { min: [...MARKER.min], max: [...MARKER.max] }
        const inset = p.box ? INSET_CM : 0
        const size = [
          Math.max(20, box.max[0] - box.min[0] - inset),
          Math.max(20, box.max[1] - box.min[1] - inset),
          Math.max(12, box.max[2] - box.min[2] - inset),
        ]
        // The clearance box is offset from the actor origin, so centre on it.
        const centre = [
          (box.max[0] + box.min[0]) / 2,
          (box.max[1] + box.min[1]) / 2,
          (box.max[2] + box.min[2]) / 2,
        ]
        const cos = Math.cos(p.yaw)
        const sin = Math.sin(p.yaw)

        dummy.position.set(
          p.position[0] + centre[0] * cos - centre[1] * sin,
          p.position[1] + centre[0] * sin + centre[1] * cos,
          p.position[2] + centre[2]
        )
        dummy.rotation.set(0, 0, p.yaw)
        dummy.scale.set(size[0] * p.scale[0], size[1] * p.scale[1], size[2] * p.scale[2])
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })

      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      root.add(mesh)
      meshes.push(mesh)
      lookup.push({ mesh, items: list })
    }

    // --- real geometry, loaded in the background ---
    const loader = new GLTFLoader()
    let disposed = false
    const loaded: THREE.InstancedMesh[] = []

    for (const pending of pendingMeshes) {
      let outstanding = pending.parts.length
      let drawn = 0

      const finish = () => {
        outstanding--
        if (outstanding > 0) return
        if (drawn === 0) return
        // Retire the placeholder box only once something replaced it.
        const placeholder = lookup.find((l) => l.items === pending.list && l.mesh.geometry === unit)
        if (placeholder) placeholder.mesh.visible = false
      }

      for (const part of pending.parts) {
        const url = urlForFile(part.file)
        if (!url) { finish(); continue }

        // Where this piece sits relative to the building's origin: a
        // foundation's slab is 50 cm below it, a window pane sits in its frame.
        const partMatrix = new THREE.Matrix4().compose(
          new THREE.Vector3(part.loc[0], part.loc[1], part.loc[2]),
          new THREE.Quaternion(part.rot[0], part.rot[1], part.rot[2], part.rot[3]),
          new THREE.Vector3(part.scale[0] || 1, part.scale[1] || 1, part.scale[2] || 1)
        )

        loader.load(
          url,
          (gltf) => {
            if (disposed) { finish(); return }
            gltf.scene.updateMatrixWorld(true)

            const material = part.glass
              ? new THREE.MeshPhongMaterial({
                color: 0x9fd4e3,
                transparent: true,
                opacity: 0.22,
                shininess: 90,
                specular: 0x556066,
                side: THREE.DoubleSide,
                depthWrite: false,
              })
              : new THREE.MeshPhongMaterial({
                color: pending.colour, shininess: 10, specular: 0x151a1f,
              })

            gltf.scene.traverse((child) => {
              const asMesh = child as THREE.Mesh
              if (!asMesh.isMesh || !asMesh.geometry) return

              const geo = prepareGeometry(asMesh.geometry, asMesh.matrixWorld, partMatrix)
              if (!geo) return

              const matrices = part.spline
                ? layOutAlongSplines(geo, pending.list)
                : pending.list.map((p) => {
                  dummy.position.set(p.position[0], p.position[1], p.position[2])
                  dummy.rotation.set(0, 0, p.yaw)
                  dummy.scale.set(p.scale[0], p.scale[1], p.scale[2])
                  dummy.updateMatrix()
                  return dummy.matrix.clone()
                })
              if (!matrices.length) return

              const inst = new THREE.InstancedMesh(geo, material, matrices.length)
              inst.renderOrder = part.glass ? 1 : 0
              matrices.forEach((m, i) => inst.setMatrixAt(i, m))
              inst.instanceMatrix.needsUpdate = true
              inst.computeBoundingSphere()
              root.add(inst)
              loaded.push(inst)
              meshes.push(inst)
              lookup.push({ mesh: inst, items: pending.list })
              drawn++
            })
            finish()
          },
          undefined,
          (err) => {
            console.warn(`[blueprint] ${pending.classKey}: ${part.file} failed to load`, err)
            finish()
          }
        )
      }
    }

    // --- ground grid, one line per 8 m foundation ---
    const b = blueprint.bounds
    const span = b
      ? Math.max(2400, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) + 1600)
      : 4000
    const grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / 800)), 0x2c3540, 0x1c2228)
    grid.position.y = 0
    scene.add(grid)

    // --- frame the build ---
    const box = new THREE.Box3().setFromObject(root)
    const centre = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) || 2000
    controls.target.copy(centre)
    camera.position.set(centre.x + radius * 0.9, centre.y + radius * 0.85, centre.z + radius * 1.1)
    camera.updateProjectionMatrix()

    // --- hover picking ---
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let hoverName: string | null = null

    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(meshes, false)
      let name: string | null = null
      if (hits.length) {
        const hit = hits[0]
        const entry = lookup.find((l) => l.mesh === hit.object)
        if (entry && hit.instanceId != null) name = entry.items[hit.instanceId]?.name ?? null
      }
      if (name !== hoverName) {
        hoverName = name
        setHover(name)
      }
    }
    renderer.domElement.addEventListener('pointermove', onMove)

    // --- resize + render loop ---
    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      disposed = true
      for (const inst of loaded) {
        inst.geometry.dispose()
        const mats = Array.isArray(inst.material) ? inst.material : [inst.material]
        for (const m of mats) m.dispose()
      }
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointermove', onMove)
      controls.dispose()
      unit.dispose()
      for (const m of meshes) {
        m.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.dispose()
      }
      for (const t of textures) t.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [blueprint, hiddenKey, hidden])

  return (
    <div className="bp3d" ref={mountRef}>
      {hover && <div className="bp3d-hover">{hover}</div>}
    </div>
  )
}
