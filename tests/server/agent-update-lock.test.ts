import { expect, it } from 'vitest'
import { agentUpdateLocked, lockAgentUpdate } from '../../packages/server/src/modules/coding-agents/services/update-lock'
it('serializes installs per agent and releases on completion',()=>{
 const release=lockAgentUpdate('codex');expect(agentUpdateLocked('codex')).toBe(true)
 expect(()=>lockAgentUpdate('codex')).toThrow();expect(agentUpdateLocked('pi')).toBe(false)
 release();expect(agentUpdateLocked('codex')).toBe(false)
})
