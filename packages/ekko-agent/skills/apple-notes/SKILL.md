---
name: apple-notes
description: Create, view, search, edit, move, export, or delete Apple Notes on macOS with the memo CLI.
metadata:
  keywords:
    - apple notes
    - notes.app
    - memo notes
---

# Apple Notes

Use `memo notes` to work with Apple Notes when the user wants the result in Notes.app. This Skill is macOS-only.

## Prerequisites

```bash
command -v memo
memo notes --help
```

The `memo` CLI comes from <https://github.com/antoniorodr/memo>. If it is missing, explain the dependency and let the user choose whether to install it; do not install it silently. Notes.app must be accessible, and macOS may ask the user to grant Automation access under **System Settings > Privacy & Security > Automation**.

## Read and search

```bash
memo notes
memo notes -f "Folder Name"
memo notes -s "query"
```

Use the narrowest folder or search query available. Do not surface unrelated private notes in the response.

## Create

```bash
memo notes -a
memo notes -a "Note Title"
```

Creation may open an interactive editor. Use a persistent interactive terminal when available; otherwise ask the user to complete the prompt locally.

## Edit, move, export, and delete

```bash
memo notes -e
memo notes -m
memo notes -ex
memo notes -d
```

These commands use interactive note selection. Before editing, moving, or deleting, identify the exact note and folder. Treat create, edit, move, and delete as changes to the user's Notes library: perform them only when requested. Confirm immediately before deletion if the target was not already unambiguous in the user's instruction.

## Limitations

- `memo` cannot edit notes that contain images or attachments.
- Interactive prompts require terminal access and may not work in a one-shot command.
- Exported files can contain private note content; write them only to a location the user requested and avoid exposing unrelated content.
