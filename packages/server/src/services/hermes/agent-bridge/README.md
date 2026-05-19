# Agent Bridge

Optional backend-side bridge for talking to Hermes Agent by instantiating
`run_agent.AIAgent` directly in a Python process.

This is intentionally separate from the current Web UI chat path.

## Python Service

```bash
python packages/server/src/services/hermes/agent-bridge/hermes_bridge.py
```

Default endpoint:

```text
ipc:///tmp/hermes-agent-bridge.sock
```

On Windows, the default endpoint is TCP because Python may not support Unix
domain sockets there:

```text
tcp://127.0.0.1:18765
```

Override with:

```bash
HERMES_AGENT_BRIDGE_ENDPOINT=tcp://127.0.0.1:8765 python packages/server/src/services/hermes/agent-bridge/hermes_bridge.py
```

The service discovers Hermes Agent in this order:

1. `--agent-root`
2. `HERMES_AGENT_ROOT`
3. the installed `hermes` command path
4. current working directory and parent directories
5. common locations such as `~/.hermes/hermes-agent`, `~/hermes-agent`, and `/opt/hermes-agent`
6. the `hermes-agent` package installed in the selected Python environment

Hermes home is resolved from `--hermes-home`, `HERMES_HOME`, then `~/.hermes`.

Default agent root:

```text
~/.hermes/hermes-agent
```

You can pass both paths explicitly:

```bash
python packages/server/src/services/hermes/agent-bridge/hermes_bridge.py \
  --agent-root ~/.hermes/hermes-agent \
  --hermes-home ~/.hermes
```

If no source checkout containing `run_agent.py` is found, the bridge falls back
to importing `run_agent` from the Python environment. This supports package
installs such as `pip install hermes-agent`. The Node manager prefers the source
checkout's virtualenv when a checkout exists, then the Python interpreter from
the installed `hermes` command, then the system Python.

The socket transport uses Python and Node standard libraries. No ZMQ dependency
is required.

## Backend Usage

```ts
import { AgentBridgeClient } from './services/hermes/agent-bridge'

const bridge = new AgentBridgeClient()
const run = await bridge.chat(sessionId, message)

for await (const chunk of bridge.streamOutput(run.run_id)) {
  if (chunk.delta) {
    // forward chunk.delta to Socket.IO/SSE/etc.
  }
}
```

The external chat call only sends `session_id` and `message`. Provider, model,
keys, tools, reasoning, and session DB are resolved by hermes-agent from the
normal Hermes config and environment.

The bridge instantiates `AIAgent` with `platform="cli"` by default so behavior
matches CLI chat. Override it only if a caller intentionally needs a distinct
platform identity:

```bash
HERMES_AGENT_BRIDGE_PLATFORM=agent-bridge python packages/server/src/services/hermes/agent-bridge/hermes_bridge.py
```
