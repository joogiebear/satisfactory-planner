using System.Text.Json;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Component.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Meshes;
using CUE4Parse_Conversion.Textures;
using CUE4Parse.UE4.Assets.Exports.Texture;

namespace SatisfactoryMeshExporter;

/// <summary>
/// Exports Satisfactory's building meshes straight from an installed copy of
/// the game, so the planner can draw real geometry instead of boxes.
///
/// The models live inside UE5 IoStore containers (.utoc/.ucas) in Unreal's own
/// format, which only a UE asset library can read. CUE4Parse is the same
/// library FModel is built on, so this does what an FModel export would without
/// the clicking.
///
/// Nothing is redistributed: this reads the copy of the game already on the
/// machine and writes into the planner's own data folder.
/// </summary>
public static class Program
{
    private static bool Verbose;
    private static bool WithMaterials;

    public static int Main(string[] args)
    {
        var gameDir = ArgValue(args, "--game");
        // Default into the temp folder rather than the working directory: a
        // bare "meshes" once landed the game's models in a git checkout, and
        // from there into a commit.
        var outDir = ArgValue(args, "--out")
                     ?? Path.Combine(Path.GetTempPath(), "satisfactory-meshes");
        var listOnly = args.Contains("--list");
        Verbose = args.Contains("--verbose");
        WithMaterials = !args.Contains("--no-materials");
        var limit = int.TryParse(ArgValue(args, "--limit"), out var l) ? l : int.MaxValue;
        var versionArg = ArgValue(args, "--ue");
        var only = ArgValue(args, "--only");
        var findFiles = ArgValue(args, "--files");
        var dumpAsset = ArgValue(args, "--dump");
        var phasesOut = ArgValue(args, "--phases");

        if (string.IsNullOrWhiteSpace(gameDir))
        {
            Console.Error.WriteLine("usage: satisfactory-mesh-exporter --game <Satisfactory dir> --out <dir> [--list] [--limit N] [--ue GAME_UE5_6]");
            return 2;
        }

        var paks = Path.Combine(gameDir, "FactoryGame", "Content", "Paks");
        if (!Directory.Exists(paks))
        {
            Console.Error.WriteLine($"ERROR: no Paks folder under {gameDir}");
            Console.Error.WriteLine("       Point --game at the folder containing FactoryGameSteam.exe.");
            return 2;
        }

        // The engine version has to match or the containers won't parse. Newer
        // builds may need a bump, so it stays overridable from the command line.
        var version = EGame.GAME_UE5_6;
        if (!string.IsNullOrWhiteSpace(versionArg) && Enum.TryParse<EGame>(versionArg, true, out var parsed))
            version = parsed;

        Console.WriteLine($"Reading {paks}  (engine {version})");

        using var provider = new DefaultFileProvider(paks, SearchOption.AllDirectories, new VersionContainer(version));
        provider.Initialize();

        // UE5 serialises properties unversioned, so nothing deserialises without
        // type mappings. Satisfactory ships its own next to the docs, which means
        // they always match the installed build.
        var usmap = Path.Combine(gameDir, "CommunityResources", "FactoryGame.usmap");
        if (!File.Exists(usmap))
        {
            Console.Error.WriteLine($"ERROR: mappings not found at {usmap}");
            Console.Error.WriteLine("       Without FactoryGame.usmap the game's assets cannot be read.");
            return 2;
        }
        var normalised = NormaliseUsmap(usmap);
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(normalised);
        Console.WriteLine($"Mappings: {Path.GetFileName(usmap)}");
        // Satisfactory ships its paks unencrypted; the null key mounts them all.
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        provider.PostMount();
        Console.WriteLine($"Mounted {provider.Files.Count} files");

        // Which asset actually backs a building is not always guessable from its
        // class name, so let a path substring be searched directly.
        if (!string.IsNullOrWhiteSpace(findFiles))
        {
            foreach (var key in provider.Files.Keys
                         .Where(k => k.Contains(findFiles, StringComparison.OrdinalIgnoreCase))
                         .OrderBy(k => k).Take(120))
                Console.WriteLine($"FILE {key}");
            return 0;
        }

        // The Space Elevator's phases -- the deliveries that open the next tier
        // -- are the other half of progression, and they are nowhere in the
        // game's exported docs. They are plain assets, so read them here and
        // hand the planner's data extractor a JSON file to merge in.
        if (!string.IsNullOrWhiteSpace(phasesOut))
        {
            var phases = new List<Dictionary<string, object?>>();
            foreach (var path in provider.Files.Keys
                         .Where(k => k.Contains("/GamePhases/GP_", StringComparison.OrdinalIgnoreCase)
                                     && k.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
                         .OrderBy(k => k, StringComparer.OrdinalIgnoreCase))
            {
                if (!provider.TryLoadPackage(path, out var pkg)) continue;
                foreach (var export in pkg.GetExports())
                {
                    if (export.Class?.Name != "FGGamePhase") continue;

                    // Phases with no cost are still emitted: the tier a phase is
                    // built *with* is the last tier of the one before it, so the
                    // chain has to be unbroken to be read.
                    var costs = export.GetOrDefault<object?>("mCosts", null) as UScriptArray;
                    var items = new List<Dictionary<string, object?>>();
                    foreach (var entry in costs?.Properties ?? [])
                    {
                        var record = Unwrap(entry?.GenericValue);
                        var item = ResolvePath(Member(record, "ItemClass"));
                        if (item == null) continue;
                        items.Add(new Dictionary<string, object?>
                        {
                            ["item"] = Path.GetFileName(item) + "_C",
                            ["amount"] = Convert.ToDouble(Member(record, "Amount") ?? 0),
                        });
                    }

                    phases.Add(new Dictionary<string, object?>
                    {
                        ["key"] = export.Name,
                        ["name"] = Member(export, "mDisplayName")?.ToString() ?? export.Name,
                        ["lastTier"] = Convert.ToInt32(export.GetOrDefault<object?>("mLastTierOfPhase", 0) ?? 0),
                        ["cost"] = items,
                    });
                }
            }

            File.WriteAllText(phasesOut,
                JsonSerializer.Serialize(phases, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Wrote {phases.Count} game phases to {phasesOut}");
            return 0;
        }

        // Not everything the planner wants is a building. The Space Elevator's
        // phase costs, for one, live in their own assets and never reach the
        // game's exported docs, so allow any asset to be printed.
        if (!string.IsNullOrWhiteSpace(dumpAsset))
        {
            foreach (var path in provider.Files.Keys
                         .Where(k => k.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)
                                     && k.Contains(dumpAsset, StringComparison.OrdinalIgnoreCase))
                         .OrderBy(k => k))
            {
                if (!provider.TryLoadPackage(path, out var pkg)) continue;
                Console.WriteLine($"ASSET {path}");
                foreach (var ex in pkg.GetExports())
                {
                    Console.WriteLine($"  export {ex.Name} class={ex.Class?.Name}");
                    foreach (var pr in ex.Properties) Dump(pr.Name.Text, pr.Tag, 4);
                }
            }
            return 0;
        }

        // One entry per Build_* blueprint. Keying by class name matters: a
        // single folder holds dozens of wall or foundation variants, so keying
        // by folder silently collapses them onto one another.
        var buildables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in provider.Files.Keys)
        {
            if (!path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
            var name = Path.GetFileNameWithoutExtension(path);
            if (name.StartsWith("Build_", StringComparison.Ordinal))
                buildables.TryAdd(name + "_C", path);
        }
        Console.WriteLine($"Found {buildables.Count} buildable blueprints");



        var debug = ArgValue(args, "--debug");
        if (!string.IsNullOrWhiteSpace(debug))
        {
            foreach (var hit in buildables.Where(k => k.Key.Contains(debug, StringComparison.OrdinalIgnoreCase)).Take(2))
            {
                Console.WriteLine($"DEBUG {hit.Key} -> {hit.Value}");
                if (!provider.TryLoadPackage(hit.Value, out var dp)) { Console.WriteLine("  package failed to load"); continue; }
                foreach (var ex in dp.GetExports())
                {
                    Console.WriteLine($"  export {ex.Name} class={ex.Class?.Name} type={ex.GetType().Name}");
                    foreach (var pr in ex.Properties) Dump(pr.Name.Text, pr.Tag, 3);
                }
            }
            return 0;
        }

        Directory.CreateDirectory(outDir);
        // class -> the pieces that make it up, each with its own placement.
        var manifest = new Dictionary<string, List<Dictionary<string, object?>>>();
        int resolved = 0, noMesh = 0, failed = 0, written = 0;
        var exportedMeshes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var meshTextures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var meshSources = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (className, assetPath) in buildables.OrderBy(k => k.Key))
        {
            if (resolved >= limit) break;
            // Comma-separated, so a fix can sweep every building it affected in
            // one pass rather than paying the mount cost per name.
            if (!string.IsNullOrWhiteSpace(only)
                && !only.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Any(f => className.Contains(f, StringComparison.OrdinalIgnoreCase))) continue;

            List<MeshPart> parts;
            try
            {
                parts = FindParts(provider, assetPath);
            }
            catch (Exception ex)
            {
                failed++;
                if (failed <= 5) Console.Error.WriteLine($"  {className}: {ex.Message}");
                continue;
            }

            if (parts.Count == 0) { noMesh++; continue; }
            resolved++;

            if (listOnly)
            {
                Console.WriteLine($"{className,-46} {parts.Count} part(s): {string.Join(", ", parts.Take(3).Select(p => Path.GetFileName(p.Mesh)))}");
                continue;
            }

            var entries = new List<Dictionary<string, object?>>();
            foreach (var part in parts)
            {
                if (!exportedMeshes.TryGetValue(part.Mesh, out var file))
                {
                    LastTexture = null;
                    file = ExportMesh(provider, part.Mesh, outDir);
                    if (file == null) { failed++; continue; }
                    exportedMeshes[part.Mesh] = file;
                    if (LastTexture != null) meshTextures[file] = LastTexture;
                    written++;
                }
                meshSources[file] = part.Mesh;
                entries.Add(new Dictionary<string, object?>
                {
                    ["file"] = file,
                    ["loc"] = part.Location,
                    ["rot"] = part.Rotation,
                    ["scale"] = part.Scale,
                    ["glass"] = IsSeeThrough(part.Mesh, className),
                    ["spline"] = part.Spline,
                    ["stackEvery"] = part.StackEvery > 0 ? part.StackEvery : null,
                    ["atTop"] = part.AtTop ? true : null,
                    ["texture"] = meshTextures.TryGetValue(file, out var tex) ? tex : null,
                });
            }

            if (entries.Count > 0) manifest[className] = entries;
            Report(resolved, buildables.Count, className);
        }

        // Second pass: a mesh exported before its textures existed on disk found
        // nothing to match. Now that everything is written, try those again.
        if (!listOnly && WithMaterials)
        {
            var recovered = 0;
            foreach (var entry in manifest.Values.SelectMany(v => v))
            {
                if (entry["texture"] != null) continue;
                var file = (string)entry["file"]!;
                if (meshTextures.TryGetValue(file, out var known)) { entry["texture"] = known; recovered++; continue; }
                if (!meshSources.TryGetValue(file, out var source)) continue;

                var folder = AssetFolder(source);
                if (folder == null) continue;
                var marker = Path.DirectorySeparatorChar + folder + Path.DirectorySeparatorChar;
                var albedo = PickAlbedo(Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories)
                    .Where(f => f.Contains(marker, StringComparison.OrdinalIgnoreCase)));

                var stem = Path.GetFileNameWithoutExtension(file);
                var name = albedo != null
                    ? ShrinkTexture(albedo, outDir, stem)
                    : AlbedoFromMaterial(provider, source, outDir, stem);
                if (name == null) continue;
                meshTextures[file] = name;
                entry["texture"] = name;
                recovered++;
            }
            if (recovered > 0) Console.WriteLine($"Matched {recovered} more textures on a second pass");
        }

        if (!listOnly)
        {
            File.WriteAllText(
                Path.Combine(outDir, "manifest.json"),
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = false }));
        }

        Console.WriteLine($"Resolved {resolved} buildings, wrote {written} meshes, no mesh for {noMesh}, failed {failed}");
        return resolved > 0 ? 0 : 1;
    }

    /// <summary>
    /// Rewrite the shipped .usmap so CUE4Parse can read it.
    ///
    /// Satisfactory's mappings encode OptionalProperty as a plain 8-byte record
    /// with no inner type, while CUE4Parse expects an inner type to follow. That
    /// one byte of disagreement desynchronises the whole property table and the
    /// parser dies part-way through.
    ///
    /// There are exactly 44 such properties in the file and every one belongs to
    /// an engine or editor type (test structs, Slate button styles, Niagara,
    /// MovieScene) — none to a factory type. Rewriting them to BoolProperty
    /// keeps the record length identical and leaves every mapping the planner
    /// actually reads untouched.
    /// </summary>
    private static string NormaliseUsmap(string path)
    {
        var raw = File.ReadAllBytes(path);
        var offset = 3;
        if (raw[2] >= 1)
        {
            var hasVersioning = BitConverter.ToInt32(raw, offset);
            offset += 4;
            if (hasVersioning != 0)
            {
                offset += 8;                                     // FPackageFileVersion
                var customCount = BitConverter.ToInt32(raw, offset);
                offset += 4 + customCount * 20;                  // FGuid + int32 each
                offset += 4;                                     // net CL
            }
        }

        var compression = raw[offset];
        var bodyStart = offset + 1 + 8;
        if (compression != 0) return path; // compressed mappings: leave well alone

        var patched = 0;
        var p = bodyStart;

        int U8() => raw[p++];
        int U16() { var v = BitConverter.ToUInt16(raw, p); p += 2; return v; }
        int U32() { var v = (int)BitConverter.ToUInt32(raw, p); p += 4; return v; }

        var nameCount = U32();
        // Written out rather than `p += U8()`: compound assignment loads p
        // before the call runs, so the read's own increment gets discarded.
        for (var i = 0; i < nameCount; i++)
        {
            var nameLength = U8();
            p += nameLength;
        }

        var enumCount = U32();
        for (var i = 0; i < enumCount; i++)
        {
            U32();
            var values = U8();
            for (var j = 0; j < values; j++) U32();
        }

        void PropertyType()
        {
            var at = p;
            var kind = U8();
            switch (kind)
            {
                case 26: PropertyType(); U32(); break;   // Enum: inner + enum name
                case 9: U32(); break;                    // Struct: struct name
                case 8:
                case 25: PropertyType(); break;          // Array / Set: inner
                case 24: PropertyType(); PropertyType(); break; // Map: key + value
                case 28: raw[at] = 1; patched++; break;  // Optional -> Bool
            }
        }

        var structCount = U32();
        for (var i = 0; i < structCount; i++)
        {
            U32(); U32(); U16();
            var serializable = U16();
            for (var j = 0; j < serializable; j++)
            {
                U16(); U8(); U32();
                PropertyType();
            }
        }

        var outPath = Path.Combine(Path.GetTempPath(), "FactoryGame.cue4parse.usmap");
        File.WriteAllBytes(outPath, raw);
        Console.WriteLine($"Mappings: patched {patched} OptionalProperty entries for CUE4Parse");
        return outPath;
    }

    /// <summary>
    /// Export one static or skeletal mesh, returning the file name written.
    /// Machines are skeletal, scenery is static, so both are tried.
    /// </summary>
    private static string? ExportMesh(DefaultFileProvider provider, string meshPath, string outDir)
    {
        try
        {
            return ExportMeshCore(provider, meshPath, outDir, WithMaterials);
        }
        catch (Exception ex)
        {
            // Some textures fail to decompress, and taking the mesh down with
            // them costs the geometry too -- which lost every plain foundation.
            // Retry bare: an untextured building beats a missing one.
            if (WithMaterials)
            {
                try
                {
                    var bare = ExportMeshCore(provider, meshPath, outDir, false);
                    if (bare != null)
                    {
                        Console.Error.WriteLine($"  {Path.GetFileName(meshPath)}: textures failed, exported untextured");
                        LastTexture = null;
                        return bare;
                    }
                }
                catch { /* fall through to the skip below */ }
            }
            Console.Error.WriteLine($"  skipped {Path.GetFileName(meshPath)}: {ex.GetType().Name}: {ex.Message}");
            LastTexture = null;
            return null;
        }
    }

    private static string? ExportMeshCore(DefaultFileProvider provider, string meshPath, string outDir, bool withMaterials)
    {
        var options = new ExporterOptions
        {
            MeshFormat = EMeshFormat.Gltf2,
            LodFormat = ELodFormat.FirstLod,
            ExportMaterials = withMaterials,
            MaterialFormat = CUE4Parse.UE4.Assets.Exports.Material.EMaterialFormat.FirstLayer,
            TextureFormat = CUE4Parse_Conversion.Textures.ETextureFormat.Png,
            Platform = CUE4Parse.UE4.Assets.Exports.Texture.ETexturePlatform.DesktopMobile,
        };

        MeshExporter exporter;
        if (provider.TryLoadPackageObject<UStaticMesh>(meshPath, out var sm) && sm != null)
            exporter = new MeshExporter(sm, options);
        else if (provider.TryLoadPackageObject<USkeletalMesh>(meshPath, out var sk) && sk != null)
            exporter = new MeshExporter(sk, options);
        else if (MeshInPackage(provider, meshPath) is { } found)
        {
            // The object inside a package need not be named after the package:
            // the truck station's file is Truckstation_static and the mesh in it
            // is TruckStation_static. Asking for the object by the package's
            // name misses on that capital S, so take the package's own geometry.
            exporter = found is USkeletalMesh skeletal
                ? new MeshExporter(skeletal, options)
                : new MeshExporter((UStaticMesh)found, options);
        }
        else
        {
            // A blueprint's spelling of a path need not match the file's: the
            // water extractor asks for .../WaterPump/Mesh/... and the asset on
            // disk is .../Waterpump/Mesh/... . The provider's table is
            // case-sensitive, so try again with the file's own spelling.
            var corrected = MatchIgnoringCase(provider, meshPath);
            if (corrected != null && !corrected.Equals(meshPath, StringComparison.Ordinal))
                return ExportMeshCore(provider, corrected, outDir, withMaterials);

            Console.Error.WriteLine($"  skipped {Path.GetFileName(meshPath)}: no such mesh asset");
            return null;
        }

        // Textures are written as loose files beside the mesh rather than into
        // the glTF, and the material instances declare no bindings, so the only
        // reliable link is which files appear while this mesh is exported.
        var before = withMaterials
            ? new HashSet<string>(Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories), StringComparer.OrdinalIgnoreCase)
            : null;

        if (!exporter.TryWriteToDir(new DirectoryInfo(outDir), out var why, out var producedPath))
        {
            Console.Error.WriteLine($"  skipped {Path.GetFileName(meshPath)}: exporter wrote nothing ({why})");
            return null;
        }

        var safe = meshPath.Replace('/', '_').TrimStart('_') + ".glb";
        var target = Path.Combine(outDir, safe);
        MoveWithRetry(producedPath, target);

        if (before != null)
        {
            var fresh = Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories)
                .Where(f => !before.Contains(f))
                .ToList();

            var albedo = PickAlbedo(fresh);

            // A texture is only written once, so a mesh sharing one with an
            // earlier building sees nothing new — and a mesh whose fresh files
            // are all normals and masks yields no base colour either. Either
            // way, fall back to that building's own asset folder, which is
            // where its maps live.
            if (albedo == null)
            {
                var folder = AssetFolder(meshPath);
                if (folder != null)
                {
                    var marker = Path.DirectorySeparatorChar + folder + Path.DirectorySeparatorChar;
                    albedo = PickAlbedo(Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories)
                        .Where(f => f.Contains(marker, StringComparison.OrdinalIgnoreCase)));
                }
            }
            LastTexture = albedo == null ? null : ShrinkTexture(albedo, outDir, Path.GetFileNameWithoutExtension(safe));
        }

        return safe;
    }

    /// <summary>
    /// The building folder an asset belongs to, e.g. "ConstructorMk1" from
    /// /Game/FactoryGame/Buildable/Factory/ConstructorMk1/Mesh/ConstructorMk1_static.
    /// Leaf folders like Mesh or Texture are skipped in favour of the one that
    /// names the building.
    /// </summary>
    private static string? AssetFolder(string meshPath)
    {
        var parts = meshPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        for (var i = parts.Length - 2; i >= 0; i--)
        {
            var name = parts[i];
            if (name.Equals("Mesh", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Meshes", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Texture", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Textures", StringComparison.OrdinalIgnoreCase)) continue;
            return name;
        }
        return null;
    }

    /// <summary>Filename of the base-colour texture written for the last mesh, if any.</summary>
    private static string? LastTexture;

    /// <summary>
    /// Re-encode a base-colour map at a size a browser can hold.
    ///
    /// Source textures run to several megabytes each and the full set would be
    /// well over a gigabyte. A 512 px JPEG keeps the surface readable at the
    /// scale a blueprint is viewed and takes the set to a few tens of megabytes.
    /// </summary>
    /// <summary>
    /// The base-colour map a mesh's own material points at, written out.
    ///
    /// The usual link is circumstantial -- whichever textures appeared on disk
    /// while a mesh was exported -- and it only holds when a mesh's maps live
    /// beside it. The pipelines break that: their material is shared with the
    /// pipeline supports and its textures sit in that folder instead. The
    /// material itself knows, so when the circumstantial match comes up empty,
    /// ask it directly.
    /// </summary>
    private static string? AlbedoFromMaterial(DefaultFileProvider provider, string meshPath, string outDir, string stem)
    {
        if (!provider.TryLoadPackageObject<UStaticMesh>(meshPath, out var mesh) || mesh == null)
        {
            if (Verbose) Console.WriteLine($"    [tex] {stem}: mesh would not load");
            return null;
        }

        foreach (var materialPath in MaterialPaths(mesh))
        {
            var texture = AlbedoParameter(provider, materialPath, 0);
            if (Verbose) Console.WriteLine($"    [tex] {stem}: {materialPath} -> {texture ?? "no base colour"}");
            if (texture == null) continue;
            if (!provider.TryLoadPackageObject<UTexture2D>(texture, out var map) || map == null) continue;
            try
            {
                using var bitmap = map.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                var written = WriteAlbedo(bitmap, outDir, stem);
                if (written != null) return written;
            }
            catch { /* an undecodable map is no worse than no map */ }
        }
        return null;
    }

    /// <summary>
    /// The materials a mesh is skinned with. Newer builds keep these in
    /// StaticMaterials as structs; older ones expose a flat array of references.
    /// </summary>
    private static IEnumerable<string> MaterialPaths(UStaticMesh mesh)
    {
        var raw = mesh.GetOrDefault<object?>("StaticMaterials", null) ?? Reflect(mesh, "Materials");
        if (raw is not UScriptArray array)
        {
            if (Verbose) Console.WriteLine($"    [tex] no material array ({raw?.GetType().Name ?? "null"})");
            yield break;
        }

        foreach (var entry in array.Properties)
        {
            var value = Unwrap(entry?.GenericValue);
            var path = ResolvePath(Member(value, "MaterialInterface")) ?? ResolvePath(value);
            if (path != null) yield return path;
        }
    }

    /// <summary>
    /// The best base-colour texture named by a material, following the instance
    /// chain up to the parent that actually declares it.
    /// </summary>
    private static string? AlbedoParameter(DefaultFileProvider provider, string materialPath, int depth)
    {
        if (depth > 4) return null;
        if (!provider.TryLoadPackageObject<UObject>(materialPath, out var material) || material == null) return null;

        string? best = null;
        var bestScore = int.MinValue;

        if (material.GetOrDefault<object?>("TextureParameterValues", null) is UScriptArray values)
        {
            foreach (var entry in values.Properties)
            {
                var value = Unwrap(entry?.GenericValue);
                var texture = ResolvePath(Member(value, "ParameterValue"));
                if (texture == null) continue;

                var score = BaseColourScore(Member(Member(value, "ParameterInfo"), "Name")?.ToString())
                          + BaseColourScore(Path.GetFileName(texture));
                if (score <= 0 || score <= bestScore) continue;
                bestScore = score;
                best = texture;
            }
        }
        if (best != null) return best;

        // A base material names its maps as graph expressions rather than as
        // overridable parameters, so nothing shows up above. It still lists
        // everything it samples, which is enough to pick a base colour out of.
        if (material.GetOrDefault<object?>("ReferencedTextures", null) is UScriptArray referenced)
        {
            foreach (var entry in referenced.Properties)
            {
                var texture = ResolvePath(entry?.GenericValue);
                if (texture == null) continue;
                var score = BaseColourScore(Path.GetFileName(texture));
                if (score <= 0 || score <= bestScore) continue;
                bestScore = score;
                best = texture;
            }
        }
        if (best != null) return best;

        var parent = ResolvePath(Member(material, "Parent"));
        if (Verbose) Console.WriteLine($"    [tex]   {Path.GetFileName(materialPath)} -> parent {parent ?? "none"}");
        return parent == null ? null : AlbedoParameter(provider, parent, depth + 1);
    }

    /// <summary>
    /// How much a parameter or asset name reads as "this is the base colour".
    /// Negative for the maps that are never a surface anyone would recognise.
    /// </summary>
    private static int BaseColourScore(string? name)
    {
        if (string.IsNullOrEmpty(name)) return 0;

        foreach (var reject in new[] { "Normal", "Noise", "Mask", "Atlas", "Roughness", "Metal", "Emissive", "AO" })
            if (name.Contains(reject, StringComparison.OrdinalIgnoreCase)) return -100;

        if (name.Contains("BaseColor", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Base Color", StringComparison.OrdinalIgnoreCase)) return 40;
        if (name.Contains("Albedo", StringComparison.OrdinalIgnoreCase)) return 35;
        if (name.Contains("Diffuse", StringComparison.OrdinalIgnoreCase)) return 30;
        if (name.EndsWith("_BC", StringComparison.OrdinalIgnoreCase)) return 25;
        if (name.EndsWith("_D", StringComparison.OrdinalIgnoreCase)) return 20;
        if (name.Contains("Color", StringComparison.OrdinalIgnoreCase)) return 10;
        return 0;
    }

    private static string? ShrinkTexture(string source, string outDir, string stem)
    {
        try
        {
            using var bitmap = SkiaSharp.SKBitmap.Decode(source);
            return WriteAlbedo(bitmap, outDir, stem);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Resize to something a browser will happily hold, and encode.</summary>
    private static string? WriteAlbedo(SkiaSharp.SKBitmap? bitmap, string outDir, string stem)
    {
        const int maxSide = 512;
        var name = stem + ".albedo.jpg";
        var target = Path.Combine(outDir, name);
        try
        {
            if (bitmap == null) return null;

            var longest = Math.Max(bitmap.Width, bitmap.Height);
            var scale = longest > maxSide ? (double)maxSide / longest : 1.0;
            var width = Math.Max(1, (int)(bitmap.Width * scale));
            var height = Math.Max(1, (int)(bitmap.Height * scale));

            using var resized = bitmap.Resize(new SkiaSharp.SKImageInfo(width, height), SkiaSharp.SKFilterQuality.High);
            if (resized == null) return null;
            using var image = SkiaSharp.SKImage.FromBitmap(resized);
            using var data = image.Encode(SkiaSharp.SKEncodedImageFormat.Jpeg, 82);
            using var file = File.Create(target);
            data.SaveTo(file);
            return name;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Pick the base-colour map out of a mesh's textures.
    ///
    /// The game's suffixes are consistent: _BC or _D is base colour, _N is a
    /// normal map, and masks, noise and shared atlases are inputs to the
    /// material graph rather than a surface anyone would recognise.
    /// </summary>
    private static string? PickAlbedo(IEnumerable<string> candidates)
    {
        string? best = null;
        var bestScore = int.MinValue;

        foreach (var path in candidates)
        {
            var name = Path.GetFileNameWithoutExtension(path);
            if (name.Contains("Noise", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Mask", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Atlas", StringComparison.OrdinalIgnoreCase)) continue;

            var score = 0;
            if (name.EndsWith("_BC", StringComparison.OrdinalIgnoreCase)) score = 100;
            else if (name.EndsWith("_D", StringComparison.OrdinalIgnoreCase)) score = 90;
            else if (name.EndsWith("_Albedo", StringComparison.OrdinalIgnoreCase)) score = 88;
            else if (name.EndsWith("_Alb", StringComparison.OrdinalIgnoreCase)) score = 85;
            else if (name.EndsWith("_BaseColor", StringComparison.OrdinalIgnoreCase)) score = 80;
            else continue;

            // Prefer the larger source, which is the main body rather than a decal.
            try { score += (int)Math.Min(20, new FileInfo(path).Length / 262144); } catch { }
            if (score > bestScore) { bestScore = score; best = path; }
        }
        return best;
    }

    /// <summary>
    /// Some buildables point at a stand-in primitive rather than real art;
    /// drawing a bare cube is worse than leaving the sized box in place.
    /// </summary>
    private static bool IsPlaceholder(string meshPath)
    {
        var name = Path.GetFileName(meshPath);
        return name.Equals("Cube", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Sphere", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Plane", StringComparison.OrdinalIgnoreCase)
            || meshPath.Contains("/Environment/Misc/", StringComparison.OrdinalIgnoreCase)
            || meshPath.Contains("BuildGun/Mesh", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Glass panes read as glass. Materials aren't exported, so this goes by
    /// asset name, which the game is consistent about for windows and panels.
    /// </summary>
    private static bool IsSeeThrough(string meshPath, string className)
    {
        var mesh = Path.GetFileName(meshPath);
        // "WallSet" meshes are the panel with a hole in it; the pane is a
        // separate "Inset" mesh, so the frame must stay solid.
        if (mesh.Contains("WallSet", StringComparison.OrdinalIgnoreCase)) return false;

        return mesh.Contains("Glass", StringComparison.OrdinalIgnoreCase)
            || mesh.Contains("Inset", StringComparison.OrdinalIgnoreCase)
            || mesh.Contains("Wall_Window", StringComparison.OrdinalIgnoreCase)
            || mesh.Contains("Roof_Window", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>One drawable piece of a building: a mesh plus where it sits.</summary>
    public sealed class MeshPart
    {
        public string Mesh { get; init; } = "";
        public float[] Location { get; init; } = [0, 0, 0];
        public float[] Rotation { get; init; } = [0, 0, 0, 1];
        public float[] Scale { get; init; } = [1, 1, 1];
        public string? Material { get; init; }
        /// <summary>Repeated along a spline in game; we draw one segment.</summary>
        public bool Spline { get; init; }
        /// <summary>
        /// A conveyor lift's column section, repeated every this many
        /// centimetres from the base until it reaches the lift's own height.
        /// </summary>
        public float StackEvery { get; init; }
        /// <summary>A conveyor lift's head, which sits at the lift's own height.</summary>
        public bool AtTop { get; init; }
    }

    /// <summary>
    /// Every mesh a building draws, read from its blueprint.
    ///
    /// Two mechanisms are in play. Machines hang meshes off StaticMeshComponents.
    /// Foundations, walls and the rest of the "lightweight" buildables instead
    /// carry an AbstractInstanceDataObject whose Instances array names the mesh
    /// and its offset — that covers the several hundred buildings that finding
    /// only components misses entirely.
    ///
    /// Both keep their relative transforms: a foundation's mesh sits 50 cm below
    /// its actor origin, and a window wall is a frame plus a separate glass pane.
    ///
    /// A variant blueprint may name no mesh of its own at all -- the clean
    /// pipelines declare only that they have no flow indicator -- so when a class
    /// yields nothing, the class it derives from is asked instead.
    /// </summary>
    private static List<MeshPart> FindParts(DefaultFileProvider provider, string assetPath, int depth = 0)
    {
        var parts = new List<MeshPart>();
        if (!provider.TryLoadPackage(assetPath, out var package)) return parts;

        foreach (var export in package.GetExports())
        {
            // --- lightweight buildables: instance data ---
            var instancesRaw = export.Properties.FirstOrDefault(x => x.Name.Text == "Instances")?.Tag?.GenericValue;
            if (instancesRaw is UScriptArray instances)
            {
                if (Verbose) Console.WriteLine($"    [dbg] {export.Name}: Instances array with {instances.Properties.Count}");
                foreach (var entry in instances.Properties)
                {
                    var record = Unwrap(entry?.GenericValue);
                    if (record == null) continue;
                    var mesh = ResolvePath(Member(record, "StaticMesh"));
                    if (Verbose) Console.WriteLine($"    [dbg]   instance mesh -> {mesh ?? "null"}");
                    if (mesh == null) continue;
                    var (loc, rot, scale) = ReadTransform(Member(record, "RelativeTransform"));
                    parts.Add(new MeshPart { Mesh = mesh, Location = loc, Rotation = rot, Scale = scale });
                }
                continue;
            }

            // --- splines: belts, lifts, pipes and power lines ---
            // These have no placed mesh component; the class default names a
            // segment mesh that the game repeats along the spline. One segment
            // is far better than nothing, though the run itself isn't traced.
            foreach (var field in new[] { "mMesh", "mMeshBody", "mConveyorMesh", "mWireMesh" })
            {
                var reference = export.GetOrDefault<FPackageIndex?>(field, null);
                // Usually geometry -- a belt's mMesh is its segment -- but not
                // always: the elevator floor stop points mMesh at one of its own
                // components, which resolves to the blueprint package and then
                // exports as nothing at all.
                if (!PointsAtGeometry(reference)) continue;
                var splineMesh = ResolvePath(reference);
                if (splineMesh == null || IsPlaceholder(splineMesh)) continue;
                parts.Add(new MeshPart { Mesh = splineMesh, Spline = true });
                break;
            }

            // --- conveyor lifts: a stack of named parts ---
            // The lift has no single body mesh. It is a base, a repeating
            // column section and a head, and the game stacks as many middles as
            // the lift is tall. How tall is per-placement and comes from the
            // blueprint, so the parts are labelled here and the viewer stacks
            // them: the middle repeats every mMeshHeight, the head rides on top.
            var liftBottom = ResolveMesh(export, "mBottomMesh");
            var liftTop = ResolveMesh(export, "mTopMesh");
            if (liftBottom != null && liftTop != null)
            {
                var storey = (float)Convert.ToDouble(
                    export.GetOrDefault<object?>("mMeshHeight", null) ?? 200.0);

                parts.Add(new MeshPart { Mesh = liftBottom });
                var middle = ResolveMesh(export, "mMidMesh");
                if (middle != null) parts.Add(new MeshPart { Mesh = middle, StackEvery = storey });
                parts.Add(new MeshPart { Mesh = liftTop, AtTop = true });
                // Break, not continue: a lift declares the same fields twice,
                // once on the class default and again on its sparse-data
                // object, and taking both stacks two lifts in the same place.
                break;
            }

            // --- machines and other component-based buildings ---
            if (export is not UStaticMeshComponent) continue;
            if (export.Name.Contains("Indicator", StringComparison.OrdinalIgnoreCase)) continue;
            var componentMesh = ResolvePath(export.GetOrDefault<FPackageIndex?>("StaticMesh", null));
            if (Verbose) Console.WriteLine($"    [dbg] {export.Name}: StaticMesh -> {componentMesh ?? "null"}");
            // A component can point at one of the engine's primitives: a lift's
            // visibility helper is the Cube, and taking it drew every conveyor
            // lift in the game as a literal box.
            if (componentMesh == null || IsPlaceholder(componentMesh)) continue;

            parts.Add(new MeshPart
            {
                Mesh = componentMesh,
                Location = ReadVector(export.GetOrDefault<object?>("RelativeLocation", null), 0f),
                Rotation = ReadRotator(export.GetOrDefault<object?>("RelativeRotation", null)),
                Scale = ReadVector(export.GetOrDefault<object?>("RelativeScale3D", null), 1f),
            });
        }

        // Some buildings name their geometry in a property rather than on a
        // component: the pipeline and hypertube supports keep theirs in
        // mSupportMeshInstanceData, with the pole height variations beside it.
        if (parts.Count == 0)
        {
            foreach (var export in package.GetExports())
            {
                foreach (var property in export.Properties)
                {
                    var mesh = FindMeshInValue(property.Tag?.GenericValue, 0);
                    if (mesh == null) continue;
                    parts.Add(new MeshPart { Mesh = mesh });
                    break;
                }
                if (parts.Count > 0) break;
            }
        }

        // Nothing here: this is a variant that only records how it differs from
        // its parent. Walk up until a class actually names geometry. The depth
        // guard is for cycles, not for depth -- the chains are two or three long.
        if (parts.Count == 0 && depth < 4)
        {
            foreach (var export in package.GetExports())
            {
                var parent = ParentClassPath(export);
                if (parent == null) continue;
                var inherited = FindParts(provider, parent, depth + 1);
                if (inherited.Count > 0) return inherited;
            }
        }

        return Trim(parts, assetPath);
    }

    /// <summary>
    /// The package a blueprint class derives from, as a path the provider can
    /// load. Different CUE4Parse versions surface this as a package index or as
    /// an already-resolved object, so both spellings are accepted.
    /// </summary>
    private static string? ParentClassPath(object? export)
    {
        var super = Reflect(export, "SuperStruct") ?? Reflect(export, "Super");
        if (super == null) return null;

        var path = super is FPackageIndex index ? ResolvePath(index) : StripObjectName(super.ToString());
        return path != null && path.StartsWith("/Game/", StringComparison.Ordinal) ? path : null;
    }

    /// <summary>Class'/Game/Foo/Build_Bar.Build_Bar_C' -> /Game/Foo/Build_Bar.</summary>
    private static string? StripObjectName(string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        var tick = name.IndexOf('\'');
        if (tick >= 0) name = name[(tick + 1)..].TrimEnd('\'');
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }

    /// <summary>
    /// The first real mesh reference anywhere inside a property value, looking
    /// through structs and arrays of structs. Shallow on purpose: a mesh nested
    /// deeper than this is decoration, not the building.
    /// </summary>
    private static string? FindMeshInValue(object? value, int depth)
    {
        if (value == null || depth > 3) return null;

        foreach (var field in new[] { "StaticMesh", "Mesh" })
        {
            var direct = ResolvePath(Member(value, field));
            if (direct != null && !IsPlaceholder(direct)) return direct;
        }

        if (value is UScriptArray array)
        {
            foreach (var entry in array.Properties)
            {
                var found = FindMeshInValue(Unwrap(entry?.GenericValue), depth + 1);
                if (found != null) return found;
            }
            return null;
        }

        var inner = Member(value, "StructType");
        return inner == null ? null : FindMeshInValue(inner, depth + 1);
    }

    private static object? Unwrap(object? value)
    {
        var inner = Member(value, "StructType");
        return inner ?? value;
    }

    /// <summary>Property or field by name, ignoring access.</summary>
    private static object? Reflect(object? target, string name)
    {
        if (target == null) return null;
        var type = target.GetType();
        return type.GetProperty(name)?.GetValue(target) ?? type.GetField(name)?.GetValue(target);
    }

    /// <summary>
    /// Read a named member from an Unreal value.
    ///
    /// Structs don't expose their fields as C# members: they carry a Properties
    /// list keyed by name, each entry wrapping the value in a tag. Anything else
    /// falls back to ordinary reflection.
    /// </summary>
    private static object? Member(object? target, string name)
    {
        if (target == null) return null;

        if (Reflect(target, "Properties") is System.Collections.IEnumerable props && props is not string)
        {
            foreach (var item in props)
            {
                if (Reflect(item, "Name")?.ToString() != name) continue;
                return Unwrap(Reflect(Reflect(item, "Tag"), "GenericValue"));
            }
            return null;
        }

        return Unwrap(Reflect(target, name));
    }

    private static float Num(object? value, float fallback = 0f)
        => value is null ? fallback : float.TryParse(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var f) ? f : fallback;

    private static float[] ReadVector(object? value, float fallback)
    {
        if (value == null) return [fallback, fallback, fallback];
        return [Num(Member(value, "X"), fallback), Num(Member(value, "Y"), fallback), Num(Member(value, "Z"), fallback)];
    }

    private static float[] ReadQuat(object? value)
    {
        if (value == null) return [0, 0, 0, 1];
        return [Num(Member(value, "X")), Num(Member(value, "Y")), Num(Member(value, "Z")), Num(Member(value, "W"), 1f)];
    }

    /// <summary>Component rotations are pitch/yaw/roll in degrees; convert to a quaternion.</summary>
    private static float[] ReadRotator(object? value)
    {
        if (value == null) return [0, 0, 0, 1];
        var pitch = Num(Member(value, "Pitch")) * MathF.PI / 180f;
        var yaw = Num(Member(value, "Yaw")) * MathF.PI / 180f;
        var roll = Num(Member(value, "Roll")) * MathF.PI / 180f;
        float cy = MathF.Cos(yaw * 0.5f), sy = MathF.Sin(yaw * 0.5f);
        float cp = MathF.Cos(pitch * 0.5f), sp = MathF.Sin(pitch * 0.5f);
        float cr = MathF.Cos(roll * 0.5f), sr = MathF.Sin(roll * 0.5f);
        return [
            cr * sp * sy - sr * cp * cy,
            -cr * sp * cy - sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy,
        ];
    }

    private static (float[] loc, float[] rot, float[] scale) ReadTransform(object? transform)
    {
        if (transform == null) return ([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
        return (
            ReadVector(Member(transform, "Translation"), 0f),
            ReadQuat(Member(transform, "Rotation")),
            ReadVector(Member(transform, "Scale3D"), 1f)
        );
    }

    /// <summary>Package path of a referenced asset, minus the object suffix.</summary>
    /// <summary>The one mesh a package holds, whatever its export is named.</summary>
    private static UObject? MeshInPackage(DefaultFileProvider provider, string meshPath)
    {
        if (!provider.TryLoadPackage(meshPath, out var package)) return null;
        foreach (var export in package.GetExports())
            if (export is UStaticMesh or USkeletalMesh) return export;
        return null;
    }

    /// <summary>
    /// An object path spelled the way the file table spells it, or null.
    ///
    /// Built once and kept: the table has tens of thousands of entries and a
    /// handful of buildings need it.
    /// </summary>
    private static Dictionary<string, string>? PathIndex;

    private static string? MatchIgnoringCase(DefaultFileProvider provider, string objectPath)
    {
        PathIndex ??= BuildPathIndex(provider);
        // "/Game/Foo/SM_Bar" -> "Foo/SM_Bar", which is what the index is keyed on.
        var tail = objectPath.TrimStart('/');
        var slash = tail.IndexOf('/');
        if (slash < 0) return null;
        return PathIndex.TryGetValue(tail[(slash + 1)..].ToLowerInvariant(), out var real) ? real : null;
    }

    private static Dictionary<string, string> BuildPathIndex(DefaultFileProvider provider)
    {
        const string content = "/Content/";
        var index = new Dictionary<string, string>();
        foreach (var key in provider.Files.Keys)
        {
            if (!key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
            var marker = key.IndexOf(content, StringComparison.OrdinalIgnoreCase);
            if (marker < 0) continue;
            var tail = key[(marker + content.Length)..^".uasset".Length];
            index[tail.ToLowerInvariant()] = "/Game/" + tail;
        }
        return index;
    }

    /// <summary>
    /// Keep a building to its own geometry when it carries a crowd of props.
    ///
    /// The HUB is the case: skipping the engine's Cube finally let it resolve,
    /// and it came back as a hundred and thirty meshes -- mugs, kebabs, fridge
    /// magnets, FICSMAS socks, a toilet cover. All genuinely in the blueprint,
    /// none of it the building. Nothing carries a visibility flag to sort them
    /// by, so the divide used here is where the art lives: a building's own
    /// folder holds the building, and a crowd pulled in from elsewhere is set
    /// dressing. Buildings with a handful of parts are left alone entirely.
    /// </summary>
    private static List<MeshPart> Trim(List<MeshPart> parts, string assetPath)
    {
        const int crowd = 16;
        if (parts.Count <= crowd) return parts;

        var folder = AssetFolder(assetPath);
        if (folder == null) return parts;

        var marker = "/" + folder + "/";
        var own = parts.Where(p => p.Mesh.Contains(marker, StringComparison.OrdinalIgnoreCase)).ToList();
        if (own.Count == 0 || own.Count == parts.Count) return parts;

        Console.Error.WriteLine(
            $"  {folder}: kept {own.Count} of {parts.Count} meshes, dropped props from other folders");
        return own;
    }

    /// <summary>A named mesh field on an object, or null if it is absent or a stand-in.</summary>
    private static string? ResolveMesh(UObject export, string field)
    {
        var path = ResolvePath(export.GetOrDefault<FPackageIndex?>(field, null));
        return path == null || IsPlaceholder(path) ? null : path;
    }

    /// <summary>True when a reference points at mesh geometry rather than, say,
    /// a component or another blueprint.</summary>
    private static bool PointsAtGeometry(object? reference)
    {
        if (reference is not FPackageIndex index) return false;
        var className = index.ResolvedObject?.Class?.Name.Text;
        return className is "StaticMesh" or "SkeletalMesh";
    }

    private static string? ResolvePath(object? reference)
    {
        if (reference is not FPackageIndex index) return null;
        var name = index.ResolvedObject?.GetPathName();
        if (string.IsNullOrEmpty(name)) return null;
        // "/Game/Foo/SM_Bar.SM_Bar" -> "/Game/Foo/SM_Bar"
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }

    /// <summary>
    /// A line the host can parse for progress. Kept to one flat line so a
    /// caller can read it straight off stdout without buffering.
    /// </summary>
    private static void Report(int done, int total, string what)
    {
        Console.WriteLine($"PROGRESS {done} {total} {what}");
        Console.Out.Flush();
    }

    /// <summary>The writer's handle can still be closing, so retry the rename.</summary>
    private static void MoveWithRetry(string from, string to, int attempts = 6)
    {
        for (var i = 0; ; i++)
        {
            try
            {
                if (File.Exists(to)) File.Delete(to);
                File.Move(from, to);
                return;
            }
            catch (IOException) when (i < attempts)
            {
                Thread.Sleep(120);
            }
        }
    }

    /// <summary>Recursively print a property, for --debug.</summary>
    private static void Dump(string name, dynamic? tag, int depth)
    {
        var pad = new string(' ', depth * 2);
        if (tag == null) { Console.WriteLine($"{pad}{name} = null"); return; }

        object? value = tag.GenericValue;
        var unwrapped = Member(value, "StructType");
        if (unwrapped != null) value = unwrapped;

        if (value is UScriptArray arr)
        {
            Console.WriteLine($"{pad}{name}: array[{arr.Properties.Count}]");
            for (var i = 0; i < Math.Min(arr.Properties.Count, 3) && depth < 7; i++)
                Dump($"[{i}]", arr.Properties[i], depth + 1);
            return;
        }

        if (Member(value, "Properties") is System.Collections.IEnumerable inner && inner is not string && depth < 7)
        {
            Console.WriteLine($"{pad}{name}: struct");
            foreach (var item in inner)
            {
                var n = item?.GetType().GetProperty("Name")?.GetValue(item)?.ToString() ?? "?";
                var t = item?.GetType().GetProperty("Tag")?.GetValue(item);
                Dump(n, t, depth + 1);
            }
            return;
        }

        var text = value?.ToString() ?? "null";
        if (text.Length > 120) text = text[..120];
        Console.WriteLine($"{pad}{name} = {text}");
    }

    private static string? ArgValue(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
