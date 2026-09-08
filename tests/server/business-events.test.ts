import { it, expect, vi } from 'vitest'
import { createBusinessEventHub } from '../../packages/server/src/modules/studio/services/webhooks/business-events'
const event={schema_version:1 as const,id:'e',type:'chat.run.completed',occurred_at:new Date().toISOString(),profile:'default',source:'chat',subject:{session_id:'s'},payload:{}}
it('HTTP and social failures cannot block App, with unsubscribe cleanup', async()=>{
 const errors=vi.fn(),app=vi.fn();const hub=createBusinessEventHub(errors)
 hub.subscribe('http',()=>{throw Error('failed')});hub.subscribe('social',async()=>{throw Error('failed')})
 const stop=hub.subscribe('app',app);hub.publish(event);await Promise.resolve();await Promise.resolve()
 expect(app).toHaveBeenCalledOnce();expect(errors).toHaveBeenCalledWith('http');expect(errors).toHaveBeenCalledWith('social')
 stop();hub.publish(event);expect(app).toHaveBeenCalledOnce()
})
