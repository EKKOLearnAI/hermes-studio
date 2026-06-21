# Hermes Studio Health Operating System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a native Hermes Studio health module with Body3D, smart diet, smart fitness, old data migration, and Hermes Agent health context.

**Architecture:** Add a profile-scoped `health_state.db` service in Hermes Studio using the existing Personal State SQLite patterns. Migrate old health data from `personal-assistant`, port the deterministic health planning logic to TypeScript, build a Vue health cockpit, and expose concise health context to Hermes Agent through a skill.

**Tech Stack:** TypeScript, Koa, `node:sqlite`, Vue 3, Vite, Vitest, Three.js, local SQLite, Hermes Agent skills.

---

### Task 1: Health State Service Skeleton

**Files:**
- Create: `packages/server/src/services/hermes/health-state.ts`
- Test: `tests/server/health-state-service.test.ts`

**Step 1: Write failing tests**

Add tests that call:

- `getHealthStateDbPath('default')`
- `getHealthOverview({ profile: 'default' })`

Expected behavior:

- default profile resolves to `~/.hermes/health_state.db`
- overview initializes an empty database
- overview returns empty arrays and neutral defaults

**Step 2: Run tests**

Run:

```bash
npx vitest run tests/server/health-state-service.test.ts --reporter=dot
```

Expected: FAIL because the service does not exist.

**Step 3: Implement minimal service**

Use `packages/server/src/services/hermes/personal-state.ts` as the pattern:

- `DatabaseSync`
- `getProfileDir`
- WAL pragma
- JSON parse/stringify helpers
- idempotent `CREATE TABLE IF NOT EXISTS`

Create initial tables:

- `health_meta`
- `health_profile`
- `health_body_map`
- `health_records`
- `health_workouts`
- `health_food_items`
- `health_food_logs`
- `health_food_templates`
- `health_supplements`
- `health_supplement_logs`
- `health_daily_plans`
- `health_daily_checkins`

**Step 4: Run tests**

Run:

```bash
npx vitest run tests/server/health-state-service.test.ts --reporter=dot
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/services/hermes/health-state.ts tests/server/health-state-service.test.ts
git commit -m "feat: add health state service skeleton"
```

### Task 2: Health Overview Aggregation

**Files:**
- Modify: `packages/server/src/services/hermes/health-state.ts`
- Test: `tests/server/health-state-service.test.ts`

**Step 1: Write failing tests**

Seed rows for:

- weight records
- food logs
- workouts
- supplements
- body map
- daily plan

Assert `getHealthOverview` returns:

- current weight
- target weight
- nutrition targets, consumed, and remaining
- recent workouts
- top body concerns
- latest plan
- supplement status

**Step 2: Run tests**

Expected: FAIL because aggregation is incomplete.

**Step 3: Implement aggregation**

Implement deterministic helpers:

- `getWeightSummary(records)`
- `getNutritionSummary(profile, foodLogs)`
- `getTopBodyConcerns(bodyMap)`
- `getRecentWorkouts(workouts)`
- `getSupplementSummary(supplements, logs)`

Port only the old logic needed for MVP.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/services/hermes/health-state.ts tests/server/health-state-service.test.ts
git commit -m "feat: aggregate health overview"
```

### Task 3: Health Routes And Controller

**Files:**
- Create: `packages/server/src/controllers/hermes/health-state.ts`
- Create: `packages/server/src/routes/hermes/health-state.ts`
- Modify: `packages/server/src/routes/hermes/index.ts`
- Test: `tests/server/health-state-routes.test.ts`
- Test: `tests/server/health-state-controller.test.ts`

**Step 1: Write failing route tests**

Cover:

- `GET /api/hermes/health/overview`
- `GET /api/hermes/health/profile`
- `PUT /api/hermes/health/profile`
- `GET /api/hermes/health/body-map`
- `PUT /api/hermes/health/body-map`
- `GET /api/hermes/health/records`
- `POST /api/hermes/health/records`
- `GET /api/hermes/health/workouts`
- `POST /api/hermes/health/workouts`
- `GET /api/hermes/health/food/items`
- `GET /api/hermes/health/food/logs`
- `POST /api/hermes/health/food/logs`
- `GET /api/hermes/health/today-plan`
- `POST /api/hermes/health/check-ins`

**Step 2: Run tests**

Expected: FAIL because routes do not exist.

**Step 3: Implement routes and controller**

Follow the Personal State controller style:

- parse `profile`
- validate minimal request bodies
- return `{ overview }`, `{ profile }`, `{ bodyMap }`, etc.
- keep domain logic inside service

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/controllers/hermes/health-state.ts packages/server/src/routes/hermes/health-state.ts packages/server/src/routes/hermes/index.ts tests/server/health-state-routes.test.ts tests/server/health-state-controller.test.ts
git commit -m "feat: expose health state api"
```

### Task 4: Old Health Data Importer

**Files:**
- Create: `scripts/import-personal-assistant-health.mjs`
- Test: `tests/server/health-state-import.test.ts`

**Step 1: Write failing importer tests**

Create a temporary old SQLite database with representative rows from:

- `life_awakening_health_stats`
- `life_health_records`
- `life_health_workouts`
- `life_awakening_food_logs`
- `life_awakening_food_templates`
- `food_items`
- `life_awakening_medications`
- `life_health_supplement_logs`
- `life_health_daily_plans`
- `life_health_daily_checkins`

Assert repeated imports do not duplicate rows.

**Step 2: Run tests**

Expected: FAIL because importer does not exist.

**Step 3: Implement importer**

Use source markers:

- `source = 'personal-assistant-import'`
- `source_id = '<old-table>:<old-id>'`

Support CLI:

```bash
node scripts/import-personal-assistant-health.mjs --source D:/code/my_project/personal-assistant/data/life_awakening.db --profile default
```

**Step 4: Run tests**

Expected: PASS.

**Step 5: Run real import after backing up DB**

Back up:

```bash
Copy-Item C:\Users\Administrator\.hermes\health_state.db D:\code\hermes-data-backups\<timestamp>-before-health-import\health_state.db
```

Then import.

**Step 6: Commit**

```bash
git add scripts/import-personal-assistant-health.mjs tests/server/health-state-import.test.ts
git commit -m "feat: import personal assistant health data"
```

### Task 5: Health API Client

**Files:**
- Create: `packages/client/src/api/hermes/health-state.ts`
- Test: `tests/client/health-state-api.test.ts`

**Step 1: Write failing client tests**

Assert request paths and profile query behavior for:

- `fetchHealthOverview`
- `fetchHealthProfile`
- `updateHealthProfile`
- `fetchHealthBodyMap`
- `updateHealthBodyMap`
- `fetchHealthRecords`
- `createHealthRecord`
- `fetchHealthWorkouts`
- `createHealthWorkout`
- `fetchFoodItems`
- `fetchFoodLogs`
- `createFoodLog`
- `fetchTodayPlan`
- `createHealthCheckIn`

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement API client**

Use the same `request` helper and `withProfile` pattern used by Personal State.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/client/src/api/hermes/health-state.ts tests/client/health-state-api.test.ts
git commit -m "feat: add health state client api"
```

### Task 6: Body3D Assets And Mapping

**Files:**
- Create: `packages/client/public/models/health/bodyparts3d/*`
- Create: `packages/client/public/models/health/README.md`
- Create: `packages/client/public/models/health/LICENSE.txt`
- Create: `packages/client/src/views/hermes/health/body-visualization.ts`
- Create: `packages/client/src/views/hermes/health/body-3d-model-mapping.ts`
- Test: `tests/client/health-body-visualization.test.ts`

**Step 1: Write failing mapping tests**

Test:

- region status tone from body map
- posture overlay visibility
- compensation-chain region derivation
- selected region summary
- related workout derivation

**Step 2: Copy assets**

Copy the old redistributable assets from:

```text
D:/code/my_project/personal-assistant/frontend-next/public/models/health
```

to:

```text
packages/client/public/models/health
```

**Step 3: Port deterministic mapping helpers**

Port TypeScript helpers from the old React frontend, changing imports and types for Studio.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/client/public/models/health packages/client/src/views/hermes/health/body-visualization.ts packages/client/src/views/hermes/health/body-3d-model-mapping.ts tests/client/health-body-visualization.test.ts
git commit -m "feat: add health body model assets and mapping"
```

### Task 7: Vue Body3D Component

**Files:**
- Create: `packages/client/src/views/hermes/health/HealthBody3DViewer.vue`
- Test: `tests/client/health-body-3d-viewer.test.ts`

**Step 1: Write failing component tests**

Use deterministic assertions:

- renders fallback when WebGL is unavailable
- renders selected region label
- camera preset buttons exist
- layer toggles affect props/state

Do not unit-test WebGL internals.

**Step 2: Implement Vue + Three.js viewer**

Use plain Three.js:

- `Scene`
- `PerspectiveCamera`
- `WebGLRenderer`
- `STLLoader`
- raycasting for click selection
- simple orbit controls if available, otherwise mouse drag rotation

Keep all model-specific mapping in helper files.

**Step 3: Run tests**

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/client/src/views/hermes/health/HealthBody3DViewer.vue tests/client/health-body-3d-viewer.test.ts
git commit -m "feat: add vue health body 3d viewer"
```

### Task 8: Health View

**Files:**
- Create: `packages/client/src/views/hermes/HealthView.vue`
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/views/hermes/PersonalOSView.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/client/health-view.test.ts`
- Test: `tests/client/personal-os-view.test.ts`

**Step 1: Write failing view tests**

Assert:

- `/hermes/personal-os/health` route renders
- Personal OS health card links to health route
- tabs exist: overview, Body3D, smart diet, smart fitness
- overview shows weight, nutrition gap, plan, body concerns
- diet tab shows food logs and quick form
- fitness tab shows workouts and check-in form

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement route and view**

Build a dense operational UI, not a landing page.

Use:

- restrained dashboard layout
- tabs
- compact metric panels
- timeline/list sections where useful
- no marketing hero

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/client/src/views/hermes/HealthView.vue packages/client/src/router/index.ts packages/client/src/views/hermes/PersonalOSView.vue packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts tests/client/health-view.test.ts tests/client/personal-os-view.test.ts
git commit -m "feat: add personal os health view"
```

### Task 9: Hermes Agent Health Skill

**Files:**
- Create: `D:/code/hermes-agent/skills/health/personal-health-system/SKILL.md`
- Modify: `D:/code/hermes-agent/tests/tools/test_personal_state_store.py` only if adding shared context there is required
- Test: use Hermes Agent skill validation command already used for planning skills

**Step 1: Write the skill**

The skill should instruct Hermes to:

- load health context before diet, training, sleep, or fat-loss advice
- treat health DB data as factual state
- distinguish records from recommendations
- ask before creating or changing health facts unless the user clearly requests it
- use Body Map, nutrition gap, and training state in planning

**Step 2: Validate skill**

Run the existing skill validation command used in Hermes Agent.

Expected: PASS.

**Step 3: Commit**

```bash
git -C D:/code/hermes-agent add skills/health/personal-health-system/SKILL.md
git -C D:/code/hermes-agent commit -m "feat: add personal health system skill"
```

### Task 10: End-To-End Verification

**Files:**
- No new files unless fixing issues found during verification.

**Step 1: Run focused tests**

Run:

```bash
npx vitest run tests/server/health-state-service.test.ts tests/server/health-state-routes.test.ts tests/server/health-state-controller.test.ts tests/server/health-state-import.test.ts tests/client/health-state-api.test.ts tests/client/health-body-visualization.test.ts tests/client/health-body-3d-viewer.test.ts tests/client/health-view.test.ts tests/client/personal-os-view.test.ts --reporter=dot
```

Expected: PASS.

**Step 2: Run broader affected tests**

Run:

```bash
npx vitest run tests/server/personal-state-service.test.ts tests/client/personal-os-view.test.ts tests/client/smart-planning-view.test.ts --reporter=dot
```

Expected: PASS.

**Step 3: Start dev server**

Run:

```bash
npm run dev
```

Expected: Studio remains available at the current local dev URL.

**Step 4: Browser verification**

Open:

- `/hermes/personal-os`
- `/hermes/personal-os/health`

Verify:

- health card links correctly
- migrated data appears
- Body3D area is nonblank
- selecting a body region updates details
- diet and fitness tabs render migrated records

**Step 5: Commit verification fixes**

If fixes were required:

```bash
git add <changed-files>
git commit -m "fix: verify health module integration"
```
