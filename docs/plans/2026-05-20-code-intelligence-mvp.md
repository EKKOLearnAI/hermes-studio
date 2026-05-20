# Code Intelligence MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only Code Intelligence page to Hermes Web UI that summarizes the current repository, detected languages, key manifests, available skills/agent workflows, and safe next actions.

**Architecture:** Implement the first version as a local server-side scanner plus a Vue dashboard. Keep the scanner read-only: no installs, no git writes, no agent execution. The API returns deterministic JSON generated from the configured/current workspace path, and the client renders it with refresh/error states.

**Tech Stack:** Vue 3, TypeScript, Koa routes/controllers, Node `fs/promises`, Vitest, vue-i18n, existing sidebar/router patterns.

---

## Scope Decisions

- MVP supports TypeScript, Vue, Python, JavaScript, Markdown, JSON, shell, and C/C++ detection.
- C++ is detection-only in MVP: show `not detected` unless `.cpp`, `.hpp`, `.h`, `.cc`, `.cxx`, `CMakeLists.txt`, `compile_commands.json`, `.sln`, or `.vcxproj` exists.
- Python is detection + Hermes bridge awareness: show whether Python files and common manifests exist.
- No agent auto-execution in MVP. The page only recommends skills/actions.
- No dependency installation.
- No deep AST parsing. Use simple file extension + manifest scanning first.

## Current Evidence

- Router lives at `packages/client/src/router/index.ts`.
- Sidebar navigation lives at `packages/client/src/components/layout/AppSidebar.vue`.
- Server route registration lives at `packages/server/src/routes/index.ts`.
- Monaco editor already exists at `packages/client/src/components/hermes/files/FileEditor.vue`.
- Chat code highlighting exists at `packages/client/src/components/hermes/chat/highlight.ts`.
- Python bridge exists at `packages/server/src/services/hermes/agent-bridge/hermes_bridge.py`.
- Current repo has many `.ts`/`.vue` files, one `.py`, and no detected C++/CMake files.

---

### Task 1: Add pure repository scanner tests

**Objective:** Define the expected read-only scanner output before adding production scanner code.

**Files:**
- Create: `tests/server/code-intelligence-scanner.test.ts`
- Later create: `packages/server/src/services/hermes/code-intelligence/scanner.ts`

**Step 1: Write failing test**

Create `tests/server/code-intelligence-scanner.test.ts` with temp-dir fixtures that assert:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { describe, expect, it, afterEach } from 'vitest'
import { scanCodeIntelligence } from '../../packages/server/src/services/hermes/code-intelligence/scanner'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-code-intel-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scanCodeIntelligence', () => {
  it('summarizes TypeScript, Vue, Python, and C++ detection without reading dependency folders', async () => {
    const root = fixture()
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(join(root, 'src', 'App.vue'), '<template />\n<script setup lang="ts"></script>\n')
    writeFileSync(join(root, 'src', 'main.ts'), 'console.log("ok")\n')
    writeFileSync(join(root, 'src', 'bridge.py'), 'print("ok")\n')
    writeFileSync(join(root, 'node_modules', 'ignored', 'huge.ts'), 'ignored\n')

    const result = await scanCodeIntelligence(root)

    expect(result.root).toBe(root)
    expect(result.languages.TypeScript.files).toBe(1)
    expect(result.languages.Vue.files).toBe(1)
    expect(result.languages.Python.files).toBe(1)
    expect(result.languages['C/C++'].status).toBe('not_detected')
    expect(result.manifests.some((item) => item.name === 'package.json')).toBe(true)
    expect(result.recommendedSkills).toContain('codebase-inspection')
    expect(result.recommendedSkills).toContain('hermes-agent')
  })

  it('marks C/C++ as detected when CMake or C++ files exist', async () => {
    const root = fixture()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n')
    writeFileSync(join(root, 'addon.cpp'), 'int main() { return 0; }\n')

    const result = await scanCodeIntelligence(root)

    expect(result.languages['C/C++'].status).toBe('detected')
    expect(result.capabilities.cpp.reason).toContain('CMakeLists.txt')
  })
})
```

**Step 2: Run test to verify RED**

Run:

```bash
npm test -- tests/server/code-intelligence-scanner.test.ts
```

Expected: FAIL because `scanner.ts` does not exist.

---

### Task 2: Implement pure read-only scanner

**Objective:** Add the minimal scanner to pass Task 1 tests.

**Files:**
- Create: `packages/server/src/services/hermes/code-intelligence/scanner.ts`

**Step 1: Write minimal implementation**

Implement:

- `scanCodeIntelligence(root: string): Promise<CodeIntelligenceSummary>`
- Recursively walk files while skipping `.git`, `node_modules`, `dist`, `build`, `.next`, `.cache`, `.runtime`, `coverage`, `venv`, `.venv`, `__pycache__`.
- Count files and lines by language.
- Detect manifests: `package.json`, `pyproject.toml`, `requirements.txt`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `CMakeLists.txt`, `compile_commands.json`, `Dockerfile`, `docker-compose.yml`.
- Return recommended skills:
  - Always: `codebase-inspection`, `hermes-agent`.
  - If TypeScript/Vue: `test-driven-development`, `github-pr-workflow`.
  - If Python: `systematic-debugging`.
  - If C/C++ detected: add `llama-cpp` only as optional when CMake/C++ exists.

**Step 2: Run scanner test**

Run:

```bash
npm test -- tests/server/code-intelligence-scanner.test.ts
```

Expected: PASS.

---

### Task 3: Add protected API route tests

**Objective:** Define a protected endpoint for the client to fetch repository intelligence.

**Files:**
- Create: `tests/server/code-intelligence-routes.test.ts`
- Later create: `packages/server/src/controllers/hermes/code-intelligence.ts`
- Later create: `packages/server/src/routes/hermes/code-intelligence.ts`
- Modify: `packages/server/src/routes/index.ts`

**Step 1: Write failing test**

Test the route module directly or through existing route test helpers. Expected endpoint:

```http
GET /api/hermes/code-intelligence/summary
```

Expected body shape:

```ts
{
  root: string,
  languages: Record<string, { files: number, lines: number, status: 'detected' | 'not_detected' | 'partial' }>,
  manifests: Array<{ name: string, path: string }>,
  capabilities: Record<string, { status: string, reason: string }>,
  recommendedSkills: string[],
  generatedAt: string
}
```

**Step 2: Run RED**

Run:

```bash
npm test -- tests/server/code-intelligence-routes.test.ts
```

Expected: FAIL because route/controller does not exist.

---

### Task 4: Implement API controller and route

**Objective:** Expose scanner output through a protected Koa route.

**Files:**
- Create: `packages/server/src/controllers/hermes/code-intelligence.ts`
- Create: `packages/server/src/routes/hermes/code-intelligence.ts`
- Modify: `packages/server/src/routes/index.ts`

**Step 1: Implement controller**

Controller behavior:

- Resolve root from `process.cwd()` for MVP.
- Call `scanCodeIntelligence(root)`.
- Set `ctx.body` to the result.
- On scanner error, return `ctx.status = 500` and `{ error: 'Failed to scan code intelligence' }`.

**Step 2: Register route**

Add in `packages/server/src/routes/index.ts`:

```ts
import { codeIntelligenceRoutes } from './hermes/code-intelligence'
```

Then mount before proxy:

```ts
app.use(codeIntelligenceRoutes.routes())
```

**Step 3: Run route test**

Run:

```bash
npm test -- tests/server/code-intelligence-routes.test.ts
```

Expected: PASS.

---

### Task 5: Add client API wrapper tests

**Objective:** Add a typed client API function for fetching Code Intelligence data.

**Files:**
- Create: `tests/client/code-intelligence-api.test.ts`
- Create: `packages/client/src/api/hermes/code-intelligence.ts`

**Step 1: Write failing test**

Mock the existing API client pattern and assert `getCodeIntelligenceSummary()` calls `/api/hermes/code-intelligence/summary`.

**Step 2: Run RED**

Run:

```bash
npm test -- tests/client/code-intelligence-api.test.ts
```

Expected: FAIL because the client API module does not exist.

---

### Task 6: Implement client API wrapper

**Objective:** Provide typed frontend access to the summary endpoint.

**Files:**
- Create: `packages/client/src/api/hermes/code-intelligence.ts`

**Step 1: Implement types and fetcher**

Export:

- `CodeLanguageSummary`
- `CodeIntelligenceSummary`
- `getCodeIntelligenceSummary()`

Follow existing API wrapper conventions in `packages/client/src/api/hermes/system-status.ts`.

**Step 2: Run API wrapper test**

Run:

```bash
npm test -- tests/client/code-intelligence-api.test.ts
```

Expected: PASS.

---

### Task 7: Add route, sidebar item, and i18n keys

**Objective:** Make the new page discoverable in the UI.

**Files:**
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/components/layout/AppSidebar.vue`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh-TW.ts`
- Later create: `packages/client/src/views/hermes/CodeIntelligenceView.vue`

**Step 1: Add route**

Add route:

```ts
{
  path: '/hermes/code-intelligence',
  name: 'hermes.codeIntelligence',
  component: () => import('@/views/hermes/CodeIntelligenceView.vue'),
}
```

**Step 2: Add sidebar item**

Place under Agent group after Skills or under Monitoring after System Status. Suggested label key: `sidebar.codeIntelligence`.

**Step 3: Add i18n keys**

English: `Code Intelligence`

Traditional Chinese: `程式碼理解`

**Step 4: Run existing sidebar/router tests if available**

Run:

```bash
npm test -- tests/client/sidebar-search.test.ts
npm test -- tests/client/markdown-rendering.test.ts
```

Expected: PASS or unrelated existing failures only.

---

### Task 8: Add Code Intelligence view with loading/error/refresh states

**Objective:** Render a useful MVP dashboard without invoking agents automatically.

**Files:**
- Create: `packages/client/src/views/hermes/CodeIntelligenceView.vue`

**Step 1: Build view**

Render sections:

- Header: `Code Intelligence`
- Refresh button
- Repository root and generated time
- Language cards:
  - TypeScript
  - Vue
  - Python
  - C/C++
- Manifest list
- Capabilities:
  - Web UI stack
  - Python bridge
  - C++ support status
- Recommended skills
- Suggested next actions:
  - Analyze repo
  - Generate tests
  - Prepare PR plan
  - Enable C++ only when C++ files are detected

**Step 2: Keep actions non-destructive**

Buttons in MVP may be disabled or show copyable prompt text. Do not run agents automatically yet.

**Step 3: Run component tests if added**

Run:

```bash
npm test -- tests/client/code-intelligence-view.test.ts
```

Expected: PASS if test file exists. If no component test is added, run full client-relevant tests in Task 9.

---

### Task 9: Build and verify

**Objective:** Prove the feature compiles and does not break existing behavior.

**Files:**
- All touched files.

**Step 1: Run targeted tests**

Run:

```bash
npm test -- tests/server/code-intelligence-scanner.test.ts tests/server/code-intelligence-routes.test.ts tests/client/code-intelligence-api.test.ts
```

Expected: PASS.

**Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS, or document pre-existing unrelated failures.

**Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

---

### Task 10: Manual UI verification

**Objective:** Confirm the page is usable in the running Web UI.

**Files:**
- No code changes unless bugs are found.

**Step 1: Start dev server**

Run:

```bash
npm run dev
```

**Step 2: Visit page**

Open:

```text
http://localhost:8648/#/hermes/code-intelligence
```

**Step 3: Verify**

Check:

- Sidebar shows `Code Intelligence` / `程式碼理解`.
- Page loads without console errors.
- TypeScript/Vue are detected.
- Python shows partial/detected because `hermes_bridge.py` exists.
- C/C++ shows not detected in this repo.
- Recommended skills include `codebase-inspection`, `hermes-agent`, and `test-driven-development`.

---

## Post-MVP Follow-up

Only after MVP is merged:

1. Add workspace selector.
2. Add agent action buttons with explicit confirmation.
3. Add task generation that can create Kanban tasks.
4. Add C++ deep support when C++/CMake/compile_commands are present.
5. Add tree-sitter or LSP-backed symbol extraction.

## Safety Boundaries

- Scanner must stay read-only.
- Do not scan dependency folders.
- Do not install packages.
- Do not run generated commands without user confirmation.
- Do not auto-commit or auto-push from this page in MVP.
