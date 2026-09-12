# DeepSeek Harness integration

This page describes the current integration. The proposed next stages for reusing Web Profiles, Agent presets, native plugins and browser plugin runtimes are documented in [DSH 配置复用与插件完整接入规划](planning/dsh-profiles-and-plugins.md); those stages are not implemented by this planning document.

Open **Agent Manager → DeepSeek Harness** to install `@deepseek-ai/dsh`, detect an existing `dsh` CLI, check for updates, or uninstall the CLI. Installation uses the official npm registry and the same global package management path as other Coding Agents. Update checks include prerelease ordering, such as `rc.1` to `rc.2`.

The Settings button opens the shared Coding Agent configuration pages:

| Page | Native files |
| --- | --- |
| Settings → Preference | `~/.dsh/AGENTS.md` |
| Settings → Configuration | `~/.dsh/settings.yaml` |
| MCP | `~/.dsh/cordis.patch.yml` |
| Skills | `~/.dsh/skills`, followed by shared `~/.agents/skills` |

These are global CLI files, independent of the active Hermes profile. As with the other Coding Agents, `HERMES_CODING_AGENT_GLOBAL_HOME` can override the home used by Studio. DSH runtime and native plugin discovery also honor an explicit `DSH_HOME`; the existing general Settings/Skills/MCP editors still use the global Coding Agent Home.

Settings require a YAML mapping. MCP changes use Cordis plugin patches with `@deepseek-ai/dsh-mcp-client`, preserving unrelated plugins, comments, tags and anchors. Studio accepts stdio and Streamable HTTP connections. It preserves DSH `!!js` expressions as data and refuses to connection-test an MCP whose configuration depends on those expressions. Studio-managed MCP overrides remain in Studio state; they are not inserted into the user's native patch file.

Skills support direct `<name>/SKILL.md` bundles and flat `<name>.md` files. Files must have YAML frontmatter containing a kebab-case `name` and a `description`. Imports accept a skill folder or ZIP and go directly into `.dsh/skills`, without Hermes category directories. The editor can read, edit and delete native skills, including flat files. Nested category directories are not scanned. Invocation flags can be edited in frontmatter; the Hermes enable switch is hidden for DSH.

Select **DeepSeek Harness** when creating a single chat, adding a group-chat agent, or configuring a workflow agent node. **Provider and model** mode uses the provider, protocol and model selected in Studio through its local Responses proxy. **Global config** uses the native DSH model configuration. The same settings, Skills and MCP pages serve all three entry points. Workflow-selected DSH skills resolve direct bundles and flat files from the native and shared skill roots.

Studio reads the native Web Profile's bundles, installed dependencies, patches and default Agent preset, and prepares a private `studio-web-<generation>` Profile with an ACP entry point. Official Web server/UI entry points are excluded; backend plugins remain available. New sessions mount the Web default preset in the Agent factory setup; resumed sessions keep their stored preset. Scoped model credentials remain in the local proxy, with only its scoped token passed to DSH. Global mode uses the Web default model. See [implementation details and limits](planning/dsh-plugin-management-implementation.md).

DSH uses `danger-full-access` with approval policy `never`, including after restoring older restricted sessions. This policy is confined to DSH. Its child environment receives Studio's discovered toolchain PATH. Plugin install commands must explicitly target the native source Home and `--profile web`; installing into the conversation's inherited `DSH_HOME` does not update the source. Browser plugin interfaces are not yet hosted by Studio.

Each turn initializes ACP, creates or resumes the stored native session, applies the selected model, and sends text/image content. Studio loads a small Cordis plugin from the private runtime home to forward DSH's native `agent/assistant-stream` text and reasoning deltas over a private ACP notification. Only the owned ACP session's live output reaches chat; subagent and auxiliary proxy requests are not forwarded. Committed ACP messages are deduplicated against their live attempt by message ID, while final-only output remains supported. Tools, completion and context updates still come from ACP. This applies to scoped and global runs across single chat, group chat and workflows, without changing the installed DSH package. Scoped billing uses the proxy usage ledger; ACP context occupancy is not counted as billed tokens. Global usage may be estimated. Native `/compact` is not exposed through this integration.

The adapter flushes persistence before resolving a completed ACP prompt. On normal completion Studio closes the ACP session to flush persistence, then closes stdin. The next turn starts a fresh process and resumes the same persisted session. Resume errors are reported without silently creating a replacement conversation. Cancelling a run or exiting Studio cancels ACP and terminates only Studio-owned processes, with forced cleanup if needed. This does not bind the DSH Web port or stop a separately started DSH instance.

Validate the installed CLI without a paid model call with `NODE_ENV=test PORT=8648 DSH_REAL_ACP_E2E=1 npx vitest run tests/server/dsh-acp-real.test.ts`. This opt-in check uses an isolated temporary home and a local Responses fixture to verify model injection, shutdown and cross-process resume. The fixture pauses after its first text delta until Studio receives that delta, proving streaming happens before model completion; it also checks that final ACP output is not duplicated.

Native format reference: [DeepSeek Harness source, dsh-v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.1).

Validate the Web-backed production path with `DSH_WEB_REAL=1 DSH_WEB_COMMAND=/absolute/path/to/dsh npx vitest run tests/server/dsh-web-real.test.ts`. It uses temporary native Web bundles/presets and a local model fixture, including real tool calls and writes outside the workspace; no model credentials or external model requests are needed.
