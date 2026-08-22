"""
Copy Satisfactory's item and machine icons into the planner.

The game keeps its art inside UE5 IoStore containers (FactoryGame-Windows.utoc
/ .ucas), which this script cannot open on its own. Export the textures once
with FModel, then point this script at the export folder and it matches each
PNG to the right item or building using the icon names already recorded in
game-data.json.

    python tools/extract_icons.py --from "C:/Users/you/Documents/FModel/Output/Exports"

See docs/ICONS.md for the FModel steps.

The icons stay out of git: they are Coffee Stain's artwork, so each machine
extracts its own copy from the game it already owns. Without them the planner
falls back to lettered tiles, so this step is optional.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is optional
    Image = None

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "data" / "game-data.json"
OUT = ROOT / "src" / "data" / "icons"


def index_exports(root: Path) -> dict[str, Path]:
    """Map every exported texture's stem to its path, e.g. IconDesc_IronPlates_256."""
    found: dict[str, Path] = {}
    for path in root.rglob("*.png"):
        found.setdefault(path.stem, path)
    return found


def emit(src: Path, dest: Path, size: int) -> None:
    """Downscale into place when Pillow is available, otherwise copy as-is."""
    if Image is None:
        shutil.copyfile(src, dest)
        return
    with Image.open(src) as img:
        img = img.convert("RGBA")
        if max(img.size) > size:
            img = img.resize((size, size), Image.LANCZOS)
        img.save(dest, "PNG", optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="source", type=Path, required=True,
                    help="FModel Exports folder (or any folder of exported PNGs)")
    ap.add_argument("--size", type=int, default=96, help="Max icon size in pixels")
    ap.add_argument("--clean", action="store_true", help="Remove existing icons first")
    args = ap.parse_args()

    if not args.source.exists():
        print(f"ERROR: {args.source} does not exist.", file=sys.stderr)
        return 1
    if not DATA.exists():
        print("ERROR: run tools/extract_game_data.py first.", file=sys.stderr)
        return 1
    if Image is None:
        print("NOTE: Pillow isn't installed, so icons are copied at full size.")
        print("      pip install Pillow  gives smaller files.")

    data = json.loads(DATA.read_text(encoding="utf-8"))
    exports = index_exports(args.source)
    print(f"Found {len(exports)} exported textures under {args.source}")

    if args.clean and OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    wanted: list[tuple[str, str]] = []
    for key, item in data["items"].items():
        if item.get("icon"):
            wanted.append((key, item["icon"]))
    for key, building in data["buildings"].items():
        if building.get("icon"):
            wanted.append((key, building["icon"]))

    copied, missing = 0, []
    for key, icon in wanted:
        src = exports.get(icon)
        if not src:
            missing.append(f"{key} ({icon})")
            continue
        emit(src, OUT / f"{key}.png", args.size)
        copied += 1

    print(f"Wrote {copied} icons to {OUT}")
    if missing:
        print(f"{len(missing)} had no matching export, e.g.:")
        for m in missing[:8]:
            print(f"   {m}")
        print("Those fall back to lettered tiles. Check the FModel export covers")
        print("FactoryGame/Content/FactoryGame with 'Texture' included.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
