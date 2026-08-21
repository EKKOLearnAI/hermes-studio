---
date: 2026-08-18
feature: issue-2249-session-switch-composer-focus
pr: 2606
impact: Switching to another session puts the caret in the message box on desktop. No change on phones, and no change to scrolling, message loading, or what is sent.
---

# Issue #2249

Opening another session from the sidebar left focus wherever the click put it, so the first thing typed after switching went nowhere and the composer had to be clicked first.

`ChatInput` now exposes `focusComposer`, and the existing `activeSessionId` watcher in `ChatPanel` calls it after `nextTick`, before the fade animation's early return so it runs whether or not the animation surface exists. The guard on that watcher is unchanged: it still ignores a first session and a switch to the same id.

The composer decides when focus is appropriate rather than the caller: on a phone viewport it refuses, because taking focus there raises the on-screen keyboard over the conversation the user just opened.

The issue also asks for auto-scroll to the newest message on switch. That already exists — `applyInitialSessionScroll` in `MessageList` restores the remembered position for the session and scrolls to the bottom when the reader was last near it — so nothing there changed.
