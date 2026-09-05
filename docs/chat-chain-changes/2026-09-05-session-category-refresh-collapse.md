# Preserve manual category collapse during session refresh

The category reveal watcher now compares individual values instead of a newly
allocated array on every session-list update. Polling and foreground refreshes,
including refreshes that add visible categories, preserve manual collapse choices.
Initial category loading, active-session navigation, and changes to the active
session's category retain automatic reveal behavior. Recent shortcut suppression
continues to preserve its category's collapse state.

Browser regression coverage reproduces the polling failure and verifies foreground
refresh with a new category, persisted collapse state, and ordinary navigation.
