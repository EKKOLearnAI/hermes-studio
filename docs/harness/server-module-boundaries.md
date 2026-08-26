# Server Module Boundaries

This document is the target architecture and migration contract for
`packages/server/src`. It separates Studio-owned capabilities from the three
agent families without changing public API paths or persisted data as part of
the move.

## Domain Vocabulary

Do not use one `source` or `agent` field for all of these concepts:

| Concept | Allowed values | Meaning |
| --- | --- | --- |
| `AgentFamily` | `hermes`, `ekko`, `coding` | Product/domain owner of an agent implementation. |
| `AgentRuntime` | `hermes`, `ekko`, `claude-code`, `codex`, `pi` | Concrete runtime selected for a run. |
| `RunSurface` | `chat`, `workflow`, `group-chat`, `global-agent`, `api` | Studio surface that initiated a run. |
| `RunMode` | `scoped`, `global` | Whether the run is workspace/profile scoped or global. |

Hermes and Ekko are both a family and a runtime. Claude Code, Codex, and Pi are
three runtimes in the Coding family. Persist and transport these concepts
separately whenever a schema is introduced or revised.

## Target Directory

The tree below is the ownership target. Feature folders may grow beneath the
listed layers, but new top-level server modules require an architecture change
to this document and its mechanical checker.

```text
packages/server/src/
  index.ts                         # temporary process entry; delegates to bootstrap
  bootstrap/                       # only concrete composition root
    app.ts                         # Koa construction and middleware order
    http.ts                        # HTTP server lifecycle
    sockets.ts                     # Socket.IO module registration
    modules.ts                     # concrete module factories and agent adapters
    lifecycle.ts                   # startup and shutdown coordination

  modules/
    studio/                        # common product/platform capabilities
      index.ts
      contracts/
        agents/
          family.ts                # AgentFamily
          runtime.ts               # AgentRuntime
          runner.ts                # runtime-neutral run port
          registry.ts              # registration/resolution port
          events.ts                # runtime-neutral event contract
        runs/
          surface.ts               # RunSurface and RunMode
          session.ts
          usage.ts
          workspace-diff.ts
        files/
        providers/
        voice/
      public/                      # stable facades agents may import
        config.ts
        credentials.ts
        files.ts
        logging.ts
        runs.ts
        sessions.ts
        usage.ts
        workspace.ts
      middleware/
        auth.ts
        errors.ts
        request-context.ts
      http/
        body.ts
        responses.ts
        validation.ts
      routes/
        auth.ts
        update.ts
        health.ts
        devices.ts
        mcu-devices.ts
        upload.ts
        files.ts
        theme.ts
        api-docs.ts
        app-connections.ts
        app-relay.ts
        social-messages.ts
        chat-run.ts
        chat-webhooks.ts            # cross-agent event delivery; legacy URL remains /api/hermes/webhooks
        workflows.ts
        group-chat.ts
        global-agent.ts
        pets.ts
        logs.ts
        voice.ts
      controllers/
        auth.ts
        update.ts
        health.ts
        devices.ts
        mcu-devices.ts
        upload.ts
        files.ts
        theme.ts
        api-docs.ts
        app-connections.ts
        app-relay.ts
        social-messages.ts
        chat-run.ts
        chat-webhooks.ts
        workflows.ts
        group-chat.ts
        global-agent.ts
        pets.ts
        logs.ts
        voice.ts
      services/
        agents/
          agent-registry.ts        # stores injected agent runners
          run-coordinator.ts       # dispatches through Studio contracts
        auth/
        config/
        connections/
        credentials/
        files/
        logging/
        notifications/
        providers/
        sessions/
        social-messages/
        chat-run/                    # shared single-chat lifecycle and persistence
        context-compressor/
        webhooks/                    # aggregates events from every AgentFamily and RunSurface
        update/
          studio-updater.ts        # upgrades hermes-web-ui
          studio-restarter.ts
          version-preview-manager.ts
        workflow/
        group-chat/
        global-agent/
        pets/
        voice/
          stt/
          tts/
      repositories/                # Studio-owned application state
        users/
        devices/
        sessions/
        usage/
        workflows/
        group-chat/
        app-connections/
        social-messages/
        settings/
      infrastructure/
        database/
        filesystem/
        network/
        processes/
      sockets/
        chat-run.ts
        group-chat.ts
        global-agent.ts
        pets.ts

    hermes/                        # Hermes Agent-owned API and behavior
      index.ts                     # exposes factory/registration to bootstrap
      public/                      # Hermes adapter exposed only to bootstrap
        runner.ts
      contracts/
      routes/
        profiles.ts
        providers.ts
        models.ts
        sessions.ts
        skills.ts
        skill-bundles.ts
        plugins.ts
        memory.ts
        terminal.ts
        cron.ts
        journey.ts
        kanban.ts
        mcp.ts
        write-gate.ts
        channels.ts
        runtime.ts
      controllers/
        profiles.ts
        providers.ts
        models.ts
        sessions.ts
        skills.ts
        skill-bundles.ts
        plugins.ts
        memory.ts
        terminal.ts
        cron.ts
        journey.ts
        kanban.ts
        mcp.ts
        write-gate.ts
        channels.ts
        runtime.ts
      services/
        runner/
        bridge/
        gateway/
        profiles/
        providers/
        models/
        history/                   # adapters for Hermes Agent state.db
        skills/
        plugins/
        memory/
        terminal/
        cron/
        journey/
        kanban/
          kanban-service.ts
          hermes-kanban-cli.ts
          attachments.ts
          session-link.ts
          events.ts
          types.ts
        mcp/
        write-gate/
        channels/
          weixin.ts
        runtime/                   # Hermes runtime download/activation/version
      sockets/
        terminal.ts
        kanban-events.ts

    ekko/                          # Ekko Agent-owned API and behavior
      index.ts
      public/
        runner.ts
      contracts/
      routes/
        chat.ts
        providers.ts
        approvals.ts
        clarifications.ts
        mcp.ts
      controllers/
        chat.ts
        providers.ts
        approvals.ts
        clarifications.ts
        mcp.ts
      services/
        runner/
        runtime/
        providers/
        auth/
        tools/
        memory/
        approvals/
        clarifications/
        mcp/
      sockets/
        chat.ts

    coding-agents/                 # Claude Code, Codex, and Pi family
      index.ts
      public/
        runner.ts
      contracts/
      protocol/                    # shared only inside the Coding family
        events.ts
        messages.ts
        sse.ts
        tool-calls.ts
      routes/
        agents.ts
        runs.ts
        claude-code-proxy.ts
        codex-proxy.ts
      controllers/
        agents.ts
        runs.ts
        claude-code-proxy.ts
        codex-proxy.ts
      services/
        registry/
        credentials/
        sessions/
        run-manager/
        claude-code/
        codex/
        pi/
      sockets/
        runs.ts
```

`public/` does not mean a public HTTP API. It is the stable in-process facade
that another allowed layer can import. Concrete agent `public/runner.ts` files
are consumed by `bootstrap/modules.ts`, which injects them into Studio's agent
registry. Studio orchestration never imports a concrete agent module.

## Ownership Decisions

| Capability | Owner | Reason |
| --- | --- | --- |
| Studio update and Version Preview | Studio | Upgrades/restarts `hermes-web-ui`, not Hermes Agent. |
| Auth, users, devices, files, app connections, relay, social messages | Studio | Product/platform capabilities shared across agents. |
| Single Chat (Chat Run), Workflow, Group Chat, Global Agent | Studio | Cross-agent run and orchestration surfaces; dispatch through agent contracts. |
| Pets/Petdex and aggregate logs | Studio | Stored or presented as Studio product state. |
| Common config, credentials, provider contracts, voice, run/session/usage helpers | Studio | Shared capabilities exposed through `studio/public` or `studio/contracts`. |
| Studio SQLite tables and repositories | Studio | Application state owned by the Web UI. |
| Hermes profiles, bridge, gateway, skills, plugins, memory, terminal, cron | Hermes | Direct Hermes Agent behavior or state. |
| Journey | Hermes | Invokes Hermes and reads a Hermes profile. |
| Kanban | Hermes | Uses `hermes kanban`, Hermes profiles, and Hermes history. It is not a common scheduler. |
| Hermes MCP and Write Gate | Hermes | Operate through Hermes Bridge/Python and Hermes memory/skills approvals. |
| Weixin channel configuration | Hermes | Mutates Hermes profile environment and restarts the Hermes gateway. |
| Hermes Agent history adapters | Hermes | Read `~/.hermes/.../state.db`; they are separate from Studio repositories. |
| Hermes runtime download/activation/version | Hermes | Manages the Hermes runtime; split it from Studio Web UI updating. |
| Ekko runtime, provider handling, tools, memory, approvals, clarification, MCP | Ekko | Concrete Ekko Agent behavior. |
| Claude Code, Codex, Pi and their shared protocol | Coding Agents | Shared by runtimes in one family, not by all Studio agents. |

If a feature can dispatch multiple agents, that alone does not make its data
and business rules common. Ownership follows the state, command, and rules that
the feature controls. Kanban is therefore Hermes; Single Chat, Group Chat,
Workflow, and Global Agent are Studio orchestration. Hermes session history is
still exposed through a Hermes adapter, but Studio owns the chat-run lifecycle.

## Allowed Dependency Matrix

An arrow means the row may import the column.

| From / To | Studio | Hermes | Ekko | Coding Agents |
| --- | ---: | ---: | ---: | ---: |
| `bootstrap` | yes | yes | yes | yes |
| Studio | yes | no | no | no |
| Hermes | contracts/public | yes | no | no |
| Ekko | contracts/public | no | yes | no |
| Coding Agents | contracts/public | no | no | yes |

Additional layer rules:

- Routes import their own controllers plus Studio HTTP, middleware, contracts,
  or public facades. Routes do not call services or repositories directly.
- Controllers do not import routes. They delegate reusable behavior to their
  own services and may consume Studio contracts/public facades.
- Services do not import routes, controllers, or sockets.
- Agent modules do not import one another. Cross-agent execution goes through
  a Studio-owned port registered by `bootstrap`.
- Agent code does not reach into Studio internal `services`, `repositories`, or
  `infrastructure`; Studio exposes a narrow facade under `public`.
- Studio never imports a concrete agent. This keeps the module graph acyclic.

## Migration Contract

Migration is structural first. Preserve behavior while moving ownership:

1. Do not rename existing `/api/...` paths merely because files move.
2. Do not combine a module move with a database schema or state-location
   change. Studio state and Hermes Agent state remain physically separate.
3. Introduce Studio contracts/public facades before removing a cross-module
   import. `bootstrap` supplies concrete agent implementations.
4. Move one vertical feature slice at a time: route, controller, service,
   repository/adapter, socket, and focused tests.
5. Temporary re-exports may preserve internal import compatibility during one
   migration slice, but new module code may not import the legacy tree.
6. Delete compatibility re-exports and shrink the debt baseline as soon as all
   callers move.

## Mechanical Harness

Run:

```bash
npm run harness:server-boundaries
```

`scripts/server-module-boundaries.mjs` enforces:

- only the four declared module roots under `modules/`;
- the dependency matrix and route/controller/service layer rules;
- no imports from migrated modules back into legacy server source;
- no new files in the legacy tree after cutoff commit
  `a513405354f6b038e220c587c3f729871c2b8b0d`;
- no increase in the existing forbidden-import debt recorded in
  `scripts/harness/server-module-boundary-baseline.json`.

When a migration removes a forbidden legacy edge, the check intentionally
fails until its stale baseline entry is deleted. Baseline additions are not a
normal escape hatch: resolve a new dependency through Studio contracts/public
facades instead.
