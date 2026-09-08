import type { Message } from '@/stores/hermes/chat'

export interface TaskPlanSnapshot {
  session_id: string
  run_id: string
  plan_id: string
  revision: number
  execution_state: 'running' | 'ended' | 'interrupted' | 'failed'
  explanation?: string
  plan: Array<{ id: string; step: string; status: 'pending' | 'in_progress' | 'completed' }>
  created_at: number
  updated_at: number
}

export function parseTaskPlan(value: unknown): TaskPlanSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const p = value as TaskPlanSnapshot
  if (![p.session_id, p.run_id, p.plan_id].every(id => typeof id === 'string' && id.length > 0)) return null
  if (!Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isFinite(p.created_at) || !Number.isFinite(p.updated_at)) return null
  if (!['running', 'ended', 'interrupted', 'failed'].includes(p.execution_state)) return null
  if (p.explanation !== undefined && typeof p.explanation !== 'string') return null
  if (!Array.isArray(p.plan) || p.plan.length < 1 || p.plan.length > 30) return null
  const ids = new Set<string>()
  for (const step of p.plan) {
    if (!step || typeof step.id !== 'string' || !step.id.trim() || ids.has(step.id)) return null
    if (typeof step.step !== 'string' || !step.step.trim() || step.step.length > 200) return null
    if (!['pending', 'in_progress', 'completed'].includes(step.status)) return null
    ids.add(step.id)
  }
  return p
}

/** Keep a single card per plan across stream replay and paginated history. */
export function mergeTaskPlanMessages(messages: Message[], plans: unknown[], sessionId?: string): Message[] {
  const result = [...messages]
  for (const raw of plans) {
    const plan = parseTaskPlan(raw)
    if (!plan || (sessionId && plan.session_id !== sessionId)) continue
    const id = `task-plan:${plan.session_id}:${plan.plan_id}`
    const existing = result.findIndex(message => message.id === id)
    if (existing >= 0 && (result[existing].taskPlan?.revision ?? 0) >= plan.revision) continue
    const message: Message = {
      id, role: 'system', content: '', timestamp: plan.created_at,
      runMarker: plan.run_id, taskPlan: plan,
    }
    if (existing >= 0) {
      result[existing] = message
    } else {
      let index = result.findIndex(item => item.runMarker === plan.run_id && item.role !== 'user' && item.role !== 'command')
      if (index < 0) index = result.findIndex(item => item.timestamp > plan.created_at)
      result.splice(index < 0 ? result.length : index, 0, message)
    }
  }
  return result
}
