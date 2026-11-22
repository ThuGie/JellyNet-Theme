using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace JellyNet;

public sealed class Configuration : BasePluginConfiguration
{
    public bool Enabled { get; set; }
    public Guid[] PilotUsers { get; set; } = [];
    public MenuLink[] Links { get; set; } = [];
    public string[] PinnedTags { get; set; } = [];
    public Guid[] PinnedCollections { get; set; } = [];
}

public sealed class MenuLink
{
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public bool AdminOnly { get; set; }
}

public sealed class Plugin : BasePlugin<Configuration>, IHasWebPages
{
    public Plugin(IApplicationPaths paths, IXmlSerializer serializer) : base(paths, serializer) => Instance = this;

    public static Plugin? Instance { get; private set; }
    public override string Name => "JellyNet";

    public IEnumerable<PluginPageInfo> GetPages() =>
        [new() { Name = "JellyNet", EmbeddedResourcePath = "JellyNet.web.settings.html" }];
    public override Guid Id => new("7b51fc65-1948-4858-b071-1ba39709d88f");
}

public sealed class Registration(ILogger<Registration> logger) : Microsoft.Extensions.Hosting.IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var target = AssemblyLoadContext.All.SelectMany(context => context.Assemblies)
                .FirstOrDefault(assembly => assembly.GetName().Name == "Jellyfin.Plugin.FileTransformation");
            var method = target?.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface")
                ?.GetMethods().SingleOrDefault(candidate => candidate.Name == "RegisterTransformation" && candidate.GetParameters().Length == 1 && candidate.GetParameters()[0].ParameterType.FullName == "Newtonsoft.Json.Linq.JObject");
            if (method is null)
            {
                logger.LogWarning("JellyNet could not find a compatible File Transformation registration API.");
                return Task.CompletedTask;
            }

            var json = JsonSerializer.Serialize(new
            {
                id = new Guid("7b51fc65-1948-4858-b071-1ba39709d88f"),
                // File Transformation runs the exact-path pipeline before considering regex keys.
                fileNamePattern = "index.html",
                callbackAssembly = typeof(Registration).Assembly.FullName,
                callbackClass = typeof(Registration).FullName,
                callbackMethod = nameof(Transform)
            });
            var payload = method.GetParameters()[0].ParameterType.GetMethod("Parse", [typeof(string)])?.Invoke(null, [json])
                ?? throw new InvalidOperationException("File Transformation payload type could not be created.");
            method.Invoke(null, [payload]);
        }
        catch (Exception error)
        {
            logger.LogError(error, "JellyNet could not register its web transformation.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public static string Transform(Dictionary<string, string> payload)
    {
        var html = payload.GetValueOrDefault("contents") ?? "";
        if (Plugin.Instance?.Configuration.Enabled != true || html.Contains("data-jellynet", StringComparison.Ordinal))
        {
            return html;
        }

        var end = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (end < 0)
        {
            return html;
        }

        var version = Assets.Version;
        return html.Insert(end, $"""
            <link data-jellynet rel="stylesheet" href="../JellyNet/assets/{version}/jellynet.css">
            <script data-jellynet defer src="../JellyNet/assets/{version}/jellynet.js"></script>
            """);
    }
}

public sealed class Services : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, MediaBrowser.Controller.IServerApplicationHost applicationHost)
        => services.AddHostedService<Registration>();
}

internal static class Assets
{
    internal static readonly byte[] Script = Load("JellyNet.dist.jellynet.js");
    internal static readonly byte[] Style = Load("JellyNet.web.jellynet.css");
    internal static readonly string Version = Convert.ToHexString(SHA256.HashData([.. Script, .. Style]))[..16].ToLowerInvariant();

    private static byte[] Load(string name)
    {
        using var stream = typeof(Assets).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"Missing JellyNet resource {name}");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}

[ApiController]
[Route("JellyNet")]
public sealed class JellyNetController : ControllerBase
{
    [AllowAnonymous]
    [HttpGet("assets/{version}/{name}")]
    public IActionResult Asset(string version, string name)
    {
        if (version != Assets.Version || Plugin.Instance?.Configuration.Enabled != true)
        {
            return NotFound();
        }

        if (name is not ("jellynet.js" or "jellynet.css"))
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return name == "jellynet.js" ? File(Assets.Script, "text/javascript") : File(Assets.Style, "text/css");
    }

    [Authorize]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    [HttpGet("Settings")]
    public IActionResult Settings()
    {
        var config = Plugin.Instance!.Configuration;
        if (!config.Enabled || !Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var userId)
            || userId == Guid.Empty || (config.PilotUsers.Length > 0 && !config.PilotUsers.Contains(userId)))
        {
            return NotFound();
        }

        var isAdmin = User.IsInRole("Administrator");
        return Ok(new
        {
            IsAdmin = isAdmin,
            Links = config.Links.Where(link => !link.AdminOnly || isAdmin).ToArray(),
            config.PinnedTags,
            config.PinnedCollections
        });
    }
}
