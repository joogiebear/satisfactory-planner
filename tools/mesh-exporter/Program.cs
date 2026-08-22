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
    public static int Main(string[] args)
    {
        var gameDir = ArgValue(args, "--game");
        var outDir = ArgValue(args, "--out") ?? "meshes";
        var listOnly = args.Contains("--list");
        var limit = int.TryParse(ArgValue(args, "--limit"), out var l) ? l : int.MaxValue;
        var versionArg = ArgValue(args, "--ue");

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



        Directory.CreateDirectory(outDir);
        var manifest = new Dictionary<string, string>();
        int exported = 0, noMesh = 0, failed = 0;
        var seenMesh = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (className, assetPath) in buildables.OrderBy(k => k.Key))
        {
            if (exported >= limit) break;

            string? meshPath;
            try
            {
                meshPath = FindMesh(provider, assetPath);
            }
            catch (Exception ex)
            {
                failed++;
                if (failed <= 5) Console.Error.WriteLine($"  {className}: {ex.Message}");
                continue;
            }

            if (meshPath == null) { noMesh++; continue; }

            if (listOnly)
            {
                Console.WriteLine($"{className,-48} <- {meshPath}");
                exported++;
                continue;
            }

            // Many variants share one mesh; export it once and point the rest
            // at the same file.
            if (seenMesh.TryGetValue(meshPath, out var already))
            {
                manifest[className] = already;
                exported++;
                Report(exported, buildables.Count, className);
                continue;
            }

            try
            {
                var options = new ExporterOptions
                {
                    MeshFormat = EMeshFormat.Gltf2,
                    LodFormat = ELodFormat.FirstLod,
                    ExportMaterials = false,
                };

                // Machines are skeletal meshes, scenery is static, so try both.
                MeshExporter exporter;
                if (provider.TryLoadPackageObject<UStaticMesh>(meshPath, out var sm) && sm != null)
                    exporter = new MeshExporter(sm, options);
                else if (provider.TryLoadPackageObject<USkeletalMesh>(meshPath, out var sk) && sk != null)
                    exporter = new MeshExporter(sk, options);
                else { noMesh++; continue; }

                if (exporter.TryWriteToDir(new DirectoryInfo(outDir), out _, out var written))
                {
                    var target = Path.Combine(outDir, className + ".glb");
                    // The writer's handle can still be closing when we get here,
                    // so give the rename a few attempts before giving up.
                    MoveWithRetry(written, target);
                    var fileName = Path.GetFileName(target);
                    manifest[className] = fileName;
                    seenMesh[meshPath] = fileName;
                    exported++;
                    Report(exported, buildables.Count, className);
                }
                else failed++;
            }
            catch (Exception ex)
            {
                failed++;
                if (failed <= 5) Console.Error.WriteLine($"  {className}: {ex.Message}");
            }
        }

        if (!listOnly)
        {
            File.WriteAllText(
                Path.Combine(outDir, "manifest.json"),
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
        }

        Console.WriteLine($"Exported {exported}, no mesh for {noMesh}, failed {failed}");
        return exported > 0 ? 0 : 1;
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
    /// The mesh a building actually uses, read from its blueprint rather than
    /// guessed from the folder. A BlueprintGeneratedClass stores its component
    /// templates as exports in the same package, so the StaticMeshComponent
    /// among them carries the reference we want.
    /// </summary>
    private static string? FindMesh(DefaultFileProvider provider, string assetPath)
    {
        if (!provider.TryLoadPackage(assetPath, out var package)) return null;

        // Satisfactory hangs a building's main body on an
        // FGColoredInstanceMeshProxy. The other mesh components are moving
        // parts (vertex-animated) and the little production indicator, which
        // would both be the wrong thing to draw as the building.
        string? body = null;
        string? fallback = null;

        foreach (var export in package.GetExports())
        {
            var candidate = MeshFromExport(export);
            if (candidate == null) continue;

            var owner = export.Class?.Name.Text ?? string.Empty;
            if (owner.Contains("ColoredInstanceMeshProxy", StringComparison.OrdinalIgnoreCase))
                body ??= candidate;
            else if (!export.Name.Contains("Indicator", StringComparison.OrdinalIgnoreCase))
                fallback ??= candidate;
        }
        return body ?? fallback;
    }

    private static string? MeshFromExport(UObject export)
    {
        // A static mesh component names its mesh directly.
        if (export is UStaticMeshComponent smc)
        {
            var resolved = ResolvePath(smc.GetOrDefault<FPackageIndex?>("StaticMesh"));
            if (resolved != null) return resolved;
        }

        // Some buildings hold the mesh on a plain property instead.
        foreach (var name in new[] { "StaticMesh", "mMesh", "mBuildingMesh" })
        {
            if (export.Properties.All(p => p.Name.Text != name)) continue;
            var resolved = ResolvePath(export.GetOrDefault<FPackageIndex?>(name));
            if (resolved != null) return resolved;
        }
        return null;
    }

    private static string? ResolvePath(FPackageIndex? index)
    {
        var name = index?.ResolvedObject?.GetPathName();
        if (string.IsNullOrEmpty(name)) return null;
        // Strip the object suffix: "/Game/Foo/SM_Bar.SM_Bar" -> "/Game/Foo/SM_Bar"
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

    private static string Trunc(string? v) => v == null ? "null" : (v.Length > 90 ? v[..90] : v);

    private static string? ArgValue(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
