# Assistant Roles and Context Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver Phase 2 Assistant Roles, Hermes Profile mappings, bounded Context Recipes, runtime context injection, and a complete role-management UI.

**Architecture:** Store global roles, mappings, and recipes in Personal Twin schema v2. Resolve a role from the selected Hermes Profile, build a deterministic and bounded context bundle from the canonical Twin, and inject its rendered instructions at server-controlled chat and Coding Agent boundaries. Expose protected REST/client APIs and embed the management UI as a second tab on the existing Profiles page.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Koa, Vue 3, Pinia, Naive UI, Vitest, OpenAPI generator.

---

## Execution Rules

- Use `@superpowers:test-driven-development` for every behavior change.
- Use `@superpowers:systematic-debugging` for any unexpected test failure.
- Use `@superpowers:verification-before-completion` before every completion claim.
- Use `@superpowers:requesting-code-review` after Tasks 5 and 9 and before final handoff.
- Preserve all unrelated dirty Health/UI/auth files. Stage only the files listed by each task.
- Do not expose capability scope as enforced authorization; Phase 3 owns execution enforcement.
- Do not add arbitrary SQL, arbitrary Twin writes, or secret-bearing context output.

## Task 1: Personal Twin Schema v2 and Role Types

**Files:**

- Modify: `packages/server/src/services/hermes/personal-twin/database.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/types.ts`
- Modify: `tests/server/personal-twin-database.test.ts`

### Step 1: Write failing schema migration tests

Extend `tests/server/personal-twin-database.test.ts` with:

```ts
it('migrates an existing v1 database to role schema v2 without losing twin rows', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { getPersonalTwinDbPath, initPersonalTwinSchema } = await import('../../packages/server/src/services/hermes/personal-twin')
  const db = new DatabaseSync(getPersonalTwinDbPath())
  initPersonalTwinSchema(db)
  db.prepare(`INSERT INTO twin_entities (id, type, label, attributes_json, source, source_id, created_at, updated_at)
    VALUES ('person:self', 'person', 'Self', '{}', 'system', 'self', ?, ?)`)
    .run('2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  db.prepare("UPDATE twin_meta SET value = '1' WHERE key = 'schema_version'").run()

  initPersonalTwinSchema(db)

  expect(db.prepare("SELECT value FROM twin_meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' })
  expect(db.prepare("SELECT id FROM twin_entities WHERE id = 'person:self'").get()).toEqual({ id: 'person:self' })
  expect(new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name)))
    .toEqual(expect.objectContaining(new Set([
      'twin_assistant_roles', 'twin_role_profile_mappings', 'twin_context_recipes',
    ])))
  db.close()
})
```

Also update the future-version test to reject version `3`.

### Step 2: Run the test and verify it fails

Run:

```bash
npx vitest run tests/server/personal-twin-database.test.ts --reporter=verbose
```

Expected: FAIL because schema version is still 1 and role tables do not exist.

### Step 3: Add Phase 2 types

Add strict types to `types.ts`:

```ts
export const TWIN_DOMAINS = [
  'body', 'health', 'fitness', 'nutrition', 'home', 'life', 'work',
  'entertainment', 'commerce', 'digital',
] as const
export type TwinDomain = typeof TWIN_DOMAINS[number]

export const TWIN_CONTEXT_SECTIONS = [
  'subject', 'observations', 'events', 'goals', 'constraints', 'entities', 'relations',
] as const
export type TwinContextSection = typeof TWIN_CONTEXT_SECTIONS[number]

export interface AssistantRoleDataScope {
  domains: TwinDomain[]
  sections: TwinContextSection[]
  includeProvenance: boolean
}

export interface AssistantRoleCapabilityScope {
  allow: string[]
  deny: string[]
  enforcement: 'declarative_phase_2'
}

export interface AssistantRole {
  id: string
  name: string
  description: string
  persona: string
  builtIn: boolean
  enabled: boolean
  dataScope: AssistantRoleDataScope
  capabilityScope: AssistantRoleCapabilityScope
  decisionAuthority: Record<string, unknown>
  spendingLimits: Record<string, unknown>
  memoryNamespace: string
  escalationRules: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface ContextRecipe {
  id: string
  roleId: string
  name: string
  description: string
  builtIn: boolean
  enabled: boolean
  domains: TwinDomain[]
  sections: TwinContextSection[]
  queryTemplate: string
  limits: { perSection: number; totalCharacters: number }
  createdAt: string
  updatedAt: string
}
```

Add input, mapping, summary, and `RoleContextBundle` interfaces alongside these types.

### Step 4: Implement sequential schema migration

Set `SCHEMA_VERSION = 2`. Refactor `initPersonalTwinSchema()` so version 0 runs v1 then v2, while version 1 runs only v2.

Create v2 tables with foreign keys and cascades:

```sql
CREATE TABLE IF NOT EXISTS twin_assistant_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL,
  built_in INTEGER NOT NULL CHECK(built_in IN (0,1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  data_scope_json TEXT NOT NULL,
  capability_scope_json TEXT NOT NULL,
  decision_authority_json TEXT NOT NULL DEFAULT '{}',
  spending_limits_json TEXT NOT NULL DEFAULT '{}',
  memory_namespace TEXT NOT NULL UNIQUE,
  escalation_rules_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_role_profile_mappings (
  role_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(role_id, profile_name),
  FOREIGN KEY(role_id) REFERENCES twin_assistant_roles(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twin_role_primary_profile
ON twin_role_profile_mappings(profile_name) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS twin_context_recipes (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  built_in INTEGER NOT NULL CHECK(built_in IN (0,1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  domains_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  query_template TEXT NOT NULL DEFAULT '',
  limits_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(role_id, name),
  FOREIGN KEY(role_id) REFERENCES twin_assistant_roles(id) ON DELETE CASCADE
);
```

Include all three tables in `REQUIRED_TWIN_TABLES`.

### Step 5: Run tests and typecheck

Run:

```bash
npx vitest run tests/server/personal-twin-database.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

### Step 6: Commit

```bash
git add packages/server/src/services/hermes/personal-twin/database.ts packages/server/src/services/hermes/personal-twin/types.ts tests/server/personal-twin-database.test.ts
git commit -m "feat: add assistant role schema"
```

## Task 2: Role Registry, Built-ins, and CRUD

**Files:**

- Create: `packages/server/src/services/hermes/personal-twin/assistant-roles.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/index.ts`
- Create: `tests/server/assistant-roles-store.test.ts`

### Step 1: Write failing role-store tests

Cover:

- Five built-ins seed exactly once.
- A built-in edit survives another seed call.
- Built-ins cannot be deleted.
- Custom role create/update/delete.
- Clone creates a custom role and cloned recipes.
- Invalid domains, sections, slugs, duplicate namespaces, and oversized persona fail.

Representative test:

```ts
it('seeds built-ins without overwriting edits and clones them as custom roles', async () => {
  const roles = await import('../../packages/server/src/services/hermes/personal-twin')
  expect(roles.listAssistantRoles().map(role => role.id)).toEqual([
    'chief-of-staff', 'entertainment-assistant', 'fitness-coach', 'health-manager', 'home-manager',
  ])
  roles.updateAssistantRole('health-manager', { description: 'My health lead' })
  roles.ensureBuiltInAssistantRoles()
  expect(roles.getAssistantRole('health-manager')?.description).toBe('My health lead')

  const clone = roles.cloneAssistantRole('health-manager', { name: 'Recovery Coach' })
  expect(clone).toMatchObject({ builtIn: false, name: 'Recovery Coach' })
  expect(() => roles.deleteAssistantRole('health-manager')).toThrow(/built-in/i)
})
```

### Step 2: Run the test and verify it fails

```bash
npx vitest run tests/server/assistant-roles-store.test.ts --reporter=verbose
```

Expected: FAIL because the module does not exist.

### Step 3: Implement validation and row mapping

Use explicit snake_case row interfaces and JSON mappers. Add:

```ts
const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_.:-]{1,127}$/

function validateRoleInput(input: AssistantRoleInput): void {
  // Validate strings, fixed domains/sections, unique arrays, length caps,
  // semantic capability IDs, and JSON-safe values.
}
```

Keep server caps in named constants: persona 12,000 characters, description 500, at most 64 capability IDs, and at most 32 escalation rules.

### Step 4: Seed built-in roles idempotently

Define complete built-in templates and one default recipe per role. Use `ON CONFLICT(id) DO NOTHING`; never update an existing built-in row during seeding.

Default scopes:

- Chief of Staff: all domains, all read sections.
- Health Manager: body, health, nutrition, fitness.
- Fitness Coach: body, fitness, nutrition, health.
- Home Manager: home and digital.
- Entertainment Assistant: entertainment, life, commerce.

All capability scopes use `enforcement: 'declarative_phase_2'`.

### Step 5: Implement CRUD and cloning

Export:

```ts
ensureBuiltInAssistantRoles(): void
listAssistantRoles(): AssistantRole[]
getAssistantRole(id: string): AssistantRole | null
createAssistantRole(input: AssistantRoleInput): AssistantRole
updateAssistantRole(id: string, patch: AssistantRolePatch): AssistantRole
deleteAssistantRole(id: string): void
cloneAssistantRole(id: string, input: { name: string; id?: string }): AssistantRole
```

Create/clone/delete role and recipes in a single `BEGIN IMMEDIATE` transaction. Reject ID changes through update.

### Step 6: Run tests and typecheck

```bash
npx vitest run tests/server/assistant-roles-store.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

### Step 7: Commit

```bash
git add packages/server/src/services/hermes/personal-twin/assistant-roles.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/assistant-roles-store.test.ts
git commit -m "feat: add assistant role registry"
```

## Task 3: Profile Mappings and Context Recipe Store

**Files:**

- Modify: `packages/server/src/services/hermes/personal-twin/assistant-roles.ts`
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
- Create: `tests/server/assistant-role-mappings.test.ts`
- Modify: `tests/server/profiles-controller.test.ts`

### Step 1: Write failing mapping and recipe tests

Cover:

- Setting a primary mapping replaces another role's primary mapping for that Profile.
- Role resolution returns the enabled mapped role, then Chief of Staff fallback.
- Missing on-disk Profile is marked stale.
- Profile rename updates mappings.
- Profile delete removes mappings without deleting roles.
- Recipe CRUD validates domains, sections, and bounded limits.

```ts
it('resolves one enabled primary role per profile and reports stale mappings', async () => {
  const roles = await import('../../packages/server/src/services/hermes/personal-twin')
  roles.setAssistantRoleProfileMapping('health-manager', 'coach')
  expect(roles.resolveAssistantRoleForProfile('coach')?.id).toBe('health-manager')
  expect(roles.listAssistantRolesWithMappings()).toContainEqual(expect.objectContaining({
    id: 'health-manager',
    mapping: expect.objectContaining({ profileName: 'coach', stale: true }),
  }))
})
```

### Step 2: Run tests and verify failure

```bash
npx vitest run tests/server/assistant-role-mappings.test.ts tests/server/profiles-controller.test.ts --reporter=verbose
```

Expected: FAIL because mapping/recipe functions do not exist.

### Step 3: Implement mappings

Export:

```ts
setAssistantRoleProfileMapping(roleId: string, profileName: string | null): AssistantRoleProfileMapping | null
resolveAssistantRoleForProfile(profileName: string): AssistantRole | null
renameAssistantRoleProfileMappings(oldName: string, newName: string): void
removeAssistantRoleProfileMappings(profileName: string): void
listAssistantRolesWithMappings(): AssistantRoleSummary[]
```

Use one transaction to clear an existing primary mapping for a Profile and insert the new mapping. Normalize Profile names but preserve case-sensitive on-disk names returned by the Profile service.

### Step 4: Implement recipe CRUD

Export:

```ts
listContextRecipes(roleId: string): ContextRecipe[]
createContextRecipe(roleId: string, input: ContextRecipeInput): ContextRecipe
updateContextRecipe(roleId: string, recipeId: string, patch: ContextRecipePatch): ContextRecipe
deleteContextRecipe(roleId: string, recipeId: string): void
```

Clamp `perSection` to 1..50 and `totalCharacters` to 1,000..40,000. Reject arbitrary sections and domains.

### Step 5: Integrate Profile lifecycle

Call `renameAssistantRoleProfileMappings()` only after Profile rename succeeds. Call `removeAssistantRoleProfileMappings()` only after Profile deletion succeeds. Mapping cleanup failure must log a sanitized warning and not pretend the Profile operation failed after it has already completed.

### Step 6: Run tests and typecheck

```bash
npx vitest run tests/server/assistant-role-mappings.test.ts tests/server/profiles-controller.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

### Step 7: Commit

```bash
git add packages/server/src/services/hermes/personal-twin/assistant-roles.ts packages/server/src/controllers/hermes/profiles.ts tests/server/assistant-role-mappings.test.ts tests/server/profiles-controller.test.ts
git commit -m "feat: map assistant roles to profiles"
```

## Task 4: Deterministic Context Engine

**Files:**

- Create: `packages/server/src/services/hermes/personal-twin/role-context.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/index.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/store.ts`
- Create: `tests/server/assistant-role-context.test.ts`

### Step 1: Write failing context-engine tests

Cover:

- Recipe domains/sections are intersected with role scope.
- Matching record after 200 unrelated records is still returned.
- Percent and underscore are escaped literally.
- Provenance is included only when allowed.
- Rendering is deterministic.
- Total character budget truncates at record boundaries and reports it.
- Missing/stale Profile mapping falls back to Chief of Staff.
- Context contains no credential or database path fields.

```ts
it('intersects scopes and filters before limits while preserving provenance', async () => {
  // Insert one old body match and 200 newer digital records.
  const bundle = buildRoleContextForProfile('coach', {
    query: 'needle%_literal',
    recipeId: 'health-manager-default',
  })
  expect(bundle.sections.observations).toEqual([
    expect.objectContaining({ metric: 'body.deep_match', value: 'needle%_literal' }),
  ])
  expect(bundle.appliedScope.domains).toEqual(expect.arrayContaining(['body', 'health']))
})
```

### Step 2: Run test and verify failure

```bash
npx vitest run tests/server/assistant-role-context.test.ts --reporter=verbose
```

Expected: FAIL because the engine does not exist.

### Step 3: Add bounded store queries

Add fixed-filter helpers for goals, constraints, entities, and relations similar to Phase 1 observation/event query-before-limit behavior. Accept only validated domains, sections, query text, and limit values. Never accept SQL fragments.

### Step 4: Build structured bundles

Implement:

```ts
buildRoleContext(roleId: string, options?: RoleContextOptions): RoleContextBundle
buildRoleContextForProfile(profileName: string, options?: RoleContextOptions): RoleContextBundle | null
renderRoleContext(bundle: RoleContextBundle): string
```

Use stable section order:

```ts
const SECTION_ORDER: TwinContextSection[] = [
  'subject', 'goals', 'constraints', 'observations', 'events', 'entities', 'relations',
]
```

Apply the character budget by serializing one record at a time. Set `truncated.sections[section] = true` when a record cannot fit. Include source record IDs separately from rendered data.

### Step 5: Add safe runtime wrapper

Implement a wrapper that catches context generation errors, logs only role/profile/error class, and returns an empty string. The preview path must call the strict builder and surface errors.

### Step 6: Run tests and typecheck

```bash
npx vitest run tests/server/assistant-role-context.test.ts tests/server/personal-twin-projectors.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

### Step 7: Commit

```bash
git add packages/server/src/services/hermes/personal-twin/role-context.ts packages/server/src/services/hermes/personal-twin/index.ts packages/server/src/services/hermes/personal-twin/store.ts tests/server/assistant-role-context.test.ts
git commit -m "feat: build role scoped twin context"
```

## Task 5: Chat and Coding Agent Runtime Injection

**Files:**

- Modify: `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts`
- Modify: `packages/server/src/services/hermes/run-chat/handle-coding-agent-run.ts`
- Modify: `tests/server/run-chat-bridge-final-context.test.ts`
- Modify: `tests/server/handle-coding-agent-run.test.ts`
- Create: `tests/server/assistant-role-runtime-context.test.ts`

### Step 1: Write failing runtime tests

Mock `buildSafeRoleContextInstructionsForProfile()` and assert:

- Bridge chat calls it with the selected Profile and normalized user input.
- Returned role context appears once in final instructions.
- Coding Agent input gets the same role context.
- Empty/failing context falls back to the existing base prompt.
- User-supplied instructions cannot replace the role persona block.

```ts
expect(buildSafeRoleContextInstructionsForProfileMock).toHaveBeenCalledWith('coach', {
  query: 'How should I train today?',
})
expect(bridge.run).toHaveBeenCalledWith(expect.objectContaining({
  instructions: expect.stringContaining('Assistant Role Context'),
}))
```

### Step 2: Run tests and verify failure

```bash
npx vitest run tests/server/assistant-role-runtime-context.test.ts tests/server/run-chat-bridge-final-context.test.ts tests/server/handle-coding-agent-run.test.ts --reporter=verbose
```

Expected: FAIL because role context is not requested or injected.

### Step 3: Inject at server-controlled boundaries

In both handlers:

1. Convert content blocks to bounded plain query text.
2. Build safe role instructions using the resolved Profile.
3. Compose in this order: base Hermes prompt, role context, caller instructions.
4. Keep existing workspace/profile guidance.

Do not accept a client role ID in socket payloads during Phase 2.

### Step 4: Run focused runtime regressions

```bash
npx vitest run tests/server/assistant-role-runtime-context.test.ts tests/server/run-chat-bridge-final-context.test.ts tests/server/handle-coding-agent-run.test.ts tests/server/run-chat-bridge-resume.test.ts --reporter=dot
```

Expected: PASS.

### Step 5: Typecheck and request review

```bash
npx tsc --noEmit -p packages/server/tsconfig.json
```

Use `@superpowers:requesting-code-review` for Tasks 1-5. Fix all Critical and Important findings before continuing.

### Step 6: Commit

```bash
git add packages/server/src/services/hermes/run-chat/handle-bridge-run.ts packages/server/src/services/hermes/run-chat/handle-coding-agent-run.ts tests/server/run-chat-bridge-final-context.test.ts tests/server/handle-coding-agent-run.test.ts tests/server/assistant-role-runtime-context.test.ts
git commit -m "feat: inject assistant role context"
```

## Task 6: Protected Assistant Role HTTP API

**Files:**

- Create: `packages/server/src/controllers/hermes/assistant-roles.ts`
- Create: `packages/server/src/routes/hermes/assistant-roles.ts`
- Modify: `packages/server/src/routes/index.ts`
- Create: `tests/server/assistant-roles-controller.test.ts`
- Create: `tests/server/assistant-roles-routes.test.ts`

### Step 1: Write failing controller tests

Test list, detail, create, update, delete, clone, mapping, and preview delegation. Verify malformed bodies return 400 and service errors do not leak database paths.

### Step 2: Write failing route tests

Assert exactly these protected paths and methods:

```text
GET    /api/hermes/assistant-roles
POST   /api/hermes/assistant-roles
GET    /api/hermes/assistant-roles/:id
PUT    /api/hermes/assistant-roles/:id
DELETE /api/hermes/assistant-roles/:id
POST   /api/hermes/assistant-roles/:id/clone
PUT    /api/hermes/assistant-roles/:id/profile-mapping
POST   /api/hermes/assistant-roles/:id/context/preview
```

Assert mutation handlers include `requireSuperAdmin`, and the router is mounted after global auth middleware.

### Step 3: Run tests and verify failure

```bash
npx vitest run tests/server/assistant-roles-controller.test.ts tests/server/assistant-roles-routes.test.ts --reporter=verbose
```

Expected: FAIL because controllers/routes do not exist.

### Step 4: Implement controllers

Use explicit parsers for:

- Required strings.
- Optional booleans and bounded integers.
- Fixed string arrays.
- JSON objects/arrays.

Return 404 for missing roles, 409 for built-in deletion, and 400 for validation. Preview returns the strict `RoleContextBundle`.

### Step 5: Register protected routes

Create one router and mount it after authentication in `routes/index.ts`.

### Step 6: Run tests and typecheck

```bash
npx vitest run tests/server/assistant-roles-controller.test.ts tests/server/assistant-roles-routes.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: PASS.

### Step 7: Commit

```bash
git add packages/server/src/controllers/hermes/assistant-roles.ts packages/server/src/routes/hermes/assistant-roles.ts packages/server/src/routes/index.ts tests/server/assistant-roles-controller.test.ts tests/server/assistant-roles-routes.test.ts
git commit -m "feat: expose assistant role api"
```

## Task 7: Client API and Pinia Store

**Files:**

- Create: `packages/client/src/api/hermes/assistant-roles.ts`
- Create: `packages/client/src/stores/hermes/assistant-roles.ts`
- Create: `tests/client/assistant-roles-api.test.ts`
- Create: `tests/client/assistant-roles-store.test.ts`

### Step 1: Write failing client API tests

Cover every endpoint, URL encoding, JSON methods, and response unwrapping. Ensure the client exposes typed role/recipe/context contracts but no arbitrary Twin write method.

### Step 2: Run and verify failure

```bash
npx vitest run tests/client/assistant-roles-api.test.ts tests/client/assistant-roles-store.test.ts --reporter=verbose
```

Expected: FAIL because modules do not exist.

### Step 3: Implement typed API

Export functions:

```ts
fetchAssistantRoles()
fetchAssistantRole(id)
createAssistantRole(input)
updateAssistantRole(id, patch)
deleteAssistantRole(id)
cloneAssistantRole(id, input)
updateAssistantRoleProfileMapping(id, profileName)
previewAssistantRoleContext(id, input)
```

### Step 4: Implement store

State:

- `roles`
- `selectedRoleId`
- `loading`
- `saving`
- `preview`
- `error`

After each mutation, refresh the affected role/list from the server. Do not treat optimistic state as authoritative.

### Step 5: Run tests and client typecheck

```bash
npx vitest run tests/client/assistant-roles-api.test.ts tests/client/assistant-roles-store.test.ts --reporter=dot
npx vue-tsc -b
```

Expected: PASS.

### Step 6: Commit

```bash
git add packages/client/src/api/hermes/assistant-roles.ts packages/client/src/stores/hermes/assistant-roles.ts tests/client/assistant-roles-api.test.ts tests/client/assistant-roles-store.test.ts
git commit -m "feat: add assistant role client state"
```

## Task 8: Complete Role Management UI

**Files:**

- Create: `packages/client/src/components/hermes/profiles/AssistantRolesPanel.vue`
- Create: `packages/client/src/components/hermes/profiles/AssistantRoleEditor.vue`
- Create: `packages/client/src/components/hermes/profiles/AssistantRolePreviewDrawer.vue`
- Create: `packages/client/src/components/hermes/profiles/assistant-role-messages.ts`
- Modify: `packages/client/src/views/hermes/ProfilesView.vue`
- Create: `tests/client/assistant-roles-panel.test.ts`
- Create: `tests/client/assistant-role-editor.test.ts`
- Modify: `tests/client/profiles-view.test.ts`

### Step 1: Write failing UI tests

Cover:

- Profiles page shows Runtime Profiles and Assistant Roles tabs.
- Built-in badges and delete guard.
- Create, clone, edit, enable/disable, map, and delete custom roles.
- Domain/section selection and declarative capability warning.
- Recipe editing and bounded numeric controls.
- Preview drawer shows sections, provenance IDs, and truncation warning.
- Stale Profile mapping warning.
- Loading, validation error, empty, and retry states.

### Step 2: Run and verify failure

```bash
npx vitest run tests/client/assistant-roles-panel.test.ts tests/client/assistant-role-editor.test.ts tests/client/profiles-view.test.ts --reporter=verbose
```

Expected: FAIL because components/tab do not exist.

### Step 3: Add feature-local messages

Because global locale files contain unrelated worktree changes, create a feature-local typed message table for English and Chinese. Select by the current `vue-i18n` locale and fall back to English. Do not stage unrelated locale files.

### Step 4: Build the roles panel

Use Naive UI cards/list, badges, select, switch, buttons, alerts, and confirmation dialogs. Keep selection stable after refresh. Display the Phase 2 warning:

```text
Capability permissions are declarative until Action Fabric enforcement is enabled in Phase 3.
```

### Step 5: Build editor and preview

Use a drawer or modal with grouped sections:

- Identity and persona.
- Profile mapping.
- Data scope.
- Capability declaration.
- Decision/escalation metadata.
- Context recipes.

Preview is read-only and renders the server bundle, not a client-side reconstruction.

### Step 6: Add Profiles tabs

Wrap the existing runtime profile controls and `ProfilesPanel` in the Runtime Profiles tab. Mount `AssistantRolesPanel` in the second tab. Preserve all existing profile events and modals.

### Step 7: Run UI tests and typecheck

```bash
npx vitest run tests/client/assistant-roles-panel.test.ts tests/client/assistant-role-editor.test.ts tests/client/profiles-view.test.ts --reporter=dot
npx vue-tsc -b
```

Expected: PASS.

### Step 8: Commit

```bash
git add packages/client/src/components/hermes/profiles/AssistantRolesPanel.vue packages/client/src/components/hermes/profiles/AssistantRoleEditor.vue packages/client/src/components/hermes/profiles/AssistantRolePreviewDrawer.vue packages/client/src/components/hermes/profiles/assistant-role-messages.ts packages/client/src/views/hermes/ProfilesView.vue tests/client/assistant-roles-panel.test.ts tests/client/assistant-role-editor.test.ts tests/client/profiles-view.test.ts
git commit -m "feat: add assistant role management ui"
```

## Task 9: OpenAPI and Hermes MCP Discovery

**Files:**

- Modify: `scripts/generate-openapi.mjs`
- Modify: `bin/hermes-web-ui-mcp.mjs`
- Modify: `tests/server/api-docs-controller.test.ts`
- Modify: `docs/openapi.json`

### Step 1: Add failing API docs assertions

Assert all eight Assistant Role paths, body schemas for role scope/mapping/preview, path parameters, and Personal Twin/Assistant Roles tags.

### Step 2: Run test and verify failure

```bash
npx vitest run tests/server/api-docs-controller.test.ts --reporter=verbose
```

Expected: FAIL because paths/tag/hints are missing.

### Step 3: Update OpenAPI generation and MCP hints

Add route tag mapping for `routes/hermes/assistant-roles.ts`. Improve schema inference only where needed by the typed controller; do not hard-code the entire document.

Add concise MCP discovery hints describing role list, mapping, and context preview. Do not advertise capability permissions as enforced execution authorization.

### Step 4: Generate and verify

```bash
npm run openapi:generate
npx vitest run tests/server/api-docs-controller.test.ts tests/server/llm-prompt.test.ts --reporter=dot
git diff --check
```

Expected: OpenAPI generation reports endpoints/tags and tests PASS.

If unrelated dirty auth sources alter generated output, generate from a temporary clean detached worktree with the Phase 2 generator/route/controller files applied, then copy only the deterministic `docs/openapi.json` result.

### Step 5: Request code review

Use `@superpowers:requesting-code-review` for Tasks 6-9. Fix all Critical and Important findings.

### Step 6: Commit

```bash
git add scripts/generate-openapi.mjs bin/hermes-web-ui-mcp.mjs tests/server/api-docs-controller.test.ts docs/openapi.json
git commit -m "docs: expose assistant role operations"
```

## Task 10: Full Phase 2 Verification and Handoff

**Files:**

- Verify all Phase 2 files.
- Do not modify unrelated dirty files to make verification easier.

### Step 1: Run focused Phase 2 suite

```bash
npx vitest run \
  tests/server/personal-twin-database.test.ts \
  tests/server/assistant-roles-store.test.ts \
  tests/server/assistant-role-mappings.test.ts \
  tests/server/assistant-role-context.test.ts \
  tests/server/assistant-role-runtime-context.test.ts \
  tests/server/assistant-roles-controller.test.ts \
  tests/server/assistant-roles-routes.test.ts \
  tests/client/assistant-roles-api.test.ts \
  tests/client/assistant-roles-store.test.ts \
  tests/client/assistant-roles-panel.test.ts \
  tests/client/assistant-role-editor.test.ts \
  tests/client/profiles-view.test.ts \
  tests/server/api-docs-controller.test.ts \
  --reporter=dot
```

Expected: PASS.

### Step 2: Run source regressions

```bash
npx vitest run \
  tests/server/personal-twin-store.test.ts \
  tests/server/personal-twin-projectors.test.ts \
  tests/server/personal-twin-import.test.ts \
  tests/server/profiles-controller.test.ts \
  tests/server/run-chat-bridge-final-context.test.ts \
  tests/server/handle-coding-agent-run.test.ts \
  tests/client/profiles-api.test.ts \
  --reporter=dot
```

Expected: PASS.

### Step 3: Run typechecks and harness

```bash
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
npm run harness:check
```

Expected: all exit 0.

### Step 4: Run full suite

```bash
npm test -- --reporter=dot
```

Expected: every test file passes; only documented platform skips remain.

### Step 5: Verify generated docs and worktree scope

```bash
npm run openapi:generate
git diff --check
git status --short
git log --oneline --max-count=15
```

Expected:

- Generated OpenAPI is deterministic.
- Phase 2 commits contain only explicitly staged files.
- Existing unrelated Health/UI/auth changes remain present and unstaged.
- No database, credential, log, cache, or temporary file is tracked.

### Step 6: Final review

Use `@superpowers:requesting-code-review` over the complete Phase 2 commit range. Fix Critical and Important findings, rerun affected tests, then repeat Steps 3-5.

### Step 7: Completion definition

Report exact evidence that:

- Five built-in roles seed without overwriting edits.
- Built-in and custom lifecycle rules work.
- Profile mapping resolves runtime role context.
- Context scope intersection, provenance, query-before-limit, and budgets work.
- Chat and Coding Agent paths inject context with safe fallback.
- Full role-management UI workflows pass.
- Capability permissions are visibly declarative pending Phase 3.
- OpenAPI/MCP, focused tests, regressions, typechecks, harness, and full suite pass.

Do not claim Phase 3 Action Fabric enforcement is implemented.
