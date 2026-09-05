import { config } from '../../studio/public/config'
import { AgentUpdatePolicy } from './update-policy'
import { getCodingAgentDefinitions, checkUpdateAgent, installCodingAgent } from './index'
import { codingAgentRunManager } from './runtime/run-manager'
import { lockAgentUpdate } from './update-lock'
const policy = new AgentUpdatePolicy(config.appHome, {
 ids:()=>getCodingAgentDefinitions().map(v=>v.id),
 check:checkUpdateAgent,
 busy:id=>codingAgentRunManager.hasLiveAgent(id),
 install:async id=>{
  const release=lockAgentUpdate(id)
  try {
   if(codingAgentRunManager.hasLiveAgent(id))throw new Error('Agent session became active; update postponed')
   return await installCodingAgent(id)
  }finally{release()}
 },
})
let started: Promise<void>|null=null
export async function getAgentUpdateManager():Promise<AgentUpdatePolicy>{
 if(!started)started=policy.load().then(()=>policy.start())
 await started;return policy
}
