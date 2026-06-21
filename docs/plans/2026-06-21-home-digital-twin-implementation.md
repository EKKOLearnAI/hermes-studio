# Home Digital Twin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first Hermes Studio Home module with a profile-scoped household digital twin, inventory/object placement, Home Assistant device sync, basic device binding/control, and a PersonalOS Home UI.

**Architecture:** Add a new profile-scoped `home_state.db` service under the existing Hermes server patterns, with Koa controllers/routes exposing Home APIs. The frontend adds a PersonalOS Home route, API client, overview, 2D map, inventory, and device panels. Home Assistant is an adapter behind the Hermes Home model, not the source of the domain model.

**Tech Stack:** TypeScript, Koa, `node:sqlite` `DatabaseSync`, Vue 3, Naive UI, Vue Router, Vitest, existing Hermes Studio auth/profile middleware.

---

## Reference Documents

- Design: `docs/plans/2026-06-21-home-digital-twin-design.md`
- Existing Personal State service: `packages/server/src/services/hermes/personal-state.ts`
- Existing Personal State routes: `packages/server/src/routes/hermes/personal-state.ts`
- Existing PersonalOS view: `packages/client/src/views/hermes/PersonalOSView.vue`
- Existing Devices UI/API: `packages/client/src/views/hermes/DevicesView.vue`, `packages/client/src/api/hermes/devices.ts`
- Previous 2D map reference: `D:/code/my_project/personal-assistant/frontend-next/app/assets/components/asset-map-editor.tsx`
- Previous placement helpers: `D:/code/my_project/personal-assistant/frontend-next/app/assets/asset-map-utils.ts`

## Implementation Notes

- Keep the implementation V1-shaped. Do not build full 3D in this plan.
- Do not modify old `my_project/personal-assistant` databases.
- Keep Home Assistant credentials server-side and masked in responses.
- Reuse existing profile access checks from Personal State controller patterns.
- Prefer deterministic rules over LLM routing in V1.
- Commit after each task when tests pass.

---

### Task 1: Home State Service Schema And Core CRUD

**Files:**
- Create: `tests/server/home-state-service.test.ts`
- Create: `packages/server/src/services/hermes/home-state.ts`

**Step 1: Write the failing service test**

Create `tests/server/home-state-service.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('home state service', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-home-state-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('creates rooms, furniture, compartments, inventory, devices, and placements in the profile home db', async () => {
    const home = await import('../../packages/server/src/services/hermes/home-state')

    expect(home.getHomeStateDbPath('default')).toBe(join(hermesHome, 'home_state.db'))

    const room = home.createHomeRoom({ name: '客厅', floorName: '1F', profile: 'default' })
    const furniture = home.createHomeFurniture({ roomId: room.id, name: '电视柜', furnitureType: 'cabinet', profile: 'default' })
    const compartment = home.createHomeCompartment({ furnitureId: furniture.id, name: '左抽屉', profile: 'default' })
    const item = home.createHomeInventoryBatch({
      name: '备用电池',
      quantity: 4,
      unit: '节',
      profile: 'default',
    })
    const placement = home.placeHomeTarget({
      targetType: 'inventory_batch',
      targetId: item.id,
      roomId: room.id,
      furnitureId: furniture.id,
      compartmentId: compartment.id,
      x: 120,
      y: 240,
      profile: 'default',
    })

    const overview = home.getHomeOverview({ profile: 'default' })
    expect(overview.rooms).toHaveLength(1)
    expect(overview.furniture).toHaveLength(1)
    expect(overview.compartments).toHaveLength(1)
    expect(overview.inventory).toMatchObject([{ name: '备用电池', quantity: 4 }])
    expect(overview.placements[0]).toMatchObject({
      id: placement.id,
      targetType: 'inventory_batch',
      targetId: item.id,
      roomId: room.id,
      furnitureId: furniture.id,
      compartmentId: compartment.id,
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/server/home-state-service.test.ts
```

Expected: FAIL with module not found for `home-state`.

**Step 3: Implement minimal Home State service**

Create `packages/server/src/services/hermes/home-state.ts`.

Use `personal-state.ts` as the local pattern: `DatabaseSync`, `getProfileDir`, WAL, JSON helpers, row mappers, and short ID generation.

Minimum exported types/functions:

```ts
export type HomeTargetType = 'object' | 'inventory_batch' | 'asset' | 'device'

export interface HomeRoom {
  id: string
  name: string
  floorName: string
  x: number | null
  y: number | null
  w: number | null
  h: number | null
  color: string
  createdAt: string
  updatedAt: string
}

export interface HomeFurniture {
  id: string
  roomId: string
  name: string
  furnitureType: string
  x: number | null
  y: number | null
  w: number | null
  h: number | null
  createdAt: string
  updatedAt: string
}

export interface HomeCompartment {
  id: string
  furnitureId: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface HomeInventoryBatch {
  id: string
  name: string
  quantity: number
  unit: string
  expiryDate: string | null
  notes: string
  createdAt: string
  updatedAt: string
}

export interface HomePlacement {
  id: string
  targetType: HomeTargetType
  targetId: string
  roomId: string | null
  furnitureId: string | null
  compartmentId: string | null
  x: number | null
  y: number | null
  z: number | null
  createdAt: string
  updatedAt: string
}

export interface HomeOverview {
  generatedAt: string
  profile: string
  rooms: HomeRoom[]
  furniture: HomeFurniture[]
  compartments: HomeCompartment[]
  inventory: HomeInventoryBatch[]
  placements: HomePlacement[]
  devices: HomeDevice[]
}
```

Minimum schema:

```sql
CREATE TABLE IF NOT EXISTS home_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS home_rooms (...);
CREATE TABLE IF NOT EXISTS home_furniture (...);
CREATE TABLE IF NOT EXISTS home_compartments (...);
CREATE TABLE IF NOT EXISTS home_inventory_batches (...);
CREATE TABLE IF NOT EXISTS home_devices (...);
CREATE TABLE IF NOT EXISTS home_placements (...);
CREATE TABLE IF NOT EXISTS home_inventory_ledger (...);
CREATE TABLE IF NOT EXISTS home_device_bindings (...);
CREATE TABLE IF NOT EXISTS home_device_states (...);
CREATE TABLE IF NOT EXISTS home_intent_runs (...);
CREATE TABLE IF NOT EXISTS home_intent_steps (...);
```

Implement only the fields needed by the test plus table placeholders for later tasks.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/server/home-state-service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/server/home-state-service.test.ts packages/server/src/services/hermes/home-state.ts
git commit -m "feat(home): add home state service"
```

---

### Task 2: Inventory Consumption And Ledger

**Files:**
- Modify: `tests/server/home-state-service.test.ts`
- Modify: `packages/server/src/services/hermes/home-state.ts`

**Step 1: Add failing inventory ledger test**

Append to `tests/server/home-state-service.test.ts`:

```ts
it('deducts inventory with an append-only ledger entry', async () => {
  const home = await import('../../packages/server/src/services/hermes/home-state')

  const batch = home.createHomeInventoryBatch({
    name: '空气净化器滤芯',
    quantity: 2,
    unit: '个',
    profile: 'default',
  })

  const result = home.consumeHomeInventoryBatch({
    id: batch.id,
    quantity: 1,
    reason: 'filter_replacement',
    actor: 'user',
    profile: 'default',
  })

  expect(result.batch.quantity).toBe(1)
  expect(result.ledgerEntry).toMatchObject({
    batchId: batch.id,
    eventType: 'consume',
    quantityDelta: -1,
    actor: 'user',
  })

  const overview = home.getHomeOverview({ profile: 'default' })
  expect(overview.inventory[0].quantity).toBe(1)
  expect(home.listHomeInventoryLedger({ profile: 'default', batchId: batch.id })).toHaveLength(1)
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/server/home-state-service.test.ts
```

Expected: FAIL because `consumeHomeInventoryBatch` is not implemented.

**Step 3: Implement inventory consumption**

In `home-state.ts`:

- Add `HomeInventoryLedgerEntry`.
- Add `consumeHomeInventoryBatch(input)`.
- Add `listHomeInventoryLedger({ profile, batchId })`.
- Clamp the resulting quantity at `0`.
- Store `quantity_delta` as negative for consumption.
- Store `payload_json` with `{ reason }`.

Core behavior:

```ts
const nextQuantity = Math.max(0, currentQuantity - consumeQuantity)
UPDATE home_inventory_batches SET quantity = ?, updated_at = ? WHERE id = ?
INSERT INTO home_inventory_ledger(...)
```

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/server/home-state-service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/server/home-state-service.test.ts packages/server/src/services/hermes/home-state.ts
git commit -m "feat(home): track inventory consumption ledger"
```

---

### Task 3: Home Controller And Routes

**Files:**
- Create: `tests/server/home-state-routes.test.ts`
- Create: `packages/server/src/controllers/hermes/home.ts`
- Create: `packages/server/src/routes/hermes/home.ts`
- Modify: `packages/server/src/routes/index.ts`

**Step 1: Write failing route tests**

Create `tests/server/home-state-routes.test.ts` using the Personal State route tests as the pattern.

Test coverage:

```ts
it('returns home overview for a profile', async () => {
  const request = await import('supertest')
  const { default: app } = await import('../../packages/server/src/app')

  const res = await request.default(app.callback())
    .get('/api/hermes/home/overview?profile=default')
    .set('Authorization', `Bearer ${process.env.AUTH_TOKEN || 'test-token'}`)

  expect(res.status).toBe(200)
  expect(res.body.overview.profile).toBe('default')
})

it('creates a room and returns it in the map payload', async () => {
  ...
  const create = await request.default(app.callback())
    .post('/api/hermes/home/rooms?profile=default')
    .send({ name: '厨房', floor_name: '1F', x: 20, y: 20, w: 240, h: 180 })
  expect(create.status).toBe(200)

  const map = await request.default(app.callback()).get('/api/hermes/home/map?profile=default')
  expect(map.body.map.rooms[0]).toMatchObject({ name: '厨房' })
})
```

If existing route tests use a different app import or auth helper, copy that exact local pattern.

**Step 2: Run route tests to verify they fail**

Run:

```bash
npm test -- tests/server/home-state-routes.test.ts
```

Expected: FAIL with 404 or missing route.

**Step 3: Implement controller**

Create `packages/server/src/controllers/hermes/home.ts`.

Export handlers:

- `overview(ctx)`
- `map(ctx)`
- `createRoom(ctx)`
- `createFurniture(ctx)`
- `createCompartment(ctx)`
- `createPlacement(ctx)`
- `listInventory(ctx)`
- `createInventoryBatch(ctx)`
- `consumeInventoryBatch(ctx)`

Use Personal State profile access logic:

```ts
function profileFrom(ctx: Context): string | undefined {
  const queryProfile = typeof ctx.query.profile === 'string' ? ctx.query.profile : undefined
  const stateProfile = ctx.state?.profile?.name
  return queryProfile || stateProfile
}
```

Return shapes:

```ts
ctx.body = { overview: getHomeOverview({ profile }) }
ctx.body = { map: getHomeMap({ profile }) }
ctx.body = { room: createHomeRoom({ ...body, profile }) }
```

**Step 4: Implement routes**

Create `packages/server/src/routes/hermes/home.ts`:

```ts
import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/home'

export const homeRoutes = new Router()

homeRoutes.get('/api/hermes/home/overview', ctrl.overview)
homeRoutes.get('/api/hermes/home/map', ctrl.map)
homeRoutes.post('/api/hermes/home/rooms', ctrl.createRoom)
homeRoutes.post('/api/hermes/home/furniture', ctrl.createFurniture)
homeRoutes.post('/api/hermes/home/compartments', ctrl.createCompartment)
homeRoutes.post('/api/hermes/home/placements', ctrl.createPlacement)
homeRoutes.get('/api/hermes/home/inventory', ctrl.listInventory)
homeRoutes.post('/api/hermes/home/inventory', ctrl.createInventoryBatch)
homeRoutes.post('/api/hermes/home/inventory/:id/consume', ctrl.consumeInventoryBatch)
```

Register in `packages/server/src/routes/index.ts` near other Hermes routes:

```ts
import { homeRoutes } from './hermes/home'
...
app.use(homeRoutes.routes())
app.use(homeRoutes.allowedMethods())
```

**Step 5: Run route tests**

Run:

```bash
npm test -- tests/server/home-state-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tests/server/home-state-routes.test.ts packages/server/src/controllers/hermes/home.ts packages/server/src/routes/hermes/home.ts packages/server/src/routes/index.ts
git commit -m "feat(home): expose home state routes"
```

---

### Task 4: Home Assistant Adapter

**Files:**
- Create: `tests/server/home-assistant-adapter.test.ts`
- Create: `packages/server/src/services/hermes/home-assistant-adapter.ts`
- Modify: `packages/server/src/services/hermes/home-state.ts`
- Modify: `packages/server/src/controllers/hermes/home.ts`
- Modify: `packages/server/src/routes/hermes/home.ts`

**Step 1: Write failing adapter tests**

Create `tests/server/home-assistant-adapter.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('home assistant adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tests connection by reading Home Assistant API root', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: 'API running.' }),
    })))

    const { testHomeAssistantConnection } = await import('../../packages/server/src/services/hermes/home-assistant-adapter')
    const result = await testHomeAssistantConnection({ baseUrl: 'http://ha.local:8123', token: 'secret' })

    expect(result.ok).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://ha.local:8123/api/',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    )
  })

  it('normalizes entity states into home devices', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ([
        {
          entity_id: 'fan.living_room_air_purifier',
          state: 'on',
          attributes: { friendly_name: '客厅空气净化器', percentage: 70 },
        },
        {
          entity_id: 'sensor.living_room_pm25',
          state: '38',
          attributes: { friendly_name: '客厅 PM2.5', unit_of_measurement: 'µg/m³' },
        },
      ]),
    })))

    const { fetchHomeAssistantEntities } = await import('../../packages/server/src/services/hermes/home-assistant-adapter')
    const entities = await fetchHomeAssistantEntities({ baseUrl: 'http://ha.local:8123', token: 'secret' })

    expect(entities[0]).toMatchObject({
      provider: 'home_assistant',
      externalId: 'fan.living_room_air_purifier',
      domain: 'fan',
      name: '客厅空气净化器',
      state: 'on',
    })
  })
})
```

**Step 2: Run adapter tests to verify they fail**

Run:

```bash
npm test -- tests/server/home-assistant-adapter.test.ts
```

Expected: FAIL with module not found.

**Step 3: Implement adapter service**

Create `packages/server/src/services/hermes/home-assistant-adapter.ts`.

Exports:

- `testHomeAssistantConnection({ baseUrl, token })`
- `fetchHomeAssistantEntities({ baseUrl, token })`
- `callHomeAssistantService({ baseUrl, token, domain, service, serviceData })`
- `inferCapabilities(entity)`

Normalize:

```ts
entity_id -> externalId
entity_id.split('.')[0] -> domain
attributes.friendly_name || entity_id -> name
state -> state
attributes -> attributes
```

Infer basic capabilities:

- `light` -> `switch.on_off`, `light.brightness`
- `switch` -> `switch.on_off`
- `fan` -> `switch.on_off`, `fan.speed`
- `sensor` -> `sensor.value`
- `climate` -> `climate.temperature`
- `cover` -> `cover.position`

**Step 4: Add sync endpoint**

In `home-state.ts`, add:

- `upsertHomeDeviceFromAdapter(input)`
- `listHomeDevices({ profile })`
- `saveHomeDeviceState(input)`

In controller/routes, add:

- `POST /api/hermes/home/adapters/home-assistant/test`
- `POST /api/hermes/home/adapters/home-assistant/sync`

For V1, accept `{ base_url, token }` in request body and return masked status. Later move secrets into settings.

**Step 5: Run tests**

Run:

```bash
npm test -- tests/server/home-assistant-adapter.test.ts tests/server/home-state-service.test.ts tests/server/home-state-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tests/server/home-assistant-adapter.test.ts packages/server/src/services/hermes/home-assistant-adapter.ts packages/server/src/services/hermes/home-state.ts packages/server/src/controllers/hermes/home.ts packages/server/src/routes/hermes/home.ts
git commit -m "feat(home): add home assistant adapter sync"
```

---

### Task 5: Device Binding, Command Policy, And Intent Audit

**Files:**
- Create: `tests/server/home-intent-service.test.ts`
- Modify: `packages/server/src/services/hermes/home-state.ts`
- Create: `packages/server/src/services/hermes/home-intents.ts`
- Modify: `packages/server/src/controllers/hermes/home.ts`
- Modify: `packages/server/src/routes/hermes/home.ts`

**Step 1: Write failing intent tests**

Create `tests/server/home-intent-service.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('home intent service', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-home-intent-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('answers where an inventory item is from structured placement', async () => {
    const home = await import('../../packages/server/src/services/hermes/home-state')
    const intents = await import('../../packages/server/src/services/hermes/home-intents')

    const room = home.createHomeRoom({ name: '储物间', floorName: '1F' })
    const shelf = home.createHomeFurniture({ roomId: room.id, name: '上层货架', furnitureType: 'shelf' })
    const filter = home.createHomeInventoryBatch({ name: '净化器滤芯', quantity: 1, unit: '个' })
    home.placeHomeTarget({ targetType: 'inventory_batch', targetId: filter.id, roomId: room.id, furnitureId: shelf.id })

    const response = intents.processHomeIntent({ message: '净化器滤芯在哪', profile: 'default' })

    expect(response.route.type).toBe('inventory_lookup')
    expect(response.execution.status).toBe('completed')
    expect(response.reply).toContain('储物间')
    expect(response.reply).toContain('上层货架')
    expect(response.run.steps).toHaveLength(2)
  })

  it('requires confirmation for device commands', async () => {
    const intents = await import('../../packages/server/src/services/hermes/home-intents')

    const response = intents.processHomeIntent({ message: '打开客厅灯', profile: 'default' })

    expect(response.execution.status).toBe('pending_confirmation')
    expect(response.pendingConfirmations[0]).toMatchObject({ riskLevel: 'medium' })
  })
})
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/server/home-intent-service.test.ts
```

Expected: FAIL with module not found.

**Step 3: Implement intent service**

Create `packages/server/src/services/hermes/home-intents.ts`.

Implement deterministic V1 routes:

- inventory lookup: messages containing `在哪`, `哪里`, `找`, plus matching inventory/object names
- inventory list by room: messages containing `有什么`
- device status: messages containing `怎么样`, `状态`
- device command: messages containing `打开`, `关闭`, `调到`, `设置`

Response type:

```ts
export interface HomeIntentResponse {
  reply: string
  route: { type: string; target?: string | null }
  execution: { status: 'completed' | 'failed' | 'pending_confirmation' | 'needs_input'; summary?: string }
  pendingConfirmations: Array<{ id: string; title: string; riskLevel: 'low' | 'medium' | 'high'; payload: Record<string, unknown> }>
  run: { id: string; steps: Array<Record<string, unknown>> }
}
```

Persist to `home_intent_runs` and `home_intent_steps` in `home-state.ts`.

**Step 4: Expose intent routes**

Add routes:

- `POST /api/hermes/home/intent`
- `POST /api/hermes/home/intent/:id/confirm`

V1 confirm can mark a pending run approved and return a placeholder `completed` result if no device binding exists.

**Step 5: Run tests**

Run:

```bash
npm test -- tests/server/home-intent-service.test.ts tests/server/home-state-service.test.ts tests/server/home-state-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tests/server/home-intent-service.test.ts packages/server/src/services/hermes/home-intents.ts packages/server/src/services/hermes/home-state.ts packages/server/src/controllers/hermes/home.ts packages/server/src/routes/hermes/home.ts
git commit -m "feat(home): add auditable home intents"
```

---

### Task 6: Client API Types

**Files:**
- Create: `tests/client/home-api.test.ts`
- Create: `packages/client/src/api/hermes/home.ts`

**Step 1: Write failing client API test**

Create `tests/client/home-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

describe('home api client', () => {
  it('fetches home overview with profile query', async () => {
    const request = vi.fn(async () => ({ overview: { profile: 'default', rooms: [], furniture: [], compartments: [], inventory: [], placements: [], devices: [] } }))
    vi.doMock('../../packages/client/src/api/client', () => ({ request }))

    const api = await import('../../packages/client/src/api/hermes/home')
    const overview = await api.fetchHomeOverview({ profile: 'default' })

    expect(request).toHaveBeenCalledWith('/api/hermes/home/overview?profile=default')
    expect(overview.profile).toBe('default')
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/client/home-api.test.ts
```

Expected: FAIL with module not found.

**Step 3: Implement client API**

Create `packages/client/src/api/hermes/home.ts`.

Add types matching server responses:

- `HomeRoom`
- `HomeFurniture`
- `HomeCompartment`
- `HomeInventoryBatch`
- `HomePlacement`
- `HomeDevice`
- `HomeOverview`
- `HomeMap`
- `HomeIntentResponse`

Add functions:

- `fetchHomeOverview`
- `fetchHomeMap`
- `createHomeRoom`
- `createHomeFurniture`
- `createHomeCompartment`
- `createHomePlacement`
- `fetchHomeInventory`
- `createHomeInventoryBatch`
- `consumeHomeInventoryBatch`
- `testHomeAssistantAdapter`
- `syncHomeAssistantAdapter`
- `sendHomeIntent`

Use a local `withProfile(path, profile)` helper matching `personal-state.ts`.

**Step 4: Run client API test**

Run:

```bash
npm test -- tests/client/home-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/client/home-api.test.ts packages/client/src/api/hermes/home.ts
git commit -m "feat(home): add client api"
```

---

### Task 7: PersonalOS Home Route And Module Card

**Files:**
- Create: `tests/client/home-view.test.ts`
- Modify: `tests/client/personal-os-view.test.ts`
- Create: `packages/client/src/views/hermes/HomeView.vue`
- Modify: `packages/client/src/views/hermes/PersonalOSView.vue`
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`

**Step 1: Write failing tests**

Update `tests/client/personal-os-view.test.ts` to expect the Smart Home module to link to the new route:

```ts
expect(wrapper.text()).toContain('Smart Home')
expect(wrapper.findComponent({ name: 'RouterLink' }).exists()).toBe(true)
```

Create `tests/client/home-view.test.ts`:

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import HomeView from '../../packages/client/src/views/hermes/HomeView.vue'

vi.mock('../../packages/client/src/api/hermes/home', () => ({
  fetchHomeOverview: vi.fn(async () => ({
    profile: 'default',
    generatedAt: new Date().toISOString(),
    rooms: [{ id: 'room-1', name: '客厅', floorName: '1F' }],
    furniture: [],
    compartments: [],
    inventory: [{ id: 'inv-1', name: '净化器滤芯', quantity: 1, unit: '个' }],
    placements: [],
    devices: [],
  })),
}))

describe('HomeView', () => {
  it('renders home overview tabs', async () => {
    const wrapper = mount(HomeView, { global: { stubs: ['NButton', 'NSpin', 'NTabs', 'NTabPane'] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapper.text()).toContain('客厅')
    expect(wrapper.text()).toContain('净化器滤芯')
  })
})
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/client/home-view.test.ts tests/client/personal-os-view.test.ts
```

Expected: FAIL because `HomeView.vue` and route do not exist.

**Step 3: Create Home view**

Create `packages/client/src/views/hermes/HomeView.vue`.

V1 layout:

- header title and refresh action
- metric cards: rooms, furniture, inventory, devices
- tabs: Overview, Map, Inventory, Devices, Automation
- empty setup state if no rooms/inventory/devices

Use Naive UI components already used in Studio.

**Step 4: Wire route and PersonalOS card**

In `packages/client/src/router/index.ts`, add route name:

```ts
{
  path: 'personal-os/home',
  name: 'hermes.personalHome',
  component: () => import('@/views/hermes/HomeView.vue'),
}
```

In `PersonalOSView.vue`, change `smartHome` module `to` from `null` to `{ name: 'hermes.personalHome' }`, and use live counts from Home overview later. For this task, keep metrics empty or static.

Update English and Chinese i18n copy for active Home module.

**Step 5: Run tests**

Run:

```bash
npm test -- tests/client/home-view.test.ts tests/client/personal-os-view.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tests/client/home-view.test.ts tests/client/personal-os-view.test.ts packages/client/src/views/hermes/HomeView.vue packages/client/src/views/hermes/PersonalOSView.vue packages/client/src/router/index.ts packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts
git commit -m "feat(home): add personal os home route"
```

---

### Task 8: 2D Map Components And Placement Utilities

**Files:**
- Create: `tests/client/home-map-utils.test.ts`
- Create: `packages/client/src/components/hermes/home/home-map-utils.ts`
- Create: `packages/client/src/components/hermes/home/HomeMapPanel.vue`
- Modify: `packages/client/src/views/hermes/HomeView.vue`

**Step 1: Write failing utility tests**

Create `tests/client/home-map-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { findRoomByPoint, normalizePointWithinCanvas, placementLabel } from '../../packages/client/src/components/hermes/home/home-map-utils'

describe('home map utils', () => {
  it('finds the topmost room containing a point', () => {
    const rooms = [
      { id: 'a', name: '厨房', x: 0, y: 0, w: 200, h: 200 },
      { id: 'b', name: '客厅', x: 50, y: 50, w: 200, h: 200 },
    ]
    expect(findRoomByPoint(rooms as any, { x: 80, y: 80 })?.id).toBe('b')
  })

  it('builds a structured placement label', () => {
    expect(placementLabel({
      room: { name: '主卧' },
      furniture: { name: '衣柜' },
      compartment: { name: '左1' },
    })).toBe('主卧 / 衣柜 / 左1')
  })
})
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/client/home-map-utils.test.ts
```

Expected: FAIL with module not found.

**Step 3: Implement map utils**

Create `packages/client/src/components/hermes/home/home-map-utils.ts`.

Implement:

- `pointInRoom`
- `findRoomByPoint`
- `normalizePointWithinCanvas`
- `placementLabel`
- `roomStyle`
- `placementStyle`

Adapt logic from old `asset-map-utils.ts`, but use Home domain types.

**Step 4: Create HomeMapPanel**

Create `packages/client/src/components/hermes/home/HomeMapPanel.vue`.

Initial behavior:

- render canvas with rooms and furniture rectangles
- render placement dots
- click placement emits `select-placement`
- no drag editing yet unless it stays simple
- empty state encourages creating rooms from API later

**Step 5: Mount panel in HomeView Map tab**

In `HomeView.vue`, import `HomeMapPanel` and render it with `overview.rooms`, `overview.furniture`, and `overview.placements`.

**Step 6: Run tests**

Run:

```bash
npm test -- tests/client/home-map-utils.test.ts tests/client/home-view.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add tests/client/home-map-utils.test.ts packages/client/src/components/hermes/home/home-map-utils.ts packages/client/src/components/hermes/home/HomeMapPanel.vue packages/client/src/views/hermes/HomeView.vue
git commit -m "feat(home): add 2d home map panel"
```

---

### Task 9: Inventory And Device Panels

**Files:**
- Create: `packages/client/src/components/hermes/home/HomeInventoryPanel.vue`
- Create: `packages/client/src/components/hermes/home/HomeDevicesPanel.vue`
- Modify: `tests/client/home-view.test.ts`
- Modify: `packages/client/src/views/hermes/HomeView.vue`

**Step 1: Extend Home view test**

In `tests/client/home-view.test.ts`, add mocked devices and assert inventory/device panels render:

```ts
expect(wrapper.text()).toContain('Inventory')
expect(wrapper.text()).toContain('Devices')
expect(wrapper.text()).toContain('Home Assistant')
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/client/home-view.test.ts
```

Expected: FAIL until panels render the expected text.

**Step 3: Implement inventory panel**

Create `HomeInventoryPanel.vue`:

- dense table/list
- name, quantity, unit, expiry, placement label
- low-stock/expired visual states
- consume button placeholder disabled unless an action handler is passed

**Step 4: Implement devices panel**

Create `HomeDevicesPanel.vue`:

- adapter setup block for Home Assistant URL/token
- test connection button
- sync button
- device list with provider, external ID, state freshness, capabilities
- binding status badge

Use `testHomeAssistantAdapter` and `syncHomeAssistantAdapter` from client API.

**Step 5: Wire panels into HomeView**

Render panels in Inventory and Devices tabs. Keep state local in HomeView for now.

**Step 6: Run tests**

Run:

```bash
npm test -- tests/client/home-view.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add tests/client/home-view.test.ts packages/client/src/components/hermes/home/HomeInventoryPanel.vue packages/client/src/components/hermes/home/HomeDevicesPanel.vue packages/client/src/views/hermes/HomeView.vue
git commit -m "feat(home): add inventory and devices panels"
```

---

### Task 10: Previous Layout Seed Import

**Files:**
- Create: `tests/server/home-layout-seed.test.ts`
- Create: `packages/server/src/services/hermes/home-layout-seed.ts`
- Modify: `packages/server/src/services/hermes/home-state.ts`

**Step 1: Write failing seed test**

Create `tests/server/home-layout-seed.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('home layout seed', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-home-seed-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('seeds the confirmed loft layout idempotently', async () => {
    const { seedLoftHomeLayout } = await import('../../packages/server/src/services/hermes/home-layout-seed')
    const { getHomeOverview } = await import('../../packages/server/src/services/hermes/home-state')

    seedLoftHomeLayout({ profile: 'default' })
    seedLoftHomeLayout({ profile: 'default' })

    const overview = getHomeOverview({ profile: 'default' })
    expect(overview.rooms.map(room => room.name)).toEqual(
      expect.arrayContaining(['厨房', '客厅', '阳台', '洗衣房', '主卧', '次卧']),
    )
    expect(overview.furniture.map(item => item.name)).toEqual(
      expect.arrayContaining(['冰箱', '酒柜', '桌游柜', '衣柜']),
    )
    expect(overview.rooms.filter(room => room.name === '厨房')).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/server/home-layout-seed.test.ts
```

Expected: FAIL with module not found.

**Step 3: Implement seed service**

Create `packages/server/src/services/hermes/home-layout-seed.ts`.

Hardcode the confirmed layout from the old backup:

- 1F rooms: 厕所, 厨房, 客厅, 楼梯, 阳台, 洗衣房
- 2F rooms: 走廊, 次卧, 主卧, 洗手间
- key furniture: 灶台, 碗具, 调料, 食物柜, 冰箱, 杯子, 酒柜, 桌游柜, 开放衣架, 洗衣机, 衣柜, 床, 床头柜左, 床头柜右, 储物柜, 立柜

Add idempotent helpers in `home-state.ts`:

- `findHomeRoomByName`
- `findHomeFurnitureByName`
- `createHomeRoomIfMissing`
- `createHomeFurnitureIfMissing`

Use deterministic `sourceTag/sourceId` if adding provenance fields.

**Step 4: Run test**

Run:

```bash
npm test -- tests/server/home-layout-seed.test.ts tests/server/home-state-service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/server/home-layout-seed.test.ts packages/server/src/services/hermes/home-layout-seed.ts packages/server/src/services/hermes/home-state.ts
git commit -m "feat(home): add loft layout seed"
```

---

### Task 11: End-To-End Verification Build

**Files:**
- Modify only if previous tasks exposed compile/test failures.

**Step 1: Run focused test suite**

Run:

```bash
npm test -- tests/server/home-state-service.test.ts tests/server/home-state-routes.test.ts tests/server/home-assistant-adapter.test.ts tests/server/home-intent-service.test.ts tests/server/home-layout-seed.test.ts tests/client/home-api.test.ts tests/client/home-view.test.ts tests/client/home-map-utils.test.ts tests/client/personal-os-view.test.ts
```

Expected: PASS.

**Step 2: Run full type/build check**

Run:

```bash
npm run build
```

Expected: PASS.

**Step 3: Manual local smoke test**

Run:

```bash
npm run dev
```

Open:

```text
http://localhost:8649/#/hermes/personal-os/home
```

Verify:

- Home route loads.
- Overview metrics show.
- Map tab renders seeded rooms when seed is called or records exist.
- Inventory tab renders inventory rows.
- Devices tab accepts Home Assistant URL/token test inputs.
- Intent tab or Automation section can ask "净化器滤芯在哪" after seed/inventory setup.

Stop the dev server after verification.

**Step 4: Commit verification fixes**

If fixes were needed:

```bash
git add <fixed-files>
git commit -m "fix(home): pass home digital twin verification"
```

If no fixes were needed, no commit is required.

---

## Rollout Notes

- V1 Home Assistant sync may accept URL/token in the Home module body. Before release, move credentials into a server-side saved setting if the UI persists adapter config.
- Avoid direct Xiaomi API work in this implementation plan. Xiaomi/Mijia devices should arrive through Home Assistant first.
- Keep 3D as V2. The V1 map should be stable, inspectable, and data-backed.
- Keep old personal-assistant data read-only until a separate migration plan is written and approved.

## Execution Checklist

- [ ] Home service tests pass.
- [ ] Home route tests pass.
- [ ] Home Assistant adapter tests pass.
- [ ] Intent audit tests pass.
- [ ] Client API tests pass.
- [ ] Home view tests pass.
- [ ] Map utility tests pass.
- [ ] PersonalOS card links to Home module.
- [ ] `npm run build` passes.
