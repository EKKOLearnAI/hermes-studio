# Gateway Development Guide

This document explains how Hermes Web UI manages Hermes Agent gateway processes during local development and production runtime.

## Scope

Gateway lifecycle is owned by `GatewayManager`:

- Source: `packages/server/src/services/hermes/gateway-manager.ts`
- Bootstrap: `packages/server/src/services/gateway-bootstrap.ts`
- Shutdown: `packages/server/src/services/shutdown.ts`
- Dev restart config: `nodemon.json`

The manager supports multiple Hermes profiles. Each profile gets its own gateway process and API server port.

## Startup Flow

Server bootstrap creates one `GatewayManager` instance:

```text
packages/server/src/index.ts
-> initGatewayManager()
-> new GatewayManager(activeProfile)
-> detectAllOnStartup()
-> startAll()
```

The startup process is intentionally split into two phases.

1. `detectAllOnStartup()`
   - Lists Hermes profiles.
   - Reads profile gateway metadata.
   - Checks whether an existing gateway process is alive.
   - Checks the configured `/health` endpoint.
   - Registers healthy existing gateways in memory.

2. `startAll()`
   - Skips profiles that are already healthy.
   - Skips remote profiles that cannot be started locally.
   - Resolves a local port.
   - Starts missing local gateways.

## Profile Paths

Profile directories are resolved as:

| Profile | Directory |
|---|---|
| `default` | `HERMES_BASE` |
| non-default | `HERMES_BASE/profiles/<profile>` |

`HERMES_BASE` comes from `detectHermesHome()` in `packages/server/src/services/hermes/hermes-path.ts`.

## Gateway Address Configuration

Gateway API server host and port are read from:

```yaml
platforms:
  api_server:
    extra:
      host: 127.0.0.1
      port: 8642
```

The manager writes the same structure when assigning a port. Older top-level `platforms.api_server.host` and `platforms.api_server.port` values are removed when writing, because Hermes reads the values from `extra`.

## PID Sources

`GatewayManager` reads gateway PID metadata in this order:

1. `gateway.pid`
2. `gateway_state.json`

`gateway.pid` is authoritative when present.

`gateway_state.json` is only a fallback when `gateway.pid` is missing. The fallback PID is accepted only when:

- the PID is finite;
- the PID is greater than `0`;
- `gateway_state` is `running` or `starting`.

The PID alone is not enough to mark a gateway as healthy. Callers also check process liveness and the configured `/health` endpoint.

## Process Liveness

Process liveness uses:

```ts
process.kill(pid, 0)
```

This does not terminate the process. It only checks whether the process exists and whether the current process can signal it.

`EPERM` is treated as alive. This matters on Windows and other restricted environments: `EPERM` means the process exists, but the current process does not have permission to signal it.

## Health Checks

Gateway readiness is determined by:

```text
GET <gateway-url>/health
```

A gateway is considered usable only when the health response is successful.

This protects against stale PID files and process ID reuse.

## Port Resolution

Before starting a gateway, `resolvePort()`:

1. Checks whether the profile already has a healthy in-memory gateway.
2. Checks whether PID metadata points to a healthy gateway on the configured URL.
3. Tracks ports already allocated in the current startup pass.
4. Finds a free local port with a TCP bind test.
5. Writes the selected port back to profile `config.yaml`.

Port allocation intentionally starts from the gateway base range used by this application.

## Gateway Start Mode

All platforms use:

```bash
hermes gateway run --replace
```

The process is started with:

```text
HERMES_HOME=<profile-dir>
```

This keeps each profile isolated.

`--replace` lets Hermes handle stale gateway lock files more reliably than service-manager mode.

## Development Mode on Windows

Windows development has one important difference: `nodemon` restarts can terminate child processes as part of the process tree. On Windows, `nodemon` may send `SIGTERM` during restarts instead of `SIGUSR2`.

To avoid closing every gateway on each server restart, `nodemon.json` sets:

```json
{
  "env": {
    "HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN": "0"
  }
}
```

When this variable is `0` or `false`:

- shutdown skips `gatewayManager.stopAll()` for **all signals** (including `SIGTERM`);
- gateway processes are spawned with `detached: true`;
- gateway child processes are `unref()`ed;
- the restarted server re-detects running gateways during `detectAllOnStartup()`.

This is the intended local development behavior. Editing server files should restart the Web UI server without killing all Hermes gateways.

### Debug Logging

The enhanced shutdown handler now logs all signals and environment variable states:

```text
[shutdown] Signal: SIGTERM, HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: 0
[shutdown] Dev mode detected: NOT stopping gateways
```

Gateway startup logs also indicate the process detachment mode:

```text
[gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0)
```

## Production Shutdown Behavior

In production, the env override is normally unset.

On shutdown:

```text
bindShutdown()
-> shouldStopGatewaysOnShutdown(signal)
-> gatewayManager.stopAll()
```

Only gateways marked as `owned` by the current Web UI instance are stopped by `stopAll()`.

### Signal Handling

| Signal | Default Behavior | With `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0` |
|--------|------------------|--------------------------------------------------|
| `SIGTERM` | Stop gateways | Skip gateway shutdown |
| `SIGINT` | Stop gateways | Skip gateway shutdown |
| `SIGUSR2` | Skip gateway shutdown (reload) | Skip gateway shutdown |

**Windows Note**: `nodemon` on Windows typically sends `SIGTERM` during restarts, not `SIGUSR2`. This is why the `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0` override is critical on Windows for development.

## Stop Flow

Stopping a profile gateway collects candidate PIDs from:

- the spawned child process reference;
- the in-memory gateway record;
- `gateway.pid` or `gateway_state.json`;
- local listening PIDs on the configured port.

Then it:

1. Calls `hermes gateway stop` for the profile.
2. Checks whether `/health` is already down.
3. Sends termination signals to candidate PIDs.
4. Waits until `/health` fails.
5. Force kills remaining local listeners only if the gateway is still healthy after the timeout.

Because local port listener detection can include unrelated processes, prefer PID metadata and health checks when debugging stop behavior.

## CLI PID Recovery

The npm CLI entrypoint `bin/hermes-web-ui.mjs` also has PID recovery logic for the Web UI server itself.

The safe order is:

1. Read `~/.hermes-web-ui/server.pid`.
2. If the PID is alive, use it.
3. If the PID is stale, remove it.
4. Only then use port listener detection as a fallback.

The CLI should not recover from a port before checking the PID file. Doing so can mistake an unrelated process for Hermes Web UI.

## Port Listener Detection

The CLI uses platform-specific listener detection:

| Platform | Primary command | Fallback |
|---|---|---|
| Windows | `netstat -aon -p tcp` | none |
| macOS/Linux | `lsof -tiTCP:<port> -sTCP:LISTEN` | `ss -ltnp 'sport = :<port>'` |

The server-side `GatewayManager` uses:

| Platform | Command |
|---|---|
| Windows | `netstat -ano -p tcp` |
| macOS/Linux | `lsof -tiTCP:<port> -sTCP:LISTEN` |

Port detection is best-effort. Some minimal Linux containers may not have `lsof`; some restricted systems may hide PIDs owned by another user.

## Environment Variables

| Variable | Values | Purpose |
|---|---|---|
| `HERMES_HOME` | path | Overrides Hermes home/profile root when launching Hermes commands. |
| `HERMES_BIN` | path | Overrides Hermes CLI binary path. |
| `GATEWAY_HOST` | host | Default gateway host when config does not define one. |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | `0`, `false`, `1`, `true` | Controls whether shutdown stops owned gateways. `0`/`false` also enables detached gateway processes. |

## Recommended Local Development Workflow

Use:

```bash
npm run dev
```

Expected behavior:

- client and server both run in dev mode;
- `nodemon` restarts the server when `packages/server/src` changes;
- gateways keep running across server restarts;
- the restarted server re-registers healthy gateways during bootstrap.

### Quick Health Check

Verify everything is working:

```bash
# Check environment variable is set
# (should see: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = 0)
npm run dev

# In another terminal, check gateways are running
ps aux | grep -i "hermes.*gateway"

# Trigger a restart by editing a server file
# (gateways should keep running)
```

### Expected Logs

**Startup:**
```text
[bootstrap] HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = 0
[gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0)
```

**During Nodemon Restart:**
```text
[shutdown] Signal: SIGTERM, HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: 0
[shutdown] Dev mode detected: NOT stopping gateways
```

**After Restart:**
```text
[bootstrap] HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = 0
%s: already running (PID: xxxxx, port: 8642)
```

If a gateway fails after restart, check:

1. `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` is `0` in the server process.
2. Gateway start logs include `Detaching gateway process`.
3. The profile has a valid `gateway.pid` or `gateway_state.json`.
4. The configured gateway `/health` endpoint is reachable.
5. No unrelated process occupies the profile's configured port.

## Troubleshooting

### Gateways close on every Windows restart

Check that the server process was launched through `nodemon.json` and that the environment contains:

```bash
HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0
```

Also confirm the gateway start log prints:

```text
[gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0)
```

If it prints `Attaching gateway process`, the dev opt-out env did not reach the server process.

#### Debugging Steps

1. **Check startup logs** for environment variable confirmation:
   ```text
   [bootstrap] HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = 0
   ```

2. **Check shutdown logs** when nodemon restarts:
   ```text
   [shutdown] Signal: SIGTERM, HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: 0
   [shutdown] Dev mode detected: NOT stopping gateways
   ```

3. **Verify gateway detachment mode**:
   ```text
   [gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0)
   ```

4. **Check if gateway survived restart**:
   ```bash
   # Before restart
   ps aux | grep -i "hermes.*gateway"
   # Note the PID
   # After nodemon restart
   ps aux | grep -i "hermes.*gateway"
   # PID should be the same
   ```

If logs show `Attaching gateway process` or shutdown logs show `STOPPING gateways`, the environment variable is not being applied correctly.

### Gateway is alive but Web UI does not detect it

Check:

- the profile `config.yaml` host and port;
- `gateway.pid`;
- `gateway_state.json`;
- `GET http://<host>:<port>/health`;
- whether the PID exists and is visible to the Web UI process.

Detection requires both PID liveness and a healthy endpoint.

### Port is occupied

The manager will allocate another available gateway port for local profiles.

For manual debugging:

Windows:

```powershell
netstat -aon -p tcp
```

macOS/Linux:

```bash
lsof -tiTCP:<port> -sTCP:LISTEN
ss -ltnp 'sport = :<port>'
```

### Stale lock file on Windows

Before starting a gateway on Windows, the manager checks `gateway.lock`. If the lock PID is no longer alive, it removes the stale lock file.

If startup still fails, inspect the profile directory for:

- `gateway.lock`;
- `gateway.pid`;
- `gateway_state.json`;
- Hermes gateway logs.

## Development Notes

- Keep startup detection read-only. Process cleanup belongs in start/stop paths.
- Treat PID files as hints, not proof. Always combine PID liveness with health checks.
- Treat port listener discovery as a fallback. A listening port can belong to another process.
- Preserve production shutdown cleanup unless the dev opt-out env is explicitly set.
- When changing Windows process handling, test both `npm run dev` and production-style startup.

## Recent Changes

### Enhanced Logging and Windows Support (2025-01-XX)

**Improvements:**
- Enhanced shutdown handler with detailed logging for all signals
- Gateway manager now logs detachment mode explicitly
- Added environment variable confirmation on startup
- Improved cross-platform signal handling documentation

**Debug Logs Added:**
```text
[bootstrap] HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = 0
[gateway] Detaching gateway process (dev mode: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=0)
[shutdown] Signal: SIGTERM, HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: 0
[shutdown] Dev mode detected: NOT stopping gateways
```

**Benefits:**
- Easier troubleshooting of gateway lifecycle issues
- Clear visibility into signal handling during nodemon restarts
- Better cross-platform development experience
- Production behavior remains unchanged

**Testing:**
- ✅ Windows: Gateways persist across nodemon restarts
- ✅ macOS/Linux: Existing SIGUSR2 behavior preserved
- ✅ Production: Default shutdown cleanup unchanged
- ✅ Backward compatibility: No breaking changes
