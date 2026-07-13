# Health Closed-Loop Kernel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Phase 4 eight-domain health loop from automatic ingestion through Personal Twin projections, risk-graded intervention, Action Fabric shadow/live execution, and outcome-driven strategy updates.

**Architecture:** Add a `health-loop` service family inside the existing server modular monolith. All normalized health facts go to Personal Twin, all side effects go through Action Fabric, and existing `health_state.db`, S400, Personal Autopilot, and Weixin reminder code remains available as compatibility input until parity is verified.

**Tech Stack:** TypeScript 6, Node.js 23+, Koa, `node:sqlite`, Vue 3 Composition API, Pinia, Naive UI, Vitest, Three.js, existing Hermes Agent auxiliary vision configuration, existing OpenAPI generator.

---

## Execution Rules

- Use @superpowers:test-driven-development for every production-code task.
- Use @superpowers:systematic-debugging for every unexpected failure.
- Preserve unrelated auth, credential prompt, account settings, and user-auth changes in the dirty worktree.
- Never stage with `git add .` or `git add -A`; stage only the exact files listed for the current task.
- Existing uncommitted Health/S400/Body3D/Fitness work is approved Phase 4 input, but it must pass the baseline checkpoint before it is committed.
- Do not send real Weixin reminders during development. All automated tests use fakes; manual validation starts in shadow mode.
- Do not use real health photos, reports, credentials, or messages in fixtures.
- Use stable error codes and sanitized DTOs. Never expose raw SQLite, filesystem, provider, credential, parser, or model errors.

### Task 1: Reconcile and Freeze the Approved Health Baseline

**Files:**
- Inspect: `packages/client/src/App.vue`
- Inspect: `packages/client/src/api/client.ts`
- Inspect: `packages/client/src/api/hermes/health-state.ts`
- Inspect: `packages/client/src/components/layout/AppSidebar.vue`
- Inspect: `packages/client/src/i18n/locales/en.ts`
- Inspect: `packages/client/src/i18n/locales/zh.ts`
- Inspect: `packages/client/src/router/index.ts`
- Inspect: `packages/client/src/views/hermes/DevicesView.vue`
- Inspect: `packages/client/src/views/hermes/FitnessView.vue`
- Inspect: `packages/client/src/views/hermes/HealthView.vue`
- Inspect: `packages/client/src/views/hermes/PersonalOSView.vue`
- Inspect: `packages/client/src/views/hermes/SettingsView.vue`
- Inspect: `packages/client/src/views/hermes/health/HealthBody3DViewer.vue`
- Inspect: `packages/client/src/components/hermes/settings/XiaomiHealthSettings.vue`
- Inspect: `packages/server/src/controllers/hermes/health-state.ts`
- Inspect: `packages/server/src/routes/hermes/health-state.ts`
- Inspect: `packages/server/src/services/hermes/health-state.ts`
- Inspect: `packages/server/src/services/hermes/scale-sync.ts`
- Test: `tests/client/devices-view.test.ts`
- Test: `tests/client/fitness-view.test.ts`
- Test: `tests/client/health-body-3d-viewer.test.ts`
- Test: `tests/client/health-state-api.test.ts`
- Test: `tests/client/health-view.test.ts`
- Test: `tests/client/personal-os-view.test.ts`
- Test: `tests/client/xiaomi-health-settings.test.ts`
- Test: `tests/server/health-state-controller.test.ts`
- Test: `tests/server/health-state-routes.test.ts`
- Test: `tests/server/health-state-service.test.ts`
- Test: `tests/server/scale-sync-service.test.ts`

**Step 1: Record the ownership boundary**

Run:

```powershell
git status --short
git diff --stat
git diff -- packages/server/src/controllers/auth.ts packages/server/src/middleware/user-auth.ts packages/client/src/components/auth/DefaultCredentialPrompt.vue
```

Expected: the auth-related files remain identified as unrelated and must not enter a health commit.

**Step 2: Run the approved health baseline**

Run:

```powershell
npx vitest run tests/server/health-state-service.test.ts tests/server/health-state-controller.test.ts tests/server/health-state-routes.test.ts tests/server/scale-sync-service.test.ts tests/client/health-state-api.test.ts tests/client/health-view.test.ts tests/client/health-body-3d-viewer.test.ts tests/client/fitness-view.test.ts tests/client/xiaomi-health-settings.test.ts --reporter=dot
```

Expected: 9 files and 30 tests pass. If the count changed, explain the delta before proceeding.

**Step 3: Audit shared-file hunks**

For every shared navigation, locale, router, API, and settings file, classify each hunk as `health`, `auth`, or `other`. Do not rewrite user hunks merely to make staging easier. If one file contains mixed ownership, leave it uncommitted until a later task owns and tests the exact file.

**Step 4: Run type checks for the baseline**

Run:

```powershell
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
```

Expected: both commands exit 0, or any pre-existing failure is documented with a focused reproduction before Phase 4 code changes.

**Step 5: Commit only unambiguously health-owned baseline files**

Stage the verified health-only files explicitly. Confirm with `git diff --cached --name-only` that no auth file is staged, then commit:

```powershell
git commit -m "feat: preserve phase 4 health baseline"
```

Expected: unrelated dirty files remain present and unstaged.

### Task 2: Extend Personal Twin Artifact and Projection Contracts

**Files:**
- Modify: `packages/server/src/services/hermes/personal-twin/database.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/types.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/store.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/projectors.ts`
- Test: `tests/server/personal-twin-database.test.ts`
- Test: `tests/server/personal-twin-store.test.ts`
- Test: `tests/server/personal-twin-projectors.test.ts`

**Step 1: Write failing schema and store tests**

Add tests requiring schema v5 to add artifact metadata and consent tables, while preserving all v4 rows. Add tests for content-addressed artifact upsert, artifact lookup, and compare-and-set custom projection writes.

Use these public contracts:

```ts
export interface TwinArtifactInput {
  mediaType: string
  contentHash: string
  relativePath: string
  sizeBytes: number
  sensitivity: 'health' | 'general'
  metadata: Record<string, unknown>
  source: string
  sourceId: string
}

export interface TwinProjectionWrite {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
  expectedVersion?: number
  updatedAt: string
}
```

**Step 2: Run tests to verify RED**

Run:

```powershell
npx vitest run tests/server/personal-twin-database.test.ts tests/server/personal-twin-store.test.ts tests/server/personal-twin-projectors.test.ts --reporter=dot
```

Expected: FAIL because schema v5 and the new store APIs do not exist.

**Step 3: Implement schema v5 and minimal APIs**

Add columns to `twin_artifacts` only when missing and add `twin_artifact_consents` with manifest digest, processor, scope JSON, issued time, expiry, consumed time, and revoked time. Implement stable content-hash idempotency and fail closed on content identity conflicts. Add `writeTwinProjection()` with expected-version CAS and `listTwinProjections(prefix, subjectId)`.

**Step 4: Verify GREEN and migration safety**

Run the tests from Step 2 plus:

```powershell
npx tsc --noEmit -p packages/server/tsconfig.json
```

Expected: all pass, including v4-to-v5 migration and future-version rejection.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/personal-twin/database.ts packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/store.ts packages/server/src/services/hermes/personal-twin/projectors.ts tests/server/personal-twin-database.test.ts tests/server/personal-twin-store.test.ts tests/server/personal-twin-projectors.test.ts
git commit -m "feat: extend twin health artifact contracts"
```

### Task 3: Add Eight-Domain Health Ingestion Contracts

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/types.ts`
- Create: `packages/server/src/services/hermes/health-loop/normalizers.ts`
- Create: `packages/server/src/services/hermes/health-loop/ingestion.ts`
- Create: `packages/server/src/services/hermes/health-loop/index.ts`
- Test: `tests/server/health-loop-ingestion.test.ts`

**Step 1: Write failing normalization tests**

Cover one fixture for each domain and assert that measured, reported, inferred, and derived evidence remain distinct. Include unit normalization, ISO timestamp validation, unknown-field omission, prototype-pollution rejection, source conflict rejection, and stable replay.

The central input is:

```ts
export interface HealthIngestionEnvelope {
  domain: 'body_composition' | 'measurements' | 'posture' | 'skin' | 'diet' | 'fitness' | 'sleep' | 'internal_health'
  source: string
  sourceId: string
  observedAt: string
  evidenceClass: 'measured' | 'reported' | 'inferred' | 'derived'
  confidence: number
  payload: Record<string, unknown>
  artifactIds?: string[]
  parserVersion?: string
}
```

**Step 2: Run test to verify RED**

Run:

```powershell
npx vitest run tests/server/health-loop-ingestion.test.ts --reporter=dot
```

Expected: FAIL because the health-loop module does not exist.

**Step 3: Implement strict domain normalizers**

Create explicit field allowlists and numeric bounds for all eight domains. Convert normalized facts into one or more `TwinObservationInput` or `TwinEventInput` records. Derive deterministic source IDs as `<envelope sourceId>:<metric>` without hashing secret material. Persist an ingestion event only after all records validate.

**Step 4: Verify GREEN**

Run Step 2 and server TypeScript. Expected: PASS with one replay producing no duplicate Twin rows.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop tests/server/health-loop-ingestion.test.ts
git commit -m "feat: add health ingestion contracts"
```

### Task 4: Add Connector Registry and S400, Diet, Fitness, and Sleep Adapters

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/connectors.ts`
- Create: `packages/server/src/services/hermes/health-loop/connectors/s400.ts`
- Create: `packages/server/src/services/hermes/health-loop/connectors/health-state.ts`
- Create: `packages/server/src/services/hermes/health-loop/connectors/structured-import.ts`
- Modify: `packages/server/src/services/hermes/scale-sync.ts`
- Test: `tests/server/health-loop-connectors.test.ts`
- Test: `tests/server/scale-sync-service.test.ts`

**Step 1: Write failing connector tests**

Require connector status to expose no secrets and include `configured`, `health`, `lastAttemptAt`, `lastSuccessAt`, `cursor`, `domains`, and sanitized `errorCode`. Test S400 replay, health-state diet/fitness/sleep import, and cursor advancement only after successful Twin commit.

**Step 2: Run test to verify RED**

```powershell
npx vitest run tests/server/health-loop-connectors.test.ts tests/server/scale-sync-service.test.ts --reporter=dot
```

Expected: connector registry assertions fail.

**Step 3: Implement adapters**

Define:

```ts
export interface HealthConnector {
  id: string
  domains: HealthDomain[]
  status(): Promise<HealthConnectorStatus>
  sync(input: { cursor?: string; now?: string }): Promise<HealthConnectorBatch>
}
```

Wrap existing S400 sync instead of duplicating Xiaomi logic. Add legacy health-state and structured JSON/CSV adapters for diet, fitness, and sleep. Send every batch through the ingestion service.

**Step 4: Verify GREEN and source regressions**

Run Step 2 plus `tests/server/health-state-service.test.ts`. Expected: all pass.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/connectors.ts packages/server/src/services/hermes/health-loop/connectors packages/server/src/services/hermes/scale-sync.ts tests/server/health-loop-connectors.test.ts tests/server/scale-sync-service.test.ts
git commit -m "feat: connect health device and log sources"
```

### Task 5: Add Local Artifact Vault and One-Time Consent Broker

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/artifacts.ts`
- Create: `packages/server/src/services/hermes/health-loop/consent.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/index.ts`
- Test: `tests/server/health-loop-artifacts.test.ts`
- Test: `tests/server/health-loop-consent.test.ts`

**Step 1: Write failing security tests**

Test content-addressed storage under `<HERMES_HOME>/personal/artifacts`, path containment, MIME and size allowlists, hash verification, atomic writes, no filename trust, single-use consent, manifest scope binding, expiry, revocation, replay rejection, and sanitized errors.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/health-loop-artifacts.test.ts tests/server/health-loop-consent.test.ts --reporter=dot
```

Expected: FAIL because vault and consent broker are missing.

**Step 3: Implement the vault and consent token**

The consent manifest must contain only:

```ts
interface HealthProcessingManifest {
  artifactIds: string[]
  processor: string
  purpose: 'measurement' | 'posture' | 'skin' | 'diet' | 'internal_health'
  selectedRegions: string[]
  requestedFields: string[]
  retention: string
}
```

Store only a SHA-256 digest of the bearer token. Consume the token transactionally before remote dispatch and bind it to the canonical manifest digest.

**Step 4: Verify GREEN and traversal protection**

Run Step 2 and server TypeScript. Expected: all pass, including Windows path cases.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/artifacts.ts packages/server/src/services/hermes/health-loop/consent.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/health-loop-artifacts.test.ts tests/server/health-loop-consent.test.ts
git commit -m "feat: add private health artifact vault"
```

### Task 6: Add Guided Capture and Artifact Analysis Adapters

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/analysis.ts`
- Create: `packages/server/src/services/hermes/health-loop/analyzers/structured.ts`
- Create: `packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision.ts`
- Create: `packages/server/src/services/hermes/health-loop/capture-protocols.ts`
- Test: `tests/server/health-loop-analysis.test.ts`
- Test: `tests/server/health-loop-capture-protocols.test.ts`

**Step 1: Write failing analysis contract tests**

Cover body measurements, posture, skin, meal photo, and internal report analysis. Require strict JSON output, model/parser version, requested field allowlist, confidence, per-field evidence, capture-quality result, and `pending_confirmation` for first-time report markers.

**Step 2: Run test to verify RED**

```powershell
npx vitest run tests/server/health-loop-analysis.test.ts tests/server/health-loop-capture-protocols.test.ts --reporter=dot
```

Expected: FAIL because analyzers do not exist.

**Step 3: Implement analyzer interfaces and safe adapters**

Use a structured analyzer for JSON/CSV and pre-extracted report text. Add an auxiliary-vision adapter that uses the existing profile auxiliary `vision` configuration through an injected client. It must not run without consumed consent when the selected provider is remote. Reject prose, unknown keys, NaN, infinite values, and outputs outside the requested schema.

Define capture protocols for lighting, view, distance, scale reference, body region, and minimum image set. Low capture quality returns `recapture_required` and produces no inferred observation.

**Step 4: Verify GREEN with fake processors**

Run Step 2. All tests must use deterministic fake analyzers and synthetic artifacts; no network calls.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/analysis.ts packages/server/src/services/hermes/health-loop/analyzers packages/server/src/services/hermes/health-loop/capture-protocols.ts tests/server/health-loop-analysis.test.ts tests/server/health-loop-capture-protocols.test.ts
git commit -m "feat: analyze guided health captures"
```

### Task 7: Migrate Existing Health Data into Personal Twin

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/migration.ts`
- Modify: `packages/server/src/services/hermes/personal-twin/legacy-import.ts`
- Test: `tests/server/health-loop-migration.test.ts`
- Test: `tests/server/personal-twin-import.test.ts`

**Step 1: Write failing migration tests**

Seed health-state fixtures for all eight domains, including S400, body profile, posture, skin, food logs, workouts, sleep check-in, and internal markers. Assert stable source IDs, preserved timestamps, evidence classes, pending confirmation, and no duplicates on a second run.

**Step 2: Run test to verify RED**

```powershell
npx vitest run tests/server/health-loop-migration.test.ts tests/server/personal-twin-import.test.ts --reporter=dot
```

Expected: health-loop migration assertions fail.

**Step 3: Implement compatibility migration**

Read existing services through their public APIs where possible. Do not query source SQLite directly from multiple modules. Store a source fingerprint and counts, preserve source records, and commit each logical source record atomically with its Twin outbox entries.

**Step 4: Verify GREEN and source data preservation**

Run Step 2 and confirm test fixtures remain unchanged after import.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/migration.ts packages/server/src/services/hermes/personal-twin/legacy-import.ts tests/server/health-loop-migration.test.ts tests/server/personal-twin-import.test.ts
git commit -m "feat: migrate health state into personal twin"
```

### Task 8: Build Deterministic Health Projectors

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/projectors.ts`
- Create: `packages/server/src/services/hermes/health-loop/rules/health-math.ts`
- Test: `tests/server/health-loop-projectors.test.ts`

**Step 1: Write failing projector tests**

Test all nine projections, historical replay determinism, measured/inferred coexistence, freshness expiry, unit conflicts, source conflicts, pending internal markers, rule versioning, and full input record references.

Expected keys:

```ts
const HEALTH_PROJECTIONS = [
  'health.body_composition_state', 'health.fat_loss_state', 'health.nutrition_state',
  'health.training_state', 'health.recovery_state', 'health.posture_state',
  'health.skin_state', 'health.internal_state', 'health.readiness_state',
] as const
```

**Step 2: Run test to verify RED**

```powershell
npx vitest run tests/server/health-loop-projectors.test.ts --reporter=dot
```

Expected: FAIL because projectors are missing.

**Step 3: Implement pure projector functions and CAS persistence**

Separate pure computation from SQLite access. Each value contains `schemaVersion`, `ruleVersion`, `inputRecordIds`, `effectiveAt`, `computedAt`, `freshness`, `confidence`, `conflicts`, `missing`, and `rationale`. Sort all unordered inputs before computation.

**Step 4: Verify GREEN and replay hash stability**

Run Step 2 twice with fixed time. Expected: identical projection JSON digests.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/projectors.ts packages/server/src/services/hermes/health-loop/rules tests/server/health-loop-projectors.test.ts
git commit -m "feat: project canonical health state"
```

### Task 9: Build the Cross-Domain Intervention Engine

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/interventions.ts`
- Create: `packages/server/src/services/hermes/health-loop/rules/intervention-rules.ts`
- Test: `tests/server/health-loop-interventions.test.ts`

**Step 1: Write failing decision tests**

Cover low sleep overriding hard training, pain escalation, unsafe weight-loss velocity, protein shortage, posture-chain overload, skin recapture, incomplete lab metadata, stale source blocking, quiet time, cooldown, supersession, and one-primary-action ranking.

Require this output:

```ts
interface HealthInterventionDecision {
  primary: HealthActionCandidate | null
  alternatives: HealthActionCandidate[]
  considered: Array<{ id: string; accepted: boolean; reason: string }>
  projectionVersions: Record<string, number>
  ruleVersion: string
  decidedAt: string
}
```

**Step 2: Run test to verify RED**

```powershell
npx vitest run tests/server/health-loop-interventions.test.ts --reporter=dot
```

Expected: FAIL because decision engine is missing.

**Step 3: Implement deterministic rules and ranking**

Use explicit rule IDs and a stable score tuple rather than opaque LLM scoring. Assign `none`, `low`, `medium`, `high`, or `critical` risk and `auto`, `approval`, or `inform_only` authority. Do not create executable candidates for medication, supplement dose, diagnosis, or emergency disposition.

**Step 4: Verify GREEN**

Run Step 2 and server TypeScript. Expected: all pass with stable ordering under input permutation.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/interventions.ts packages/server/src/services/hermes/health-loop/rules/intervention-rules.ts tests/server/health-loop-interventions.test.ts
git commit -m "feat: decide cross-domain health actions"
```

### Task 10: Extend Action Fabric for Connector Executors and Health Capabilities

**Files:**
- Modify: `packages/server/src/services/hermes/action-fabric/types.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/database.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/registry.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/executors.ts`
- Test: `tests/server/action-fabric-database.test.ts`
- Test: `tests/server/action-fabric-registry.test.ts`
- Test: `tests/server/action-fabric-worker.test.ts`
- Test: `tests/server/health-loop-fabric-registry.test.ts`

**Step 1: Write failing registry and compatibility tests**

Add the `connector` executor type without changing existing simulator/internal semantics. Register the eight versioned health capabilities from the design, require external-write classification, exact target restrictions, idempotency, risk, reversibility, and consent-related authentication metadata.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/action-fabric-database.test.ts tests/server/action-fabric-registry.test.ts tests/server/action-fabric-worker.test.ts tests/server/health-loop-fabric-registry.test.ts --reporter=dot
```

Expected: connector type and health registry tests fail.

**Step 3: Implement connector support and health registry**

Extend validator allowlists, resolution environments, adapter contracts, migrations, and worker control behavior. Existing built-in contract digests must remain unchanged. Health capability schemas must be explicit and versioned; do not use unconstrained `{ type: 'object' }` for side-effecting inputs.

**Step 4: Verify GREEN and Phase 3 regression**

Run every `tests/server/action-fabric-*.test.ts` plus the new registry test. Expected: all pass.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/action-fabric/types.ts packages/server/src/services/hermes/action-fabric/database.ts packages/server/src/services/hermes/action-fabric/registry.ts packages/server/src/services/hermes/action-fabric/executors.ts tests/server/action-fabric-database.test.ts tests/server/action-fabric-registry.test.ts tests/server/action-fabric-worker.test.ts tests/server/health-loop-fabric-registry.test.ts
git commit -m "feat: register health fabric capabilities"
```

### Task 11: Implement Shadow, Plan, Analysis, and Weixin Executors

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/executors/shadow.ts`
- Create: `packages/server/src/services/hermes/health-loop/executors/plan.ts`
- Create: `packages/server/src/services/hermes/health-loop/executors/analysis.ts`
- Create: `packages/server/src/services/hermes/health-loop/executors/weixin.ts`
- Modify: `packages/server/src/services/hermes/action-fabric/runtime.ts`
- Modify: `packages/server/src/services/hermes/weixin-sender.ts`
- Test: `tests/server/health-loop-executors.test.ts`
- Test: `tests/server/weixin-sender.test.ts`

**Step 1: Write failing executor tests**

Test prepare/execute/verify/interrupt/compensate contracts, shadow no-side-effect proof, plan CAS and compensation, consent consumption, self-recipient restriction, message minimization, receipt verification, uncertain result handling, and no blind resend.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/health-loop-executors.test.ts tests/server/weixin-sender.test.ts --reporter=dot
```

Expected: FAIL because health executors are missing.

**Step 3: Implement adapters**

Use dependency injection for analyzers and sender. The Weixin adapter may call the existing sender only after policy resolution and must persist provider identity or an explicit unverifiable result. The plan adapter stores prior version and digest and refuses compensation across intervening edits.

**Step 4: Verify GREEN and executor sanitation**

Run Step 2 plus `tests/server/action-fabric-worker.test.ts`. Expected: all pass and sensitive-shaped values are redacted or rejected.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/executors packages/server/src/services/hermes/action-fabric/runtime.ts packages/server/src/services/hermes/weixin-sender.ts tests/server/health-loop-executors.test.ts tests/server/weixin-sender.test.ts
git commit -m "feat: execute health workflows safely"
```

### Task 12: Add Health Runtime, Outbox Consumption, and Outcome Feedback

**Files:**
- Create: `packages/server/src/services/hermes/health-loop/runtime.ts`
- Create: `packages/server/src/services/hermes/health-loop/outcomes.ts`
- Create: `packages/server/src/services/hermes/health-loop/settings.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/server/health-loop-runtime.test.ts`
- Test: `tests/server/health-loop-outcomes.test.ts`

**Step 1: Write failing lifecycle and feedback tests**

Test serialized start/stop, outbox lease and deduplication, restart recovery, projection-triggered intent creation, default shadow setting, explicit live switch, and all feedback outcomes. Test that adverse feedback supersedes normal follow-up but does not create a medical action.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/health-loop-runtime.test.ts tests/server/health-loop-outcomes.test.ts --reporter=dot
```

Expected: FAIL because runtime and outcome services are missing.

**Step 3: Implement runtime and settings**

Consume immutable Twin outbox IDs at least once and deduplicate by outbox ID. Derive intervention idempotency from rule version, projection versions, action ID, and effective date. Keep live delivery disabled by default. Record `completed`, `partial`, `skipped`, `deferred`, `adverse_feedback`, `unsuitable`, `data_incorrect`, and `expired` as Twin events.

**Step 4: Verify GREEN and shutdown ordering**

Run Step 2 plus `tests/server/shutdown.test.ts` and Action Fabric runtime tests. Expected: workers stop before databases close.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-loop/runtime.ts packages/server/src/services/hermes/health-loop/outcomes.ts packages/server/src/services/hermes/health-loop/settings.ts packages/server/src/index.ts tests/server/health-loop-runtime.test.ts tests/server/health-loop-outcomes.test.ts
git commit -m "feat: close the health outcome loop"
```

### Task 13: Replace Direct Reminder Scheduling with Fabric Shadow Parity

**Files:**
- Modify: `packages/server/src/services/hermes/autopilot-reminders.ts`
- Modify: `packages/server/src/services/hermes/autopilot-reminder-scheduler.ts`
- Modify: `packages/server/src/services/hermes/personal-autopilot.ts`
- Test: `tests/server/autopilot-reminders-dispatch.test.ts`
- Test: `tests/server/autopilot-reminders-scheduler.test.ts`
- Test: `tests/server/personal-autopilot-service.test.ts`
- Test: `tests/server/health-loop-reminder-parity.test.ts`

**Step 1: Write failing parity tests**

For recorded Personal Autopilot scenarios, compare old policy output to health-loop shadow decisions. Require the scheduler to enqueue a semantic intent rather than call `sendWeixinTextReminder()` directly. Preserve existing settings and delivery history APIs during migration.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/autopilot-reminders-dispatch.test.ts tests/server/autopilot-reminders-scheduler.test.ts tests/server/personal-autopilot-service.test.ts tests/server/health-loop-reminder-parity.test.ts --reporter=dot
```

Expected: direct sender assertion exposes the old path.

**Step 3: Route reminder effects through Action Fabric**

Keep compatibility reads, but create health reminder intents with stable idempotency. Store legacy delivery IDs in workflow metadata. Do not enable live delivery as part of migration.

**Step 4: Verify GREEN and no direct send path**

Run Step 2 and use `rg "sendWeixinTextReminder" packages/server/src/services/hermes` to confirm only the Weixin executor owns outbound calls.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/autopilot-reminders.ts packages/server/src/services/hermes/autopilot-reminder-scheduler.ts packages/server/src/services/hermes/personal-autopilot.ts tests/server/autopilot-reminders-dispatch.test.ts tests/server/autopilot-reminders-scheduler.test.ts tests/server/personal-autopilot-service.test.ts tests/server/health-loop-reminder-parity.test.ts
git commit -m "refactor: route health reminders through fabric"
```

### Task 14: Add Protected HTTP API, OpenAPI, and MCP Discovery

**Files:**
- Create: `packages/server/src/controllers/hermes/health-loop.ts`
- Create: `packages/server/src/routes/hermes/health-loop.ts`
- Modify: `packages/server/src/routes/index.ts`
- Modify: `packages/server/src/services/hermes/mcp.ts`
- Modify: `docs/openapi.json`
- Test: `tests/server/health-loop-controller.test.ts`
- Test: `tests/server/health-loop-routes.test.ts`
- Test: `tests/server/api-docs-controller.test.ts`
- Test: `tests/server/hermes-web-ui-mcp.test.ts`

**Step 1: Write failing controller and route tests**

Cover:

```text
GET  /api/hermes/health-loop/overview
GET  /api/hermes/health-loop/connectors
POST /api/hermes/health-loop/connectors/:id/sync
POST /api/hermes/health-loop/artifacts
POST /api/hermes/health-loop/artifacts/:id/analyze
POST /api/hermes/health-loop/consents
POST /api/hermes/health-loop/consents/:id/revoke
GET  /api/hermes/health-loop/interventions
POST /api/hermes/health-loop/interventions/:id/feedback
GET  /api/hermes/health-loop/settings
PUT  /api/hermes/health-loop/settings
```

Require authentication for reads and super-admin for sync, analysis, consent, feedback mutation, and live enablement. Do not trust user identity from the request body.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/server/health-loop-controller.test.ts tests/server/health-loop-routes.test.ts tests/server/api-docs-controller.test.ts tests/server/hermes-web-ui-mcp.test.ts --reporter=dot
```

Expected: routes are missing.

**Step 3: Implement thin routes and strict DTOs**

Controllers validate types, object depth, arrays, file budgets, semantic IDs, and dangerous keys before calling services. DTOs return artifact IDs and sanitized metadata, never raw local paths, tokens, policy snapshots, or provider errors.

**Step 4: Generate and verify OpenAPI**

Run:

```powershell
npm run openapi:generate
npx vitest run tests/server/health-loop-controller.test.ts tests/server/health-loop-routes.test.ts tests/server/api-docs-controller.test.ts tests/server/hermes-web-ui-mcp.test.ts --reporter=dot
```

Expected: all pass and two consecutive generations have the same hash.

**Step 5: Commit**

```powershell
git add packages/server/src/controllers/hermes/health-loop.ts packages/server/src/routes/hermes/health-loop.ts packages/server/src/routes/index.ts packages/server/src/services/hermes/mcp.ts docs/openapi.json tests/server/health-loop-controller.test.ts tests/server/health-loop-routes.test.ts tests/server/api-docs-controller.test.ts tests/server/hermes-web-ui-mcp.test.ts
git commit -m "feat: expose health closed loop api"
```

### Task 15: Add Client API and Race-Safe Store

**Files:**
- Create: `packages/client/src/api/hermes/health-loop.ts`
- Create: `packages/client/src/stores/hermes/health-loop.ts`
- Test: `tests/client/health-loop-api.test.ts`
- Test: `tests/client/health-loop-store.test.ts`

**Step 1: Write failing API and store tests**

Test every endpoint, encoded semantic IDs, FormData upload, latest-request wins, selected-intervention version guards, stale response discard, mutation serialization, consent lifecycle, and authoritative reload after feedback, sync, consent, or live-mode mutation.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/client/health-loop-api.test.ts tests/client/health-loop-store.test.ts --reporter=dot
```

Expected: modules are missing.

**Step 3: Implement API and Pinia store**

Use `packages/client/src/api/client.ts` for JSON requests and a narrow authenticated upload helper for FormData. Store actions return their own response payload so components never treat shared stale state as a fresh mutation result.

**Step 4: Verify GREEN and Vue TypeScript**

```powershell
npx vitest run tests/client/health-loop-api.test.ts tests/client/health-loop-store.test.ts --reporter=dot
npx vue-tsc -b
```

Expected: all pass.

**Step 5: Commit**

```powershell
git add packages/client/src/api/hermes/health-loop.ts packages/client/src/stores/hermes/health-loop.ts tests/client/health-loop-api.test.ts tests/client/health-loop-store.test.ts
git commit -m "feat: add health loop client state"
```

### Task 16: Upgrade Health UI into a Closed-Loop Command Center

**Files:**
- Modify: `packages/client/src/views/hermes/HealthView.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthReadinessPanel.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthDomainStatusGrid.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthInterventionPanel.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthCaptureWizard.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthConsentDialog.vue`
- Create: `packages/client/src/components/hermes/health-loop/HealthAutomationPanel.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/health-loop-command-center.test.ts`
- Test: `tests/client/health-loop-capture.test.ts`
- Test: `tests/client/health-view.test.ts`
- Test: `tests/client/i18n-coverage.test.ts`

**Step 1: Write failing UI tests**

Require readiness, one primary action, alternatives, eight domain freshness states, connector errors, active workflow, shadow/live badge, confirmation requests, feedback actions, capture requirements, extracted-value review, one-time consent manifest, and server-provided available actions. Add keyboard and accessible-name coverage.

**Step 2: Run tests to verify RED**

```powershell
npx vitest run tests/client/health-loop-command-center.test.ts tests/client/health-loop-capture.test.ts tests/client/health-view.test.ts tests/client/i18n-coverage.test.ts --reporter=dot
```

Expected: new components are missing.

**Step 3: Implement the command center**

Keep current Body3D, S400, diet, fitness, skin, and internal-health content as drill-downs. Put readiness and the next action first. Require explicit typed confirmation before switching to live Weixin. Do not render local artifact paths or raw report data in list views.

**Step 4: Verify GREEN, responsive state, and Vue TypeScript**

Run Step 2 and `npx vue-tsc -b`. Expected: all pass. Manually inspect narrow and wide layouts with synthetic fixture data.

**Step 5: Commit**

```powershell
git add packages/client/src/views/hermes/HealthView.vue packages/client/src/components/hermes/health-loop packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts tests/client/health-loop-command-center.test.ts tests/client/health-loop-capture.test.ts tests/client/health-view.test.ts tests/client/i18n-coverage.test.ts
git commit -m "feat: add health closed loop command center"
```

### Task 17: Add End-to-End Loop Verification and Final Delivery Checks

**Files:**
- Create: `tests/server/health-loop-e2e.test.ts`
- Create: `tests/e2e/health-loop.spec.ts`
- Modify: `docs/plans/2026-07-13-health-closed-loop-implementation.md` only if commands or file boundaries changed during implementation

**Step 1: Write the complete synthetic loop test**

Cover:

```text
S400 + sleep + diet fixture
→ Twin observations exactly once
→ deterministic projections
→ recovery override decision
→ Action Fabric shadow workflow
→ no Weixin side effect
→ user completes action
→ immutable outcome event
→ readiness and next action recompute
```

Add separate paths for remote-consent rejection, live fake-Weixin receipt, restart recovery, emergency stop, adverse feedback, and internal-marker approval.

**Step 2: Run focused Phase 4 verification**

Run all `health-loop` tests plus existing health, Twin, Action Fabric, reminder, and role tests. Expected: 0 failures.

**Step 3: Run static, harness, generation, and build checks**

```powershell
npx tsc --noEmit -p packages/server/tsconfig.json
npx vue-tsc -b
npm run harness:check
npm run openapi:generate
npm run build
git diff --check
```

Expected: every command exits 0 and a second OpenAPI generation produces no diff.

**Step 4: Run broad regression and browser verification**

```powershell
npm test -- --maxWorkers=4
npx playwright test tests/e2e/health-loop.spec.ts
```

Expected: 0 failures. Real Weixin remains disabled; the browser test uses mocked APIs.

**Step 5: Audit scope and request final review**

Use @superpowers:requesting-code-review. Review must verify safety boundaries, privacy manifests, idempotency, restart behavior, no direct reminder sends, dirty-worktree preservation, and no Critical or Important findings.

**Step 6: Commit final verification artifacts**

```powershell
git add tests/server/health-loop-e2e.test.ts tests/e2e/health-loop.spec.ts docs/plans/2026-07-13-health-closed-loop-implementation.md
git commit -m "test: verify phase 4 health closed loop"
```

## Phase 4 Completion Definition

Phase 4 is complete only when:

- All eight domains have normalized automatic ingestion and visible connector status.
- Existing Health data has idempotent Twin migration evidence.
- Artifact processing is local-first and remote calls require a consumed manifest-bound one-time consent.
- Nine health projections are deterministic, replayable, freshness-aware, and explainable.
- Cross-domain rules produce one safe next action with explicit alternatives and considered reasons.
- Action Fabric owns every plan change, remote processing request, and outbound reminder.
- Shadow is the default and exercises the complete durable workflow without an external side effect.
- Live fake-Weixin execution verifies receipts and uncertain outcomes without blind resend.
- Real Weixin is available but remains user-disabled at delivery.
- Completion and adverse feedback update Twin and change subsequent strategy.
- Existing health, auth, Personal Twin, Assistant Roles, Action Fabric, OpenAPI, and UI regressions pass.
- Final review reports no Critical or Important findings.

