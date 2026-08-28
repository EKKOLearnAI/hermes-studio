---
name: obsidian
description: Read, search, create, edit, organize, and inspect Obsidian vault notes, tasks, links, properties, and plugins with the official CLI.
metadata:
  keywords:
    - obsidian vault
    - obsidian cli
    - obsidian notes
---

# Obsidian

Use the official `obsidian` CLI for Obsidian-aware vault operations. Vault notes are Markdown, so direct file reads and edits are appropriate when the exact vault path is known and the change does not require Obsidian to update links or metadata.

## Prerequisites

- Obsidian 1.12.7 or newer is installed.
- **Settings > General > Command line interface** is enabled.
- `obsidian` is registered on `PATH`.
- Obsidian is running; the CLI connects to the desktop application.

Check without changing the vault:

```bash
obsidian version
obsidian help
```

If the CLI is absent, explain how to enable the official CLI in Obsidian. Do not silently install a third-party `obsidian-cli` package.

## Vault selection

Multiple vaults are common. Use `vault="<name>"` when the target is ambiguous, and ask the user to choose rather than guessing. Prefer `path="Folder/Note.md"` for exact vault-relative resolution; `file=<name>` uses Obsidian's name-based resolution.

Do not edit `.obsidian/` configuration unless the user explicitly requested a settings or plugin change. Avoid reading or exposing unrelated notes from a private vault.

## Command pattern

```bash
obsidian <command> [name=value] [flag]
obsidian vault="Notes" search query="meeting notes" format=json
```

Quote parameter values containing spaces. Prefer structured output such as `format=json` when available.

## Open and read

```bash
obsidian open file=Recipe
obsidian open path="Inbox/Idea.md" newtab
obsidian read
obsidian read file=Recipe
```

## Search

```bash
obsidian search query="TODO" matches
obsidian search query="status::active" format=json
obsidian search:open query="project notes"
```

## Create and modify

```bash
obsidian create name="New Note"
obsidian create path="Inbox/Idea.md" content="# Idea"
obsidian append file=Note content="New line"
obsidian prepend file=Note content="After frontmatter"
```

Create and modify notes only when requested. For multiline or user-provided content, avoid fragile shell interpolation; use a safe file-based workflow or the agent's file tools after resolving the exact vault path.

## Move and delete

```bash
obsidian move file=Note to=Archive/
obsidian move path="Inbox/Old.md" to="Projects/New.md"
obsidian delete file=Note
```

Prefer Obsidian's move command so links can be maintained. Verify the exact source and destination. Confirm immediately before deletion if the target was not already explicit in the user's request.

## Daily notes and tasks

```bash
obsidian daily
obsidian daily:read
obsidian daily:append content="- [ ] Review inbox"
obsidian tasks all todo
obsidian task file=Note line=8 done
```

Completing a task changes a note. Resolve the file and task line before applying it.

## Properties and links

```bash
obsidian tags all counts
obsidian property:read file=Note name=status
obsidian property:set file=Note name=status value=done
obsidian backlinks file=Note
obsidian unresolved verbose counts
```

## Plugin and developer commands

```bash
obsidian plugin:reload my-plugin
obsidian dev:errors
obsidian dev:screenshot file=shot.png
obsidian eval "app.vault.getFiles().length"
```

Plugin reloads and `eval` can change or inspect broad application state. Use them only for an explicit plugin-development or diagnostic task. Do not run arbitrary user-supplied JavaScript through `obsidian eval` without reviewing its effects.

## File model

- Notes are `*.md` files.
- Canvases are `*.canvas` JSON files.
- Attachments live in the vault's configured attachment folder.
- `.obsidian/` stores vault configuration.

Use direct Markdown edits for bounded bulk text changes after locating the correct vault. Use CLI move, delete, property, and task operations when Obsidian-aware behavior matters.
