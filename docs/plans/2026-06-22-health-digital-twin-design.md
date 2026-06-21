# Health Digital Twin Design

## Goal

Turn the Health module from a data cockpit into a personal health digital twin centered on Body3D, with two connected layers:

- External health: physique, muscle development, posture, training, diet, fat loss, recovery.
- Internal health: health records, hospital checkup indicators, micronutrients, supplements, and abnormal-marker follow-up.

## Current State

Hermes Studio already has:

- `health_state.db` with migrated profile, body map, food items, food logs, workouts, supplements, daily plans, and check-ins.
- Health API under `/api/hermes/health/*`.
- `HealthView.vue` and `HealthBody3DViewer.vue`.
- Bodyparts3D STL assets under `packages/client/public/models/health/bodyparts3d`.

Old `personal-assistant` data source:

- `food_items`: 174 rows, including micronutrient columns such as sodium, potassium, calcium, magnesium, iron, zinc, vitamin A/C/D/E/B6/B12, folate, cholesterol, saturated fat, trans fat.
- `life_awakening_food_logs`: 28 rows, including `micros` JSON.
- `life_health_records`: 9 rows, generic category/value/unit health records.
- `life_health_workouts`: 40 rows.
- `life_health_daily_plans`: 11 rows.
- `life_health_daily_checkins`: 12 rows.
- `life_awakening_health_stats`: profile, Body3D muscle map, nutrition config, supplement config.

There is not yet a rich hospital-report table in the old project. The initial internal-health layer should therefore support generic checkup markers and micronutrient summaries first, then expand when actual lab reports are added.

## Product Model

The first screen should make Body3D the primary object, not a secondary card.

Health module layout:

1. Digital Twin Header
   - User profile, current weight, target weight, body fat if available.
   - Body3D state summary: top constrained regions, high-priority muscle regions, recent training load.
   - Mode switch: External / Internal / Plan.

2. Body3D Twin Stage
   - Large Body3D region map.
   - Selected region details.
   - External mode: muscle, posture, training, diet linkage.
   - Internal mode: related markers, nutrition deficiencies, supplement relevance.

3. External Health Panel
   - Body composition and fat-loss trend.
   - Training records and planned workouts.
   - Posture and activation constraints.
   - Diet macro progress.

4. Internal Health Panel
   - Health records grouped as body composition, vitals, labs, symptoms, medication, note.
   - Micronutrient intake summary from food logs and food item nutrient data.
   - Checkup marker model that can hold future hospital metrics: marker key, label, value, unit, reference range, status, measured date, source.
   - Supplement coverage and gaps.

5. Intervention Plan
   - Today health plan.
   - Proposed actions: workout, meal, supplement, check-in, marker follow-up.
   - No medical diagnosis; only tracking, organization, and clinician-question support.

## Data Model Additions

Keep existing tables and add derived structures first:

- `internalMarkers`: derived from `health_records` where category indicates lab/checkup/vital/symptom/medication/note, plus future explicit marker rows.
- `micronutrientSummary`: derived from `foodLogs[].nutrition.micros` and food item micronutrient fields.
- `externalSummary`: derived from body map, workouts, latest plan, weight summary.
- `digitalTwinSummary`: combines external and internal state for the top of the page.

Avoid adding a separate hospital-report table until there is imported report data or a report upload workflow.

## Migration Strategy

Enhance the existing import script:

- Preserve existing food item micronutrient columns inside `foodItems[].nutrition.micros`.
- Preserve food log `micros` JSON inside `foodLogs[].nutrition.micros`.
- Preserve `life_health_records.source_tag` and `source_id` in record payload/source metadata.
- Map categories conservatively:
  - `weight`, `body_fat`, `waist`, `measurement` -> external body composition.
  - `blood_pressure`, `heart_rate`, `sleep`, `energy`, `pain` -> vitals/check-ins.
  - `lab`, `checkup`, `blood`, `urine`, `vitamin`, `mineral`, `micro` -> internal marker.
  - Unknown categories remain generic records.

## UI Behavior

The first visible health screen should immediately show:

- Large Body3D twin.
- Current external state.
- Internal marker/micronutrient status.
- Today's intervention plan.

The user should be able to scan whether the main issue is external training/posture/diet or internal checkup/nutrition markers.

## Testing

Add tests for:

- Health service derives micronutrient summaries from food logs.
- Import script preserves food-item and food-log micronutrient data.
- Health API returns digital twin summary, external summary, internal markers, and micronutrient summary.
- Health view renders Body3D as primary stage and shows External/Internal/Plan sections.

## Non-Goals For This Pass

- Full Three.js mesh rendering.
- Medical diagnosis.
- OCR/PDF parsing of hospital reports.
- Automatic supplement prescriptions.
