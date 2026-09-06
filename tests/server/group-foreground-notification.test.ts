import { it, expect } from 'vitest'
import { groupReplyNotification } from '../../packages/server/src/modules/studio/services/group-chat/foreground-notification'
it('builds a WeChat-style room title and sender-prefixed bounded preview',()=>{
 const event=groupReplyNotification({id:'room',name:'Team'},{id:'m',senderName:'Pi',senderType:'agent',role:'assistant',content:'Done\nnow'},10)
 expect(event).toMatchObject({id:'group:room:message:m',target:'group',title:'Team',content:'Pi: Done now',messageId:'m',timestamp:10})
})
it('does not alert for human posts, tools, empty output or interrupted output',()=>{
 const base={id:'m',senderName:'Pi',senderType:'agent',role:'assistant',content:'done'}
 for(const patch of [{senderType:'member'},{role:'tool'},{content:''},{finish_reason:'tool_calls'},{finish_reason:'aborted'}]) expect(groupReplyNotification({id:'r',name:'Room'},{...base,...patch})).toBeNull()
})
