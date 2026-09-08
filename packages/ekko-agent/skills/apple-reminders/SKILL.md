---
name: apple-reminders
description: List, create, edit, complete, or delete Apple Reminders and reminder lists on macOS with remindctl.
metadata:
  keywords:
    - apple reminders
    - reminders.app
    - remindctl
---

# Apple Reminders

Use `remindctl` when the user wants tasks stored in Apple Reminders and synchronized through their Apple account. This Skill is macOS-only.

If “remind me” could mean either an Apple Reminder or a notification inside the current host application, ask which destination they want when the surrounding context does not make it clear. Do not claim that this Skill schedules chat messages or agent jobs.

## Prerequisites

```bash
command -v remindctl
remindctl status
```

The `remindctl` CLI comes from <https://github.com/steipete/remindctl>. If it is missing, explain the dependency and let the user decide whether to install it; do not install it silently.

The user may need to grant Reminders access:

```bash
remindctl authorize
```

Authorization is a visible macOS permission decision. Let the user approve or deny it.

## View reminders

```bash
remindctl
remindctl today
remindctl tomorrow
remindctl week
remindctl overdue
remindctl all
remindctl 2026-01-04
remindctl today --json
remindctl today --plain
remindctl today --quiet
```

Prefer JSON for structured processing. Limit the returned personal data to what is needed for the request.

## Manage lists

```bash
remindctl list
remindctl list Work
remindctl list Projects --create
remindctl list Work --delete
```

Creating or deleting a list changes the user's Reminders library. Verify the exact list name; confirm before deleting a list unless the user explicitly named that deletion.

## Create reminders

```bash
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting prep" --due "2026-02-15 09:00"
```

Resolve relative dates in the user's local timezone. Before creation, make sure the title, list, due date and time, and timezone are unambiguous. Do not invent a due time for a date-only request.

## Complete and delete

```bash
remindctl complete 1 2 3
remindctl delete 4A83 --force
```

First list or otherwise resolve each ID to its title and list. Completing and deleting are mutations; perform them only when the user requested them. Confirm immediately before a forced deletion if the exact target was not already explicit.

## Date formats

`--due` and date filters accept `today`, `tomorrow`, `yesterday`, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, and ISO 8601 timestamps. Use absolute dates in the final response when a relative date could be misunderstood.
