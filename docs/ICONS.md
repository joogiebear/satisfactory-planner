# Adding the game's icons

The planner works fine without icons — it falls back to lettered tiles, amber
for solids and teal for fluids. This adds the real artwork.

Satisfactory keeps its textures inside UE5 IoStore containers
(`FactoryGame-Windows.utoc` / `.ucas`, about 7.9 GB), which the planner can't
open by itself. FModel does it in a few clicks, and afterwards a script matches
each PNG to the right item using the icon names already in `game-data.json`.

You only need to do this once per game update.

## 1. Export the textures with FModel

1. Install [FModel](https://fmodel.app).
2. **Directory selector** → point it at:
   `<Satisfactory>\FactoryGame\Content\Paks`
   Leave the AES key blank; Satisfactory's paks aren't encrypted.
3. Set **UE Version** to the one FModel suggests for the game build, then Load.
4. In the folder tree, right-click `FactoryGame/Content/FactoryGame` and choose
   **Export Folder Packages Textures** (or select `Save Textures` from the
   context menu). This writes PNGs under FModel's `Output/Exports` folder.

Exporting the whole `FactoryGame` folder is the simplest route. If you'd rather
keep it small, the icons live in `UI` subfolders beneath `Resource/Parts`,
`Resource/RawResources` and `Buildable/Factory`.

## 2. Bring them into the planner

```bash
python tools/extract_icons.py --from "C:/Users/<you>/Documents/FModel/Output/Exports"
```

It reports how many matched and names anything it couldn't find. Icons land in
`src/data/icons/` and are picked up the next time the app builds or reloads.

`pip install Pillow` first if you want them downscaled — otherwise they're
copied at full size, which still works but makes a larger app.

## Why they aren't in the repo

`src/data/icons/` is gitignored. The artwork belongs to Coffee Stain, so each
machine extracts its own copy from the game it already owns rather than the
repo redistributing it.
