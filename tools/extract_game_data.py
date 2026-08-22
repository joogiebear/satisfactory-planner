"""
Extract a clean production-planning database from Satisfactory's shipped docs.

The game ships its full item/recipe/building definitions in
    <install>/CommunityResources/Docs/en-US.json
as UTF-16LE JSON, where struct-valued fields are Unreal's text format rather
than nested JSON. This script parses those, normalises the units, and writes a
compact game-data.json for the planner to consume.

Unit notes (verified against in-game values):
  * Fluid/gas amounts in recipes are stored in centilitres -> divide by 1000.
  * Conveyor mSpeed is cm/min -> items/min = mSpeed / 2.
  * Pipeline mFlowLimit is m3/s -> m3/min = mFlowLimit * 60.
  * Extractor rate = mItemsPerCycle / mExtractCycleTime * 60 (then fluid-scaled).

Usage:
    python tools/extract_game_data.py [--docs PATH] [--out PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Locating the game
# --------------------------------------------------------------------------

STEAM_APP_ID = "526870"
FLUID_FORMS = {"RF_LIQUID", "RF_GAS"}
FLUID_SCALE = 1000.0


def find_docs() -> Path | None:
    """Locate en-US.json by walking Steam's library folder registry."""
    roots = [
        Path("C:/Program Files (x86)/Steam"),
        Path("C:/Program Files/Steam"),
    ]
    libraries: list[Path] = []
    for root in roots:
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if not vdf.exists():
            continue
        text = vdf.read_text(encoding="utf-8", errors="replace")
        # Each library block has a "path" line; collect them all.
        for match in re.finditer(r'"path"\s+"([^"]+)"', text):
            libraries.append(Path(match.group(1).replace("\\\\", "\\")))
    libraries.extend(roots)

    for lib in libraries:
        candidate = (
            lib / "steamapps" / "common" / "Satisfactory"
            / "CommunityResources" / "Docs" / "en-US.json"
        )
        if candidate.exists():
            return candidate
    return None


# --------------------------------------------------------------------------
# Unreal text-format parsing
# --------------------------------------------------------------------------

# Matches: ItemClass="...'/Game/.../Desc_IronOre.Desc_IronOre_C'",Amount=3
ITEM_AMOUNT_RE = re.compile(
    r'ItemClass\s*=\s*"[^"]*?[\'"]?(?:/[\w\-/]+\.)?(?P<cls>\w+_C)[\'"]?"'
    r'\s*,\s*Amount\s*=\s*(?P<amt>[\d.]+)'
)

# Matches a trailing class name inside a quoted object path.
CLASS_PATH_RE = re.compile(r'(?:/[\w\-/]+\.)?(\w+_C)')

# Matches: Texture2D /Game/.../UI/IconDesc_IronPlates_256.IconDesc_IronPlates_256
ICON_RE = re.compile(r'(?:Texture2D\s+)?/[\w\-/]+/(?P<asset>[\w\-]+)\.(?P=asset)\s*$')


def parse_icon(raw: str | None) -> str:
    """Asset name of an icon texture, which is what an FModel export is named."""
    if not raw:
        return ""
    m = ICON_RE.search(raw.strip())
    return m.group("asset") if m else ""


def parse_item_amounts(raw: str | None) -> list[dict]:
    """Parse an mIngredients / mProduct field into [{item, amount}]."""
    if not raw:
        return []
    out = []
    for m in ITEM_AMOUNT_RE.finditer(raw):
        out.append({"item": m.group("cls"), "amount": float(m.group("amt"))})
    return out


def parse_class_list(raw: str | None) -> list[str]:
    """Parse a quoted list of object paths into bare class names."""
    if not raw:
        return []
    out = []
    for chunk in re.findall(r'"([^"]+)"', raw):
        m = CLASS_PATH_RE.search(chunk)
        if m:
            out.append(m.group(1))
        elif chunk.startswith("/Script/"):
            out.append(chunk.rsplit(".", 1)[-1])
    return out


def parse_forms(raw: str | None) -> list[str]:
    """Parse '(RF_LIQUID,RF_GAS)' into ['RF_LIQUID', 'RF_GAS']."""
    if not raw:
        return []
    return re.findall(r"RF_\w+", raw)


def fnum(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clean_text(value: str | None) -> str:
    """Strip the narrow no-break spaces the game uses in display strings."""
    if not value:
        return ""
    return value.replace("\u202f", " ").replace("\u00a0", " ").strip()


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

# Groups whose classes describe craftable/extractable *items*.
ITEM_GROUPS = [
    "FGItemDescriptor",
    "FGResourceDescriptor",
    "FGItemDescriptorBiomass",
    "FGItemDescriptorNuclearFuel",
    "FGItemDescriptorPowerBoosterFuel",
    "FGConsumableDescriptor",
    "FGEquipmentDescriptor",
    "FGAmmoTypeProjectile",
    "FGAmmoTypeInstantHit",
    "FGAmmoTypeSpreadshot",
    "FGPowerShardDescriptor",
    "FGBuildingDescriptor",
    "FGVehicleDescriptor",
]

MANUFACTURER_GROUPS = [
    "FGBuildableManufacturer",
    "FGBuildableManufacturerVariablePower",
]

EXTRACTOR_GROUPS = [
    "FGBuildableResourceExtractor",
    "FGBuildableWaterPump",
    "FGBuildableFrackingExtractor",
]

GENERATOR_GROUPS = [
    "FGBuildableGeneratorFuel",
    "FGBuildableGeneratorNuclear",
    "FGBuildableGeneratorGeoThermal",
]


def build_groups(raw: list) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for entry in raw:
        name = entry["NativeClass"].split(".")[-1].rstrip("'")
        groups.setdefault(name, []).extend(entry["Classes"])
    return groups


def extract_items(groups: dict) -> dict[str, dict]:
    resource_keys = {
        c["ClassName"] for c in groups.get("FGResourceDescriptor", [])
    }
    items: dict[str, dict] = {}
    for group in ITEM_GROUPS:
        for c in groups.get(group, []):
            key = c["ClassName"]
            if key in items:
                continue
            form = c.get("mForm", "RF_SOLID")
            is_fluid = form in FLUID_FORMS
            # Fluid energy is stored per litre; normalise to per m3 so it lines
            # up with the m3/min the rest of the planner speaks in.
            energy = fnum(c.get("mEnergyValue")) * (FLUID_SCALE if is_fluid else 1.0)
            items[key] = {
                "key": key,
                "name": clean_text(c.get("mDisplayName")) or key,
                "form": form,
                "isFluid": is_fluid,
                "isRaw": key in resource_keys,
                "stackSize": c.get("mStackSize", "SS_MEDIUM"),
                "energyMJ": round(energy, 4),
                "sinkPoints": int(fnum(c.get("mResourceSinkPoints"))),
                "icon": parse_icon(c.get("mSmallIcon") or c.get("mPersistentBigIcon")),
                "category": group,
            }
    return items


def extract_buildings(groups: dict) -> dict[str, dict]:
    # A buildable's icon lives on its matching descriptor, e.g. the icon for
    # Build_ConstructorMk1_C is on Desc_ConstructorMk1_C.
    descriptor_icons = {
        c["ClassName"]: parse_icon(c.get("mSmallIcon") or c.get("mPersistentBigIcon"))
        for c in groups.get("FGBuildingDescriptor", [])
    }
    buildings: dict[str, dict] = {}
    for group in MANUFACTURER_GROUPS:
        for c in groups.get(group, []):
            key = c["ClassName"]
            can_boost = str(c.get("mCanChangeProductionBoost", "True")) == "True"
            override_slots = str(c.get("mOverrideProductionShardSlotSize", "False")) == "True"
            # When the building doesn't override the slot count it falls back to
            # the engine default of one slot (Constructor/Smelter both = 1).
            slots = int(fnum(c.get("mProductionShardSlotSize"))) if override_slots else 1
            boost_per = fnum(c.get("mProductionShardBoostMultiplier"), 1.0) if override_slots else 1.0
            if not can_boost:
                slots, boost_per = 0, 0.0
            buildings[key] = {
                "key": key,
                "name": clean_text(c.get("mDisplayName")) or key,
                "powerMW": round(fnum(c.get("mPowerConsumption")), 4),
                "powerExponent": round(fnum(c.get("mPowerConsumptionExponent"), 1.321929), 6),
                "boostPowerExponent": round(fnum(c.get("mProductionBoostPowerConsumptionExponent"), 2.0), 4),
                "manufacturingSpeed": fnum(c.get("mManufacturingSpeed"), 1.0),
                "sloopSlots": slots,
                "sloopBoostPerSlot": round(boost_per, 6),
                "canOverclock": str(c.get("mCanChangePotential", "True")) == "True",
                "maxPotential": fnum(c.get("mMaxPotential"), 1.0),
                "icon": descriptor_icons.get(key.replace("Build_", "Desc_", 1), ""),
                "variablePower": group == "FGBuildableManufacturerVariablePower",
            }
    return buildings


def extract_recipes(groups: dict, items: dict, buildings: dict) -> dict[str, dict]:
    recipes: dict[str, dict] = {}
    for c in groups.get("FGRecipe", []):
        key = c["ClassName"]
        produced_in = parse_class_list(c.get("mProducedIn"))
        machines = [m for m in produced_in if m in buildings]
        if not machines:
            # Build-gun / workbench-only recipes can't be automated.
            continue

        ingredients = parse_item_amounts(c.get("mIngredients"))
        products = parse_item_amounts(c.get("mProduct"))
        if not products:
            continue

        # Skip recipes referencing items we don't know about.
        refs = [e["item"] for e in ingredients + products]
        if any(r not in items for r in refs):
            continue

        # Fluids are stored x1000.
        for entry in ingredients + products:
            if items[entry["item"]]["isFluid"]:
                entry["amount"] = entry["amount"] / FLUID_SCALE

        duration = fnum(c.get("mManufactoringDuration"), 1.0)
        if duration <= 0:
            continue

        const = fnum(c.get("mVariablePowerConsumptionConstant"))
        factor = fnum(c.get("mVariablePowerConsumptionFactor"), 1.0)
        machine = machines[0]
        var_power = None
        if buildings[machine]["variablePower"] and (const or factor != 1.0):
            var_power = {
                "minMW": round(const, 3),
                "maxMW": round(const + factor, 3),
                "avgMW": round(const + factor / 2.0, 3),
            }

        name = clean_text(c.get("mDisplayName")) or key
        is_alt = name.startswith("Alternate:") or "_Alternate_" in key

        recipes[key] = {
            "key": key,
            "name": name[len("Alternate:"):].strip() if is_alt else name,
            "isAlternate": is_alt,
            "timeSeconds": duration,
            "machine": machine,
            "ingredients": [
                {"item": e["item"], "amount": round(e["amount"], 6)} for e in ingredients
            ],
            "products": [
                {"item": e["item"], "amount": round(e["amount"], 6)} for e in products
            ],
            "variablePower": var_power,
        }
    return recipes


def extract_extractors(groups: dict, items: dict) -> list[dict]:
    out = []
    for group in EXTRACTOR_GROUPS:
        for c in groups.get(group, []):
            cycle = fnum(c.get("mExtractCycleTime"), 1.0)
            per_cycle = fnum(c.get("mItemsPerCycle"))
            if cycle <= 0:
                continue
            forms = parse_forms(c.get("mAllowedResourceForms"))
            is_fluid = bool(set(forms) & FLUID_FORMS)
            rate = per_cycle / cycle * 60.0
            if is_fluid:
                rate /= FLUID_SCALE
            only_certain = str(c.get("mOnlyAllowCertainResources", "False")) == "True"
            allowed = parse_class_list(c.get("mAllowedResources")) if only_certain else []
            out.append({
                "key": c["ClassName"],
                "name": clean_text(c.get("mDisplayName")) or c["ClassName"],
                "kind": "fracking" if group == "FGBuildableFrackingExtractor" else (
                    "fluid" if is_fluid else "solid"),
                "baseRatePerMin": round(rate, 6),
                "powerMW": round(fnum(c.get("mPowerConsumption")), 4),
                "powerExponent": round(fnum(c.get("mPowerConsumptionExponent"), 1.321929), 6),
                "allowedForms": forms,
                "allowedResources": [a for a in allowed if a in items],
                # Purity only scales solid nodes and fracking; water is unlimited.
                "affectedByPurity": group != "FGBuildableWaterPump",
            })
    out.sort(key=lambda e: (e["kind"], e["baseRatePerMin"]))
    return out


def extract_belts(groups: dict) -> list[dict]:
    belts = []
    seen = set()
    for c in groups.get("FGBuildableConveyorBelt", []):
        name = clean_text(c.get("mDisplayName"))
        if "Clean" in name or name in seen:
            continue
        seen.add(name)
        belts.append({
            "key": c["ClassName"],
            "name": name,
            "itemsPerMin": round(fnum(c.get("mSpeed")) / 2.0, 3),
        })
    belts.sort(key=lambda b: b["itemsPerMin"])
    return belts


def extract_pipes(groups: dict) -> list[dict]:
    pipes = []
    seen = set()
    for c in groups.get("FGBuildablePipeline", []):
        name = clean_text(c.get("mDisplayName"))
        if "Clean" in name or name in seen:
            continue
        seen.add(name)
        pipes.append({
            "key": c["ClassName"],
            "name": name,
            "cubicMetersPerMin": round(fnum(c.get("mFlowLimit")) * 60.0, 3),
        })
    pipes.sort(key=lambda p: p["cubicMetersPerMin"])
    return pipes


def extract_generators(groups: dict, items: dict) -> list[dict]:
    """Generators, with per-fuel burn rates derived from fuel energy content.

    mFuel is already nested JSON here (unlike the Unreal-struct string fields).
    Verified: Coal gen 75 MW * ratio 10 -> 45 m3/min water; Nuclear 2500 MW *
    ratio 1.6 -> 240 m3/min water.
    """
    out = []
    for group in GENERATOR_GROUPS:
        for c in groups.get(group, []):
            power = fnum(c.get("mPowerProduction"))
            if power <= 0:
                continue
            sup_ratio = fnum(c.get("mSupplementalToPowerRatio"))
            needs_sup = str(c.get("mRequiresSupplementalResource", "False")) == "True"

            fuels = []
            for entry in c.get("mFuel") or []:
                if not isinstance(entry, dict):
                    continue
                fuel_key = entry.get("mFuelClass", "")
                if fuel_key not in items:
                    continue
                energy = items[fuel_key]["energyMJ"]
                # Fluid energy values are per m3 already; solids are per item.
                burn = (power / energy * 60.0) if energy > 0 else 0.0

                byproduct = entry.get("mByproduct") or ""
                byproduct_amount = fnum(entry.get("mByproductAmount"))
                fuels.append({
                    "item": fuel_key,
                    "ratePerMin": round(burn, 6),
                    "supplemental": (entry.get("mSupplementalResourceClass") or "") or None,
                    "supplementalPerMin": round(power * sup_ratio * 60.0 / 1000.0, 6)
                    if needs_sup else 0.0,
                    "byproduct": byproduct if byproduct in items else None,
                    "byproductPerMin": round(burn * byproduct_amount, 6)
                    if byproduct in items else 0.0,
                })

            out.append({
                "key": c["ClassName"],
                "name": clean_text(c.get("mDisplayName")) or c["ClassName"],
                "powerMW": round(power, 3),
                "fuels": fuels,
            })
    out.sort(key=lambda g: g["powerMW"])
    return out


CLEARANCE_RE = re.compile(
    r"ClearanceBox=\(Min=\(X=(?P<x0>-?[\d.]+),Y=(?P<y0>-?[\d.]+),Z=(?P<z0>-?[\d.]+)\),"
    r"Max=\(X=(?P<x1>-?[\d.]+),Y=(?P<y1>-?[\d.]+),Z=(?P<z1>-?[\d.]+)\)"
)
TRANSLATION_RE = re.compile(
    r"RelativeTransform=\(Translation=\(X=(?P<x>-?[\d.]+),Y=(?P<y>-?[\d.]+),Z=(?P<z>-?[\d.]+)\)"
)


def buildable_category(group: str, key: str) -> str:
    """Coarse grouping used to colour a blueprint preview."""
    g, k = group.lower(), key.lower()
    if "conveyor" in k or "conveyor" in g:
        return "conveyor"
    if "pipe" in k or "pipe" in g:
        return "pipe"
    if "foundation" in g or "foundation" in k or "ramp" in g or "walkway" in g or "catwalk" in k:
        return "foundation"
    if "wall" in g or "wall" in k or "door" in g or "gate" in k or "window" in k:
        return "wall"
    if "power" in g or "power" in k or "wire" in k or "generator" in g:
        return "power"
    if group in MANUFACTURER_GROUPS or group in EXTRACTOR_GROUPS:
        return "machine"
    if "storage" in g or "container" in k:
        return "storage"
    return "other"


def extract_footprints(groups: dict) -> dict[str, dict]:
    """Bounding box per buildable, in centimetres, from its clearance volume.

    A blueprint records only a transform per building, so drawing it needs the
    size from somewhere: the clearance box is the game's own footprint and
    matches what the build gun reserves (Smelter 500x1000x450, Foundation
    800x800x100). Buildings without one -- belts and pipes, which are splines --
    fall back to a small marker so their run still shows.
    """
    out: dict[str, dict] = {}
    for group, classes in groups.items():
        if not group.startswith("FGBuildable"):
            continue
        for c in classes:
            key = c.get("ClassName", "")
            if not key or key in out:
                continue
            raw = str(c.get("mClearanceData", "") or "")
            box = None
            m = CLEARANCE_RE.search(raw)
            if m:
                lo = [fnum(m.group("x0")), fnum(m.group("y0")), fnum(m.group("z0"))]
                hi = [fnum(m.group("x1")), fnum(m.group("y1")), fnum(m.group("z1"))]
                # The box may be offset from the actor origin.
                t = TRANSLATION_RE.search(raw[m.end():m.end() + 220])
                if t:
                    off = [fnum(t.group("x")), fnum(t.group("y")), fnum(t.group("z"))]
                    lo = [lo[i] + off[i] for i in range(3)]
                    hi = [hi[i] + off[i] for i in range(3)]
                box = {"min": [round(v, 1) for v in lo], "max": [round(v, 1) for v in hi]}
            elif c.get("mWidth") or c.get("mHeight"):
                w = fnum(c.get("mWidth"), 200.0) / 2
                h = fnum(c.get("mHeight"), 200.0)
                box = {"min": [-w, -w, 0.0], "max": [w, w, h]}

            out[key] = {
                "category": buildable_category(group, key),
                "box": box,
            }
    return out


def extract_buildable_names(groups: dict) -> dict[str, str]:
    """Display name for every placeable building, keyed by its Build_*_C class.

    Blueprints reference buildables by class path, including scenery like
    foundations and walls that never appear in a recipe, so this covers far more
    than the production machines the planner itself needs.
    """
    names: dict[str, str] = {}
    for group, classes in groups.items():
        if not group.startswith("FGBuildable"):
            continue
        for c in classes:
            key = c.get("ClassName", "")
            label = clean_text(c.get("mDisplayName"))
            if key and label and key not in names:
                names[key] = label
    return names


# The MAM's research trees, keyed by the prefix its class names carry. The
# game groups these visually and nothing in the docs names the grouping, so the
# class name is the only handle there is.
# The schematic types the HUB hands you as you progress, as opposed to research
# you opt into. Iron Rod and Iron Plate live in EST_Custom
# (`Schematic_StartingRecipes_C`) rather than in any milestone, so leaving that
# type out makes the most basic recipes in the game look like locked research.
HUB_SCHEMATIC_TYPES = {"EST_Milestone", "EST_Tutorial", "EST_Custom"}

MAM_TREES = {
    "Quartz": "Quartz",
    "Caterium": "Caterium",
    "Sulfur": "Sulfur",
    "Mycelia": "Mycelia",
    "Nutrients": "Nutrients",
    "PowerSlugs": "Power Slugs",
    "Alien": "Alien Technology",
    "ACarapace": "Alien Technology",
    "AOrgans": "Alien Technology",
    "AOrganisms": "Alien Technology",
    "AO": "Alien Technology",
    "XMas": "FICSMAS",
}


def schematic_goals(groups: dict, items: dict, recipes: dict, types: set[str], track: str) -> list[dict]:
    """Things you complete to unlock more of the game, in a shape the planner
    can act on: what it costs, and which recipes it hands you.

    An unlock can also be a map marker, an inventory slot or pure information.
    Those are counted rather than listed — the planner has nothing to say about
    them, but "and 2 other unlocks" is worth knowing before you commit to a
    build.
    """
    out: list[dict] = []
    for c in groups.get("FGSchematic", []):
        if c.get("mType") not in types:
            continue

        unlocked: list[str] = []
        other = 0
        for unlock in c.get("mUnlocks", []) or []:
            if unlock.get("Class") == "BP_UnlockRecipe_C":
                unlocked.extend(parse_class_list(unlock.get("mRecipes")))
            else:
                other += 1

        key = c.get("ClassName", "")
        group = ""
        if track == "mam":
            m = re.match(r"Research_([A-Za-z]+)_", key)
            group = MAM_TREES.get(m.group(1), "Other") if m else "Other"

        out.append({
            "key": key,
            "name": clean_text(c.get("mDisplayName")),
            "track": track,
            "tier": int(fnum(c.get("mTechTier"), 0)),
            "group": group,
            # A cost can name an item no recipe produces (raw ore, alien parts),
            # and those are dropped rather than left as keys resolving to nothing.
            "cost": [e for e in parse_item_amounts(c.get("mCost")) if e["item"] in items],
            "unlocksRecipes": [r for r in unlocked if r in recipes],
            "otherUnlocks": other,
            "note": "",
        })
    return out


def extract_milestones(groups: dict, items: dict, recipes: dict) -> list[dict]:
    """The HUB milestones, in the order the game presents them.

    Tutorial schematics are the Tier 0 HUB upgrades and milestones proper start
    at Tier 1, so both are kept: they are one continuous progression to a player
    and splitting them would leave the first six steps missing.
    """
    out = schematic_goals(groups, items, recipes, {"EST_Milestone", "EST_Tutorial"}, "milestone")
    out.sort(key=lambda m: (m["tier"], m["key"]))
    return out


def extract_mam(groups: dict, items: dict, recipes: dict) -> list[dict]:
    """MAM research nodes, grouped by tree.

    Their `mTechTier` is meaningless — every node reports 3 — so it is left in
    the record but the grouping is what the UI should sort on.
    """
    out = schematic_goals(groups, items, recipes, {"EST_MAM"}, "mam")
    out.sort(key=lambda m: (m["group"], m["name"]))
    return out


def extract_hard_drives(groups: dict, items: dict, recipes: dict) -> list[dict]:
    """Hard-drive alternates.

    These cost nothing to unlock — you find the drive — so there is nothing to
    plan. What matters is which recipe each one gives you, so it can be switched
    on once you have it.
    """
    out = schematic_goals(groups, items, recipes, {"EST_Alternate"}, "harddrive")
    out.sort(key=lambda m: m["name"])
    return out


def load_game_phases(path: Path | None, items: dict) -> list[dict]:
    """Space Elevator phases, read from the game's own assets by the mesh
    exporter (`--phases`), because they are absent from the exported docs.

    A phase records the last tier it *unlocks*, not the tech you build it with:
    Phase 1 opens Tiers 3 and 4, and you deliver it holding Tier 2. So the tier
    a phase is planned at is the previous phase's last — which is why the
    exporter emits the cost-less phases too, to keep that chain unbroken.
    """
    if not path or not path.exists():
        return []

    raw = json.loads(path.read_text(encoding="utf-8"))
    out = []
    previous = 0

    for entry in raw:
        cost = [e for e in entry.get("cost", []) if e["item"] in items]
        last = int(entry.get("lastTier", 0))
        if cost:
            number = re.search(r"(\d+)$", entry.get("key", ""))
            opened = [t for t in range(previous + 1, last + 1)]
            out.append({
                "key": entry.get("key", ""),
                "name": clean_text(entry.get("name")) or f"Phase {number.group(1) if number else len(out) + 1}",
                "track": "spaceelevator",
                "tier": previous,
                "group": "",
                "cost": cost,
                "unlocksRecipes": [],
                "otherUnlocks": 0,
                # A phase unlocks tiers rather than recipes, which is the whole
                # reason to build one; saying "no new recipes" would be true and
                # useless.
                "note": ("Opens Tier " + " and ".join(str(t) for t in opened)) if opened
                        else "Completes Project Assembly",
            })
        previous = max(previous, last)
    return out


def recipe_tiers(groups: dict, recipes: dict) -> dict[str, int]:
    """The tier at which each recipe is handed to you by the HUB.

    Only the schematics the HUB progression actually hands you count. Every
    schematic carries an `mTechTier`, but it means nothing on most of them: MAM
    research reports tier 3 for all hundred of its nodes and the AWESOME shop
    reports tier 1, so reading the field across all types puts a Blender recipe
    in Tier 0 and makes the whole limit meaningless.

    A recipe the HUB never grants gets no entry rather than a zero. That is the
    honest answer: MAM research and hard drives are not tier-gated, so the
    limit has nothing to say about them and the machine check carries the
    weight instead.
    """
    tiers: dict[str, int] = {}
    for c in groups.get("FGSchematic", []):
        if c.get("mType") not in HUB_SCHEMATIC_TYPES:
            continue
        # EST_Custom is a grab bag. Most of what it holds belongs to the HUB
        # progression -- the recipes you start the game with, and the companion
        # schematics that carry the second half of a milestone's unlocks -- but
        # a few MAM nodes and hard-drive alternates are filed there too, and
        # those are research whatever the field says.
        key = c.get("ClassName", "")
        if c.get("mType") == "EST_Custom" and (
            key.startswith("Research_") or "Alternate" in key
        ):
            continue
        tier = int(fnum(c.get("mTechTier"), 0))
        for unlock in c.get("mUnlocks", []) or []:
            if unlock.get("Class") != "BP_UnlockRecipe_C":
                continue
            for key in parse_class_list(unlock.get("mRecipes")):
                if key in recipes and (key not in tiers or tier < tiers[key]):
                    tiers[key] = tier
    return tiers


def machine_tiers(recipes: dict, tiers: dict[str, int]) -> dict[str, int]:
    """The earliest tier each production building can exist at.

    Derived from the standard recipes rather than the building's own unlock,
    because a building's recipe is not in this database -- only the things
    buildings make are. The first standard recipe a machine runs arrives with
    the machine, so the two tiers are the same.

    Alternates are excluded on purpose: a hard drive can hand you a Blender
    recipe long before Tier 7, and taking that as evidence the Blender exists
    would defeat the point of the limit.
    """
    out: dict[str, int] = {}
    for key, r in recipes.items():
        machine = r.get("machine")
        if not machine or r["isAlternate"]:
            continue
        tier = tiers.get(key)
        if tier is None:
            continue  # MAM-granted: says nothing about when the machine arrives
        if machine not in out or tier < out[machine]:
            out[machine] = tier
    return out


def extract_icons(groups: dict, items: dict, buildables: dict) -> dict[str, str]:
    """Class name -> the game's own icon texture for it.

    The icons used to come off the wiki, which meant downloading Coffee Stain's
    artwork and baking it into the installer. The game ships the same icons and
    every descriptor names one, so they can be read from the player's own copy
    like the building models are -- nothing redistributed, and better coverage
    besides.

    A buildable carries no icon itself; its descriptor does, under the matching
    Desc_ name.
    """
    by_descriptor: dict[str, str] = {}
    for classes in groups.values():
        for c in classes:
            asset = parse_icon(c.get("mSmallIcon")) or parse_icon(c.get("mPersistentBigIcon"))
            if asset:
                by_descriptor[c.get("ClassName", "")] = asset

    out: dict[str, str] = {}
    for key in items:
        if key in by_descriptor:
            out[key] = by_descriptor[key]
    for key in buildables:
        descriptor = "Desc_" + key[len("Build_"):] if key.startswith("Build_") else key
        if descriptor in by_descriptor:
            out[key] = by_descriptor[descriptor]
    return out


def prune_unreachable(items: dict, recipes: dict) -> dict:
    """Keep only items that participate in an automatable recipe."""
    used = set()
    for r in recipes.values():
        for e in r["ingredients"] + r["products"]:
            used.add(e["item"])
    return {k: v for k, v in items.items() if k in used}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--docs", type=Path, default=None, help="Path to en-US.json")
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parents[1] / "src" / "data" / "game-data.json")
    ap.add_argument("--version", default="unknown", help="Game version label to embed")
    ap.add_argument("--phases", type=Path,
                    default=Path(__file__).resolve().parent / "space-elevator-phases.json",
                    help="Space Elevator phases, from satisfactory-mesh-exporter --phases")
    args = ap.parse_args()

    docs = args.docs or find_docs()
    if not docs or not docs.exists():
        print("ERROR: could not find en-US.json. Pass --docs <path>.", file=sys.stderr)
        print("  Expected under: <Satisfactory>/CommunityResources/Docs/en-US.json", file=sys.stderr)
        return 1

    print(f"Reading {docs}")
    raw = json.loads(docs.read_text(encoding="utf-16"))
    groups = build_groups(raw)

    items = extract_items(groups)
    buildings = extract_buildings(groups)
    recipes = extract_recipes(groups, items, buildings)
    items = prune_unreachable(items, recipes)
    milestones = extract_milestones(groups, items, recipes)
    phases = load_game_phases(args.phases, items)
    tiers = recipe_tiers(groups, recipes)
    buildable_names = extract_buildable_names(groups)
    icons = extract_icons(groups, items, buildable_names)

    data = {
        "gameVersion": args.version,
        # The file's name, not its path: this ships publicly and nobody needs
        # to know which drive the game is installed on.
        "source": docs.name,
        "items": items,
        "recipes": recipes,
        "buildings": buildings,
        "extractors": extract_extractors(groups, items),
        "belts": extract_belts(groups),
        "pipes": extract_pipes(groups),
        "generators": extract_generators(groups, items),
        "buildableNames": buildable_names,
        "icons": icons,
        "footprints": extract_footprints(groups),
        "milestones": milestones,
        "spaceElevator": phases,
        "mamResearch": extract_mam(groups, items, recipes),
        "hardDrives": extract_hard_drives(groups, items, recipes),
        "recipeTiers": tiers,
        "machineTiers": machine_tiers(recipes, tiers),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")

    size_kb = args.out.stat().st_size / 1024
    print(f"Wrote {args.out}  ({size_kb:.0f} KB)")
    print(f"  items       {len(items)}")
    print(f"  recipes     {len(recipes)}  ({sum(1 for r in recipes.values() if r['isAlternate'])} alternate)")
    print(f"  phases      {len(phases)} Space Elevator")
    print(f"  milestones  {len(milestones)}  (tiers {min(m['tier'] for m in milestones)}-{max(m['tier'] for m in milestones)})")
    print(f"  buildings   {len(buildings)}")
    print(f"  extractors  {len(data['extractors'])}")
    print(f"  belts       {len(data['belts'])}")
    print(f"  pipes       {len(data['pipes'])}")
    print(f"  generators  {len(data['generators'])}")
    print(f"  buildables  {len(data['buildableNames'])}")
    print(f"  icons       {len(icons)}")
    boxed = sum(1 for v in data['footprints'].values() if v['box'])
    print(f"  footprints  {boxed}/{len(data['footprints'])} with a box")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
