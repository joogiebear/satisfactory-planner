# Icons

Every item and building shows the game's own icon, read from the copy of
Satisfactory on the machine running the planner. There is nothing to fetch and
nothing to install — icons come out of the same first-run extraction as the
building models, into the same folder, and are served over the `mesh://` scheme.

## Where they come from

`src/data/game-data.json` carries an `icons` map of class name to icon texture,
built by `tools/extract_game_data.py` from the game's published docs. A
descriptor names its own icon in `mSmallIcon`; a *buildable* does not, so
`Build_X_C` is matched to `Desc_X_C` to find one.

Some descriptors name no icon at all — ramp walls and half foundations, mostly,
where a material variant was added without one. The game lists those under the
same name as a sibling that does have one, so the icon is borrowed: a polished
concrete half foundation and a plain one are the same picture as far as a chip
in a list is concerned. That takes it to 697 classes, leaving ten with nothing
to borrow (Catwalk Corner, the wall outlets, some FICSMAS pieces), which fall
back to a lettered tile.

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
