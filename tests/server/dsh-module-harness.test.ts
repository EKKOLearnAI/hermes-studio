import { expect, it } from 'vitest'
// @ts-expect-error Harness scripts are plain Node modules.
import { dshModuleViolations } from '../../scripts/dsh-module-harness.mjs'

it('keeps Web composition and unrestricted execution policy inside DSH', () => {
  const source = "const env = { DSH_PERMISSION_MODE: 'danger-full-access' }"
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/runtime-config.ts', source)).toEqual([])
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/runtime/run-manager.ts', source)).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/index.ts', 'export async function executeDshPluginCommand() {}')).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/host.ts', "import { commandEnv } from '..'")).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/hermes/services/skills.ts', 'export function validateDshSkill() {}')).toHaveLength(1)
})

it('keeps the DSH slot transport out of shared client modules', () => {
  const source = "import { openDshPluginUi } from '@/api/coding-agents/dsh'"
  expect(dshModuleViolations('packages/client/src/components/coding-agents/dsh/DshPluginSettingsPanel.vue', source)).toEqual([])
  expect(dshModuleViolations('packages/client/src/views/hermes/CodingAgentConfigView.vue', source)).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/runtime-config.ts', 'const managedPluginPatches = []')).toHaveLength(1)
})

it('rejects handwritten native plugin business adapters', () => {
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/example.ts', `const path = '/modlens/config'`)).toHaveLength(1)
})
