# Hermes Studio Health Operating System Design

**Date:** 2026-06-21

**Status:** Approved

## Goal

Move the user's existing health, Body3D, smart diet, and smart fitness systems from `my_project/personal-assistant` into Hermes Studio as a native Personal OS module.

The first version should be a complete health cockpit MVP: it must preserve the user's migrated health data, show an interactive 3D body map, support daily diet and supplement execution, support workout and posture-aware fitness planning, and expose enough context for Hermes Agent to understand the user's body state and fat-loss execution.

## Current Context

Hermes Studio already has a modular Personal OS surface:

- `/hermes/personal-os`
- `/hermes/personal-os/planning`
- profile-scoped Personal State storage under Hermes profile directories
- Personal State APIs and UI patterns for SQLite-backed local state

The old personal assistant project already contains a strong health-system prototype:

- health records and weight records
- workout logs
- daily health plans and check-ins
- food logs
- food templates
- a food item database
- medication and supplement logs
- health profile JSON
- muscle Body Map JSON
- nutrition configuration JSON
- supplement configuration JSON
- Three.js Body3D STL assets and region mapping logic

Observed old data counts:

- food database: 174 rows
- food logs: 28 rows
- food templates: 22 rows
- medications/supplements: 12 rows
- daily health plans: 11 rows
- daily check-ins: 12 rows
- health records: 9 rows
- workout logs: 40 rows

## Product Direction

The health module should be a `Health Operating System`, not a passive record viewer.

The default job is to answer:

- What is my current body and fat-loss state?
- What should I eat next today?
- What training or recovery action should I take today?
- Which body regions or posture issues need attention?
- What should Hermes know before giving health, diet, schedule, or training advice?

## Recommended Architecture

Create Hermes Studio native health state instead of embedding the old FastAPI service.

This means:

- add a profile-scoped `health_state.db`
- add Hermes Studio server services/controllers/routes for health state
- write an importer from `personal-assistant/data/life_awakening.db`
- reuse old data models where they are already good
- port old deterministic health planning rules to TypeScript
- rewrite the Body3D viewer as Vue + Three.js
- copy the redistributable STL assets into Studio public assets
- link the Personal OS health module card to `/hermes/personal-os/health`
- add a Hermes Agent skill/context surface for health state

This avoids keeping the deprecated personal assistant app alive as a runtime dependency.

## Information Architecture

The first Studio health module has four tabs.

### 1. Overview

The overview is the daily decision surface.

It shows:

- current weight
- target weight
- latest body-fat value when available
- recent weight trend
- today's health plan
- today's nutrition gap
- supplement completion status
- today's workout or recovery guidance
- top Body Map concerns
- posture focus and risk notes

This page should make the next action obvious within one minute.

### 2. Body3D

Body3D is the visual body-state layer.

It shows:

- a rotatable 3D body model
- camera presets: front, back, left, right
- clickable body regions: chest, shoulders, biceps, forearms, abs, lats, glutes, quads, hamstrings, calves
- region colors derived from Body Map status
- posture issue overlays
- compensation-chain overlays
- selected-region details
- related recent workout for the selected region

The old React component cannot be copied directly because Hermes Studio uses Vue. Reuse the STL assets, mapping tables, status rules, and posture overlay definitions; rewrite rendering with plain Three.js inside a Vue component.

### 3. Smart Diet

Smart Diet is an action-oriented diet execution surface.

It shows:

- a top `today gap` panel for calories, protein, carbs, fat, fiber, and water
- current consumed values
- remaining values
- status labels such as low protein, close to fat limit, or under-eating risk
- food log grouped by breakfast, lunch, dinner, snack, and uncategorized
- quick food log form
- template meal picker
- supplement one-tap check-in
- low-frequency settings for nutrition defaults and templates

First version should migrate and expose the old food database and templates. AI photo recognition is explicitly deferred.

### 4. Smart Fitness

Smart Fitness is the training and posture-correction execution surface.

It shows:

- today's training recommendation
- day state such as normal training, recovery priority, or correction priority
- focus muscle groups
- posture focus
- recent workout logs
- quick workout creation
- daily check-in form for workout status, activation score, pain score, and energy score
- Body Map summary
- staged posture-correction plan when posture profile data exists

Fitness recommendations should remain rule-engine first. AI can interpret or explain, but the first version should produce deterministic, inspectable outputs.

## Data Model

Use a profile-scoped SQLite database:

- default profile: `~/.hermes/health_state.db`
- named profiles: `~/.hermes/profiles/<profile>/health_state.db`

Recommended tables:

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
- `health_meta`

Stable profile-style data may be stored as JSON where the old system already used JSON:

- profile data
- posture profile
- muscle map
- nutrition defaults
- supplement defaults

Execution facts should be rows:

- weight records
- workout records
- food logs
- supplement logs
- daily check-ins

## API Surface

Add Hermes Studio APIs under:

- `GET /api/hermes/health/overview`
- `GET /api/hermes/health/profile`
- `PUT /api/hermes/health/profile`
- `GET /api/hermes/health/body-map`
- `PUT /api/hermes/health/body-map`
- `GET /api/hermes/health/records`
- `POST /api/hermes/health/records`
- `PUT /api/hermes/health/records/:id`
- `DELETE /api/hermes/health/records/:id`
- `GET /api/hermes/health/workouts`
- `POST /api/hermes/health/workouts`
- `GET /api/hermes/health/food/items`
- `GET /api/hermes/health/food/logs`
- `POST /api/hermes/health/food/logs`
- `GET /api/hermes/health/food/templates`
- `POST /api/hermes/health/food/templates`
- `GET /api/hermes/health/supplements`
- `POST /api/hermes/health/supplements/:id/check-in`
- `GET /api/hermes/health/today-plan`
- `POST /api/hermes/health/check-ins`

Every endpoint must support the same profile selector behavior used by Personal State.

## Hermes Agent Context

Hermes should be able to read a concise health context before giving advice.

The context should include:

- current weight and target
- latest weight trend
- today's nutrition consumed/target/remaining
- today's supplement status
- today's training state and recommendation
- recent workout summary
- top Body Map risks
- posture focus
- relevant fat-loss goal

This should be exposed through a Hermes Agent skill and/or Personal State-adjacent tool context. The skill should tell Hermes to treat the health database as factual state, and to create proposed changes instead of silently modifying records when user confirmation is needed.

## Migration

Write an idempotent importer from:

- `D:/code/my_project/personal-assistant/data/life_awakening.db`

to:

- `~/.hermes/health_state.db`

The importer must preserve old IDs using source markers so repeated runs do not duplicate data.

The importer should migrate:

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

It should not delete old data.

## Error Handling

- Missing health database: initialize empty state and show setup empty states.
- Missing migrated data: render neutral health plan, not a crash.
- Invalid JSON from old rows: skip that field, record import warning, continue.
- WebGL unavailable: show a non-3D fallback with Body Map list and posture details.
- Missing STL asset: show model load failure, keep the rest of the health module usable.
- Sparse diet data: show certainty gaps rather than pretending all nutrition is known.

## Out Of Scope

First version does not include:

- AI photo food recognition
- automated body photo or video posture diagnosis
- medical-grade body diagnosis
- full exercise library or periodization engine
- external wearable integration
- exhaustive nutrition database expansion

## Testing Strategy

Backend tests should cover:

- database initialization and migration
- overview aggregation
- today-plan generation
- profile read/write
- body map read/write
- health records CRUD
- workout creation
- food log creation and nutrition aggregation
- supplement check-in
- profile selector behavior

Frontend tests should cover:

- Personal OS health module link
- health API client request paths
- overview rendering
- Body3D mapping helpers
- nutrition gap calculations
- workout and body-region related-workout derivation
- fallback rendering for missing model/WebGL where practical

Manual verification should cover:

- `/hermes/personal-os`
- `/hermes/personal-os/health`
- 3D model renders and is nonblank
- model region selection changes detail panel
- migrated data appears in overview, diet, and fitness tabs

## Success Criteria

The module is successful when:

- Studio has a native health route under Personal OS.
- Old health data is migrated without loss.
- The user can see current fat-loss state and today's diet gap.
- The user can view and interact with Body3D.
- The user can record food, supplement, health, and workout facts.
- The user can see today's training/posture recommendation.
- Hermes Agent can read health context and account for it in planning advice.
