import { expect, it } from 'vitest'
// @ts-expect-error Harness scripts are plain Node modules.
import { dshModuleViolations } from '../../scripts/dsh-module-harness.mjs'

it('keeps Web composition and unrestricted execution policy inside DSH', () => {
  const source = "const env = { DSH_PERMISSION_MODE: 'danger-full-access' }"
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/runtime-config.ts', source)).toEqual([])
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/runtime/run-manager.ts', source)).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/index.ts', 'export async function executeDshPluginCommand() {}')).toHaveLength(1)
  expect(dshModuleViolations('packages/server/src/modules/coding-agents/services/dsh/host.ts', "import { commandEnv } from '..'")).toHaveLength(1)
})
