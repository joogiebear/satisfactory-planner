"""
Download item and machine icons from the Satisfactory wiki.

The game's own artwork lives inside UE5 IoStore containers that need FModel to
open by hand (see tools/extract_icons.py and docs/ICONS.md). This script is the
automatic alternative: the wiki publishes the same icons under predictable
titles, so every item and building in game-data.json can be matched by name.

    python tools/fetch_icons.py

Icons land in src/data/icons/<ClassName>.png and are gitignored, so each machine
fetches its own copy rather than the repo redistributing the artwork.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is optional
    Image = None

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "src" / "data" / "game-data.json"
OUT = ROOT / "src" / "data" / "icons"

API = "https://satisfactory.wiki.gg/api.php"
HEADERS = {"User-Agent": "satisfactory-planner/1.0 (personal factory planner)"}
BATCH = 40


def api_get(params: dict) -> dict:
    url = f"{API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def resolve_urls(names: list[str]) -> dict[str, str]:
    """Map display name -> direct image URL, asking the wiki in batches."""
    found: dict[str, str] = {}
    for start in range(0, len(names), BATCH):
        batch = names[start:start + BATCH]
        try:
            res = api_get({
                "action": "query",
                "titles": "|".join(f"File:{n}.png" for n in batch),
                "prop": "imageinfo",
                "iiprop": "url",
                "format": "json",
            })
        except Exception as exc:
            print(f"  batch {start // BATCH + 1} failed: {exc}", file=sys.stderr)
            continue

        query = res.get("query", {})
        # MediaWiki rewrites titles (underscores to spaces), so map back.
        renamed = {n["to"]: n["from"] for n in query.get("normalized", [])}
        for page in query.get("pages", {}).values():
            info = page.get("imageinfo")
            if not info:
                continue
            title = renamed.get(page.get("title", ""), page.get("title", ""))
            if title.startswith("File:") and title.endswith(".png"):
                found[title[5:-4]] = info[0]["url"]
        time.sleep(0.15)  # be polite to the wiki
    return found


def save(url: str, dest: Path, size: int) -> None:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
    dest.write_bytes(raw)
    if Image is None:
        return
    with Image.open(dest) as img:
        img = img.convert("RGBA")
        if max(img.size) > size:
            img.thumbnail((size, size), Image.LANCZOS)
        img.save(dest, "PNG", optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", type=int, default=128, help="Max icon size in pixels")
    ap.add_argument("--force", action="store_true", help="Re-download icons that already exist")
    args = ap.parse_args()
    socket.setdefaulttimeout(25)

    if not DATA.exists():
        print("ERROR: run tools/extract_game_data.py first.", file=sys.stderr)
        return 1
    if Image is None:
        print("NOTE: Pillow isn't installed, so icons are saved at full size.")

    data = json.loads(DATA.read_text(encoding="utf-8"))
    # One class can share a name with another; keep every class that needs art.
    wanted: dict[str, str] = {}
    for key, item in data["items"].items():
        wanted[key] = item["name"]
    for key, building in data["buildings"].items():
        wanted[key] = building["name"]
    # Every placeable building too, so the blueprint preview can label its boxes.
    # The wiki has no page for many wall and ramp variants; those just fall back
    # to a plain coloured box, which is all a wall needs to be.
    for key, name in (data.get("buildableNames") or {}).items():
        wanted.setdefault(key, name)

    OUT.mkdir(parents=True, exist_ok=True)
    todo = {k: v for k, v in wanted.items() if args.force or not (OUT / f"{k}.png").exists()}
    if not todo:
        print(f"All {len(wanted)} icons already present in {OUT}")
        return 0

    print(f"Resolving {len(set(todo.values()))} names on the wiki…")
    urls = resolve_urls(sorted(set(todo.values())))
    print(f"Resolved {len(urls)}")

    saved, missing = 0, []
    for key, name in sorted(todo.items()):
        url = urls.get(name)
        if not url:
            missing.append(f"{name} ({key})")
            continue
        try:
            save(url, OUT / f"{key}.png", args.size)
            saved += 1
        except Exception as exc:
            missing.append(f"{name} ({key}): {exc}")
        if saved % 25 == 0 and saved:
            print(f"  {saved}…")

    total = len(list(OUT.glob("*.png")))
    print(f"Saved {saved} icons; {total} now in {OUT}")
    if missing:
        print(f"{len(missing)} could not be fetched:")
        for m in missing[:12]:
            print(f"   {m}")
        print("Those fall back to lettered tiles.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
