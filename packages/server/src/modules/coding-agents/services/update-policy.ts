import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

export type UpdateState = { autoUpdate: boolean; checkedAt: string; currentVersion: string; latestVersion: string; status: 'unknown'|'checking'|'current'|'available'|'waiting'|'updating'|'failed'; error?: string }
export type UpdateAdapter = {
  ids(): string[]
  check(id: string): Promise<{success: boolean; tool: {installed: boolean; version: string}; latestVersion: string; updateAvailable: boolean; message?: string}>
  install(id: string): Promise<{success: boolean; tool: {version: string}; message?: string}>
  busy(id: string): boolean
}
const blank = (): UpdateState => ({autoUpdate:false,checkedAt:'',currentVersion:'',latestVersion:'',status:'unknown'})
/** Only one scheduler owns checks; adapters must atomically exclude new launches
 * while installing. Policy is host-wide, never inherited from a chat prompt. */
export class AgentUpdatePolicy {
  private states: Record<string, UpdateState> = {}
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private writes: Promise<void> = Promise.resolve()
  constructor(private home: string, private adapter: UpdateAdapter) {}
  async load(): Promise<void> {
    try {
      const data=JSON.parse(await readFile(join(this.home,'agent-update-policy.json'),'utf8'))
      for(const id of this.adapter.ids()) if(typeof data[id]?.autoUpdate==='boolean') this.states[id]={...blank(),autoUpdate:data[id].autoUpdate}
    } catch { /* absent or invalid policy fails closed to manual install */ }
  }
  snapshot(): Record<string, UpdateState> { return Object.fromEntries(this.adapter.ids().map(id=>[id,{...(this.states[id]||blank())}])) }
  async set(id: string, enabled: unknown): Promise<void> {
    if(!this.adapter.ids().includes(id)||typeof enabled!=='boolean') throw new Error('Invalid agent update policy')
    this.states[id]={...(this.states[id]||blank()),autoUpdate:enabled}
    const value=JSON.stringify(Object.fromEntries(Object.entries(this.states).map(([key,v])=>[key,{autoUpdate:v.autoUpdate}])))
    this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.home,{recursive:true});const path=join(this.home,'agent-update-policy.json');await writeFile(path+'.tmp',value,{mode:0o600});await rename(path+'.tmp',path)})
    await this.writes
  }
  start(): void { if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),60_000);this.timer.unref?.() }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=undefined }
  async tick(force=false): Promise<void> {
    if(this.running)return;this.running=true
    try {
      for(const id of this.adapter.ids()) {
        const state=this.states[id] ||= blank()
        try {
          if(force||!state.checkedAt||Date.now()-Date.parse(state.checkedAt)>=6*60*60_000) {
            state.status='checking';state.error=undefined
            const result=await this.adapter.check(id);state.checkedAt=new Date().toISOString()
            if(!result.success)throw new Error(result.message||'Update check failed')
            state.currentVersion=result.tool.version;state.latestVersion=result.latestVersion
            state.status=result.tool.installed&&result.updateAvailable?'available':'current'
          }
          if(!state.autoUpdate||!['available','waiting'].includes(state.status))continue
          if(this.adapter.busy(id)){state.status='waiting';continue}
          state.status='updating'
          const result=await this.adapter.install(id)
          if(!result.success)throw new Error(result.message||'Update failed')
          state.currentVersion=result.tool.version;state.status='unknown';state.checkedAt=''
        } catch(error) {state.status='failed';state.error=error instanceof Error?error.message:'Update failed'}
      }
    } finally {this.running=false}
  }
}
