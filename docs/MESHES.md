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

Three mechanisms, and a building can use more than one:

- **Machines** hang meshes off `UStaticMeshComponent`s. The body is on an
  `FGColoredInstanceMeshProxy`; the others are vertex-animated moving parts and
  the production indicator.
- **Foundations, walls and most scenery** carry an `AbstractInstanceDataObject`
  whose `Instances` array names the mesh and its offset. Looking only at
  components misses several hundred buildings entirely, which is why early
  versions drew every foundation as a box.
- **Belts, lifts and pipes** name a segment mesh on the class default
  (`mMesh`) that the game repeats along a spline.

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

Every belt in the test blueprints resolves a path. Lifts, mergers, splitters and
poles have no spline, which is correct: they are placed meshes.

## What still isn't right

Nothing is textured. Materials aren't exported, so parts are tinted by category
— machines amber, structure grey, glass translucent — rather than carrying the
game's own surfaces.

Conveyor lifts point at a stand-in primitive in the asset, so they keep a sized
box rather than a bare cube. A few dozen other buildables resolve no mesh at all
and do the same.

## Size

Source meshes are Nanite-era — a Smelter alone is 1.4 MB. `tools/optimise-meshes.mjs`
welds, simplifies to roughly a tenth of the triangles, strips materials and
quantises positions, which lands each building near 100 KB with no runtime
decoder needed. Silhouettes stay recognisable, which is all a layout preview
asks for.

`src/data/meshes/` is gitignored — the geometry is Coffee Stain's, so each
machine extracts its own copy.
