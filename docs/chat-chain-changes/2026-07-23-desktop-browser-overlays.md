---
date: 2026-07-23
pr: pending
feature: Desktop browser overlays, stale lease recovery, and compact MCP category discovery
impact: The native browser no longer covers app overlays, stale browser leases recover immediately, and browser/devices/use now add one category schema each to model context while preserving direct-call compatibility.
---

Overlay detection now covers the active Naive UI drawer and modal nodes as well
as custom image-preview and full-screen overlay surfaces. Delayed checks follow
CSS enter and leave transitions so the Electron `WebContentsView` cannot cover
an overlay that starts outside the viewport or at zero opacity.

Browser MCP registration now includes its process ID. The Desktop Broker keeps
live-client lease conflicts intact but reclaims a lease immediately when its
owning MCP process has exited. The server-to-ekko-agent request and response
flow is unchanged.

Closing a download-created blank tab no longer waits for page-side annotation
cleanup, which may never resolve after a cancelled download. Closing the last
tab now persists an empty tab list instead of immediately recreating another
blank tab.

Browser, devices, and use MCP servers now expose one compact category tool each.
The model first lists the category catalog, describes only the operation it needs,
then invokes that operation through the same category tool. Existing direct tool
names remain callable for clients that already know them, but are no longer returned
by `tools/list`. The API server keeps its two-stage OpenAPI index/request design.

All Web UI runtimes now keep the same four managed MCP server configurations,
including `hermes-studio-browser`. Browser capability is still gated by the local
Desktop Browser Broker: without a valid broker its `tools/list` is empty and calls
return a bounded MCP error. This prevents Web UI and Desktop processes from
alternately removing and restoring the shared browser configuration.

Coding-agent system guidance now directs models to discover browser operations via
`hermes_studio_browser_toolset` instead of treating an empty MCP resource list as
evidence that the Browser MCP toolset is unavailable.

Codex runs backed by Chat Completions or Anthropic Messages now expand the four
split Hermes MCP namespaces into the same compact API, browser, devices, and use
entry tools before forwarding the model request. Returned tool calls are annotated
with the originating namespace so Codex routes them back to the correct local MCP
server instead of treating an enabled server as an unavailable tool.

Codex deferred discovery is also preserved across those compatibility adapters.
Its client-side `tool_search` specification is forwarded as an ordinary provider
tool, then converted back to native `tool_search_call` and `tool_search_output`
items. Matching deferred MCP schemas are added only to the following provider
request, so browser, devices, and use do not occupy the model context until they
are requested.

Browser profiles now use one root directory with fixed `data/` and `download/`
children. The default profile follows the same layout. Creating or editing a
profile requires an empty root; changing it leaves the old directory untouched
and immediately rebuilds the active profile without restarting Desktop. Each
profile can also use a direct connection, the system proxy, or its own fixed
HTTP/HTTPS/SOCKS proxy, applied before restored tabs load.

The browser toolbar now shows the active profile and switches profiles through
the same guarded immediate-switch flow as the settings page. It also exposes a
download panel with live byte/percentage progress and cancellation backed by the
main process's active Electron `DownloadItem`; the settings page shows the same
progress and cancellation controls.

Prompted downloads now configure Electron's native save dialog synchronously
inside `will-download`, while automatic downloads set their final path in the
same callback. This prevents completed macOS transfers from remaining as hidden
`.com.github.Electron.*` temporary files. Terminal download states can no longer
be overwritten by a late progress event, and the download popover header now
inherits the active theme instead of forcing a white background.

Browser sessions are now retained per profile for the lifetime of the manager.
Before profile switches or active-profile rebuilds, Electron DOM storage and the
cookie store are explicitly flushed to that profile's `data/` directory. All Profile
cookies, including their original expirations, are also encrypted with the operating
system credential store and mirrored after cookie changes, then restored before the
profile's first request. This covers Electron session cookies and custom Sessions
whose Chromium Cookie database has not been written yet. Authenticated sites such as
Gmail therefore survive both profile switches and Desktop restarts without relying
only on the quit path. Final shutdown persistence is bounded to two seconds so a
stuck storage backend cannot block process exit.
