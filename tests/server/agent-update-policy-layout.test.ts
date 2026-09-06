import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps update settings out of action buttons and hides raw process errors',()=>{
 const s=readFileSync('packages/client/src/views/hermes/AgentManagerView.vue','utf8')
 expect(s).toContain('class="agent-update-policy-row"')
 expect(s).toContain('<NSwitch size="small"')
 expect(s).not.toContain('{{ updatePolicies[agent.id]?.error }}')
 expect(s).toContain("t('codingAgents.checkUpdateFailed')")
})
