# Health Digital Twin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Body3D-centered personal health digital twin with external health, internal markers, micronutrient summaries, and migrated old Personal Assistant health data.

**Architecture:** Extend the existing `health-state` service with derived summaries rather than adding new tables first. Keep Body3D as the primary UI object and render External/Internal/Plan sections from the same Health Overview API. Enhance the existing migration script to preserve micronutrient payloads from old food items and food logs.

**Tech Stack:** TypeScript, Vue 3, Vitest, Koa routes, Node `node:sqlite`, existing Hermes Studio API client.

---

### Task 1: Derived Digital Twin Health Summary

**Files:**
- Modify: `packages/server/src/services/hermes/health-state.ts`
- Test: `tests/server/health-state-service.test.ts`

**Step 1: Write failing tests**

Add a test that seeds `health_profile`, `health_body_map`, `health_records`, `health_food_logs`, and `health_workouts`, then expects `getHealthOverview()` to include:

- `digitalTwinSummary`
- `externalSummary`
- `internalMarkers`
- `micronutrientSummary`

**Step 2: Run test to verify failure**

Run:

```powershell
npx vitest run tests/server/health-state-service.test.ts --reporter=dot
```

Expected: fails because those overview fields do not exist.

**Step 3: Implement minimal service code**

Add TypeScript interfaces and derived builders:

- `buildDigitalTwinSummary`
- `buildExternalSummary`
- `buildInternalMarkers`
- `buildMicronutrientSummary`

**Step 4: Run tests**

Run the same Vitest command and `npx tsc --noEmit -p packages/server/tsconfig.json`.

**Step 5: Commit**

```powershell
git add packages/server/src/services/hermes/health-state.ts tests/server/health-state-service.test.ts
git commit -m "feat: derive health digital twin summary"
```

### Task 2: Preserve Old Micronutrient Data In Import

**Files:**
- Modify: `scripts/import-personal-assistant-health.mjs`
- Test: `tests/server/health-state-import.test.ts`

**Step 1: Write failing tests**

Extend the import fixture with:

- `food_items.sodium_per_100g`, `potassium_per_100g`, `vitamin_c_per_100g`
- `life_awakening_food_logs.micros`
- `life_health_records.source_tag`, `source_id`

Expect imported `foodItems`, `foodLogs`, and `records` to preserve those fields in structured payloads.

**Step 2: Run test to verify failure**

```powershell
npx vitest run tests/server/health-state-import.test.ts --reporter=dot
```

**Step 3: Implement import mapping**

Map micronutrients into `nutrition.micros` and health record provenance into `value` or metadata without losing existing macro fields.

**Step 4: Run tests**

Run import and service tests.

**Step 5: Run real import**

Back up target DBs, then run:

```powershell
node scripts/import-personal-assistant-health.mjs --source "D:\code\my_project\personal-assistant\data\life_awakening.db" --profile default
```

Verify counts and sample micronutrient rows.

**Step 6: Commit**

```powershell
git add scripts/import-personal-assistant-health.mjs tests/server/health-state-import.test.ts
git commit -m "feat: preserve health micronutrient import"
```

### Task 3: Health API And Client Types

**Files:**
- Modify: `packages/client/src/api/hermes/health-state.ts`
- Test: `tests/client/health-state-api.test.ts`

**Step 1: Write failing tests**

Expect the `HealthOverview` client type to expose digital twin, external, internal marker, and micronutrient fields.

**Step 2: Run test**

```powershell
npx vitest run tests/client/health-state-api.test.ts --reporter=dot
```

**Step 3: Implement client types**

Add explicit interfaces for the new overview sections.

**Step 4: Run test**

Run the same test.

**Step 5: Commit**

```powershell
git add packages/client/src/api/hermes/health-state.ts tests/client/health-state-api.test.ts
git commit -m "feat: type health digital twin overview"
```

### Task 4: Body3D Digital Twin View

**Files:**
- Modify: `packages/client/src/views/hermes/HealthView.vue`
- Modify: `packages/client/src/views/hermes/health/HealthBody3DViewer.vue`
- Test: `tests/client/health-view.test.ts`
- Test: `tests/client/health-body-3d-viewer.test.ts`

**Step 1: Write failing tests**

Expect Health view to render:

- `健康数字孪生`
- Body3D before side panels
- mode controls for external/internal/plan
- external health panel
- internal markers panel
- micronutrient summary panel

**Step 2: Run tests**

```powershell
npx vitest run tests/client/health-view.test.ts tests/client/health-body-3d-viewer.test.ts --reporter=dot
```

**Step 3: Implement UI**

Rework the Health view first screen:

- large twin stage
- summary strip
- mode tabs
- External/Internal/Plan panels

Keep cards shallow and avoid nested cards.

**Step 4: Run tests**

Run health client tests.

**Step 5: Commit**

```powershell
git add packages/client/src/views/hermes/HealthView.vue packages/client/src/views/hermes/health/HealthBody3DViewer.vue tests/client/health-view.test.ts tests/client/health-body-3d-viewer.test.ts
git commit -m "feat: make health view a digital twin cockpit"
```

### Task 5: Browser Verification

**Files:**
- No code changes unless verification finds defects.

**Step 1: Run full focused tests**

```powershell
npx vitest run tests/server/health-state-service.test.ts tests/server/health-state-import.test.ts tests/client/health-state-api.test.ts tests/client/health-body-visualization.test.ts tests/client/health-body-3d-viewer.test.ts tests/client/health-view.test.ts --reporter=dot
npx tsc --noEmit -p packages/server/tsconfig.json
```

**Step 2: Verify in browser**

Open:

```text
http://localhost:8649/#/hermes/personal-os/health
```

Confirm the visible page shows Body3D digital twin, external health, internal markers, micronutrients, and today plan.

**Step 3: Commit any verification fix**

Only if a defect is found, fix with a failing test first and commit separately.
