import { beforeEach, it, expect, vi } from 'vitest'
const auth=vi.hoisted(()=>({user:{id:1,role:'user'} as any,profiles:['default']}))
vi.mock('../../packages/server/src/modules/studio/public/auth',()=>({authenticateUserToken:async()=>auth.user}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store',()=>({listUserProfiles:()=>auth.profiles.map(profile_name=>({profile_name}))}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({source:'cli',agent:'codex',profile:'default'}),getSessionNotificationPreview:()=>({title:'Title',preview:'Reply'})}))
import { bindAppEventSubscription, parseAppSubscription, publishDomainEvent, publishGroupMessage, registerGroupEventAccess } from '../../packages/server/src/modules/studio/services/webhooks/app-events'
function socket(){const handlers=new Map<string,Function>();return {id:Math.random().toString(),handshake:{auth:{token:'test'}},data:{},emit:vi.fn(),on:(n:string,f:Function)=>{const old=handlers.get(n);handlers.set(n,old?(...args:any[])=>{old(...args);f(...args)}:f)},once:(n:string,f:Function)=>handlers.set(n,f),handlers}}
const flush=()=>new Promise(r=>setTimeout(r,15))
beforeEach(()=>{auth.user={id:1,role:'user'};auth.profiles=['default']})
it('normalizes omitted/blank profile before authorization and validates types',async()=>{
 expect(parseAppSubscription({schema_version:1}).profile).toBe('default')
 expect(()=>parseAppSubscription({schema_version:1,types:['unsafe']})).toThrow()
 const s=socket();bindAppEventSubscription(s as any);auth.profiles=['other'];const ack=vi.fn()
 await s.handlers.get('app.events.subscribe')!({schema_version:1},ack)
 expect(ack).toHaveBeenCalledWith({ok:false,error:'event_subscription_denied'})
 s.handlers.get('disconnect')!()
})
it('receives unified workflow event without HTTP endpoints and rechecks revocation',async()=>{
 const s=socket();bindAppEventSubscription(s as any)
 await s.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'r'},{title:'W'})
 await flush();expect(s.emit).toHaveBeenCalledWith('app.event',expect.objectContaining({schema_version:1,type:'workflow.run.completed',subject:{workflow_id:'w',run_id:'r'}}))
 auth.profiles=[]
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'r2'},{title:'W'})
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 s.handlers.get('disconnect')!()
})
it('group membership and filters are intersected at delivery and disconnected listeners removed',async()=>{
 let member=true;const unregister=registerGroupEventAccess({canReceive:()=>member})
 const s=socket();bindAppEventSubscription(s as any)
 await s.handlers.get('app.events.subscribe')!({schema_version:1,room_ids:['r']},vi.fn())
 publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'a',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 member=false;publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'b',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 s.handlers.get('disconnect')!();member=true
 publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'c',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1);unregister()
})
it('new protocol selection excludes legacy delivery and requested/resolved identities remain distinct',async()=>{
 const { bindLegacyAppEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events')
 const s=socket();s.handshake.auth={token:'test',appEventVersion:1} as any
 bindAppEventSubscription(s as any);bindLegacyAppEvents(s as any,'workflow',()=>true)
 await s.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'versioned'},{title:'W'})
 await flush();expect(s.emit.mock.calls.map(call=>call[0])).toEqual(['app.event'])
 s.handlers.get('disconnect')!()
})
it('real Socket.IO transport restores subscriptions and emits the same envelope after reconnect',async()=>{
 const {createServer}=await import('node:http')
 const {Server}=await import('socket.io')
 const {io}=await import('socket.io-client')
 const http=createServer();const server=new Server(http)
 server.of('/chat-run').on('connection',bindAppEventSubscription)
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
 const port=(http.address() as any).port
 const client=io(`http://127.0.0.1:${port}/chat-run`,{auth:{token:'test',appEventVersion:1},transports:['websocket'],autoConnect:false})
 const received:any[]=[];client.on('app.event',e=>received.push(e))
 const connect=async()=>{const ready=new Promise<void>(resolve=>client.once('connect',()=>resolve()));client.connect();await ready;await new Promise<void>((resolve,reject)=>client.emit('app.events.subscribe',{schema_version:1,profile:'default'},(ack:any)=>ack.ok?resolve():reject(Error('denied'))))}
 try {
  await connect();publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'live1'},{title:'W'})
  await vi.waitFor(()=>expect(received).toHaveLength(1))
  expect(received[0]).toMatchObject({schema_version:1,type:'workflow.run.completed',subject:{workflow_id:'w',run_id:'live1'},display:{title:'W'}})
  client.disconnect();await flush();publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'offline'},{title:'W'})
  await connect();expect(received).toHaveLength(1)
  publishDomainEvent('workflow.run.failed','default',{workflow_id:'w',run_id:'live2'},{title:'W'})
  await vi.waitFor(()=>expect(received).toHaveLength(2))
 } finally {client.disconnect();await new Promise<void>(resolve=>server.close(()=>resolve()));http.close()}
})
