# Real building geometry

The blueprint viewer draws Satisfactory's actual building meshes instead of
sized boxes. It reads them from the copy of the game already on your machine —
nothing is downloaded, nothing is bundled, and nothing is redistributed.

## In the app

Open the **Blueprints** tab and the planner offers to do it. It finds
Satisfactory through Steam on its own, or you can point it at the folder
containing `FactoryGameSteam.exe`. The extractor is bundled, so there is nothing
to install — not even .NET.

The first run takes a couple of minutes and caches the result in the app's own
data folder:

```
%APPDATA%\Satisfactory Planner\meshes
```

Re-run it after a game update; "Not now" keeps the sized boxes.

## From the command line

For browser development, where there is no desktop shell to do it:

```bash
npm run fetch-meshes
npm run fetch-meshes -- --game "D:/SteamLibrary/steamapps/common/Satisfactory"
```

That route builds the extractor from source, so it needs the **.NET SDK** (8 or
newer). If `dotnet` isn't on your machine, install it without admin rights:

```bash
powershell -c "& { iwr https://dot.net/v1/dotnet-install.ps1 -OutFile $env:TEMP\dotnet-install.ps1; & $env:TEMP\dotnet-install.ps1 -Channel 10.0 -InstallDir $env:LOCALAPPDATA\Microsoft\dotnet }"
```

Building the installer needs the extractor published first, which
`npm run dist` does not do for you:

```bash
dotnet publish tools/mesh-exporter -c Release -r win-x64 --self-contained true -o tools/mesh-exporter/publish
```

## Why it takes a C# program

The models live inside UE5 IoStore containers (`FactoryGame-Windows.utoc` /
`.ucas`, about 7.9 GB) in Unreal's own serialisation format. Reading that needs
a UE asset library; there is no practical JavaScript or Python route. The
extractor uses [CUE4Parse](https://github.com/FabianFG/CUE4Parse), the same
library [FModel](https://fmodel.app) is built on, so this does what an FModel
export would without the clicking.

Three things had to line up, and each is worth knowing if a game update breaks
the export:

- **Engine version.** The anniversary-2026 build is **UE 5.6**. Get it wrong and
  every package fails with "read size is bigger than remaining archive length".
  Override with `--ue GAME_UE5_7` if a later update moves on.
- **Type mappings.** UE5 serialises properties unversioned, so nothing parses
  without a `.usmap`. Satisfactory ships its own at
  `CommunityResources/FactoryGame.usmap`, which always matches the installed
  build. The extractor patches 44 `OptionalProperty` entries in it before use:
  the game writes them as plain 8-byte records while CUE4Parse expects an inner
  type, and that one byte of disagreement desynchronises the whole property
  table. All 44 belong to engine and editor types — Slate styles, Niagara,
  MovieScene, test structs — so no factory mapping is affected.
- **Which mesh.** A building's body hangs off its `FGColoredInstanceMeshProxy`
  component. The other mesh components are vertex-animated moving parts and the
  production indicator, which would be the wrong thing to draw.

## How a building's meshes are found

Four mechanisms, and a building can use more than one:

- **Machines** hang meshes off `UStaticMeshComponent`s. The body is on an
  `FGColoredInstanceMeshProxy`; the others are vertex-animated moving parts and
  the production indicator.
- **Foundations, walls and most scenery** carry an `AbstractInstanceDataObject`
  whose `Instances` array names the mesh and its offset. Looking only at
  components misses several hundred buildings entirely, which is why early
  versions drew every foundation as a box.
- **Belts, lifts and pipes** name a segment mesh on the class default
  (`mMesh`) that the game repeats along a spline.
- **Pipeline and hypertube supports** keep theirs inside a property struct
  (`mSupportMeshInstanceData`, with the pole height variations beside it)
  rather than on a component at all.
- **Conveyor lifts** have no body mesh at all: they are a base, a repeating
  column section and a head (`mBottomMesh`, `mMidMesh`, `mTopMesh`), stacked as
  many times as the lift is tall. How tall is per-placement, so the manifest
  labels the column with `stackEvery` and the head with `atTop` and the viewer
  stacks them against the height read from the blueprint. A lift declares those
  fields twice — once on the class default and again on its sparse-data object —
  so taking both stacks two lifts in the same place.
- **Power lines** name theirs on `mWireMesh`, which is why they drew as markers
  until that field was added to the list.

Components are not automatically geometry. A conveyor lift carries a visibility
helper pointing at the engine's `Cube`, and taking it drew every lift in the
game as a literal box — so a component's mesh goes through the same placeholder
filter as everything else.

Nor is every mesh a building. Skipping the Cube finally let the HUB resolve, and
it came back as 131 meshes: mugs, kebabs, fridge magnets, FICSMAS socks, a
toilet cover. All genuinely in the blueprint, none of it the building, and none
of it carrying a visibility flag to sort by. Past sixteen parts a building is
held to the art in its own folder, which drops the crowd pulled in from
elsewhere; the HUB lands at 49, the rest being its own build-stage variants.

Two more things stand between a class name and a mesh once one is named. A
reference in one of those fields is not always geometry: the elevator floor stop
points `mMesh` at one of its own components, which resolves to the blueprint
package and exports as nothing, so a reference is only followed when it
genuinely points at a StaticMesh or SkeletalMesh. And the object inside a
package need not be named after the package — the truck station's file is
`Truckstation_static` while the mesh in it is `TruckStation_static` — so a miss
on the object name falls back to whatever geometry the package holds.

Two more things stand between a class name and its geometry. A **variant
blueprint** may name no mesh whatsoever, because it records only how it differs
from its parent: `Build_Pipeline_NoIndicator_C` — the Clean Pipeline, and what
every blueprint actually stores for a pipe run — declares nothing but the
absence of a flow indicator. When a class yields no parts, the class it derives
from is asked instead. And the **spelling of a path is not reliable**: the water
extractor's blueprint asks for `.../WaterPump/Mesh/...` while the asset on disk
is `.../Waterpump/Mesh/...`. The provider's file table is case-sensitive, so a
miss falls back to a lowercased index of it.

Every part keeps its relative transform, because they matter: a foundation's
slab sits 50 cm below its actor origin, a splitter's 55 cm below, and a window
wall is a frame plus a separate pane.

## Glass

Materials aren't exported, so see-through parts are identified by mesh name.
The rule is narrow on purpose: `WallSet` meshes are the panel *with a hole in
it* and must stay solid, while the pane is a separate `Inset` mesh. Anything
named for glass, an inset, a wall window or a roof window is drawn translucent —
44 parts across 40 buildings.

## Conveyor paths

A belt isn't a placed mesh: the game repeats one short segment along a spline,
and that spline lives in the blueprint's own property data rather than in the
asset. Decoding Unreal's property list in full would be a large job, so the
reader takes a narrow path to it — each spline point is a struct of three
vectors (Location, ArriveTangent, LeaveTangent), and a vector's payload ends
exactly where the next field name's length prefix begins, which anchors the read
without walking property headers.

The coordinates are **doubles**. Reading them as floats produces garbage, and
that is the quick way to tell whether a game update has changed the encoding —
the test suite asserts belt lengths land between 50 cm and 500 m, which floats
fail immediately.

A lift's own height is a separate read: `mTopTransform` in its property block
holds where the head ends up, with X and Y always zero, so the Z is the travel —
negative for a lift that descends. Without it every lift drew one storey tall
however far it really reaches, which in a build that stacks them three high is
most of the structure missing.

Every belt in the test blueprints resolves a path. Lifts, mergers, splitters and
poles have no spline, which is correct: they are placed meshes.

Segments are laid between points spaced by arc length, so consecutive segments
share an endpoint. Aiming each one at the tangent under its own midpoint instead
leaves them overlapping on the inside of a bend and gapping on the outside. And
orientation needs a full basis, not an axis-to-axis rotation: rotating X onto the
tangent leaves the roll about that axis unconstrained, three.js picks one, and a
curving belt slowly corkscrews. Building the frame against world up pins it flat,
with another reference for vertical runs so the basis never degenerates.

They are tiled along **local X**, which is Unreal's convention for spline meshes
whatever the mesh's proportions. Measuring the longest side instead looks
like it works, because a belt segment is 200 × 28 cm — but a pipe segment is
100 × 150 cm, and picking its longest side lays a pipe run out as a stack of
discs across the path.

## Surfaces

Buildings carry the game's own base-colour maps, which is what makes an
Assembler read as a grey chassis with red panels rather than a tinted shape.

Getting there is less direct than it sounds. CUE4Parse writes textures as loose
files beside the mesh rather than into the glTF, so the first link is
circumstantial: the exporter snapshots the output folder around each mesh and
treats whatever PNGs turn up as that mesh's textures, picking the base colour by
the game's own suffixes — `_BC`, `_D`, `_Alb`, `_Albedo` — while skipping masks,
noise and shared atlases, which are material-graph inputs rather than surfaces.

That only holds when a mesh's maps live beside it. The pipelines break it: their
material is shared with the pipeline supports and its textures sit in *that*
folder. So when the circumstantial match comes up empty, the material is asked
directly — walk the instance's `TextureParameterValues`, then its parent's, and
finally a base material's `ReferencedTextures`, scoring parameter and asset
names for how much they read as a base colour. Following the material took
coverage from 79% of parts to 92%.

Each map is re-encoded to a 512 px JPEG. At source size the full set runs to
roughly 1.9 GB; this brings it to a few tens of megabytes while staying legible
at the scale a blueprint is viewed. Meshes keep UV0 for it; the game's other
seven UV channels drive effects we don't reproduce.

Anything without a resolvable map keeps its category tint, so it still reads as
the right kind of thing. Sometimes that is the only correct answer: the pipeline
material carries no texture at all — only `UpVector` and `SplineDir` for its
spline shader — because the game colours pipes from a swatch the player picks at
runtime. Their tint is the default swatch's light steel.

## What still isn't right

Only base colour. The game's normal, roughness and mask maps are exported but
unused, and Satisfactory's real look also comes from per-instance swatch tinting
and decal layers applied by its own shader — reproducing that would mean
reimplementing the material graph.

Every placeable building resolves geometry. The last five to hold out named
theirs on fields nothing else uses — a floor hole puts the visible ring on
`mCapMesh` (its `mMidMesh` is a black box filling the hole, which is not
something to draw) and a ladder names one rung section on `mLadderSegmentMesh`.
A few cheat and debug classes still resolve the engine's cube; they are not real
buildings.

One lookup hazard remains worth knowing: the game disagrees with itself about
capitalisation. Its docs call the Mk.2 pipeline pump `Build_PipelinePumpMk2_C`
while the asset behind it is spelled `MK2`, so the viewer folds case when
matching a building to its parts.

## Size

Source meshes are Nanite-era — a Smelter alone is 1.4 MB. `tools/optimise-meshes.mjs`
welds, simplifies to roughly a tenth of the triangles, strips materials and
quantises positions, which lands each building near 100 KB with no runtime
decoder needed. Silhouettes stay recognisable, which is all a layout preview
asks for.

`src/data/meshes/` is gitignored — the geometry is Coffee Stain's, so each
machine extracts its own copy.
