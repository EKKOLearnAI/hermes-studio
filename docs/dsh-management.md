# DeepSeek Harness management

Open **Agent Manager → DeepSeek Harness** to install `@deepseek-ai/dsh`, detect an existing `dsh` CLI, check for updates, or uninstall the CLI. Installation uses the official npm registry and the same global package management path as other Coding Agents. Update checks include prerelease ordering, such as `rc.1` to `rc.2`.

The Settings button opens the shared Coding Agent configuration pages:

| Page | Native files |
| --- | --- |
| Settings → Preference | `~/.dsh/AGENTS.md` |
| Settings → Configuration | `~/.dsh/settings.yaml` |
| MCP | `~/.dsh/cordis.patch.yml` |
| Skills | `~/.dsh/skills`, followed by shared `~/.agents/skills` |

These are global CLI files, independent of the active Hermes profile. As with the other Coding Agents, `HERMES_CODING_AGENT_GLOBAL_HOME` can override the home used by Studio. A separately configured DSH instance using a custom `DSH_HOME` is outside this management scope.

Settings require a YAML mapping. MCP changes use Cordis plugin patches with `@deepseek-ai/dsh-mcp-client`, preserving unrelated plugins, comments, tags and anchors. Studio accepts stdio and Streamable HTTP connections. It preserves DSH `!!js` expressions as data and refuses to connection-test an MCP whose configuration depends on those expressions. Studio-managed MCP overrides remain in Studio state; they are not inserted into the user's native patch file.

Skills support direct `<name>/SKILL.md` bundles and flat `<name>.md` files. Files must have YAML frontmatter containing a kebab-case `name` and a `description`. Imports accept a skill folder or ZIP and go directly into `.dsh/skills`, without Hermes category directories. The editor can read, edit and delete native skills, including flat files. Nested category directories are not scanned. Invocation flags can be edited in frontmatter; the Hermes enable switch is hidden for DSH.

This phase adds management only. DSH is not yet a Studio chat agent: ACP session creation, model injection, runtime home isolation and shutdown ownership are follow-up work. The management pages do not start a long-running DSH service or stop an independently running DSH instance.

Native format reference: [DeepSeek Harness source, dsh-v0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.1).
