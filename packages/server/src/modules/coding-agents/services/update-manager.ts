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
let loaded: Promise<void>|null=null
function loadPolicy(): Promise<void> {
  if (!loaded) loaded = policy.load()
  return loaded
}
// Manual checking publishes the shared result but must not start auto-install.
export async function checkAgentUpdateAndPublish(id: string) {
  await loadPolicy()
  return policy.checkNow(id)
}
let started: Promise<void>|null=null
export async function getAgentUpdateManager():Promise<AgentUpdatePolicy>{
 if(!started)started=loadPolicy().then(()=>policy.start())
 await started;return policy
}
