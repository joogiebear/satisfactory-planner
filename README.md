# Satisfactory Planner

A desktop production planner for Satisfactory. Pick what you want to make and
how many per minute; it works out the machines, the raw resources, the power
draw and where your belts run out of headroom.

Everything is computed from the game's own data files, so the numbers match the
build you have installed rather than a wiki snapshot.

## What it does

- **Production tree** — the full chain for any item, with per-branch machine
  counts and power. Connectors are drawn as the logistics: amber for belts,
  teal for pipes, and hazard stripes on any link that exceeds the tier you
  picked, with the number of lines it would need.
- **Correct byproducts and loops** — recipes with two outputs (Plastic also
  makes Heavy Oil Residue) and mutually recursive pairs (Recycled Plastic and
  Recycled Rubber consume each other) are solved as one material balance, not
  walked recursively.
- **Alternate recipes** — tick the ones you've unlocked; only those are used.
- **Overclocking and Somersloops** — per recipe, with the real
  `clock^1.321929` power curve and Somersloops doubling output at 4× draw.
- **Extraction settings** — miner mark, node purity per resource, and pump
  clock, feeding exact extractor counts.
- **Blueprint reader** — drop in a `.sbp` and see its footprint, exact build
  cost, every building inside it, and how it lines up with your current plan.

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
items, recipes, buildings, extractors, belts, pipes and generators.

Units are normalised on the way through — fluid amounts are stored ×1000 in the
raw files, conveyor speeds are in cm/min, pipe flow is m³/s — and the results
are checked against known in-game figures in the test suite.

## Icons

Optional, and off by default: the app ships with lettered tiles. To use the
game's own artwork, see [docs/ICONS.md](docs/ICONS.md). It needs a one-time
FModel export because the textures live inside UE5 IoStore containers.

## Tests

```bash
npm test
```

Covers the solver against known in-game values (30 ore for 20 Iron Plate/min,
60 ore for 5 Reinforced Iron Plate/min, belt tiers, the overclock exponent,
Somersloop behaviour, purity scaling), every producible item solving with all
alternates unlocked, and the blueprint reader against any blueprints saved on
this machine.

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
tools/        extraction scripts for game data and icons
electron/     desktop shell
```

## Licence

MIT, for the code. Satisfactory and its data and artwork belong to Coffee Stain
Studios; nothing of theirs is redistributed here — the extraction scripts read
from your own installed copy.
