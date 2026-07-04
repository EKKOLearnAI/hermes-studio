# Personal Autopilot Design

## Goal

Hermes Personal OS should automatically sense the user's body, lifestyle, and execution state, then use the smallest possible interaction to keep the user moving toward an ideal physical condition and orderly daily life.

The system is not a health dashboard, task tracker, or planning app first. It is an autonomous personal operating coach. Software exists only to improve the user's real body and real daily order.

## Product Principle

The user should not have to keep opening Smart Planning to decide what to do. Smart Planning should become a background planning and scheduling engine. The foreground experience should answer one question:

> What is the most important thing I should do now?

Plans still exist, but the user should not need to inspect them constantly. The system should know the plan, monitor current state, and surface only the next best action when it matters.

## Core Loop

```text
Signals -> State Diagnosis -> Intervention Policy -> Next Best Action -> Review
```

### Signals

The system should infer state from existing and low-friction sources:

- Weight, body map, workouts, food logs, supplements, health records, daily check-ins.
- Skin condition, skincare completion, sleep, fatigue, pain, posture, stress, and recovery notes.
- Calendar, tasks, schedule windows, missed meals, missed workouts, bedtime drift, and life-order tasks.
- One-sentence logs, quick buttons, and photo-based records.
- At most one subjective daily status prompt: good, normal, or collapsed.

The default should be passive observation. Manual input is only requested when the system cannot infer enough to make a useful decision.

### State Diagnosis

The system should classify the current state rather than only report raw data:

- Body transformation is progressing, stalled, overloaded, or disordered.
- Diet is supporting or damaging the current body goal.
- Training is insufficient, excessive, imbalanced, or appropriately loaded.
- Skin problems may relate to sleep, diet, stress, skincare interruption, or environmental irritation.
- Daily life is orderly, drifting, overloaded, or already collapsed.

Diagnosis should be practical and action-oriented. It should not produce medical diagnosis or pretend to replace clinicians.

### Intervention Policy

The system should choose an intervention level:

- `silent`: everything is acceptable; keep observing.
- `nudge`: lightweight reminder at a meal, workout, skincare, or bedtime window.
- `correct`: the user is drifting; suggest a realistic substitute.
- `takeover`: the day is collapsing; show only one minimum viable action.
- `upgrade`: recent execution is stable; increase training, diet, or lifestyle demands slightly.

The system should not keep shouting. It should intervene when continued passivity would move the user away from the goal.

### Next Best Action

The main UI should prioritize a single next action, not a long task list.

Examples:

- Eat this now, because the meal window is slipping.
- Do this 8-minute fallback workout, because the normal workout is no longer realistic today.
- Do only cleanser and moisturizer tonight, because the day is already overloaded.
- Start bedtime shutdown now, because recovery is the limiting factor.
- Clear this one life-order item, because the environment is beginning to drift.

Each action should include a short reason and an optional lower-friction fallback.

### Review

The system should review without asking the user to backfill a perfect log.

- Nightly review should take under one minute.
- Weekly review should identify the one or two highest-leverage changes.
- Missed days should not create debt. The system should resume from the current state.
- Strategy should adjust automatically based on adherence, body signals, fatigue, skin state, and life-order drift.

## UX Direction

### Today Command Center

The first screen of Personal OS should become a command center, not a module directory or planning board.

It should show:

- Current inferred state.
- The next best action.
- Why this action matters.
- The fallback action if energy or time is low.
- A compact state strip for body, diet, skin, recovery, and daily order.

### Smart Planning Role

Smart Planning should move behind the command center.

It remains responsible for:

- Storing the plan.
- Understanding schedule constraints.
- Tracking tasks, events, projects, and recurring routines.
- Feeding candidate actions into the decision engine.

It should not be the main user-facing surface for daily execution. The user should only open the full plan when they want to inspect or edit the plan.

### Health, Diet, Skin Role

Health, diet, and skin modules should become both signal sources and intervention domains.

- Health/body: weight trend, body map, training load, posture, fatigue, recovery.
- Diet: meal timing, macro/micro intake, food patterns, adherence to body goal.
- Skin: visible status, routine adherence, irritation triggers, sleep/diet/stress links.

They should still have detail views, but the daily surface should merge them into one body transformation protocol.

## Data Model Direction

Add a lightweight autopilot layer rather than replacing existing health and planning data.

Important concepts:

- `Signal`: an observed or inferred fact.
- `StateSnapshot`: current diagnosis across body, diet, skin, recovery, and order.
- `Intervention`: a system decision to stay silent, nudge, correct, takeover, or upgrade.
- `NextAction`: one action selected for the user now.
- `Review`: nightly or weekly adjustment record.

Existing health-state and personal-state data should feed these structures.

## Success Criteria

The system is working if:

- The user no longer needs to inspect Smart Planning throughout the day.
- The first screen always makes the next useful action obvious.
- Recording is mostly one sentence, one photo, or one tap.
- Failed days recover automatically without planning debt.
- Weekly reports change the next week's strategy, not just summarize history.
- The user's body, skin, energy, and daily order trend in the right direction.

## Non-Goals

- Building a complex health data warehouse before the daily loop works.
- Requiring complete manual logging.
- Turning every plan item into something the user must stare at.
- Medical diagnosis, supplement prescription, or clinician replacement.
- Perfect automation on the first pass.

## First Implementation Slice

The first useful slice should be small:

1. Add a Personal OS command center card with current state and one next best action.
2. Add an autopilot service that reads existing Personal State and Health State overviews.
3. Start with rule-based intervention policy.
4. Move Smart Planning into a secondary detailed route.
5. Add quick logging for food, workout, skin, and daily status.

This gives the system a daily operating loop before adding deeper automation.
