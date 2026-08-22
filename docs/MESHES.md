# Real building geometry

The blueprint viewer can draw Satisfactory's actual building meshes instead of
sized boxes. It reads them from the copy of the game already on your machine —
nothing is downloaded and nothing is redistributed.

```bash
npm run fetch-meshes
```

That's it, if Satisfactory is installed through Steam. Otherwise point it at the
folder containing `FactoryGameSteam.exe`:

```bash
npm run fetch-meshes -- --game "D:/SteamLibrary/steamapps/common/Satisfactory"
```

It builds the extractor, reads the game, and simplifies the result — currently
143 buildings, 226 MB of source geometry down to about 20 MB. Reload the app
afterwards.

## What you need

The extractor is a small C# program, so it needs the **.NET SDK** (8 or newer)
to build. If `dotnet` isn't on your machine, install it without admin rights:

```bash
powershell -c "& { iwr https://dot.net/v1/dotnet-install.ps1 -OutFile $env:TEMP\dotnet-install.ps1; & $env:TEMP\dotnet-install.ps1 -Channel 10.0 -InstallDir $env:LOCALAPPDATA\Microsoft\dotnet }"
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

## What doesn't get a mesh

About 428 buildables resolve no mesh, almost all of them lightweight foundation
and wall variants that are built from shared instanced geometry. They keep their
sized boxes, which for a flat slab or a wall panel is the right shape anyway.

Belts, lifts, pipes and power lines are splines: the file stores a path, not a
placed mesh. They show as small markers along their run.

## Size

Source meshes are Nanite-era — a Smelter alone is 1.4 MB. `tools/optimise-meshes.mjs`
welds, simplifies to roughly a tenth of the triangles, strips materials and
quantises positions, which lands each building near 100 KB with no runtime
decoder needed. Silhouettes stay recognisable, which is all a layout preview
asks for.

`src/data/meshes/` is gitignored — the geometry is Coffee Stain's, so each
machine extracts its own copy.
