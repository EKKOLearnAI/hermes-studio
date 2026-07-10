# Personal Twin Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the global, profile-independent Personal Twin Kernel foundation with typed core records, append-only observations and events, deterministic latest-state projections, legacy Personal OS import, and read APIs.

**Architecture:** Add a modular Personal Twin service under the existing Hermes Studio Koa server. Store the canonical twin at <HERMES_HOME>/personal/twin.db with SQLite WAL, keep existing profile databases untouched, and import them idempotently through public Health State and Personal State service APIs. Expose bounded read APIs plus an explicit legacy-sync endpoint; do not migrate current UI pages or add Action Fabric execution in this phase.

**Tech Stack:** TypeScript 6, Node.js node:sqlite DatabaseSync, Koa, @koa/router, Vue client API wrappers, Vitest, generated OpenAPI.

---

## Reference Design

Read before implementation:

- docs/plans/2026-07-10-personal-digital-twin-action-fabric-design.md
- ARCHITECTURE.md
- packages/server/src/services/hermes/hermes-profile.ts
- packages/server/src/services/hermes/health-state.ts
- packages/server/src/services/hermes/personal-state.ts

## Scope Guards

- This plan implements roadmap Phase 1 only.
- Do not build Assistant Roles, Action Fabric, Android, Home Assistant control, browser automation, or commerce workflows here.
- Do not switch HealthView, PersonalOSView, reminders, or S400 writes to the new twin yet.
- Do not delete, rename, or rewrite health_state.db, personal_state.db, or autopilot_reminders.db.
- Do not add PostgreSQL, Redis, Kafka, Temporal, an ORM, or a new runtime dependency.
- Do not expose generic arbitrary-write HTTP endpoints for Twin facts in Phase 1.
- Keep all list APIs bounded to at most 200 rows.
- Keep facts, observations, events, and inferences distinguishable.
- The working tree already contains unrelated user changes. Stage only files listed by each task. Never use git add -A.

## Required Execution Skills

- @superpowers:executing-plans to run this plan with checkpoints.
- @superpowers:test-driven-development for every production-code task.
- @superpowers:verification-before-completion before each commit and final handoff.

## Target File Layout

    packages/server/src/services/hermes/personal-twin/
      types.ts
      database.ts
      store.ts
      projectors.ts
      legacy-import.ts
      service.ts
      index.ts
    packages/server/src/controllers/hermes/personal-twin.ts
    packages/server/src/routes/hermes/personal-twin.ts
    packages/client/src/api/hermes/personal-twin.ts

    tests/server/personal-twin-database.test.ts
    tests/server/personal-twin-store.test.ts
    tests/server/personal-twin-projectors.test.ts
    tests/server/personal-twin-import.test.ts
    tests/server/personal-twin-controller.test.ts
    tests/server/personal-twin-routes.test.ts
    tests/client/personal-twin-api.test.ts

## API Surface for This Phase

    GET  /api/hermes/personal-twin/overview
    GET  /api/hermes/personal-twin/entities
    GET  /api/hermes/personal-twin/observations
    GET  /api/hermes/personal-twin/events
    GET  /api/hermes/personal-twin/context
    POST /api/hermes/personal-twin/imports/legacy

The Twin is global. These endpoints do not accept or use a Hermes profile to choose storage. The legacy import body may optionally contain a profiles array to select source profiles, but every source writes into the same global Twin.

### Task 1: Global Twin Types, Path, and SQLite Schema

**Files:**

- Create: packages/server/src/services/hermes/personal-twin/types.ts
- Create: packages/server/src/services/hermes/personal-twin/database.ts
- Create: packages/server/src/services/hermes/personal-twin/index.ts
- Test: tests/server/personal-twin-database.test.ts

**Step 1: Write the failing database test**

Create tests/server/personal-twin-database.test.ts:

~~~ts
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal twin database', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-twin-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('creates one global twin database below Hermes home', async () => {
    const { getPersonalTwinDbPath, withPersonalTwinDb } = await import(
      '../../packages/server/src/services/hermes/personal-twin'
    )

    expect(getPersonalTwinDbPath()).toBe(join(hermesHome, 'personal', 'twin.db'))
    withPersonalTwinDb(db => db.prepare('SELECT 1').get())
    expect(existsSync(getPersonalTwinDbPath())).toBe(true)

    const db = new DatabaseSync(getPersonalTwinDbPath(), { open: true, readOnly: true })
    try {
      const names = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'twin_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map(row => row.name)

      expect(names).toEqual([
        'twin_artifacts',
        'twin_constraints',
        'twin_entities',
        'twin_events',
        'twin_goals',
        'twin_import_runs',
        'twin_meta',
        'twin_observations',
        'twin_outbox',
        'twin_preferences',
        'twin_projections',
        'twin_relations',
      ])
    } finally {
      db.close()
    }
  })
})
~~~

**Step 2: Run the test and verify it fails**

Run:

    npx vitest run tests/server/personal-twin-database.test.ts --reporter=dot

Expected: FAIL because packages/server/src/services/hermes/personal-twin does not exist.

**Step 3: Add the core TypeScript contracts**

Create types.ts with these exported contracts. Keep JSON payloads typed as Record<string, unknown>, not any.

~~~ts
export type TwinConfirmationState = 'observed' | 'reported' | 'confirmed' | 'inferred'
export type TwinOutboxStatus = 'pending' | 'published' | 'failed'

export interface TwinProvenance {
  source: string
  sourceId: string
  actor: string
  confidence: number
  confirmationState: TwinConfirmationState
  evidence: Array<Record<string, unknown>>
  schemaVersion: number
}

export interface TwinEntity {
  id: string
  type: string
  label: string
  attributes: Record<string, unknown>
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinRelation {
  id: string
  subjectId: string
  predicate: string
  objectId: string
  attributes: Record<string, unknown>
  validFrom: string | null
  validTo: string | null
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinObservation {
  id: string
  entityId: string
  metric: string
  value: unknown
  unit: string | null
  observedAt: string
  ingestedAt: string
  provenance: TwinProvenance
}

export interface TwinEvent {
  id: string
  eventType: string
  subjectId: string | null
  payload: Record<string, unknown>
  occurredAt: string
  ingestedAt: string
  provenance: TwinProvenance
}

export interface TwinProjection {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
  version: number
  updatedAt: string
}

export interface TwinGoal {
  id: string
  subjectId: string
  domain: string
  title: string
  target: Record<string, unknown>
  status: string
  priority: number
  startsAt: string | null
  dueAt: string | null
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinConstraint {
  id: string
  subjectId: string
  domain: string
  key: string
  value: unknown
  enforcement: 'hard' | 'advisory'
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinOverview {
  generatedAt: string
  subject: TwinEntity
  counts: {
    entities: number
    relations: number
    observations: number
    events: number
    goals: number
    constraints: number
    pendingOutbox: number
  }
  latestObservations: TwinObservation[]
  recentEvents: TwinEvent[]
  imports: Array<Record<string, unknown>>
}
~~~

**Step 4: Implement the global path and schema**

Create database.ts. Use getHermesBaseDir(), not getProfileDir().

~~~ts
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 1

export function getPersonalTwinDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'twin.db')
}

export function withPersonalTwinDb<T>(callback: (db: DatabaseSync) => T): T {
  const path = getPersonalTwinDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    initPersonalTwinSchema(db)
    return callback(db)
  } finally {
    db.close()
  }
}

export function initPersonalTwinSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS twin_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_entities_type ON twin_entities(type);

    CREATE TABLE IF NOT EXISTS twin_relations (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT,
      valid_to TEXT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id),
      FOREIGN KEY(object_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_relations_subject ON twin_relations(subject_id, predicate);
    CREATE INDEX IF NOT EXISTS idx_twin_relations_object ON twin_relations(object_id, predicate);

    CREATE TABLE IF NOT EXISTS twin_observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value_json TEXT NOT NULL,
      unit TEXT,
      observed_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      confidence REAL NOT NULL,
      confirmation_state TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      schema_version INTEGER NOT NULL,
      UNIQUE(source, source_id, metric),
      FOREIGN KEY(entity_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_observations_lookup
      ON twin_observations(entity_id, metric, observed_at DESC);

    CREATE TABLE IF NOT EXISTS twin_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      subject_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      confidence REAL NOT NULL,
      confirmation_state TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      schema_version INTEGER NOT NULL,
      UNIQUE(source, source_id, event_type),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_twin_events_lookup
      ON twin_events(subject_id, event_type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS twin_goals (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      starts_at TEXT,
      due_at TEXT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_preferences (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_constraints (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      enforcement TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_projections (
      projection_key TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(projection_key, subject_id),
      FOREIGN KEY(subject_id) REFERENCES twin_entities(id)
    );

    CREATE TABLE IF NOT EXISTS twin_artifacts (
      id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twin_outbox (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_twin_outbox_pending
      ON twin_outbox(status, available_at);

    CREATE TABLE IF NOT EXISTS twin_import_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(source, source_fingerprint)
    );
  `)

  db.prepare(`
    INSERT INTO twin_meta(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCHEMA_VERSION))
}
~~~

Create index.ts exporting types.ts and database.ts.

**Step 5: Run the test and server typecheck**

Run:

    npx vitest run tests/server/personal-twin-database.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 6: Commit only Task 1 files**

    git add packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/database.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/personal-twin-database.test.ts
    git commit -m "feat: add global personal twin schema"

### Task 2: Entity and Relation Store

**Files:**

- Create: packages/server/src/services/hermes/personal-twin/store.ts
- Modify: packages/server/src/services/hermes/personal-twin/types.ts
- Modify: packages/server/src/services/hermes/personal-twin/index.ts
- Test: tests/server/personal-twin-store.test.ts

**Step 1: Write failing entity and relation tests**

The test must prove:

- person:self is stable and globally stored.
- Repeating the same source/sourceId updates an entity rather than duplicating it.
- A relation requires existing subject and object entities.
- Goals and constraints upsert by provenance identity.
- List filters and limits work.

~~~ts
it('upserts entities and relations by provenance identity', async () => {
  const {
    getTwinEntity,
    listTwinConstraints,
    listTwinEntities,
    listTwinGoals,
    listTwinRelations,
    upsertTwinConstraint,
    upsertTwinEntity,
    upsertTwinGoal,
    upsertTwinRelation,
  } = await import('../../packages/server/src/services/hermes/personal-twin')

  upsertTwinEntity({
    id: 'person:self',
    type: 'person',
    label: 'Self',
    attributes: { heightCm: 178 },
    source: 'system',
    sourceId: 'self',
  })
  upsertTwinEntity({
    type: 'person',
    label: 'Li Hao',
    attributes: { heightCm: 178 },
    source: 'system',
    sourceId: 'self',
  })
  upsertTwinEntity({
    id: 'body:self',
    type: 'body',
    label: 'Body',
    attributes: {},
    source: 'system',
    sourceId: 'body:self',
  })
  upsertTwinRelation({
    subjectId: 'body:self',
    predicate: 'belongs_to',
    objectId: 'person:self',
    attributes: {},
    source: 'system',
    sourceId: 'body-owner',
  })
  upsertTwinGoal({
    subjectId: 'person:self',
    domain: 'body',
    title: 'Reach target weight',
    target: { weightKg: 75 },
    status: 'active',
    priority: 100,
    source: 'health-state:default',
    sourceId: 'goal:target-weight',
  })
  upsertTwinConstraint({
    subjectId: 'person:self',
    domain: 'health',
    key: 'allergy',
    value: 'sample-allergen',
    enforcement: 'hard',
    source: 'health-state:default',
    sourceId: 'allergy:sample-allergen',
  })

  expect(listTwinEntities({ type: 'person' })).toHaveLength(1)
  expect(getTwinEntity('person:self')).toMatchObject({ label: 'Li Hao' })
  expect(listTwinRelations({ subjectId: 'body:self' })).toEqual([
    expect.objectContaining({ predicate: 'belongs_to', objectId: 'person:self' }),
  ])
  expect(listTwinGoals({ subjectId: 'person:self' })).toEqual([
    expect.objectContaining({ title: 'Reach target weight' }),
  ])
  expect(listTwinConstraints({ subjectId: 'person:self' })).toEqual([
    expect.objectContaining({ key: 'allergy', enforcement: 'hard' }),
  ])
})
~~~

**Step 2: Run the test and verify it fails**

    npx vitest run tests/server/personal-twin-store.test.ts --reporter=dot

Expected: FAIL because store exports do not exist.

**Step 3: Add write-input types**

Add TwinEntityInput, TwinRelationInput, list filter types, and TwinRecordNotFoundError to types.ts. Require source and sourceId for every write.

~~~ts
export interface TwinEntityInput {
  id?: string
  type: string
  label: string
  attributes?: Record<string, unknown>
  source: string
  sourceId: string
}

export interface TwinRelationInput {
  id?: string
  subjectId: string
  predicate: string
  objectId: string
  attributes?: Record<string, unknown>
  validFrom?: string | null
  validTo?: string | null
  source: string
  sourceId: string
}

export interface TwinGoalInput {
  id?: string
  subjectId: string
  domain: string
  title: string
  target: Record<string, unknown>
  status: string
  priority: number
  startsAt?: string | null
  dueAt?: string | null
  source: string
  sourceId: string
}

export interface TwinConstraintInput {
  id?: string
  subjectId: string
  domain: string
  key: string
  value: unknown
  enforcement: 'hard' | 'advisory'
  source: string
  sourceId: string
}

export class TwinRecordNotFoundError extends Error {}
~~~

**Step 4: Implement store helpers**

Create store.ts with:

- stableTwinId(prefix, parts) using SHA-256 truncated to 16 hex characters.
- parseJson and jsonString helpers.
- clampLimit(limit) returning 1..200 with default 50.
- upsertTwinEntity.
- getTwinEntity.
- listTwinEntities.
- upsertTwinRelation.
- listTwinRelations.
- upsertTwinGoal.
- listTwinGoals.
- upsertTwinConstraint.
- listTwinConstraints.

Use INSERT ... ON CONFLICT(source, source_id) DO UPDATE for entities and relations. Preserve created_at and update updated_at. Return rows by canonical ID after the upsert.

Do not accept table or column names from callers. Build optional WHERE clauses from a fixed list of filters.

**Step 5: Run focused tests and typecheck**

    npx vitest run tests/server/personal-twin-database.test.ts tests/server/personal-twin-store.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 6: Commit only Task 2 files**

    git add packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/store.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/personal-twin-store.test.ts
    git commit -m "feat: add personal twin entity store"

### Task 3: Immutable Observations, Events, and Transactional Outbox

**Files:**

- Modify: packages/server/src/services/hermes/personal-twin/types.ts
- Modify: packages/server/src/services/hermes/personal-twin/store.ts
- Modify: packages/server/src/services/hermes/personal-twin/index.ts
- Test: tests/server/personal-twin-store.test.ts

**Step 1: Add failing tests**

Add tests proving:

- The same source/sourceId/metric creates one observation.
- The same source/sourceId/eventType creates one event.
- A different metric from the same source record creates another observation.
- Every newly inserted observation or event creates one pending outbox row in the same transaction.
- Re-importing the same record does not add another outbox row.
- Confidence outside 0..1 is rejected.

~~~ts
it('records observations and events idempotently with outbox entries', async () => {
  const {
    listTwinEvents,
    listTwinObservations,
    recordTwinEvent,
    recordTwinObservation,
    upsertTwinEntity,
    withPersonalTwinDb,
  } = await import('../../packages/server/src/services/hermes/personal-twin')

  upsertTwinEntity({
    id: 'person:self',
    type: 'person',
    label: 'Self',
    source: 'system',
    sourceId: 'self',
  })

  const input = {
    entityId: 'person:self',
    metric: 'body.weight_kg',
    value: 85,
    unit: 'kg',
    observedAt: '2026-07-08T08:41:00+08:00',
    source: 'health-state:default',
    sourceId: 'scale-reading-1',
    actor: 'scale-sync',
    confidence: 1,
    confirmationState: 'observed' as const,
    evidence: [],
  }
  recordTwinObservation(input)
  recordTwinObservation(input)
  recordTwinEvent({
    eventType: 'health.scale.measured',
    subjectId: 'person:self',
    payload: { sourceDevice: 'Mi Body Composition Scale S400' },
    occurredAt: input.observedAt,
    source: input.source,
    sourceId: input.sourceId,
    actor: input.actor,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [],
  })

  expect(listTwinObservations({ entityId: 'person:self' })).toHaveLength(1)
  expect(listTwinEvents({ subjectId: 'person:self' })).toHaveLength(1)
  expect(withPersonalTwinDb(db => (
    db.prepare("SELECT COUNT(*) AS count FROM twin_outbox WHERE status = 'pending'").get() as { count: number }
  ).count)).toBe(2)
})
~~~

**Step 2: Run the test and verify it fails**

    npx vitest run tests/server/personal-twin-store.test.ts --reporter=dot

Expected: FAIL because observation and event functions do not exist.

**Step 3: Add observation and event inputs**

Add TwinObservationInput and TwinEventInput. Default schemaVersion to 1 only inside the store. Do not default source, sourceId, actor, confidence, or confirmationState.

**Step 4: Implement atomic append functions**

Implement recordTwinObservation and recordTwinEvent with BEGIN IMMEDIATE / COMMIT / ROLLBACK. Use INSERT OR IGNORE for immutable records. Insert the outbox row only when the record insert reports changes === 1.

Outbox topics:

    twin.observation.recorded
    twin.event.recorded

Outbox IDs must derive from the inserted record ID and topic, so duplicate source records cannot create duplicate dispatch rows.

List methods must support fixed filters and sort newest first:

- listTwinObservations({ entityId, metric, limit })
- listTwinEvents({ subjectId, eventType, limit })

**Step 5: Run focused tests and typecheck**

    npx vitest run tests/server/personal-twin-store.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 6: Commit only Task 3 files**

    git add packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/store.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/personal-twin-store.test.ts
    git commit -m "feat: record personal twin facts"

### Task 4: Deterministic Latest-State Projections and Context

**Files:**

- Create: packages/server/src/services/hermes/personal-twin/projectors.ts
- Create: packages/server/src/services/hermes/personal-twin/service.ts
- Modify: packages/server/src/services/hermes/personal-twin/store.ts
- Modify: packages/server/src/services/hermes/personal-twin/index.ts
- Test: tests/server/personal-twin-projectors.test.ts

**Step 1: Write failing projection tests**

Prove that:

- The newest observation becomes latest:<metric>.
- An older observation arriving later does not replace the projection.
- Replaying observations is deterministic.
- Overview creates person:self when the database is empty.
- Context returns bounded observations and events for requested domain prefixes.

~~~ts
it('keeps the newest observation when data arrives out of order', async () => {
  const {
    getTwinProjection,
    recordTwinObservation,
    rebuildTwinProjections,
    upsertTwinEntity,
  } = await import('../../packages/server/src/services/hermes/personal-twin')

  upsertTwinEntity({
    id: 'person:self',
    type: 'person',
    label: 'Self',
    source: 'system',
    sourceId: 'self',
  })

  recordTwinObservation({
    entityId: 'person:self',
    metric: 'body.weight_kg',
    value: 84.5,
    unit: 'kg',
    observedAt: '2026-07-09T08:00:00+08:00',
    source: 'test',
    sourceId: 'new',
    actor: 'test',
    confidence: 1,
    confirmationState: 'observed',
    evidence: [],
  })
  recordTwinObservation({
    entityId: 'person:self',
    metric: 'body.weight_kg',
    value: 85,
    unit: 'kg',
    observedAt: '2026-07-08T08:00:00+08:00',
    source: 'test',
    sourceId: 'old',
    actor: 'test',
    confidence: 1,
    confirmationState: 'observed',
    evidence: [],
  })

  rebuildTwinProjections()

  expect(getTwinProjection('latest:body.weight_kg', 'person:self')?.value).toMatchObject({
    value: 84.5,
    unit: 'kg',
    observedAt: '2026-07-09T08:00:00+08:00',
  })
})
~~~

**Step 2: Run the test and verify it fails**

    npx vitest run tests/server/personal-twin-projectors.test.ts --reporter=dot

Expected: FAIL because projectors and service do not exist.

**Step 3: Implement projectors**

Create projectors.ts with:

- projectObservation(db, observation).
- rebuildTwinProjections().
- getTwinProjection(key, subjectId).

The projection key is latest:<metric>. Compare observedAt as parsed timestamps, then use ingestedAt and ID as deterministic tie breakers. Store this payload:

~~~ts
{
  metric: observation.metric,
  value: observation.value,
  unit: observation.unit,
  observedAt: observation.observedAt,
  source: observation.provenance.source,
  sourceId: observation.provenance.sourceId,
  confidence: observation.provenance.confidence,
  confirmationState: observation.provenance.confirmationState,
}
~~~

Call projectObservation in the same transaction only when recordTwinObservation inserts a new row.

rebuildTwinProjections must delete and deterministically recreate only projection keys owned by the Phase 1 projector. Do not delete future projectors by using DELETE FROM twin_projections WHERE projection_key LIKE 'latest:%'.

**Step 4: Implement overview and context service**

Create service.ts with:

- ensurePrimarySubject(): TwinEntity.
- getPersonalTwinOverview(): TwinOverview.
- getPersonalTwinContext({ domains, query, limit }).

Context domain filters are prefix based and fixed:

- body and health -> body., health.
- fitness and nutrition -> fitness., nutrition.
- home -> home.
- life and work -> life., work.
- entertainment -> entertainment., bilibili.
- commerce -> commerce., food_delivery.
- digital -> digital., app., account.

The optional query filters labels, metrics, event types, and serialized payload text with a bounded LIKE query. Escape percent and underscore before using LIKE.

**Step 5: Run tests and typecheck**

    npx vitest run tests/server/personal-twin-database.test.ts tests/server/personal-twin-store.test.ts tests/server/personal-twin-projectors.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 6: Commit only Task 4 files**

    git add packages/server/src/services/hermes/personal-twin/projectors.ts packages/server/src/services/hermes/personal-twin/service.ts packages/server/src/services/hermes/personal-twin/store.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/personal-twin-projectors.test.ts
    git commit -m "feat: project personal twin state"

### Task 5: Idempotent Legacy Health and Personal State Import

**Files:**

- Create: packages/server/src/services/hermes/personal-twin/legacy-import.ts
- Modify: packages/server/src/services/hermes/personal-twin/types.ts
- Modify: packages/server/src/services/hermes/personal-twin/index.ts
- Test: tests/server/personal-twin-import.test.ts

**Step 1: Write the failing import integration test**

The test must:

- Create default and named-profile source directories.
- Seed Health State using createHealthScaleReading, createHealthRecord, createHealthWorkout, createHealthFoodLog, and createHealthCheckIn.
- Seed Personal State using proposePersonalStateChange and approvePersonalStateProposal.
- Run syncLegacyTwinSources twice.
- Assert the second run does not increase observation, event, or outbox counts.
- Assert both profiles write into one global twin.db.
- Assert a scale reading creates one body.weight_kg observation, despite the mirrored legacy weight record.
- Assert source and sourceId retain the legacy profile and record ID.

Core expectation:

~~~ts
const first = syncLegacyTwinSources()
const second = syncLegacyTwinSources()

expect(second.counts).toEqual(first.counts)
expect(listTwinObservations({
  entityId: 'person:self',
  metric: 'body.weight_kg',
})).toHaveLength(1)
expect(listTwinEvents({ eventType: 'fitness.workout.logged' })).toHaveLength(1)
expect(listTwinEvents({ eventType: 'personal.task.created' })).toHaveLength(1)
~~~

**Step 2: Run the test and verify it fails**

    npx vitest run tests/server/personal-twin-import.test.ts --reporter=dot

Expected: FAIL because legacy-import.ts does not exist.

**Step 3: Define the import result**

Add:

~~~ts
export interface TwinLegacyImportResult {
  runId: string
  profiles: string[]
  status: 'completed' | 'failed'
  counts: {
    entities: number
    observations: number
    events: number
    goals: number
    constraints: number
  }
  startedAt: string
  completedAt: string
}
~~~

**Step 4: Implement source discovery and fingerprinting**

Use listProfileNamesFromDisk() by default. Accept an optional profiles array and normalize it against known profiles.

The run fingerprint must include:

- Importer version.
- Sorted profile names.
- Health and Personal State source database paths.
- Source file size and mtime when present.

Record the run in twin_import_runs. Reusing the same fingerprint returns the existing completed result after ensuring deterministic record IDs make replay harmless. Never mark a failed run completed.

**Step 5: Implement conservative legacy mapping**

Use getHealthOverview({ profile, includeRecords: true }) and getPersonalStateOverview({ profile, limit: 10000 }). Do not query private legacy tables from the importer.

Create person:self and body:self once.

Map Health Profile:

- Height and stable profile data -> person:self attributes.
- Goals -> twin_goals with source health-state:<profile>.
- Allergies and conditions -> hard or advisory constraints; preserve original values without medical inference.

Map Health Records:

- scale_reading -> event health.scale.measured plus one observation per numeric composition field.
- weight -> body.weight_kg unless a scale_reading with the same source and recordedAt already supplied it.
- body_measurement -> one body.measurement.<key> observation for each numeric measurement.
- posture_assessment -> event health.posture.assessed.
- skin_assessment -> event health.skin.assessed.
- other records -> event health.record.<normalized-kind>.

Map other Health collections:

- workouts -> fitness.workout.logged.
- foodLogs -> nutrition.meal.logged.
- dailyCheckins -> health.daily_checkin.recorded.
- dailyPlans -> health.plan.recorded.
- bodyMap rows -> health.body_region.assessed.
- supplementLogs -> health.supplement.taken.

Map Personal State:

- proposals -> personal.proposal.created or personal.proposal.reviewed according to status.
- tasks -> personal.task.created with current status in payload.

Use stable source IDs in this format:

    health-state:<profile>:<collection>:<legacy-id>
    personal-state:<profile>:<collection>:<legacy-id>

Keep original payloads under payload.legacy. Do not reinterpret unknown fields.

**Step 6: Run import and regression tests**

    npx vitest run tests/server/personal-twin-import.test.ts tests/server/health-state-service.test.ts tests/server/personal-state-service.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 7: Commit only Task 5 files**

    git add packages/server/src/services/hermes/personal-twin/legacy-import.ts packages/server/src/services/hermes/personal-twin/types.ts packages/server/src/services/hermes/personal-twin/index.ts tests/server/personal-twin-import.test.ts
    git commit -m "feat: import legacy personal twin state"

### Task 6: Protected Personal Twin HTTP API

**Files:**

- Create: packages/server/src/controllers/hermes/personal-twin.ts
- Create: packages/server/src/routes/hermes/personal-twin.ts
- Modify: packages/server/src/routes/index.ts
- Test: tests/server/personal-twin-controller.test.ts
- Test: tests/server/personal-twin-routes.test.ts

**Step 1: Write failing controller tests**

Mock the Personal Twin service module and assert:

- overview returns the global overview.
- entities, observations, and events parse fixed query filters.
- context parses a comma-separated domains query and bounded limit.
- legacy import passes only a normalized profiles string array.
- a profile query does not reach a storage selector.

~~~ts
it('returns global overview without profile-scoped storage', async () => {
  const { overview } = await import(
    '../../packages/server/src/controllers/hermes/personal-twin'
  )
  const ctx: any = {
    query: { profile: 'coach' },
    request: { body: {} },
    state: { user: { id: 'local', role: 'super_admin' } },
    body: null,
  }

  await overview(ctx)

  expect(getPersonalTwinOverview).toHaveBeenCalledWith()
  expect(ctx.body).toEqual({ overview: { subject: { id: 'person:self' } } })
})
~~~

**Step 2: Write failing route tests**

Expect exactly the six Phase 1 paths and verify GET/POST method delegation.

**Step 3: Run tests and verify they fail**

    npx vitest run tests/server/personal-twin-controller.test.ts tests/server/personal-twin-routes.test.ts --reporter=dot

Expected: FAIL because controller and route modules do not exist.

**Step 4: Implement bounded controllers**

Create controller functions:

- overview.
- entities.
- observations.
- events.
- context.
- importLegacy.

Use a shared integerQuery helper that clamps 1..200. Reject malformed profiles bodies with HTTP 400. Let service errors reach the existing server error middleware; do not leak database paths in custom error bodies.

**Step 5: Register routes**

Create personal-twin.ts:

~~~ts
import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/personal-twin'

export const personalTwinRoutes = new Router()

personalTwinRoutes.get('/api/hermes/personal-twin/overview', ctrl.overview)
personalTwinRoutes.get('/api/hermes/personal-twin/entities', ctrl.entities)
personalTwinRoutes.get('/api/hermes/personal-twin/observations', ctrl.observations)
personalTwinRoutes.get('/api/hermes/personal-twin/events', ctrl.events)
personalTwinRoutes.get('/api/hermes/personal-twin/context', ctrl.context)
personalTwinRoutes.post('/api/hermes/personal-twin/imports/legacy', ctrl.importLegacy)
~~~

Import personalTwinRoutes in packages/server/src/routes/index.ts and register it in the protected route section next to Personal State and Health State.

**Step 6: Run API tests and typecheck**

    npx vitest run tests/server/personal-twin-controller.test.ts tests/server/personal-twin-routes.test.ts --reporter=dot
    npx tsc --noEmit -p packages/server/tsconfig.json

Expected: PASS.

**Step 7: Commit only Task 6 files**

    git add packages/server/src/controllers/hermes/personal-twin.ts packages/server/src/routes/hermes/personal-twin.ts packages/server/src/routes/index.ts tests/server/personal-twin-controller.test.ts tests/server/personal-twin-routes.test.ts
    git commit -m "feat: expose personal twin api"

### Task 7: Client API Contracts

**Files:**

- Create: packages/client/src/api/hermes/personal-twin.ts
- Test: tests/client/personal-twin-api.test.ts

**Step 1: Write the failing client API test**

Mock request exactly as tests/client/personal-state-api.test.ts does. Assert query encoding and method/body:

~~~ts
await fetchPersonalTwinOverview()
await fetchPersonalTwinEntities({ type: 'person', limit: 20 })
await fetchPersonalTwinObservations({
  entityId: 'person:self',
  metric: 'body.weight_kg',
  limit: 30,
})
await fetchPersonalTwinEvents({ eventType: 'fitness.workout.logged', limit: 10 })
await fetchPersonalTwinContext({
  domains: ['body', 'health'],
  query: 'weight',
  limit: 25,
})
await syncLegacyPersonalTwin(['default', 'coach'])

expect(mockRequest.mock.calls).toEqual([
  ['/api/hermes/personal-twin/overview'],
  ['/api/hermes/personal-twin/entities?type=person&limit=20'],
  ['/api/hermes/personal-twin/observations?entityId=person%3Aself&metric=body.weight_kg&limit=30'],
  ['/api/hermes/personal-twin/events?eventType=fitness.workout.logged&limit=10'],
  ['/api/hermes/personal-twin/context?domains=body%2Chealth&query=weight&limit=25'],
  ['/api/hermes/personal-twin/imports/legacy', {
    method: 'POST',
    body: JSON.stringify({ profiles: ['default', 'coach'] }),
  }],
])
~~~

**Step 2: Run the test and verify it fails**

    npx vitest run tests/client/personal-twin-api.test.ts --reporter=dot

Expected: FAIL because the client module does not exist.

**Step 3: Implement the client module**

Re-export the read model interfaces needed by UI callers. Use URLSearchParams for every list call. Do not add profile to any Twin endpoint.

Functions:

- fetchPersonalTwinOverview.
- fetchPersonalTwinEntities.
- fetchPersonalTwinObservations.
- fetchPersonalTwinEvents.
- fetchPersonalTwinContext.
- syncLegacyPersonalTwin.

The client does not expose arbitrary create/update fact methods in Phase 1.

**Step 4: Run client tests and client typecheck**

    npx vitest run tests/client/personal-twin-api.test.ts --reporter=dot
    npx vue-tsc -b

Expected: PASS.

**Step 5: Commit only Task 7 files**

    git add packages/client/src/api/hermes/personal-twin.ts tests/client/personal-twin-api.test.ts
    git commit -m "feat: add personal twin client api"

### Task 8: OpenAPI and Hermes MCP Discovery

**Files:**

- Modify: scripts/generate-openapi.mjs
- Modify: bin/hermes-web-ui-mcp.mjs
- Modify: tests/server/api-docs-controller.test.ts
- Generate: docs/openapi.json

**Step 1: Write the failing API docs assertion**

Add to tests/server/api-docs-controller.test.ts:

~~~ts
expect(ctx.body.paths['/api/hermes/personal-twin/overview'].get.tags).toEqual([
  'Personal Twin',
])
expect(ctx.body.paths['/api/hermes/personal-twin/imports/legacy'].post).toBeTruthy()
~~~

Run:

    npx vitest run tests/server/api-docs-controller.test.ts --reporter=dot

Expected: FAIL because generated OpenAPI has no Personal Twin routes.

**Step 2: Add the route tag mapping**

Add to tagMappings in scripts/generate-openapi.mjs:

~~~js
'routes/hermes/personal-twin.ts': {
  name: 'Personal Twin',
  description: 'Global personal digital twin state and legacy synchronization',
},
~~~

**Step 3: Add the compact MCP module hint**

Add to moduleHints in bin/hermes-web-ui-mcp.mjs:

~~~js
'Personal Twin': {
  purpose: 'Read the global personal digital twin, context, events, observations, and import status.',
  keywords: ['personal twin', 'digital twin', 'body state', 'life state', 'observations', 'events'],
},
~~~

**Step 4: Regenerate OpenAPI**

Run:

    npm run openapi:generate

Expected: docs/openapi.json is updated and console output reports successful generation.

**Step 5: Run API docs and MCP tests**

Run:

    npx vitest run tests/server/api-docs-controller.test.ts tests/server/llm-prompt.test.ts --reporter=dot
    node bin/hermes-web-ui-mcp.mjs --help

Expected: tests PASS and MCP help exits successfully.

**Step 6: Commit only Task 8 files**

    git add scripts/generate-openapi.mjs bin/hermes-web-ui-mcp.mjs tests/server/api-docs-controller.test.ts docs/openapi.json
    git commit -m "docs: expose personal twin operations"

### Task 9: Full Phase 1 Verification

**Files:**

- Verify all Phase 1 files.
- Do not modify unrelated dirty files to make verification easier.

**Step 1: Run the focused Personal Twin suite**

    npx vitest run tests/server/personal-twin-database.test.ts tests/server/personal-twin-store.test.ts tests/server/personal-twin-projectors.test.ts tests/server/personal-twin-import.test.ts tests/server/personal-twin-controller.test.ts tests/server/personal-twin-routes.test.ts tests/client/personal-twin-api.test.ts tests/server/api-docs-controller.test.ts --reporter=dot

Expected: all test files and tests PASS.

**Step 2: Run source-domain regressions**

    npx vitest run tests/server/health-state-service.test.ts tests/server/personal-state-service.test.ts tests/server/health-state-controller.test.ts tests/server/personal-state-controller.test.ts tests/client/health-state-api.test.ts tests/client/personal-state-api.test.ts --reporter=dot

Expected: PASS. Legacy source behavior is unchanged.

**Step 3: Run both typechecks**

    npx tsc --noEmit -p packages/server/tsconfig.json
    npx vue-tsc -b

Expected: both commands exit 0.

**Step 4: Regenerate OpenAPI and verify a clean generated result**

    npm run openapi:generate
    git diff --check

Expected: OpenAPI generation succeeds and git diff --check prints no errors.

**Step 5: Inspect commit and worktree scope**

    git status --short
    git log --oneline --max-count=12

Expected:

- Phase 1 commits contain only files explicitly staged by each task.
- Existing unrelated working-tree changes remain present and untouched.
- No database, credential, artifact, log, or temporary test file is tracked.

**Step 6: Record the implementation handoff**

Report:

- Exact test and typecheck results.
- Legacy import counts from a temporary test database only.
- Any source records intentionally deferred to Phase 4 domain projection.
- Remaining work: Assistant Roles and Context policy, Action Fabric, Health dual-write/event loop, Home Assistant, MCP/browser executors, Android companion, and commerce.

Do not claim Phase 2 or later capabilities are implemented.

## Phase 1 Completion Definition

Phase 1 is complete only when:

- <HERMES_HOME>/personal/twin.db is independent of Hermes Profile selection.
- Core Twin schema initializes with WAL and foreign keys.
- Entities and relations upsert deterministically by provenance.
- Observations and events are immutable, idempotent, and create transactional outbox rows.
- Latest-observation projections remain correct under out-of-order ingestion and replay.
- Existing Health State and Personal State can be imported twice without duplication.
- Source databases remain unchanged.
- Read and explicit import APIs are protected and available through generated OpenAPI and Hermes Studio MCP.
- The client API compiles without changing current Personal OS screens.
- Focused tests, source regressions, and both typechecks pass.
