import { expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/public/auth',()=>({authenticateUserToken:vi.fn(),isAuthEnabled:vi.fn()}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store',()=>({listUserProfiles:()=>[{profile_name:'allowed'}]}))
const run=vi.hoisted(()=>({status:'completed'}))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({getWorkflowRunWithEvidence:()=>run}))
vi.mock('../../packages/server/src/modules/studio/services/workflow/manager',()=>({getWorkflowManager:vi.fn()}))
vi.mock('../../packages/server/src/modules/studio/public/logging',()=>({logger:{error:vi.fn(),info:vi.fn()}}))
import { WorkflowSocketServer } from '../../packages/server/src/modules/studio/sockets/workflow'
it('notifies only terminal run once to currently authorized users, never canceled or node progress',()=>{
 const ok={data:{user:{id:1}},emit:vi.fn()},guest={data:{},emit:vi.fn()}
 const nsp={sockets:new Map([['ok',ok],['guest',guest]]),to:()=>({emit:vi.fn()})}
 const manager={onRuntimeStatus:vi.fn(()=>()=>{}),get:()=>({id:'w',name:'Workflow',profile:'allowed'})}
 const server=new WorkflowSocketServer({of:()=>nsp} as any,manager as any)
 const send=(status:string,runId='r')=>(server as any).emitRuntimeStatus({workflowId:'w',runId,status})
 send('running');send('canceled');expect(ok.emit).not.toHaveBeenCalled()
 send('completed');send('completed');expect(ok.emit).toHaveBeenCalledTimes(1);expect(guest.emit).not.toHaveBeenCalled()
 expect(ok.emit.mock.calls[0][1]).toMatchObject({target:'workflow',workflowId:'w',runId:'r',kind:'completion'})
 run.status='failed';send('failed','r2');expect(ok.emit).toHaveBeenCalledTimes(2)
 manager.get=()=>({id:'w',name:'Workflow',profile:'denied'});send('failed','r3');expect(ok.emit).toHaveBeenCalledTimes(2)
})
