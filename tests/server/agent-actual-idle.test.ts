import { expect, it } from 'vitest'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { beginAgentPreparation, lockAgentUpdate, agentPreparing, agentActivityRevision } from '../../packages/server/src/modules/coding-agents/services/update-lock'
it('idle retained conversations do not block updates but active work and queues do',()=>{
 const manager=new CodingAgentRunManager()
 const run:any={launch:{agentId:'codex'},exited:false,state:{isWorking:false,queue:[],events:[]}}
 ;(manager as any).runs.set('test',run)
 expect(manager.isAgentBusyForUpdate('codex')).toBe(false)
 for(const field of ['turnActive','pendingChatCompletionEvent','pty']) {
  run[field]=true;expect(manager.isAgentBusyForUpdate('codex')).toBe(true);delete run[field]
 }
 run.state.queue.push({});expect(manager.isAgentBusyForUpdate('codex')).toBe(true);run.state.queue=[]
 run.state.events=[{event:'approval.requested'}];expect(manager.isAgentBusyForUpdate('codex')).toBe(true)
 expect(manager.isAgentBusyForUpdate('pi')).toBe(false)
})
it('async preparation and update lock exclude each other per Agent',()=>{
 const before=agentActivityRevision('codex');const done=beginAgentPreparation('codex')
 expect(agentPreparing('codex')).toBe(true);expect(()=>lockAgentUpdate('codex')).toThrow()
 done();expect(agentActivityRevision('codex')).toBeGreaterThan(before)
 const unlock=lockAgentUpdate('codex');try {expect(()=>beginAgentPreparation('codex')).toThrow();const other=beginAgentPreparation('pi');other()}finally{unlock()}
})
