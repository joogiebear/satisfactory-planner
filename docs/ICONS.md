# Icons

Every item and building shows the game's own icon, read from the copy of
Satisfactory on the machine running the planner. There is nothing to fetch and
nothing to install — icons come out of the same first-run extraction as the
building models, into the same folder, and are served over the `mesh://` scheme.

## Where they come from

`src/data/game-data.json` carries an `icons` map of class name to icon texture,
built by `tools/extract_game_data.py` from the game's published docs. A
descriptor names its own icon in `mSmallIcon`; a *buildable* does not, so
`Build_X_C` is matched to `Desc_X_C` to find one. That covers 675 classes — all
168 items and 507 of the 539 buildables. The remainder are wall and ramp
variants whose descriptors name no icon; those fall back to a lettered tile.

The mesh exporter turns that map into files:

```bash
satisfactory-mesh-exporter.exe --game "<Satisfactory>" --out <dir> --icons <map.json>
```

Each is written as `<ClassName>.png` at 128 px — more than a chip ever shows.
PNG rather than JPEG because the icons have transparent surrounds that JPEG
would turn into grey haloes.

## Why not the wiki

They used to be downloaded from the Satisfactory wiki into `src/data/icons/`,
which Vite then inlined into the bundle. That was a mistake worth recording: the
folder was gitignored, so the repository looked clean, but the build baked 371
PNGs of Coffee Stain's artwork straight into the published installers — while
the README claimed no artwork travelled with the app. Reading them from the
player's own copy removes the redistribution, needs no network, and covers 675
classes instead of 389.

## Without an extraction

Chips fall back to a lettered tile, tinted by how the item travels — solid,
fluid or raw. The planner works exactly the same; it is only less pretty. That
is also what the web build shows, since it has no game to read from.
