import type { WorkflowRecord, WorkflowRunNowInput } from './workflow-manager'
import { getWorkflowManager } from './workflow-manager'
import { createWorkflowScheduleEvent, claimWorkflowScheduleTrigger, getWorkflowSchedule, listWorkflowSchedules, updateWorkflowSchedule, type WorkflowScheduleRecord } from '../db/hermes/workflow-schedule-store'
import { listActiveWorkflowRuns } from '../db/hermes/workflow-run-store'
import { logger } from './logger'

type Dependencies = { getWorkflow?: (id:string)=>WorkflowRecord|null; hasActiveRun?: (id:string)=>boolean; runNow?: (id:string,input:WorkflowRunNowInput)=>Promise<{run:{id:string}}> }
const MINUTE=60_000
function values(field:string,min:number,max:number):Set<number> { const out=new Set<number>(); for(const part of field.split(',')){ const [range,stepRaw]=part.split('/'); const step=stepRaw?Number(stepRaw):1; if(!Number.isInteger(step)||step<1)throw new Error('invalid cron step'); const [fromRaw,toRaw]=range==='*'?[String(min),String(max)]:range.split('-'); const from=Number(fromRaw),to=toRaw===undefined?from:Number(toRaw); if(!Number.isInteger(from)||!Number.isInteger(to)||from<min||to>max||from>to)throw new Error('invalid cron field'); for(let n=from;n<=to;n+=step)out.add(n) } return out }
export function assertWorkflowScheduleCron(schedule:string):void { const fields=schedule.trim().split(/\s+/); if(fields.length!==5)throw new Error('schedule must be a five-field cron expression'); values(fields[0],0,59);values(fields[1],0,23);values(fields[2],1,31);values(fields[3],1,12);values(fields[4],0,6) }
function zoned(date:number,timezone:string):number[]{ const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,minute:'numeric',hour:'numeric',day:'numeric',month:'numeric',weekday:'short',hourCycle:'h23'}).formatToParts(new Date(date)); const v=(t:string)=>Number(parts.find(p=>p.type===t)?.value); const weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.find(p=>p.type==='weekday')?.value||''); return [v('minute'),v('hour'),v('day'),v('month'),weekday] }
export function nextWorkflowScheduleAt(schedule:string,timezone:string,after:number):number { assertWorkflowScheduleCron(schedule); new Intl.DateTimeFormat('en-US',{timeZone:timezone}); const fields=schedule.trim().split(/\s+/).map((field,i)=>values(field,[0,0,1,1,0][i],[59,23,31,12,6][i])); let candidate=Math.floor(after/MINUTE)*MINUTE+MINUTE; const limit=candidate+366*24*60*MINUTE; while(candidate<=limit){const p=zoned(candidate,timezone);if(p.every((value,i)=>fields[i].has(value)))return candidate;candidate+=MINUTE}throw new Error('schedule has no occurrence in the next year') }

export class WorkflowScheduleService {
  private readonly getWorkflow: NonNullable<Dependencies['getWorkflow']>; private readonly hasActiveRun: NonNullable<Dependencies['hasActiveRun']>; private readonly runNow: NonNullable<Dependencies['runNow']>; private timer: ReturnType<typeof setInterval>|null=null
  constructor(deps:Dependencies={}) { this.getWorkflow=deps.getWorkflow||((id)=>getWorkflowManager().get(id)); this.hasActiveRun=deps.hasActiveRun||((id)=>listActiveWorkflowRuns().some(run=>run.workflow_id===id)); this.runNow=deps.runNow||((id,input)=>getWorkflowManager().runNow(id,input)) }
  start():void { if(this.timer)return; void this.tick(); this.timer=setInterval(()=>void this.tick(),15_000); this.timer.unref?.() }
  stop():void { if(this.timer)clearInterval(this.timer);this.timer=null }
  async tick(now=Date.now()):Promise<void>{ for(const schedule of listWorkflowSchedules()){ try{await this.process(schedule,now)}catch(error){logger.error(error,'[workflow-schedule] tick failed for %s',schedule.id)} } }
  private async process(schedule:WorkflowScheduleRecord,now:number):Promise<void>{
    if(!schedule.enabled)return
    let next=schedule.next_run_at
    if(next==null){ updateWorkflowSchedule(schedule.id,{next_run_at:nextWorkflowScheduleAt(schedule.schedule,schedule.timezone,now)}); return }
    if(next>now)return
    const identity=claimWorkflowScheduleTrigger(schedule,next); const following=nextWorkflowScheduleAt(schedule.schedule,schedule.timezone,now)
    if(!identity){ updateWorkflowSchedule(schedule.id,{next_run_at:following}); return }
    const workflow=this.getWorkflow(schedule.workflow_id)
    if(!workflow || workflow.profile!==schedule.profile){ const error='scheduled workflow is unavailable or its profile changed'; createWorkflowScheduleEvent({schedule_id:schedule.id,workflow_id:schedule.workflow_id,trigger_identity:identity,scheduled_at:next,kind:'failed',run_id:null,error}); updateWorkflowSchedule(schedule.id,{last_scheduled_at:next,next_run_at:following,last_error:error}); return }
    if(next < now-MINUTE || this.hasActiveRun(schedule.workflow_id)){ const error=next < now-MINUTE?'scheduled occurrence skipped while service was offline':'scheduled occurrence skipped because workflow is already running'; createWorkflowScheduleEvent({schedule_id:schedule.id,workflow_id:schedule.workflow_id,trigger_identity:identity,scheduled_at:next,kind:'skipped',run_id:null,error}); updateWorkflowSchedule(schedule.id,{last_scheduled_at:next,next_run_at:following,last_error:error}); return }
    try { const result=await this.runNow(schedule.workflow_id,{profile:schedule.profile,startNodeIds:schedule.start_node_ids,input:schedule.input,timeoutMs:schedule.timeout_ms??undefined,triggerSource:'scheduled',scheduledAt:next}); createWorkflowScheduleEvent({schedule_id:schedule.id,workflow_id:schedule.workflow_id,trigger_identity:identity,scheduled_at:next,kind:'triggered',run_id:result.run.id,error:null}); updateWorkflowSchedule(schedule.id,{last_scheduled_at:next,next_run_at:following,last_run_id:result.run.id,last_error:null}) }
    catch(err:any){const error=err?.message||'scheduled workflow failed preflight';createWorkflowScheduleEvent({schedule_id:schedule.id,workflow_id:schedule.workflow_id,trigger_identity:identity,scheduled_at:next,kind:'failed',run_id:null,error});updateWorkflowSchedule(schedule.id,{last_scheduled_at:next,next_run_at:following,last_error:error})}
  }
}
let singleton:WorkflowScheduleService|undefined
export function getWorkflowScheduleService():WorkflowScheduleService { return singleton ||= new WorkflowScheduleService() }
