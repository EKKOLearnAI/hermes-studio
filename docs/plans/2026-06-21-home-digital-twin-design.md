# Home Digital Twin Design

Date: 2026-06-21
Owner: Codex + User
Status: Approved for design documentation

## Goal

Build a Home module in Hermes Studio that combines a household digital twin, inventory management, physical item management, and real smart-device control.

The product should not be a chat-only smart-home remote. Hermes should own the semantic model of the home: rooms, furniture, compartments, objects, inventory, assets, devices, capabilities, state, intents, maintenance, and execution history. Device providers such as Home Assistant, Xiaomi Home, Hue, MQTT, and ESPHome should connect through adapters.

## Prior Project References

Several existing projects already contain pieces of this system:

- `my_project/personal-assistant` asset map: room rectangles, canvas coordinates, asset placement, and drag/drop editing.
- `my_project/personal-assistant` assets module: assets with structured child items, quantity, unit, expiry, and notes.
- `my_project/personal-assistant` health inventory flow: food and supplement logs can consume asset inventory and deduct quantities.
- `my_project/personal-assistant` wardrobe module: each clothing item is a first-class object with category, location, image, season, material, wear count, clean status, and outfit history.
- Hermes backup `home-management` skill: confirmed loft layout, room-by-room asset mapping workflow, and photo-to-layout workflow.
- Hermes backup `smart-wardrobe` skill: practical position codes such as `main bedroom wardrobe left 1` and drawer-level clothing placement.
- `hermes-desktop` Home Assistant platform settings: existing `HASS_URL` and `HASS_TOKEN` configuration shape.
- `hermes-studio` Devices page: LAN peer discovery, pairing, signatures, and authorization state for Hermes nodes.
- `hermes-studio` PersonalOS and Personal State: profile-scoped SQLite state and proposal review patterns.

The new Home module should reuse these product lessons, not copy the old implementations directly.

## Recommended Architecture

Use one Home domain model with two connected layers:

1. Digital twin layer
   - Rooms, zones, furniture, compartments, surfaces, objects, assets, inventory, and placement.
   - This is the source of truth for where things are and what they mean.

2. Device adapter layer
   - Home Assistant, Xiaomi Home through Home Assistant, Hue/OpenHue, MQTT, ESPHome, and later direct provider integrations.
   - This is the source of live device state and device commands.

The relationship is:

```text
Home Digital Twin
  Room / Furniture / Compartment / Object / Inventory / Asset
       ^
       | placement and semantic binding
       v
Device Adapter Layer
  Home Assistant / Xiaomi Home / Hue / MQTT / ESPHome
```

Hermes should not treat a Xiaomi device as just an external entity ID. A purifier, for example, should be:

- an `Asset` with purchase, warranty, manual, and maintenance records
- a `Device` with live capabilities and state
- an `ObjectPlacement` in a room or near furniture
- a `MaintenanceTask` source when the filter is low
- an `Inventory` consumer linked to spare filters

## Domain Model

### Spatial Model

Core entities:

- `Home`: one household or residence.
- `Floor`: optional floor grouping, such as first floor and second floor.
- `Room`: kitchen, living room, balcony, main bedroom, second bedroom, bathroom.
- `Zone`: logical area inside a room, such as cooking area or desk area.
- `Furniture`: wardrobe, bed, bedside table, fridge, cabinet, desk, sofa.
- `Compartment`: drawer, shelf, cabinet cell, fridge layer, wardrobe grid.
- `Surface`: top of desk, wall mount, floor area, side of cabinet.
- `Placement`: a relationship that places an object/device/asset into a room, furniture, compartment, surface, or coordinate.

The old string locations such as `主卧衣柜·左1` become structured data:

```text
Room: 主卧
  Furniture: 衣柜
    Compartment: 左1
```

### Object And Inventory Model

Core entities:

- `ObjectItem`: a physical item, such as a remote control, cable, blanket, board game, bottle, shirt, or filter.
- `InventoryBatch`: quantity-bearing stock, such as protein bars, fish oil, paper towels, batteries, or purifier filters.
- `Asset`: durable or managed object, such as an appliance, furniture, contract, warranty, or service record.
- `InventoryLedger`: append-only movement log for stock in/out, consumption, discard, move, and correction.
- `PurchaseListItem`: shopping list entry generated manually or by low stock/expiry.
- `ExpiryRecord`: expiry/opened/use-by dates.
- `ManualDocument`: manuals, invoices, warranty cards, repair notes, and generated summaries.

The old `Asset.items` model maps well to `InventoryBatch` or `ObjectItem`, depending on whether the child item needs quantity tracking.

### Wardrobe Model

Wardrobe remains a specialized object domain:

- clothing items stay first-class, not merged into generic inventory rows
- clothing can still be placed in compartments
- outfit records, wear count, clean status, material, season, and images remain wardrobe-specific

The old wardrobe `location` field becomes a `Placement` relation. The old category, image, clean status, and outfit record model should be migrated as a specialized `WardrobeItem` surface or as typed `ObjectItem` extensions.

### Device Model

Core entities:

- `Device`: semantic device in Hermes, such as purifier, lamp, curtain, AC, sensor, switch.
- `DeviceCapability`: normalized capabilities such as `switch.on_off`, `light.brightness`, `light.color_temperature`, `sensor.pm25`, `climate.temperature`, `cover.position`, `consumable.filter_life`.
- `DeviceState`: latest state snapshot plus freshness metadata.
- `DeviceBinding`: mapping from Hermes device to provider entity.
- `DeviceEvent`: state change, command, adapter sync, or error event.

Example binding:

```json
{
  "provider": "home_assistant",
  "external_id": "fan.living_room_air_purifier",
  "external_type": "fan",
  "capabilities_map": {
    "switch.on_off": "state",
    "fan.speed": "attributes.percentage",
    "sensor.pm25": "sensor.living_room_pm25",
    "consumable.filter_life": "sensor.living_room_filter_life"
  }
}
```

## Xiaomi And Home Assistant Strategy

V1 should prioritize Home Assistant as the smart-device bridge, especially for Xiaomi/Mijia.

Reasons:

- Xiaomi devices vary across cloud, LAN, Bluetooth Mesh, Zigbee gateway, and Matter paths.
- Home Assistant already has community and official Xiaomi integrations that expose devices as entities.
- Hermes should avoid hardcoding Xiaomi private API assumptions into the core model.

Initial adapter surface:

- `HomeAssistantAdapter`
  - configure URL and long-lived access token
  - test connection
  - list entities
  - import entity registry
  - read current states
  - call services for normalized control commands

Xiaomi devices then enter Hermes through Home Assistant in V1. Later direct Xiaomi Home/MIoT support can be added as another adapter without changing the Home semantic model.

## Studio Integration

The Home module belongs under PersonalOS:

- overview card in `/hermes/personal-os`
- full module route: `/hermes/personal-os/home`
- later subroutes can split map, inventory, devices, and automation if needed

Recommended first-page structure:

- `Overview`: home health, low stock, expiring items, device anomalies, pending maintenance, recent events
- `Map`: 2D layout first, later 3D mode
- `Inventory`: stock, expiry, shopping list, storage location
- `Objects`: physical items, assets, manuals, warranties
- `Devices`: adapters, imported devices, live state, bindings, manual control
- `Automation`: intents, scenes, rules, confirmations, run history

The main UX principle: chat is an input path, not the primary information architecture.

## 2D And 3D Layout Plan

V1 should ship a practical 2D layout editor, then evolve into 3D.

### V1 2D

Use the previous asset map editor as product reference:

- canvas coordinates
- room rectangles
- furniture rectangles
- compartment anchors
- object/device placement points
- drag to move
- click to inspect
- filter by room/furniture/compartment

Improvements over the old implementation:

- room and placement become structured database rows, not `custom_metadata`
- furniture and compartments are first-class
- placement supports object, asset, inventory batch, and device targets
- floor is supported from the start

### V2 3D

Add a Three.js home map:

- floors and rooms as simple extruded geometry
- furniture as low-poly boxes with type metadata
- compartments as selectable sub-volumes
- device state overlays, such as light on/off or sensor values
- object pins for precise item lookup

The previous health 3D viewer provides useful patterns: camera presets, orbit controls, object selection, state coloring, and layered overlays.

## Intent And Automation

Home intents should run through an auditable orchestrator, following the old home assistant orchestration pattern.

Intent examples:

- "备用滤芯在哪"
- "客厅空气怎么样"
- "打开书房灯"
- "厨房快过期的东西列出来"
- "生成本周家务和补货清单"
- "卧室衣柜左下抽屉有什么"

Execution model:

```text
message / voice
  -> intent parse
  -> semantic resolution
  -> object/device/inventory lookup
  -> policy and confirmation
  -> adapter or database action
  -> run and step audit
  -> response and state update
```

Risk policy:

- low risk: read-only lookup, status query, inventory search
- medium risk: create shopping list, create maintenance task, move placement, adjust non-critical device state
- high risk: unlock/open entry devices, destructive inventory correction, broad automation, command execution

Medium and high risk actions need confirmation in V1 unless explicitly whitelisted.

## Database Placement

Use profile-scoped SQLite under the Hermes profile directory, similar to Personal State:

```text
<profile>/home_state.db
```

Initial tables:

- `home_meta`
- `home_floors`
- `home_rooms`
- `home_zones`
- `home_furniture`
- `home_compartments`
- `home_objects`
- `home_inventory_batches`
- `home_inventory_ledger`
- `home_assets`
- `home_documents`
- `home_devices`
- `home_device_capabilities`
- `home_device_states`
- `home_device_bindings`
- `home_device_events`
- `home_placements`
- `home_maintenance_tasks`
- `home_purchase_list_items`
- `home_intent_runs`
- `home_intent_steps`
- `home_adapter_configs`

Adapter secrets, such as Home Assistant tokens, should use the existing server-side secret handling pattern and should never be returned to the client in plaintext.

## API Surface

Recommended first API group:

- `GET /api/hermes/home/overview`
- `GET /api/hermes/home/map`
- `POST /api/hermes/home/rooms`
- `POST /api/hermes/home/furniture`
- `POST /api/hermes/home/compartments`
- `POST /api/hermes/home/placements`
- `GET /api/hermes/home/inventory`
- `POST /api/hermes/home/inventory`
- `POST /api/hermes/home/inventory/:id/consume`
- `GET /api/hermes/home/devices`
- `POST /api/hermes/home/adapters/home-assistant/test`
- `POST /api/hermes/home/adapters/home-assistant/sync`
- `POST /api/hermes/home/devices/:id/bind`
- `POST /api/hermes/home/devices/:id/command`
- `POST /api/hermes/home/intent`
- `POST /api/hermes/home/intent/:id/confirm`

V1 should keep the API shaped around the Home model, not around any single provider.

## Migration From Previous Data

The previous projects are references, not live sources of truth for Studio. Still, migration should be planned:

1. Import confirmed loft layout into `Floor`, `Room`, and coarse `Furniture`.
2. Import asset containers and child items into `Asset`, `ObjectItem`, `InventoryBatch`, and `Placement`.
3. Convert old `space_room`, `space_storage`, `map_position`, and wardrobe `location` strings into structured placement.
4. Preserve old IDs in `source_tag` / `source_id` or equivalent provenance fields.
5. Import wardrobe data as typed objects with wardrobe-specific fields.
6. Keep a migration report for rows that cannot be confidently mapped.

Do not delete or rewrite old personal-assistant databases during migration.

## V1 Scope

V1 should do both digital twin and device integration, but at practical depth:

1. Home database and service layer.
2. 2D map editor with floors, rooms, furniture, compartments, and placements.
3. Inventory and object list with quantity, expiry, location, and movement log.
4. Home Assistant adapter configuration and sync.
5. Device import and binding to rooms/furniture/placements.
6. Basic device control through normalized capabilities.
7. Intent endpoint for lookup, inventory search, device status, simple control, and maintenance/shopping task creation.
8. Run/step audit and confirmation handling.

Out of scope for V1:

- full BIM-grade home modeling
- automatic perfect room reconstruction from photos
- direct Xiaomi private API integration
- unrestricted automatic device control
- advanced 3D furniture modeling
- multi-household collaboration

## Error Handling

- Missing Home Assistant config: show setup state and keep digital twin usable.
- Home Assistant sync failure: preserve previous state and mark adapter stale.
- Unknown provider entity: import as unbound candidate until user maps it.
- Ambiguous placement import: keep object unplaced and list it in migration report.
- Inventory deduction below zero: clamp only when the action is explicit; otherwise request confirmation.
- Device command failure: record event and return recovery guidance.
- Adapter token errors: redact token and show only connection status.

## Testing Strategy

Backend:

- schema initialization and migrations
- room/furniture/compartment CRUD
- placement rules and movement
- inventory consume and ledger behavior
- Home Assistant adapter test and sync with mocked responses
- capability normalization
- command confirmation policy
- intent run/step persistence

Frontend:

- PersonalOS Home module card links to Home route
- 2D map renders rooms, furniture, and placements
- dragging placement persists the target
- inventory detail shows location and ledger
- device list shows provider, state freshness, and binding
- command controls require confirmation when needed

Integration:

- import previous loft layout sample
- sync mocked Home Assistant entities
- bind a purifier to living room
- consume a spare filter and create maintenance history
- ask "where is the spare filter" and receive the placement answer

## Open Decisions

- Whether V1 stores Home data in one `home_state.db` or extends `personal_state.db`.
- Whether the first visual editor supports multiple floors immediately or uses a single floor with floor metadata hidden.
- Whether wardrobe data is imported into Home V1 or linked later after the generic placement model is stable.
- Whether the Home Assistant adapter configuration lives under Settings or inside the Home module setup page.
- Whether device commands should be available from the map in V1 or only from the Devices tab.
