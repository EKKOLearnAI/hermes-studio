# ADR-009 Amendment: Updates UX Model

> Status: accepted for the ADR-009 / PR #1046 branch.
>
> Scope: this note documents the simplified Updates model for the current singleton preview iteration.

## Summary

The Updates surface has two primary cards only:

- Stable
- Preview

The Preview card represents a single candidate build served at `/preview/`.

## Definitions

### Stable

Stable is the production Web UI served at `/`.
It is the default user-facing environment and the promotion target for a preview.

### Preview

Preview is the single candidate build served at `/preview/`.
This iteration is explicitly singleton-only: there is one preview slot, not a list of preview environments.

### Preview Source

Preview Source is the origin of the singleton preview build.
The default source is Release.
Branch and Commit sources are available only when Dev Mode is enabled.

### Dev Mode

Dev Mode is not a separate page, section, or card.
It is an expansion of the Preview source chooser that reveals Branch and Commit options.

## Promotion flow

The promotion action is Preview → Stable.
That is the primary update path for this iteration.

## Out of scope for this iteration

- Multi-preview management
- Any `/preview/:name` or similar multi-slot routing model
- Advanced update dashboards
- Recovery dashboards

These ideas may exist as future scale-out options, but they are intentionally not part of the current UX model.

## Future scaling note

If the product later needs more than one preview environment, the likely direction is a namespaced preview path such as `/preview/:name` or an equivalent slot model.
That future model is not implemented or implied by this note.

## Product constraint

The Updates page must stay conceptually simple:

- one Stable card
- one Preview card
- Preview Source expands to Branch/Commit only in Dev Mode
- no separate Advanced or Recovery surface in the main flow

This note exists to prevent the UI from drifting back toward the older Stable / Preview / Branch Preview / Advanced / Recovery dashboard split.
