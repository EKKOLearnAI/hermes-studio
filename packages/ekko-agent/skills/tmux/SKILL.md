---
name: tmux
description: "Control tmux sessions and panes for interactive CLIs: discover sessions, capture output, send keys, paste text, and monitor prompts."
metadata:
  keywords:
    - tmux session
    - tmux pane
    - interactive terminal
---

# tmux

Use for interactive commands that are already running in tmux or need a persistent terminal. Use normal terminal execution for one-shot commands.

## Prerequisite

```bash
command -v tmux
```

If the command is absent, tell the user that tmux must be installed; do not silently install it.

## Basics

```bash
tmux ls
tmux list-windows -t shared
tmux list-panes -t shared:0
tmux capture-pane -t shared:0.0 -p
tmux capture-pane -t shared:0.0 -p -S -
```

Targets use `session:window.pane`, for example `shared:0.0`.

## Send input

Send literal text and Enter separately:

```bash
tmux send-keys -t shared:0.0 -l -- "Please continue"
tmux send-keys -t shared:0.0 Enter
```

Special keys:

```bash
tmux send-keys -t shared:0.0 C-c
tmux send-keys -t shared:0.0 C-d
tmux send-keys -t shared:0.0 Escape
```

Use `-l --` for arbitrary text. Never approve a confirmation prompt until its target and consequences are understood.

## Sessions

```bash
tmux new-session -d -s worker
tmux rename-session -t old new
tmux kill-session -t worker
```

Killing a session is destructive. Do it only when the user requested that outcome or the session was created solely for the current task and is no longer needed.

## Helpers

`skill_view` returns this Skill's `baseDirectory`. Use it to run:

- `<baseDirectory>/scripts/find-sessions.sh` to discover sessions, including custom socket paths.
- `<baseDirectory>/scripts/wait-for-text.sh` to wait until pane output contains a pattern.

`capture-pane -p` writes to stdout, `-S -` includes full scrollback, and tmux sessions persist across SSH disconnects.
