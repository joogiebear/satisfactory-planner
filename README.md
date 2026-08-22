# Satisfactory Planner

A desktop production planner for Satisfactory. Pick what you want to make and
how many per minute; it works out the machines, the raw resources, the power
draw and where your belts run out of headroom.

Everything is computed from the game's own data files, so the numbers match the
build you have installed rather than a wiki snapshot.

## What it does

- **Factory view** — the plan as a machine-to-machine flow graph. Every machine
  is a card showing its building, count, recipe, power and each input and output
  with its rate; belts and pipes run between the exact ports that carry them,
  labelled with the item and throughput. Click a machine to swap its recipe, set
  its clock or fit Somersloops, and everything it isn't wired to dims so you can
  follow one chain through a large build. Drag to rearrange, and save the whole
  thing as a PNG.
- **Real icons** — every item and machine, fetched once with
  `npm run fetch-icons`.
- **Production tree** — the same plan as a compact outline, with per-branch
  machine counts and power. Connectors are drawn as the logistics: amber for
  belts, teal for pipes, and hazard stripes on any link that exceeds the tier
  you picked, with the number of lines it would need.
- **Correct byproducts and loops** — recipes with two outputs (Plastic also
  makes Heavy Oil Residue) and mutually recursive pairs (Recycled Plastic and
  Recycled Rubber consume each other) are solved as one material balance, not
  walked recursively.
- **Alternate recipes** — tick the ones you've unlocked; only those are used.
- **Overclocking and Somersloops** — per recipe, with the real
  `clock^1.321929` power curve and Somersloops doubling output at 4× draw.
- **Extraction settings** — miner mark, node purity per resource, and pump
  clock, feeding exact extractor counts.
- **Progression** — pick a HUB milestone, a Space Elevator phase or a MAM
  research node and it becomes the plan, capped to what you'd actually have
  unlocked at that point.
- **Power** — what it takes to run the factory you just planned: generators,
  fuel rate, water, nuclear waste, and the factory that makes the fuel.
- **Blueprint viewer** — drop in a `.sbp` and see the build itself in 3D, using
  the game's own building meshes, extracted from your installed copy on first
  run ([docs/MESHES.md](docs/MESHES.md)). Conveyors follow the paths they
  actually take, window panes are see-through, and hiding walls or foundations
  exposes the machines inside. Anything without an exported mesh falls
  back to the footprint the game reserves for it, with its icon on top. Hide foundations or walls to see
  the machines inside, hover to name anything, and read the exact build cost and
  how its machines line up with your current plan.

## Running it

```bash
npm install
npm run electron:dev
```

For the browser instead of the desktop shell:

```bash
npm run dev
```

## Building a Windows app

```bash
npm run dist
```

Produces two files in `release/`:

- `Satisfactory Planner Setup 1.0.0.exe` — installer, lets you choose the
  install location and makes a desktop shortcut.
- `Satisfactory Planner 1.0.0 portable.exe` — single file, run it from anywhere.

Both are unsigned, so Windows SmartScreen shows a warning the first time; pick
**More info → Run anyway**. Signing them needs a code-signing certificate.

### Installer vs portable

Same 136 MB app either way, with the same bundled mesh extractor. The installer
registers in Add/Remove Programs and gets shortcuts and a real uninstaller; the
portable is a self-extracting archive that unpacks to Temp on every launch, so
it starts slower and leaves nothing behind.

The uninstaller asks whether to delete the extracted building models along with
your plan and settings, and defaults to keeping them. That default matters:
electron-builder runs the **old** uninstaller as part of installing a new
version, so a blunt `deleteAppDataOnUninstall` would wipe ~64 MB of models on
every upgrade and make you sit through a twelve-minute re-extraction. The
checkbox lives in `build/installer.nsh` and is guarded three ways — it cannot
run during an update, cannot run silently, and defaults to unticked.

Two things to know if you touch that file. It is compiled twice, once for the
uninstaller and once for the installer that embeds it, so uninstaller-only code
has to sit behind `!ifdef BUILD_UNINSTALLER` or the build fails on warnings it
treats as errors. And it is included before MUI2, so `MUI_HEADER_TEXT` and
friends do not exist yet.

The build skips electron-builder's `signAndEditExecutable` step. That step pulls
in a toolchain archive containing macOS symlinks, and Windows refuses to extract
those unless Developer Mode is on, which fails the build outright. Nothing is
signed here anyway, so it is skipped; the trade-off is that the executable
carries no embedded version metadata. Turning on Developer Mode
(Settings → System → For developers) lets you drop that setting if you want it.

## Updating the game data

`src/data/game-data.json` is generated from the docs the game ships in
`CommunityResources/Docs/en-US.json`. After a game update, regenerate it:

```bash
npm run extract-data
```

The script finds Satisfactory through Steam's library registry; pass
`--docs <path>` if yours lives somewhere unusual. It reports what it found:
items, recipes, buildings, extractors, belts, pipes, generators and the four
progression tracks.

One thing is not in those docs. The Space Elevator's phase costs live in the
game's own assets, so they come from the mesh exporter instead and are checked
into `tools/space-elevator-phases.json`. Refresh them after an update that
changes Project Assembly:

```bash
tools/mesh-exporter/publish/satisfactory-mesh-exporter.exe --game "<Satisfactory>" --phases tools/space-elevator-phases.json
```

### A trap in the tier data

Every schematic carries an `mTechTier`, and most of them don't mean it. MAM
research reports tier 3 for all hundred of its nodes and the AWESOME shop
reports tier 1, so reading the field across all schematic types puts a Blender
recipe in Tier 0 and quietly makes the whole tier limit meaningless.

Reading only `EST_Milestone` overcorrects, though, and just as quietly: Iron Rod
and Iron Plate are granted by no milestone at all but by
`Schematic_StartingRecipes_C`, filed under `EST_Custom`. Leave that type out and
the two most basic recipes in the game look like locked research — a strict plan
then imports iron plate and routes the rest through hard-drive alternates to
avoid it, which looks like a solver problem and isn't.

So tiers come from `EST_Milestone`, `EST_Tutorial` and `EST_Custom`, minus the
`Research_*` and `*Alternate*` entries filed under Custom by mistake. Everything
else is gated on whether its *machine* exists yet.

Units are normalised on the way through — fluid amounts are stored ×1000 in the
raw files, conveyor speeds are in cm/min, pipe flow is m³/s — and the results
are checked against known in-game figures in the test suite.

## Progression

Four tracks, all read from the game rather than typed in: 48 HUB milestones,
5 Space Elevator phases, 120 MAM research nodes and 109 hard-drive alternates.

Picking one sets the planner's outputs to its cost — converted from a total to a
rate by the delivery time you choose — and caps recipes to what you would hold
at that point. The cap is what makes the answer worth having: without it a plan
for Tier 3's Basic Steel Production will happily route through a Blender, and
you would only find out after building it.

Research and hard drives aren't tier-gated — a drive can hand you a recipe at
any point — so they get their own switch rather than a tier. **HUB only** (the
default) plans with nothing but what the HUB has handed you by that tier, which
is the honest answer to "can I build this today". **+ research & drives** opens
it up and says in the plan which ones it leaned on. The cap doesn't apply to MAM
research itself, which you can do whenever you find the resource.

## Power

The planner works out that a build draws 1.6 GW; the Power tab works out what
that costs. Every generator and fuel the game has, ranked by how many buildings
it takes, with the fuel rate, the water, and the nuclear waste it leaves you
holding.

The number that matters there is **overhead**. Generators burn fuel, and unless
it's coal straight out of the ground, making the fuel takes its own factory that
draws its own power — so it's a fixed point, not a division. Eight Fuel
generators want 140 Fuel a minute; the refineries and extractors behind that
draw 136 MW; covering *that* wants another generator, which wants more fuel. It
settles in three or four passes because every real fuel yields far more than it
costs, and when one doesn't the answer is "this never covers the load" rather
than a number.

An option that isn't buildable says why, because a plan that can't be solved
returns no machines — and no machines reads as no overhead, which makes an
impossible fuel look like the cheapest thing on the board:

- **Gathered by hand** — the chain bottoms out in leaves, wood or hog remains,
  which the game gives no recipe for.
- **Locked by your settings** — recipes exist but none are available: a tier
  limit, a ban, an alternate you haven't ticked. Worth separating from the
  above, since calling a refinery product "gathered by hand" sends you looking
  in entirely the wrong place.
- **Costs more than it makes** — the fixed point diverges.

## Icons

```bash
npm run fetch-icons
```

Downloads an icon for every item, machine and placeable building from the
Satisfactory wiki into `src/data/icons/` — 389 in total, about 9 MB. Re-run it
after a game update adds new content. Some wall and ramp variants have no wiki
page and fall back to a plain coloured box, which is all a wall needs to be.

The folder is gitignored, so each machine fetches its own copy rather than the
repo redistributing the artwork. Without it the app falls back to lettered
tiles, tinted amber for solids and teal for fluids, and stays fully usable.

To use the game's own texture files instead of the wiki's copies, see
[docs/ICONS.md](docs/ICONS.md) — that route needs a one-time FModel export,
because the textures live inside UE5 IoStore containers.

## Tests

```bash
npm test
```

Covers the solver against known in-game values (30 ore for 20 Iron Plate/min,
60 ore for 5 Reinforced Iron Plate/min, belt tiers, the overclock exponent,
Somersloop behaviour, purity scaling), every producible item solving with all
alternates unlocked, and the blueprint reader against any blueprints saved on
this machine.

## What the blueprint viewer draws

A `.sbp` records a transform per building but no geometry. The first time you
open the Blueprints tab the app offers to read the game's real building meshes
from your installed copy; it finds Satisfactory through Steam by itself and the
extractor is bundled, so there is nothing to install. Meshes are cached per-user
in `%APPDATA%\Satisfactory Planner\meshes` — never in the installer or the
repo. See [docs/MESHES.md](docs/MESHES.md) for how it works and what to do when
a game update moves the engine version.

Without that step, or for the buildings that resolve no mesh, each one is drawn
at its **clearance box** — the volume the build gun reserves, taken from the
game's own docs, which matches in game: a Smelter is 5 x 10 x 4.5 m, a
Foundation 8 x 8 x 1 m. Those boxes carry the building's icon on the top face.

Belts, lifts, pipes and power lines are stored as splines. Decoding those needs
a full Unreal property-list parser, so they are drawn as small markers at their
own recorded positions instead — segments sit at regular intervals along a run,
so the markers still trace where a belt goes without inventing geometry.

## How the solver works

Planning is a linear program, not a recursive tree walk.

Satisfactory recipes form a general flow network. A recursive walk breaks on
two things that appear constantly: recipes with more than one output, where the
byproduct has to be credited against demand elsewhere, and mutually recursive
recipe pairs, where the walk never terminates. Solving the whole balance at once
handles both.

The program is

```
minimise  c · x    subject to   A x >= b,  x >= 0
```

where `x` holds a run rate for each recipe plus an extraction rate for each raw
resource, `A` is net output per run, and `b` is the requested rates. The
objective weights raw resources against building count, which is what the
"optimise for" control changes.

It's solved with a **dual** simplex. The obvious formulation — equalities with
explicit surplus variables — needs artificial variables and a phase-1 pass, and
because only target items carry demand almost every row has a zero right-hand
side, so that phase is massively degenerate and cycles in practice instead of
converging. Every cost here is non-negative, which makes the all-slack basis
dual-feasible immediately, so there is no phase 1 to get stuck in. Using `>=`
rather than `=` also makes surplus fall out as row slack, so byproducts need no
variables of their own — the leftover *is* the slack.

Solving every producible item in the game takes about 100 ms in total.

## Layout

```
src/core/     game data, types, the LP solver, the blueprint reader
src/ui/       React interface
src/ui/graph/ the factory flow graph: nodes, belt edges, inspector
src/ui/blueprint/  the 3D blueprint viewer
tools/        extraction scripts for game data and icons
electron/     desktop shell
```

The graph is React Flow with a dagre layout. The plan says how fast each recipe
runs but not which machine feeds which, so the graph splits every item's supply
across the machines that want it in proportion to how much each handles. Supply
equals demand for every item, so that split conserves flow exactly.

## Licence

MIT, for the code. Satisfactory and its data and artwork belong to Coffee Stain
Studios; nothing of theirs is redistributed here — the extraction scripts read
from your own installed copy.
