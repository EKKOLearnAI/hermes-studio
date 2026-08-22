# Petdex and Local Pets

This document describes the Petdex catalog and local pet management flow in Hermes Studio.

## Entry Points

- Client view: `packages/client/src/views/hermes/PetdexView.vue`
- Client API helper: `packages/client/src/api/hermes/pets.ts`
- Pet state store: `packages/client/src/stores/hermes/pets.ts`
- Server routes: `packages/server/src/routes/hermes/pets.ts`
- Server controller: `packages/server/src/controllers/hermes/pets.ts`
- Server service: `packages/server/src/services/hermes/pets.ts`

The Petdex page has two tabs:

- **Petdex** loads the remote Petdex manifest, supports search and kind filtering, and lets the user adopt a catalog pet.
- **Local** lists pets installed in the current Web UI profile, supports local asset import, and lets the user adopt or remove an installed pet.

## Local Import

The import dialog accepts:

- One required spritesheet image: PNG, WebP, JPEG, or GIF.
- One optional `pet.json` file when importing a folder.
- Display name, kind, and submitter metadata.

The upload endpoint accepts `multipart/form-data` and limits the complete request body to 10 MB. The client can import a single spritesheet or select a folder. For folder imports, the client looks for files named `spritesheet.png`, `spritesheet.webp`, `spritesheet.jpg`, `spritesheet.jpeg`, `spritesheet.gif`, and `pet.json`.

When `pet.json` is present, the UI attempts to fill metadata from these keys:

- Display name: `displayName`, `name`, or `title`
- Kind: `kind`, `type`, or `category`
- Submitter: `submittedBy`, `author`, `creator`, or `by`

The imported pet is installed but is not automatically activated. The user must select **Adopt** from the local pet list.

ZIP import is not currently implemented. The ZIP button is intentionally disabled in the UI.

## Storage

Installed pets are stored under the Web UI home, separated by profile:

```text
<HERMES_WEB_UI_HOME>/profile-metadata/<base64url-profile>/pets/
  active.json
  <slug>/
    pet.json
    spritesheet.<extension>
    local-pet.json       # optional imported metadata copy
```

`HERMES_WEB_UI_HOME` is resolved by the server configuration. The default is the normal Web UI state directory. Pet files are written with restrictive file permissions where supported by the platform.

The slug is normalized to lowercase and restricted to letters, numbers, `.`, `_`, and `-`. Importing another pet with the same slug replaces the files and metadata in that slug directory.

`active.json` stores the active pet slug, enabled state, scale, position, and update timestamp. Deleting the active pet removes its directory and disables the active configuration.

## HTTP API

All endpoints are profile-scoped using the request profile context (`X-Hermes-Profile` where applicable).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/hermes/pets/local` | List installed pets for the current profile. |
| `POST` | `/api/hermes/pets/import` | Import a spritesheet and optional `petJson` as multipart form data. Returns `201` on success. |
| `GET` | `/api/hermes/pets/local/:slug/asset` | Return the stored spritesheet bytes. |
| `GET` | `/api/hermes/pets/local/:slug/preview` | Return the local pet preview asset. |
| `DELETE` | `/api/hermes/pets/local/:slug` | Remove the installed pet and disable it when it was active. |
| `POST` | `/api/hermes/pets/adopt` | Activate an installed local pet, or fall back to adopting a Petdex pet. |

The import form fields are `slug`, `displayName`, `kind`, `submittedBy`, `spritesheet`, and optional `petJson`. The server requires the `spritesheet` file and rejects non-multipart requests.

The asset endpoints return binary image data. Missing pets return `404`; malformed requests return `400`; uploads over 10 MB return `413`.

## Desktop Behavior

The feature is implemented in the shared client and server packages. `packages/desktop` does not need a separate implementation: desktop runs the same Web UI server and client bundle. When a pet is adopted in the desktop client, the existing desktop bridge makes the pet window visible and applies the desktop scale preference.

`packages/ekko-agent` does not participate in Petdex or local pet storage.

## Validation

Focused server coverage is available in:

- `tests/server/pets-service.test.ts`
- `tests/server/pets-adopt-service.test.ts`

Use the smallest relevant checks while iterating:

```bash
npm exec vitest run tests/server/pets-service.test.ts tests/server/pets-adopt-service.test.ts
npm run build
```
