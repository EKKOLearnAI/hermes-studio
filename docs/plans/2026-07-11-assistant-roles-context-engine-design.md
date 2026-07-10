# Assistant Roles and Context Engine Design

**Date:** 2026-07-11

**Status:** Approved for implementation

**Roadmap scope:** Phase 2 of the Personal Digital Twin and Universal Action Fabric design

## Decision

Phase 2 adds a global Assistant Role Registry, explicit mappings from roles to Hermes Profiles, deterministic Context Recipes over the shared Personal Twin, runtime context injection, and a complete role-management UI.

Roles are global records in `<HERMES_HOME>/personal/twin.db`. Hermes Profiles remain runtime containers for models, credentials, skills, and processes. A mapping connects the two without copying Twin data into a Profile.

The first release ships five built-in role templates:

- Chief of Staff
- Health Manager
- Fitness Coach
- Home Manager
- Entertainment Assistant

Built-in roles cannot be deleted. Users may edit their mappings and scopes, disable them, or clone them into fully editable custom roles. Custom roles support create, edit, clone, enable/disable, and delete.

## Goals

- Keep one canonical Personal Twin while giving each assistant a bounded view.
- Separate role semantics from Hermes runtime configuration.
- Make data scopes, capability scopes, escalation rules, and context budgets explicit and inspectable.
- Build deterministic, provenance-preserving context from Twin facts.
- Inject role context into regular Hermes chat and scoped Coding Agent runs.
- Provide a complete management and preview UI in the existing Profiles surface.
- Preserve forward compatibility with the Phase 3 Capability Registry.

## Non-Goals

- Phase 2 does not execute external capabilities or treat prompt instructions as an authorization boundary.
- Phase 2 does not add durable workflows, spending transactions, payment execution, or emergency-stop enforcement.
- Phase 2 does not create per-role copies of Twin facts.
- Phase 2 does not replace Hermes Profile credentials, model settings, skills, or runtime isolation.
- Phase 2 does not add a separate role-specific memory database. It records a namespace identifier for later routing.

## Architecture

```text
Hermes Profile ── mapping ──> Assistant Role ── recipes ──> Context Engine
                                                              │
                                                              v
                                                        Personal Twin
                                                              │
                                                              v
                                               bounded Role Context Bundle
                                                              │
                                      ┌───────────────────────┴───────────────────────┐
                                      v                                               v
                                Hermes chat run                              Coding Agent run
```

The Context Engine is a read-only projection layer. It never mutates source facts while building context. It applies the role's data scope, the selected recipe, query text, item limits, and character budget before returning a bundle.

## Storage and Migration

The Personal Twin schema advances from version 1 to version 2. Migration remains sequential and idempotent for both fresh and existing databases.

### `twin_assistant_roles`

Required fields:

- `id`: stable slug for built-ins or generated ID for custom roles.
- `name`: user-facing name.
- `description`: short purpose statement.
- `persona`: trusted role instructions.
- `built_in`: deletion guard.
- `enabled`: whether runtime resolution may select the role.
- `data_scope_json`: allowed Twin domains and record classes.
- `capability_scope_json`: declared semantic capability allow/deny lists.
- `decision_authority_json`: advisory/approval boundary metadata.
- `spending_limits_json`: declarative limits reserved for Phase 3 enforcement.
- `memory_namespace`: stable future memory routing key.
- `escalation_rules_json`: conditions that require user escalation.
- `created_at`, `updated_at`.

### `twin_role_profile_mappings`

Required fields:

- `role_id`.
- `profile_name`.
- `is_primary`.
- `created_at`, `updated_at`.

The table supports multiple mappings for future reuse, while the Phase 2 UI exposes one primary Profile per role and one enabled primary role per Profile. Profile names are external references because Hermes Profiles live on disk. Missing Profile mappings are reported as stale rather than deleting roles.

### `twin_context_recipes`

Required fields:

- `id`.
- `role_id`.
- `name`.
- `description`.
- `built_in`.
- `enabled`.
- `domains_json`.
- `sections_json`.
- `query_template`.
- `limits_json`.
- `created_at`, `updated_at`.

Sections are restricted to a fixed allowlist such as subject, observations, events, goals, constraints, entities, and relations. Recipes cannot contain arbitrary SQL.

Built-in seed records use `INSERT ... ON CONFLICT DO NOTHING`, so application upgrades add missing templates without overwriting user adjustments.

## Role Model and Validation

Role IDs and memory namespaces use conservative slug validation. Names, descriptions, and personas have explicit maximum lengths. Domains use the fixed Personal Twin domain vocabulary. Limits are clamped to server-defined maxima.

Data scope contains:

- Allowed domains.
- Allowed record sections.
- Whether provenance metadata is included.

Capability scope contains semantic capability IDs only. In Phase 2 it is shown in the UI and included in trusted role instructions. Phase 3 must enforce it against the Capability Registry; it is not a security guarantee until that enforcement exists.

Built-in roles may be edited but not renamed by ID or deleted. Cloning always creates a custom role with new role and recipe IDs.

## Context Engine

The engine resolves a role in this order:

1. Explicit role ID supplied by an authorized internal caller.
2. Enabled primary role mapped to the selected Hermes Profile.
3. Enabled Chief of Staff built-in role.
4. No role context if no valid role exists.

For each enabled recipe, the engine intersects recipe domains and sections with the role data scope. It then queries the Personal Twin with filters applied before limits, preserving the Phase 1 bounded-query guarantees.

The output is a `RoleContextBundle` containing:

- Role identity and persona.
- Profile mapping information.
- Generated timestamp and input query.
- Structured context sections.
- Source record IDs and provenance summaries.
- Applied limits and truncation indicators.
- Deterministic rendered instructions for runtime injection.

Rendering uses stable section ordering and compact JSON. The output has both per-section item limits and a total character budget. Truncation occurs at record boundaries and is reported in metadata.

Context generation failures do not prevent a chat run. Runtime injection logs a sanitized warning and falls back to the base Hermes system prompt. The preview API returns validation or generation failures explicitly.

## Runtime Integration

Role context is composed with the existing Hermes system prompt at server-controlled boundaries. User input never becomes persona or policy text.

Integration points:

- Standard Hermes chat resolves the current request Profile and builds context using the latest user message as the optional query.
- Scoped Coding Agent runs resolve the session Profile and receive the same role instructions and bounded Twin context.
- Existing explicit run instructions remain after the base system prompt and role block, preserving caller behavior.

The injected block clearly separates:

- Role persona.
- Data context.
- Declared capability scope.
- Escalation rules.
- Provenance references.

The engine must not include database paths, credentials, raw secret values, or evidence blobs outside the role's allowed scope.

## HTTP API

All endpoints require authenticated access. Mutations require super-admin authorization.

- `GET /api/hermes/assistant-roles`
- `POST /api/hermes/assistant-roles`
- `GET /api/hermes/assistant-roles/:id`
- `PUT /api/hermes/assistant-roles/:id`
- `DELETE /api/hermes/assistant-roles/:id`
- `POST /api/hermes/assistant-roles/:id/clone`
- `PUT /api/hermes/assistant-roles/:id/profile-mapping`
- `POST /api/hermes/assistant-roles/:id/context/preview`

List and detail responses include mapping health and recipe summaries. The preview endpoint accepts query text and an optional recipe ID, then returns the structured bundle without starting an assistant run.

The API exposes no arbitrary SQL, raw database path, or generic Twin-write operation.

## Client and UI

The existing Profiles page becomes a two-tab surface:

- Runtime Profiles
- Assistant Roles

The Assistant Roles tab contains:

- Built-in and custom role cards.
- Enabled/disabled status and built-in badge.
- Primary Hermes Profile mapping and stale-mapping warning.
- Role editor for name, description, persona, data domains, allowed sections, capability IDs, decision authority, spending metadata, memory namespace, and escalation rules.
- Context Recipe editor with domain, section, item-limit, and character-budget controls.
- Context Preview drawer showing rendered sections, provenance IDs, and truncation metadata.
- Clone and custom-role delete actions with confirmation.

UI writes use optimistic loading states but refresh from the server after every mutation. Server validation errors remain authoritative and are shown without leaking internal paths.

## Profile Lifecycle

Profile rename updates role mappings after the runtime Profile rename succeeds. Profile deletion removes mappings but does not delete roles or recipes. External filesystem changes may leave stale mappings; listing roles marks them stale and lets the user remap them.

## Security

- Server-side scope intersection is mandatory; the client cannot expand a role's data scope through preview parameters.
- Mutation endpoints require super-admin authorization.
- Persona, recipe templates, and mapping values are treated as configuration, not user chat content.
- Capability scope is declarative in Phase 2 and must not be represented as enforced execution authorization.
- Context output is bounded and excludes credentials, file paths, and secret-bearing configuration.
- Built-in deletion and role-ID mutation are rejected server-side.

## Error Handling

- Invalid role or recipe input returns HTTP 400 with field-level-safe messages.
- Missing roles return 404.
- Built-in deletion returns 409.
- Missing mapped Profiles are represented as stale mappings; context resolution falls back safely.
- Schema migration is transactional and rejects future schema versions.
- Runtime context failures degrade to the base system prompt and produce sanitized diagnostics.

## Testing

Required coverage includes:

- Fresh schema v2 and v1-to-v2 migration.
- Idempotent built-in seeding without overwriting edits.
- Custom role CRUD, cloning, built-in deletion guard, and validation.
- Profile mapping resolution, rename, deletion, and stale detection.
- Recipe scope intersection and fixed-section validation.
- Query-before-limit behavior beyond 200 records.
- Deterministic rendering, provenance retention, and character-budget truncation.
- Chat and Coding Agent runtime injection plus safe fallback.
- Protected route ordering and super-admin mutation enforcement.
- Client API contracts and full role-management UI interactions.
- OpenAPI and Hermes MCP discovery.
- Existing Personal Twin, Profile, chat, and Coding Agent regressions.

## Acceptance Criteria

Phase 2 is complete when:

- Five built-in roles exist without overwriting user edits.
- Users can create, clone, edit, disable, map, preview, and delete custom roles from the Profiles UI.
- Built-in roles cannot be deleted.
- Every enabled role can resolve a bounded Context Recipe over the canonical Twin.
- Profile mapping controls which role context enters chat and Coding Agent runs.
- Context preserves provenance and reports truncation.
- Runtime context failures safely fall back to the base prompt.
- Capability permissions are clearly marked declarative pending Phase 3.
- OpenAPI, MCP hints, focused tests, source regressions, typechecks, and the full suite pass.
