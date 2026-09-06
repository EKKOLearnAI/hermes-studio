import { describe, it, expect } from 'vitest'
import { foregroundNotification as event } from '../../packages/server/src/modules/studio/services/chat-run/foreground-notification'
describe('foreground notification contract', () => {
  it('uses stable request and run identities without sensitive payload', () => {
    expect(event('approval.requested', { session_id:'s',approval_id:'a',command:'secret' },10)).toEqual({id:'s:approval:a',sessionId:'s',kind:'approval',resolved:false,timestamp:10})
    expect(event('approval.resolved',{session_id:'s',approval_id:'a'},11)?.id).toBe('s:approval:a')
    expect(event('run.completed',{session_id:'s',run_id:'r'},10)?.kind).toBe('completion')
  })
  it('ignores progress, aborts, missing identity and queued/interrupted runs', () => {
    for(const name of ['abort.completed','tool.completed','session.activity']) expect(event(name,{session_id:'s',run_id:'r'})).toBeNull()
    expect(event('run.completed',{session_id:'s'})).toBeNull()
    expect(event('run.completed',{session_id:'s',run_id:'r',queue_remaining:1})).toBeNull()
    expect(event('run.completed',{session_id:'s',run_id:'r',interrupted:true})).toBeNull()
  })
})
