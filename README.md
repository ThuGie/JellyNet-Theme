# JellyNet Theme

JellyNet adds a personalized homepage, category browser, and plugin drawer to Jellyfin Web. Viewers keep launching their official Jellyfin client. The enhanced interface appears in clients that load the server's transformed Jellyfin Web. Native interfaces such as Android TV, Roku, and Swiftfin continue to use their built-in layouts and Jellyfin user data.

## Install

1. Confirm your server is running Jellyfin **12.4** and **File Transformation** is active. JellyNet was tested with File Transformation 3.0.3.0.
2. Open **Dashboard → Plugins → Repositories** and add the following repository URL.

   ```text
   https://raw.githubusercontent.com/ThuGie/JellyNet-Theme/main/manifest.json
   ```

3. In the plugin catalog, install **JellyNet** and restart Jellyfin.
4. Open the installed **JellyNet** plugin's settings. Add one or more pilot user IDs to test with specific accounts, enable the theme, and save. An empty pilot list enables it for every user. Restart Jellyfin and reload the affected clients.
5. Open Jellyfin as an enabled user. Use the hamburger to browse categories, open plugins, and choose **Customize Home**.

The drawer opens JellyTube through its existing web integration when available. To add Jellytomb and other plugin links, use the destination confirmed in your server's signed-in Jellyfin Web session. In the JellyNet plugin settings enter one item per line using `Name | URL`. Append `| admin` for administrator-only links. Native Jellyfin routes beginning with `#/`, server-relative paths, and HTTP(S) destinations are accepted. Jellyfin continues to enforce permissions at the destination.

To undo a rollout, disable JellyNet and restart Jellyfin. Keep File Transformation active for the other plugins that use it. Individual viewers can choose **Use standard Jellyfin home** from their Customize Home screen.

## Build and release

Requires Node.js 24 or later and the .NET 10 SDK.

```sh
npm ci
npm run build
dotnet build --configuration Release
```

The compiled plugin is `bin/Release/net10.0/JellyNet.dll`. A manual installation puts the DLL in a dedicated directory beneath Jellyfin's plugin directory. Keep the companion DLL in that directory by itself so Jellyfin can manage versions cleanly.

GitHub Actions builds a ZIP on pushes and pull requests. To publish, update the four-part version in `JellyNet.csproj` and push a matching tag, for example `v1.0.1.0`. The workflow publishes the ZIP as a GitHub Release, verifies the checksum against the downloadable release asset and updates the repository manifest on the default branch. Existing versions remain in the catalog.

## Compatibility checks

Local staging uses Jellyfin 12.4 with File Transformation 3.0.3.0. Browser smoke checks cover connecting through the normal Jellyfin login, category and title navigation, Back focus restoration, keyboard drawer controls, cross-session layout sync, and restricted-library isolation. Before deploying broadly, verify your own plugin links, playback profiles, client builds, and performance on your reference devices, including physical Tizen and webOS devices where applicable.
